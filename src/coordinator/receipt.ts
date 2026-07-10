import type { ComponentReceiptV1, PlanStateV1, ReleaseEventV1, ReleasePlanV1, Sha256 } from "../contracts/types.js";
import { assertReleaseEvent, assertReleasePlan } from "../contracts/validate.js";
import { canonicalBytes, sha256 } from "../core/canonical.js";
import { newlyReadyPackages, outboxEntry } from "./dispatch.js";
import { assertLegalTransition, planStatePath, transact, type GitStateStore, type StoredPlanState } from "./state.js";

export type ReceiptObservation = {
  registry: { packedBytes: Uint8Array; nativeIntegrity: string; url: string; publishedAt: string };
  provenance: { url: string; subject: { name: string; digest: string } };
  workflow: { url: string; repository: string; ref: string; sha: string; eventId: string; correlationId: string; packages: { id: string; version: string }[] };
  tag: { url: string; annotated: boolean; immutable: boolean; receipt: unknown | null };
};
export type ReceiptObserver = { observe(repository: string, packageId: string, version: string): Promise<ReceiptObservation | null>; createAnnotatedTag(repository: string, receipt: ComponentReceiptV1): Promise<void> };
export type ReceiptDependencies = { store: GitStateStore; observer: ReceiptObserver; authenticate(value: unknown): Promise<{ actor: string; appId: number }>; expectedActor: string; readPlan(repository: string, releaseCommit: string): Promise<{ plan: unknown; planBytes: Uint8Array }>; dependenciesVisible?(plan: ReleasePlanV1, packageIds: string[]): Promise<boolean>; now(): Date; nonce(): string; appId: number };

const equal = (a: unknown, b: unknown) => canonicalBytes(a as never).equals(canonicalBytes(b as never));
function verify(receipt: ComponentReceiptV1, event: Extract<ReleaseEventV1, { eventType: "lenso-publish-receipt" }>, observed: ReceiptObservation, state: PlanStateV1): void {
  if (sha256(observed.registry.packedBytes) !== receipt.packedSha256 || observed.registry.nativeIntegrity !== receipt.registryIntegrity || observed.registry.url !== receipt.registryUrl || observed.registry.publishedAt !== receipt.publishedAt) throw new Error("registry contradiction");
  if (observed.provenance.url !== receipt.provenanceUrl || !equal(observed.provenance.subject, receipt.provenanceSubject)) throw new Error("provenance contradiction");
  const run = observed.workflow;
  if (run.url !== receipt.workflowUrl || run.repository !== state.repository || run.ref !== state.executionRef.name || run.sha !== state.releaseCommit || run.eventId !== event.correlationId || run.correlationId !== event.correlationId || !run.packages.some(({ id, version }) => id === receipt.packageId && version === receipt.version)) throw new Error("workflow contradiction");
  if (!observed.tag.annotated || !observed.tag.immutable || observed.tag.url !== receipt.tagUrl || !equal(observed.tag.receipt, receipt)) throw new Error("annotated tag contradiction");
}
async function block(deps: ReceiptDependencies, path: string, eventId: Sha256, reason: string): Promise<StoredPlanState> {
  let result!: PlanStateV1;
  const committed = await transact(deps.store, (snapshot) => {
    const state = snapshot.plans[path]; if (!state) throw new Error("plan state not found"); if (state.status === "verified") throw new Error("verified state is terminal");
    const at = deps.now().toISOString(); result = { ...state, status: "blocked", reason, evidence: [...state.evidence, { kind: "contradiction", url: null, digest: null }], attempts: [...state.attempts, { eventId, kind: "receipt", at, outcome: "blocked", detail: reason }], revision: state.revision + 1, updatedAt: at };
    assertLegalTransition(state, result); snapshot.plans[path] = result; return snapshot;
  });
  return { state: committed.plans[path]!, headSha: committed.headSha };
}

