import type { ComponentReceiptV1, PlanStateV1, ReleaseEventV1, ReleasePlanV1, Sha256 } from "../contracts/types.js";
import { assertReleaseEvent, assertReleasePlan } from "../contracts/validate.js";
import { canonicalBytes, sha256 } from "../core/canonical.js";
import { newlyReadyPackages, outboxEntry } from "./dispatch.js";
import { assertLegalTransition, planStatePath, transact, type GitStateStore, type StoredPlanState } from "./state.js";

export type ReceiptObservation = {
  registry: { packedBytes: Uint8Array; nativeIntegrity: string; url: string; publishedAt: string };
  provenance: { url: string; subject: { name: string; digest: string } };
  workflow: { url: string; repository: string; ref: string; sha: string; runName: string; workflowPath: string; recovery?: true };
  tag: { url: string; annotated: boolean; immutable: boolean; targetSha: string | null; receipt: unknown | null };
};
export class IncompleteEvidenceError extends Error {}
export type ReceiptObservationContext = { repository: string; releaseCommit: string; eventId: Sha256; executionRef: string; workflow: string; packages: { id: string; version: string }[] };
export type ReceiptObserver = { observe(context: ReceiptObservationContext, packageId: string, version: string): Promise<ReceiptObservation | null>; createAnnotatedTag(repository: string, receipt: ComponentReceiptV1): Promise<void> };
export type ReceiptDependencies = { store: GitStateStore; observer: ReceiptObserver; authenticate(value: unknown): Promise<{ actor: string; appId: number }>; expectedActor: string; readPlan(repository: string, releaseCommit: string): Promise<{ plan: unknown; planBytes: Uint8Array }>; dependenciesVisible?(plan: ReleasePlanV1, packageIds: string[]): Promise<boolean>; environment: ComponentReceiptV1["environment"]; recovery?: boolean; now(): Date; nonce(): string; appId: number };

const equal = (a: unknown, b: unknown) => canonicalBytes(a as never).equals(canonicalBytes(b as never));
const RECOVERABLE_RECEIPT_BLOCK_REASONS = new Set([
  "dispatch outcome unknown",
  "registry contradiction",
  "provenance contradiction",
]);
export function receiptRecoveryEligible(state: PlanStateV1): boolean {
  return state.status === "publishing" ||
    (state.status === "blocked" &&
      RECOVERABLE_RECEIPT_BLOCK_REASONS.has(state.reason ?? ""));
}
function normalizeLegacyRecoveryReceipt(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const receipt = value as Record<string, unknown>;
  const subjectValue = receipt.provenanceSubject;
  if (typeof subjectValue !== "object" || subjectValue === null || Array.isArray(subjectValue)) return value;
  const subject = subjectValue as Record<string, unknown>;
  if (!Object.hasOwn(subject, "source")) return value;
  if (Object.keys(subject).sort().join(",") !== "digest,name,source") return value;
  const sourceValue = subject.source;
  if (typeof sourceValue !== "object" || sourceValue === null || Array.isArray(sourceValue)) return value;
  const source = sourceValue as Record<string, unknown>;
  if (
    Object.keys(source).sort().join(",") !== "ref,runId,sha" ||
    source.ref !== "main" ||
    !/^[1-9][0-9]*$/u.test(String(source.runId)) ||
    !/^[0-9a-f]{40}$/u.test(String(source.sha))
  ) return value;
  const { receiptId: _legacyReceiptId, ...legacyIdentity } = receipt;
  const identity = {
    ...legacyIdentity,
    provenanceSubject: { name: subject.name, digest: subject.digest },
  };
  return { ...identity, receiptId: sha256(identity as never) };
}
function verify(receipt: ComponentReceiptV1, event: Extract<ReleaseEventV1, { eventType: "lenso-publish-receipt" }>, observed: ReceiptObservation, state: PlanStateV1): void {
  if (sha256(observed.registry.packedBytes) !== receipt.packedSha256 || observed.registry.nativeIntegrity !== receipt.registryIntegrity || observed.registry.url !== receipt.registryUrl || observed.registry.publishedAt !== receipt.publishedAt) throw new Error("registry contradiction");
  if (observed.provenance.url !== receipt.provenanceUrl || !equal(observed.provenance.subject, receipt.provenanceSubject)) throw new Error("provenance contradiction");
  const run = observed.workflow;
  const outbox = state.outbox.find(({ eventId }) => eventId === event.correlationId);
  if (!outbox || !outbox.packages.some(({ id, version }) => id === receipt.packageId && version === receipt.version)) throw new Error("workflow package contradiction");
  const exactExecution = run.ref === state.executionRef.name && run.sha === state.releaseCommit;
  if (run.url !== receipt.workflowUrl || run.repository !== state.repository || (!exactExecution && run.recovery !== true) || run.runName !== `lenso-publish-requested:${event.correlationId}` || run.workflowPath !== outbox.workflow) throw new Error("workflow contradiction");
  const tagReceipt = observed.tag.receipt;
  const tagContainsReceipt = equal(normalizeLegacyRecoveryReceipt(tagReceipt), receipt) || Boolean(tagReceipt && typeof tagReceipt === "object" && !Array.isArray(tagReceipt) && (tagReceipt as { schema?: string }).schema === "lenso.fixed-group-receipt.v1" && Array.isArray((tagReceipt as { receipts?: unknown[] }).receipts) && (tagReceipt as { receipts: unknown[] }).receipts.some((candidate) => equal(normalizeLegacyRecoveryReceipt(candidate), receipt)));
  if (!observed.tag.annotated || !observed.tag.immutable || observed.tag.targetSha !== state.releaseCommit || observed.tag.url !== receipt.tagUrl || !tagContainsReceipt) throw new Error("annotated tag contradiction");
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
  if (current.status === "blocked" && (!deps.recovery || !receiptRecoveryEligible(current))) throw new Error("blocked plan requires explicit recovery");
  if (current.receipts.some((item) => equal(item, receipt))) return { state: current, headSha: snapshot.headSha };
  if (receipt.planId !== current.planId || receipt.repository !== current.repository || receipt.sourceCommit !== current.releaseCommit || value.planId !== current.planId || value.releaseCommit !== current.releaseCommit) return block(deps, path, value.eventId, "receipt identity contradiction");
  const selected = current.packages.find(({ id, version }) => id === receipt.packageId && version === receipt.version); if (!selected || selected.requestEventId !== value.correlationId) return block(deps, path, value.eventId, "receipt package correlation contradiction");
  const boundOutbox = current.outbox.find(({ eventId }) => eventId === value.correlationId); if (!boundOutbox) return block(deps, path, value.eventId, "receipt outbox contradiction");
  const context: ReceiptObservationContext = { repository: current.repository, releaseCommit: current.releaseCommit, eventId: value.correlationId, executionRef: current.executionRef.name, workflow: boundOutbox.workflow, packages: boundOutbox.packages };
  const observation = await deps.observer.observe(context, receipt.packageId, receipt.version); if (!observation) throw new IncompleteEvidenceError("receipt evidence incomplete");
  if (!observation.tag.annotated && observation.tag.receipt === null) throw new IncompleteEvidenceError("receipt tag evidence incomplete");
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
    result = { ...state, status: verified ? "verified" : "publishing", reason: null, evidence: deps.recovery ? [...state.evidence, { kind: "recovery", url: observation.workflow.url, digest: receipt.receiptId }] : state.evidence, packages: finalPackages, receipts, outbox, occupancyKeys, attempts: [...state.attempts, { eventId: value.eventId, kind: deps.recovery ? "recovery" : "receipt", at, outcome: "accepted", detail: null }], revision: state.revision + 1, updatedAt: at };
    assertLegalTransition(state, result); stateSnapshot.plans[path] = result; if (verified) delete stateSnapshot.activeRepositories[state.repository]; return stateSnapshot;
  });
  return { state: result, headSha: committed.headSha };
}

