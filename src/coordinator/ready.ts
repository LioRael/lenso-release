import type { ComponentRegistry } from "../config/components.js";
import type {
  PlanStatePackage,
  PlanStateV1,
  RegistryPackageId,
  ReleaseEventV1,
  ReleasePlanV1,
  Sha256,
} from "../contracts/types.js";
import {
  assertReleaseEvent,
  assertReleasePlan,
} from "../contracts/validate.js";
import { sha256 } from "../core/canonical.js";
import { topologicalPhases } from "../core/dag.js";
import { executionRef } from "../publisher/contract.js";
import { newlyReadyPackages, outboxEntry } from "./dispatch.js";
import {
  normalizeRepository,
  planStatePath,
  StateConflictError,
  transact,
  type GitStateStore,
  type StoredPlanState,
} from "./state.js";

export type ReadyFacts = {
  actor: string;
  appId: number;
  planBytes: Uint8Array;
  plan: unknown;
  planSha256: string;
  sourceCommitRepository: string;
  releaseCommitRepository: string;
  releaseCommitContainsSourceCommit: boolean;
  workflowSha256: string;
  sharedRevision: string;
  sharedBundleSha256: string;
  runner: string;
  node: string;
  npm: string;
  rust: string;
  branchProtected: boolean;
  generatedFilesValid: boolean;
  externalDependenciesVisible: boolean;
};
export type GitHubReadyReader = {
  readAtReleaseCommit(
    event: Extract<ReleaseEventV1, { eventType: "lenso-plan-ready" }>,
  ): Promise<ReadyFacts>;
  ensureExecutionRef(
    repository: string,
    ref: string,
    commit: string,
  ): Promise<{ tip: string; protected: boolean }>;
};
export type ReadyDependencies = {
  store: GitStateStore;
  github: GitHubReadyReader;
  registry: ComponentRegistry;
  now(): Date;
  nonce(): string;
  appId: number;
  expectedActor: string;
};

function verifyReady(
  event: Extract<ReleaseEventV1, { eventType: "lenso-plan-ready" }>,
  facts: ReadyFacts,
  deps: ReadyDependencies,
): ReleasePlanV1 {
  assertReleasePlan(facts.plan);
  const plan = facts.plan;
  if (
    event.expectedAppId !== deps.appId ||
    facts.appId !== deps.appId ||
    facts.actor !== deps.expectedActor
  )
    throw new Error("ready GitHub App authentication mismatch");
  if (
    normalizeRepository(event.sourceRepository) !== plan.repository ||
    event.planId !== plan.planId ||
    event.planSha256 !== facts.planSha256 ||
    sha256(facts.planBytes) !== event.planSha256
  )
    throw new Error("ready plan identity mismatch");
  if (
    event.releaseCommit === plan.sourceCommit ||
    facts.sourceCommitRepository !== plan.repository ||
    facts.releaseCommitRepository !== plan.repository ||
    !facts.releaseCommitContainsSourceCommit
  )
    throw new Error("ready commit ownership or ancestry mismatch");
  for (const [actual, expected] of [
    [facts.workflowSha256, plan.publisher.workflowSha256],
    [facts.sharedRevision, plan.publisher.sharedRevision],
    [facts.sharedBundleSha256, plan.publisher.sharedBundleSha256],
    [facts.runner, plan.publisher.runner],
    [facts.node, plan.publisher.node],
    [facts.npm, plan.publisher.npm],
    [facts.rust, plan.publisher.rust],
  ])
    if (actual !== expected)
      throw new Error("ready publisher contract mismatch");
  if (!facts.branchProtected || !facts.generatedFilesValid)
    throw new Error("reviewed release commit facts mismatch");
  if (!facts.externalDependenciesVisible)
    throw new Error("external dependency is not registry-visible");
  return plan;
}
function packagesFor(
  plan: ReleasePlanV1,
  registry: ComponentRegistry,
): PlanStatePackage[] {
  const phases = topologicalPhases(
    registry,
    plan.packages.map(({ id }) => id),
  );
  return plan.packages
    .map(({ id, nextVersion: version }) => ({
      id: id as RegistryPackageId,
      version,
      phase: phases.findIndex((phase) => phase.includes(id)),
      status: "pending" as const,
      requestEventId: null,
    }))
    .sort((a, b) => {
      const left = `${a.id}:${a.version}`;
      const right = `${b.id}:${b.version}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

export async function acceptReadyEvent(
  value: unknown,
  deps: ReadyDependencies,
): Promise<StoredPlanState> {
  assertReleaseEvent(value);
  if (value.eventType !== "lenso-plan-ready")
    throw new TypeError("event type must be lenso-plan-ready");
  const facts = await deps.github.readAtReleaseCommit(value);
  const plan = verifyReady(value, facts, deps);
  const path = planStatePath(plan.repository, plan.planId);
  const refName = executionRef(plan.planId);
  const ref = await deps.github.ensureExecutionRef(
    plan.repository,
    refName,
    value.releaseCommit,
  );
  if (ref.tip !== value.releaseCommit || !ref.protected)
    throw new Error("execution ref is not protected at exact release commit");
  let result!: PlanStateV1;
  const committed = await transact(deps.store, (snapshot) => {
    const duplicate = snapshot.plans[path];
    if (duplicate) {
      result = duplicate;
      return snapshot;
    }
    if (
      snapshot.activeRepositories[plan.repository] &&
      snapshot.activeRepositories[plan.repository] !== plan.planId
    )
      throw new StateConflictError("repository active plan conflict");
    const packages = packagesFor(plan, deps.registry);
    for (const item of packages) {
      const key = `package:${item.id}:${item.version}`;
      if (
        snapshot.occupiedPackages[key] &&
        snapshot.occupiedPackages[key] !== plan.planId
      )
        throw new StateConflictError(`occupied ${key}`);
    }
    const now = deps.now().toISOString();
    const ready = newlyReadyPackages(packages);
    const entry = outboxEntry(
      plan,
      value.planSha256 as Sha256,
      value.releaseCommit,
      ready,
      now,
      deps.nonce(),
      deps.appId,
    );
    const ids = new Set(ready.map(({ id }) => id));
    result = {
      schema: "lenso.plan-state.v1",
      repository: plan.repository,
      planId: plan.planId,
      planSha256: value.planSha256,
      sourceCommit: plan.sourceCommit,
      releaseCommit: value.releaseCommit,
      status: "publishing",
      reason: null,
      evidence: [
        {
          kind: "execution-ref-protected",
          url: null,
          digest: `git:${ref.tip}`,
        },
      ],
      packages: packages.map((item) =>
        ids.has(item.id)
          ? { ...item, status: "dispatched", requestEventId: entry.eventId }
          : item,
      ),
      receipts: [],
      attempts: [
        {
          eventId: value.eventId,
          kind: "ready",
          at: now,
          outcome: "accepted",
          detail: null,
        },
      ],
      outbox: [entry],
      occupancyKeys: [
        `plan:${plan.repository}:${plan.planId}`,
        ...packages.map(({ id, version }) => `package:${id}:${version}`),
      ].sort(),
      executionRef: {
        name: refName,
        tip: value.releaseCommit,
        protected: true,
      },
      revision: 0,
      previousBlobSha: null,
      createdAt: now,
      updatedAt: now,
    };
    snapshot.plans[path] = result;
    snapshot.activeRepositories[plan.repository] = plan.planId;
    for (const item of packages)
      snapshot.occupiedPackages[`package:${item.id}:${item.version}`] =
        plan.planId;
    return snapshot;
  });
  return { state: committed.plans[path]!, headSha: committed.headSha };
}
