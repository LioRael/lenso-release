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
  "event_id",
  "plan_id",
  "plan_sha256",
  "release_commit",
  "packages_json",
  "nonce",
] as const;
export type DispatchCommand = {
  repository: string;
  workflow: string;
  ref: string;
  inputs: Record<(typeof PUBLISH_INPUT_FIELDS)[number], string>;
};
export type DispatchRunContext = {
  repository: string;
  workflow: string;
  ref: string;
  sha: string;
};
export type ObservedWorkflowRun = DispatchRunContext & {
  event: "workflow_dispatch";
  runName: string;
  runUrl: string;
};
export type WorkflowDispatcher = {
  findByEventId(
    context: DispatchRunContext,
    eventId: string,
    appToken: string,
  ): Promise<ObservedWorkflowRun | null>;
  dispatch(
    command: DispatchCommand,
    eventId: string,
    appToken: string,
  ): Promise<ObservedWorkflowRun>;
};
export type AppTokenProvider = {
  tokenFor(
    repository: string,
    permissions?: Record<string, "read" | "write">,
  ): Promise<string>;
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
    .sort((a, b) => {
      const left = `${a.id}:${a.version}`;
      const right = `${b.id}:${b.version}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
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
  const planOrder = new Map(
    plan.packages.map(({ id }, index) => [id, index] as const),
  );
  const identity = {
    schema: "lenso.release-event.v1" as const,
    eventType: "lenso-publish-requested" as const,
    issuedAt,
    nonce,
    sourceRepository: "LioRael/lenso-release",
    expectedAppId: appId,
    planId: plan.planId,
    planUrl: `https://raw.githubusercontent.com/${plan.repository}/${releaseCommit}/.lenso-release/plan.json`,
    planSha256,
    releaseCommit,
    packages: [...packages]
      .sort((a, b) => planOrder.get(a.id)! - planOrder.get(b.id)!)
      .map(({ id, version }) => ({ id, version })),
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
      event_id: event.eventId,
      plan_id: plan.planId,
      plan_sha256: event.planSha256,
      release_commit: event.releaseCommit,
      packages_json: JSON.stringify(event.packages),
      nonce: event.nonce,
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
    claimOwner: null,
    leaseExpiresAt: null,
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
  claimOwner: string = crypto.randomUUID(),
): Promise<StoredPlanState> {
  const path = planStatePath(repository, planId);
  let snapshot = await store.readSnapshot();
  let state = snapshot.plans[path];
  if (!state) throw new Error("plan state not found");
  const entry = state.outbox.find(({ status }) => status === "pending" || status === "in-flight");
  if (!entry) return { state, headSha: snapshot.headSha };
  const token = await tokens.tokenFor(repository, {
    actions: "write",
    metadata: "read",
  });
  const context: DispatchRunContext = { repository, workflow: entry.workflow, ref: entry.ref, sha: state.releaseCommit };
  const existing = await dispatcher.findByEventId(context, entry.eventId, token);
  const canonicalRun = (run: ObservedWorkflowRun): ObservedWorkflowRun => {
    const parsed = new URL(run.runUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.pathname.split("/").filter(Boolean).slice(0, 4).join("/") !==
        `${repository}/actions/runs` ||
      !/^[1-9][0-9]*$/u.test(parsed.pathname.split("/").filter(Boolean)[4] ?? "") ||
      parsed.search !== "" ||
      parsed.hash !== ""
    )
      throw new TypeError("workflow run URL is not canonical");
    if (
      run.repository !== context.repository ||
      run.workflow !== context.workflow ||
      run.ref !== context.ref ||
      run.sha !== context.sha ||
      run.event !== "workflow_dispatch" ||
      run.runName !== `lenso-publish-requested:${entry.eventId}`
    ) throw new TypeError("workflow run context mismatch");
    return run;
  };
  let run = existing ? canonicalRun(existing) : null;
  if (!run && entry.status === "in-flight") {
    if (entry.leaseExpiresAt !== null && entry.leaseExpiresAt > now().toISOString())
      throw new Error(`dispatch ${entry.eventId} is already in flight`);
    const blocked = await transact(store, (current) => {
      const candidate = current.plans[path];
      if (!candidate) throw new Error("plan state not found");
      const target = candidate.outbox.find(({ eventId }) => eventId === entry.eventId);
      if (!target || target.status !== "in-flight") return current;
      const at = now().toISOString();
      const next = {
        ...candidate,
        status: "blocked" as const,
        reason: "dispatch outcome unknown",
        attempts: [...candidate.attempts, { eventId: entry.eventId, kind: "dispatch" as const, at, outcome: "blocked" as const, detail: "dispatch outcome unknown" }],
        revision: candidate.revision + 1,
        updatedAt: at,
      };
      assertLegalTransition(candidate, next);
      current.plans[path] = next;
      return current;
    });
    return { state: blocked.plans[path]!, headSha: blocked.headSha };
  }
  if (!run) {
    let claimed = false;
    snapshot = await transact(store, (current) => {
      claimed = false;
      const candidate = current.plans[path];
      if (!candidate) throw new Error("plan state not found");
      if (
        candidate.status !== "publishing" ||
        current.activeRepositories[repository] !== planId ||
        !candidate.occupancyKeys.includes(`plan:${repository}:${planId}`)
      )
        throw new Error("plan is not active for dispatch");
      const target = candidate.outbox.find(
        ({ eventId }) => eventId === entry.eventId,
      );
      const instant = now();
      if (!target || target.status !== "pending") return current;
      claimed = true;
      const at = instant.toISOString();
      const leaseExpiresAt = new Date(instant.getTime() + 5 * 60_000).toISOString();
      const next = {
        ...candidate,
        outbox: candidate.outbox.map((item) =>
          item.eventId === entry.eventId
            ? {
                ...item,
                status: "in-flight" as const,
                claimOwner,
                leaseExpiresAt,
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
        context,
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
    if (claimed) {
      const discovered = await dispatcher.findByEventId(context, entry.eventId, token);
      run = discovered ? canonicalRun(discovered) : null;
      if (!run)
        run = canonicalRun(await dispatcher.dispatch(
          {
            repository,
            workflow: currentEntry.workflow,
            ref: currentEntry.ref,
            inputs: currentEntry.inputs,
          },
          entry.eventId,
          token,
        ));
    }
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
              claimOwner: null,
              leaseExpiresAt: null,
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