export async function recoverLostReceipt(repository: string, planId: string, packageId: string, version: string, deps: ReceiptDependencies): Promise<StoredPlanState | null> {
  const snapshot = await deps.store.readSnapshot(); const state = snapshot.plans[planStatePath(repository, planId)]; if (!state) throw new Error("plan state not found"); if (!receiptRecoveryEligible(state)) throw new Error("blocked plan is not recoverable");
  const selected = state.packages.find((item) => item.id === packageId && item.version === version); const requestId = selected?.requestEventId; if (!requestId) throw new Error("package was not dispatched");
  const outbox = state.outbox.find(({ eventId }) => eventId === requestId); if (!outbox || !outbox.packages.some(({ id, version: selectedVersion }) => id === packageId && selectedVersion === version)) throw new Error("package outbox binding missing");
  const context: ReceiptObservationContext = { repository, releaseCommit: state.releaseCommit, eventId: requestId, executionRef: state.executionRef.name, workflow: outbox.workflow, packages: outbox.packages };
  const observed = await deps.observer.observe(context, packageId, version); if (!observed) return null;
  const exactExecution = observed.workflow.ref === state.executionRef.name && observed.workflow.sha === state.releaseCommit;
  if (observed.workflow.repository !== repository || (!exactExecution && observed.workflow.recovery !== true) || observed.workflow.runName !== `lenso-publish-requested:${requestId}` || observed.workflow.workflowPath !== outbox.workflow) return null;
  const identity = { schema: "lenso.component-receipt.v1" as const, environment: deps.environment, planId: state.planId, packageId: packageId as ComponentReceiptV1["packageId"], version, repository, sourceCommit: state.releaseCommit, packedSha256: sha256(observed.registry.packedBytes) as Sha256, registryIntegrity: observed.registry.nativeIntegrity, registryUrl: observed.registry.url, provenanceUrl: observed.provenance.url, provenanceSubject: observed.provenance.subject, workflowUrl: observed.workflow.url, tagUrl: observed.tag.url, publishedAt: observed.registry.publishedAt };
  const tagReceipt = observed.tag.receipt;
  const componentTagReceipt = tagReceipt && typeof tagReceipt === "object" && !Array.isArray(tagReceipt) && (tagReceipt as { schema?: string }).schema === "lenso.fixed-group-receipt.v1"
    ? (tagReceipt as { receipts?: unknown[] }).receipts?.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as { packageId?: string; version?: string }).packageId === packageId && (candidate as { version?: string }).version === version) ?? null
    : tagReceipt;
  let receipt = componentTagReceipt === null ? null : normalizeLegacyRecoveryReceipt(componentTagReceipt) as ComponentReceiptV1;
  if (receipt === null) {
    receipt = { ...identity, receiptId: sha256(identity as never) as Sha256 };
    await deps.observer.createAnnotatedTag(repository, receipt);
    const reread = await deps.observer.observe(context, packageId, version);
    if (!reread?.tag.annotated || !reread.tag.immutable || !equal(reread.tag.receipt, receipt)) throw new Error("recovery tag did not become authoritative");
  }
  return acceptReceiptEvent({ schema: "lenso.release-event.v1", eventType: "lenso-publish-receipt", eventId: receipt.receiptId, issuedAt: deps.now().toISOString(), nonce: deps.nonce(), sourceRepository: repository, expectedAppId: deps.appId, planId, planUrl: receipt.tagUrl, planSha256: state.planSha256, releaseCommit: state.releaseCommit, correlationId: requestId, receipt }, { ...deps, recovery: state.status === "blocked" });
}