export async function acceptReceiptEvent(value: unknown, deps: ReceiptDependencies): Promise<StoredPlanState> {
  assertReleaseEvent(value); if (value.eventType !== "lenso-publish-receipt") throw new TypeError("event type must be lenso-publish-receipt");
  const auth = await deps.authenticate(value); if (value.expectedAppId !== deps.appId || auth.appId !== deps.appId || auth.actor !== deps.expectedActor) throw new Error("receipt GitHub App authentication mismatch");
  const receipt = value.receipt; const path = planStatePath(receipt.repository, receipt.planId); const snapshot = await deps.store.readSnapshot(); const current = snapshot.plans[path]; if (!current) throw new Error("plan state not found");
  if (current.status === "verified" && current.receipts.some((item) => equal(item, receipt))) return { state: current, headSha: snapshot.headSha };
  if (current.status === "blocked") throw new Error("blocked plan requires explicit recovery");
  if (current.receipts.some((item) => equal(item, receipt))) return { state: current, headSha: snapshot.headSha };
  if (receipt.planId !== current.planId || receipt.repository !== current.repository || receipt.sourceCommit !== current.releaseCommit || value.planId !== current.planId || value.releaseCommit !== current.releaseCommit) return block(deps, path, value.eventId, "receipt identity contradiction");
  const selected = current.packages.find(({ id, version }) => id === receipt.packageId && version === receipt.version); if (!selected || selected.requestEventId !== value.correlationId) return block(deps, path, value.eventId, "receipt package correlation contradiction");
  const observation = await deps.observer.observe(current.repository, receipt.packageId, receipt.version); if (!observation) throw new Error("receipt evidence incomplete");
  try { verify(receipt, value, observation, current); } catch (error) { return block(deps, path, value.eventId, error instanceof Error ? error.message : "receipt contradiction"); }
  const reread = await deps.readPlan(current.repository, current.releaseCommit); assertReleasePlan(reread.plan); const plan: ReleasePlanV1 = reread.plan;
  if (plan.repository !== current.repository || plan.planId !== current.planId || plan.sourceCommit !== current.sourceCommit || sha256(reread.planBytes) !== current.planSha256)
    return block(deps, path, value.eventId, "stored release plan binding contradiction");
  const projectedPackages = current.packages.map((item) => item.id === receipt.packageId && item.version === receipt.version ? { ...item, status: "received" as const } : item);
  const projectedReady = newlyReadyPackages(projectedPackages);
  if (projectedReady.length > 0 && deps.dependenciesVisible && !await deps.dependenciesVisible(plan, projectedReady.map(({ id }) => id)))
    return block(deps, path, value.eventId, "newly ready dependency is not registry-visible");
  let result!: PlanStateV1;
  const committed = await transact(deps.store, (stateSnapshot) => {
    const state = stateSnapshot.plans[path]; if (!state) throw new Error("plan state not found"); if (state.receipts.some((item) => equal(item, receipt))) { result = state; return stateSnapshot; }
    const packages = state.packages.map((item) => item.id === receipt.packageId && item.version === receipt.version ? { ...item, status: "received" as const } : item);
    const receipts = [...state.receipts, receipt].sort((a, b) => `${a.packageId}:${a.version}`.localeCompare(`${b.packageId}:${b.version}`)); delete stateSnapshot.occupiedPackages[`package:${receipt.packageId}:${receipt.version}`];
    const ready = newlyReadyPackages(packages); let outbox = state.outbox; let finalPackages = packages; const at = deps.now().toISOString();
    if (ready.length > 0) { const entry = outboxEntry(plan, state.planSha256, state.releaseCommit, ready, at, deps.nonce(), deps.appId); outbox = [...outbox, entry].sort((a, b) => a.eventId.localeCompare(b.eventId)); const ids = new Set(ready.map(({ id }) => id)); finalPackages = packages.map((item) => ids.has(item.id) ? { ...item, status: "dispatched" as const, requestEventId: entry.eventId } : item); }
    const verified = finalPackages.every(({ status }) => status === "received"); const occupancyKeys = verified ? [] : [`plan:${state.repository}:${state.planId}`, ...finalPackages.filter(({ status }) => status !== "received").map(({ id, version }) => `package:${id}:${version}`)].sort();
    result = { ...state, status: verified ? "verified" : "publishing", reason: null, packages: finalPackages, receipts, outbox, occupancyKeys, attempts: [...state.attempts, { eventId: value.eventId, kind: "receipt", at, outcome: "accepted", detail: null }], revision: state.revision + 1, updatedAt: at };
    assertLegalTransition(state, result); stateSnapshot.plans[path] = result; if (verified) delete stateSnapshot.activeRepositories[state.repository]; return stateSnapshot;
  });
  return { state: result, headSha: committed.headSha };
}

export async function recoverLostReceipt(repository: string, planId: string, packageId: string, version: string, deps: ReceiptDependencies): Promise<StoredPlanState | null> {
  const snapshot = await deps.store.readSnapshot(); const state = snapshot.plans[planStatePath(repository, planId)]; if (!state) throw new Error("plan state not found"); const observed = await deps.observer.observe(repository, packageId, version); if (!observed) return null;
  const selected = state.packages.find((item) => item.id === packageId && item.version === version); const requestId = selected?.requestEventId; if (!requestId) throw new Error("package was not dispatched");
  if (observed.workflow.repository !== repository || observed.workflow.ref !== state.executionRef.name || observed.workflow.sha !== state.releaseCommit || observed.workflow.eventId !== requestId || observed.workflow.correlationId !== requestId || !observed.workflow.packages.some(({ id, version: observedVersion }) => id === packageId && observedVersion === version)) return null;
  const identity = { schema: "lenso.component-receipt.v1" as const, planId: state.planId, packageId: packageId as ComponentReceiptV1["packageId"], version, repository, sourceCommit: state.releaseCommit, packedSha256: sha256(observed.registry.packedBytes) as Sha256, registryIntegrity: observed.registry.nativeIntegrity, registryUrl: observed.registry.url, provenanceUrl: observed.provenance.url, provenanceSubject: observed.provenance.subject, workflowUrl: observed.workflow.url, tagUrl: observed.tag.url, publishedAt: observed.registry.publishedAt };
  let receipt = observed.tag.receipt as ComponentReceiptV1 | null;
  if (receipt === null) {
    receipt = { ...identity, receiptId: sha256(identity as never) as Sha256 };
    await deps.observer.createAnnotatedTag(repository, receipt);
    const reread = await deps.observer.observe(repository, packageId, version);
    if (!reread?.tag.annotated || !reread.tag.immutable || !equal(reread.tag.receipt, receipt)) throw new Error("recovery tag did not become authoritative");
  }
  return acceptReceiptEvent({ schema: "lenso.release-event.v1", eventType: "lenso-publish-receipt", eventId: receipt.receiptId, issuedAt: deps.now().toISOString(), nonce: deps.nonce(), sourceRepository: repository, expectedAppId: deps.appId, planId, planUrl: receipt.tagUrl, planSha256: state.planSha256, releaseCommit: state.releaseCommit, correlationId: requestId, receipt }, deps);
}
