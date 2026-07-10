import type {
  PlanDispatchOutbox,
  PlanStatePackage,
  ReleaseEventV1,
  ReleasePlanV1,
  Sha256,
} from "../contracts/types.js";
import { sha256, type JsonValue } from "../core/canonical.js";
import { executionRef } from "../publisher/contract.js";
import {
  assertLegalTransition,
  planStatePath,
  transact,
  type GitStateStore,
  type StoredPlanState,
} from "./state.js";

export const PUBLISH_INPUT_FIELDS = [
  "event",
  "plan_id",
  "plan_sha256",
  "release_commit",
  "packages",
  "source_repository",
] as const;
export type DispatchCommand = {
  repository: string;
  workflow: string;
  ref: string;
  inputs: Record<(typeof PUBLISH_INPUT_FIELDS)[number], string>;
};
export type WorkflowDispatcher = {
  findByEventId(
    repository: string,
    eventId: string,
    appToken: string,
  ): Promise<{ runUrl: string } | null>;
  dispatch(
    command: DispatchCommand,
    eventId: string,
    appToken: string,
  ): Promise<{ runUrl: string }>;
};
export type AppTokenProvider = {
  tokenFor(repository: string): Promise<string>;
};

export function newlyReadyPackages(
  packages: readonly PlanStatePackage[],
): PlanStatePackage[] {
  const pending = packages.filter((item) => item.status === "pending");
  if (pending.length === 0) return [];
  const phase = Math.min(...pending.map(({ phase }) => phase));
  if (packages.some((item) => item.phase < phase && item.status !== "received"))
    return [];
  return pending
    .filter((item) => item.phase === phase)
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function publishRequest(
  plan: ReleasePlanV1,
  planSha256: Sha256,
  releaseCommit: string,
  packages: readonly PlanStatePackage[],
  issuedAt: string,
  nonce: string,
  appId: number,
): Extract<ReleaseEventV1, { eventType: "lenso-publish-requested" }> {
  const identity = {
    schema: "lenso.release-event.v1" as const,
    eventType: "lenso-publish-requested" as const,
    issuedAt,
    nonce,
    sourceRepository: "LioRael/lenso-release",
    expectedAppId: appId,
    planId: plan.planId,
    planUrl: `https://raw.githubusercontent.com/${plan.repository}/${releaseCommit}/.lenso/release-plan.json`,
    planSha256,
    releaseCommit,
    packages: packages.map(({ id, version }) => ({ id, version })),
  };
  return { eventId: sha256(identity as JsonValue) as Sha256, ...identity };
}
export function dispatchCommand(
  plan: ReleasePlanV1,
  event: Extract<ReleaseEventV1, { eventType: "lenso-publish-requested" }>,
): DispatchCommand {
  return {
    repository: plan.repository,
    workflow: plan.publisher.workflow,
    ref: executionRef(plan.planId),
    inputs: {
      event: JSON.stringify(event),
      plan_id: plan.planId,
      plan_sha256: event.planSha256,
      release_commit: event.releaseCommit,
      packages: JSON.stringify(event.packages),
      source_repository: event.sourceRepository,
    },
  };
}
export function outboxEntry(
  plan: ReleasePlanV1,
  planSha256: Sha256,
  releaseCommit: string,
  packages: readonly PlanStatePackage[],
  at: string,
  nonce: string,
  appId: number,
): PlanDispatchOutbox {
  const event = publishRequest(
    plan,
    planSha256,
    releaseCommit,
    packages,
    at,
    nonce,
    appId,
  );
  const command = dispatchCommand(plan, event);
  return {
    eventId: event.eventId,
    nonce,
    ref: command.ref,
    workflow: command.workflow,
    packages: event.packages,
    inputs: command.inputs,
    status: "pending",
    runUrl: null,
    createdAt: at,
    updatedAt: at,
  };
}

export async function runDispatchOutbox(
  store: GitStateStore,
  repository: string,
  planId: string,
  dispatcher: WorkflowDispatcher,
  tokens: AppTokenProvider,
  now: () => Date,
): Promise<StoredPlanState> {
  const path = planStatePath(repository, planId);
  let snapshot = await store.readSnapshot();
  let state = snapshot.plans[path];
  if (!state) throw new Error("plan state not found");
  const entry = state.outbox.find(({ status }) => status !== "dispatched");
  if (!entry) return { state, headSha: snapshot.headSha };
  const token = await tokens.tokenFor(repository);
  const existing = await dispatcher.findByEventId(repository, entry.eventId, token);
  let run = existing;
  if (!run) {
    let claimed = false;
    snapshot = await transact(store, (current) => {
      claimed = false;
      const candidate = current.plans[path];
      if (!candidate) throw new Error("plan state not found");
      const target = candidate.outbox.find(
        ({ eventId }) => eventId === entry.eventId,
      );
      if (!target || target.status !== "pending") return current;
      claimed = true;
      const at = now().toISOString();
      const next = {
        ...candidate,
        outbox: candidate.outbox.map((item) =>
          item.eventId === entry.eventId
            ? {
                ...item,
                status: "in-flight" as const,
                updatedAt: at,
              }
            : item,
        ),
        revision: candidate.revision + 1,
        updatedAt: at,
      };
      assertLegalTransition(candidate, next);
      current.plans[path] = next;
      return current;
    });
    state = snapshot.plans[path]!;
    if (!claimed) {
      const observed = await dispatcher.findByEventId(
        repository,
        entry.eventId,
        token,
      );
      if (!observed)
        throw new Error(`dispatch ${entry.eventId} is already in flight`);
      run = observed;
    }
    const currentEntry = state.outbox.find(
      ({ eventId }) => eventId === entry.eventId,
    )!;
    if (claimed)
      run = await dispatcher.dispatch(
        {
          repository,
          workflow: currentEntry.workflow,
          ref: currentEntry.ref,
          inputs: currentEntry.inputs,
        },
        entry.eventId,
        token,
      );
  }
  const committed = await transact(store, (current) => {
    const candidate = current.plans[path];
    if (!candidate) throw new Error("plan state not found");
    const target = candidate.outbox.find(
      ({ eventId }) => eventId === entry.eventId,
    );
    if (!target || target.status === "dispatched") return current;
    const at = now().toISOString();
    const next = {
      ...candidate,
      outbox: candidate.outbox.map((item) =>
        item.eventId === entry.eventId
          ? {
              ...item,
              status: "dispatched" as const,
              runUrl: run!.runUrl,
              updatedAt: at,
            }
          : item,
      ),
      attempts: [
        ...candidate.attempts,
        {
          eventId: entry.eventId,
          kind: "dispatch" as const,
          at,
          outcome: "accepted" as const,
          detail: null,
        },
      ],
      revision: candidate.revision + 1,
      updatedAt: at,
    };
    assertLegalTransition(candidate, next);
    current.plans[path] = next;
    return current;
  });
  return { state: committed.plans[path]!, headSha: committed.headSha };
}
