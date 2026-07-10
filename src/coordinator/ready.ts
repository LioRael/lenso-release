import type { ComponentRegistry } from "../config/components.js";
import type { PlanStatePackage, PlanStateV1, RegistryPackageId, ReleaseEventV1, ReleasePlanV1 } from "../contracts/types.js";
import { assertReleaseEvent, assertReleasePlan } from "../contracts/validate.js";
import { topologicalPhases } from "../core/dag.js";
import { sha256 } from "../core/canonical.js";
import { executionRef } from "../publisher/contract.js";
import { dispatchCommand, newlyReadyPackages, publishRequest, type WorkflowDispatcher } from "./dispatch.js";
import { normalizeRepository, planStatePath, type GitStateStore, type StoredPlanState } from "./state.js";

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
  externalDependenciesVisible: boolean;
};
export type GitHubReadyReader = {
  readAtReleaseCommit(event: Extract<ReleaseEventV1, { eventType: "lenso-plan-ready" }>): Promise<ReadyFacts>;
  ensureExecutionRef(repository: string, ref: string, commit: string): Promise<{ tip: string; protected: boolean }>;
};
export type ReadyDependencies = { store: GitStateStore; github: GitHubReadyReader; dispatcher: WorkflowDispatcher; registry: ComponentRegistry; now(): Date; nonce(): string; appId: number; expectedActor: string };

function verifyReady(event: Extract<ReleaseEventV1, { eventType: "lenso-plan-ready" }>, facts: ReadyFacts, deps: ReadyDependencies): ReleasePlanV1 {
  assertReleasePlan(facts.plan);
  const plan = facts.plan;
  if (event.expectedAppId !== deps.appId || facts.appId !== deps.appId || facts.actor !== deps.expectedActor) throw new Error("ready GitHub App authentication mismatch");
  if (normalizeRepository(event.sourceRepository) !== plan.repository || event.planId !== plan.planId || event.planSha256 !== facts.planSha256 || sha256(facts.planBytes) !== event.planSha256) throw new Error("ready plan identity mismatch");
  if (event.releaseCommit === plan.sourceCommit || facts.sourceCommitRepository !== plan.repository || facts.releaseCommitRepository !== plan.repository || !facts.releaseCommitContainsSourceCommit) throw new Error("ready commit ownership or ancestry mismatch");
  for (const [actual, expected] of [[facts.workflowSha256, plan.publisher.workflowSha256], [facts.sharedRevision, plan.publisher.sharedRevision], [facts.sharedBundleSha256, plan.publisher.sharedBundleSha256], [facts.runner, plan.publisher.runner], [facts.node, plan.publisher.node], [facts.npm, plan.publisher.npm], [facts.rust, plan.publisher.rust]]) if (actual !== expected) throw new Error("ready publisher contract mismatch");
  if (!facts.branchProtected) throw new Error("release branch protection missing");
  if (!facts.externalDependenciesVisible) throw new Error("external dependency is not registry-visible");
  return plan;
}

function packagesFor(plan: ReleasePlanV1, registry: ComponentRegistry): PlanStatePackage[] {
  const phases = topologicalPhases(registry, plan.packages.map(({ id }) => id));
  return plan.packages.map(({ id, nextVersion: version }) => ({ id: id as RegistryPackageId, version, phase: phases.findIndex((phase) => phase.includes(id)), status: "pending" as const, requestEventId: null })).sort((a, b) => `${a.id}:${a.version}`.localeCompare(`${b.id}:${b.version}`));
}

export async function acceptReadyEvent(value: unknown, deps: ReadyDependencies): Promise<StoredPlanState> {
  assertReleaseEvent(value);
  if (value.eventType !== "lenso-plan-ready") throw new Error("event type must be lenso-plan-ready");
  const facts = await deps.github.readAtReleaseCommit(value);
  const plan = verifyReady(value, facts, deps);
  const path = planStatePath(plan.repository, plan.planId);
  const existing = await deps.store.read(path);
  if (existing) return existing;
  const active = await deps.store.findActiveByRepository?.(plan.repository) ?? [];
  if (active.some(({ state }) => state.planId !== plan.planId && state.status !== "verified")) throw new Error("repository already has an active immutable plan");
  const packages = packagesFor(plan, deps.registry);
  const occupancyKeys = [`plan:${plan.repository}:${plan.planId}`, ...packages.map(({ id, version }) => `package:${id}:${version}`)].sort();
  for (const key of occupancyKeys) if ((await deps.store.findByOccupancyKey?.(key) ?? []).length > 0) throw new Error(`occupied concurrency key ${key}`);
  const ref = await deps.github.ensureExecutionRef(plan.repository, executionRef(plan.planId), value.releaseCommit);
  if (ref.tip !== value.releaseCommit || !ref.protected) throw new Error("execution ref is not protected at exact release commit");
  const now = deps.now().toISOString();
  let state: PlanStateV1 = { schema: "lenso.plan-state.v1", repository: plan.repository, planId: plan.planId, planSha256: value.planSha256, sourceCommit: plan.sourceCommit, releaseCommit: value.releaseCommit, status: "ready", reason: null, evidence: [], packages, receipts: [], attempts: [{ eventId: value.eventId, kind: "ready", at: now, outcome: "accepted", detail: null }], occupancyKeys, revision: 0, previousBlobSha: null, createdAt: now, updatedAt: now };
  const ready = newlyReadyPackages(state.packages);
  if (ready.length > 0) {
    const request = publishRequest(plan, value.planSha256, value.releaseCommit, ready, now, deps.nonce(), deps.appId);
    await deps.dispatcher.dispatch(dispatchCommand(plan, request));
    const ids = new Set(ready.map(({ id }) => id));
    state = { ...state, status: "publishing", packages: state.packages.map((item) => ids.has(item.id) ? { ...item, status: "dispatched", requestEventId: request.eventId } : item), attempts: [...state.attempts, { eventId: request.eventId, kind: "dispatch", at: now, outcome: "accepted", detail: null }] };
  }
  return deps.store.create(path, state);
}
