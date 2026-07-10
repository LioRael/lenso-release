import type { ComponentReceiptV1, PlanStateV1, ReleaseEventV1, ReleasePlanV1, Sha256 } from "../contracts/types.js";
import { assertComponentReceipt, assertReleaseEvent, assertReleasePlan } from "../contracts/validate.js";
import { dispatchCommand, newlyReadyPackages, publishRequest, type WorkflowDispatcher } from "./dispatch.js";
import { mutateState, planStatePath, type GitStateStore, type StoredPlanState } from "./state.js";

export type ReceiptObservation = { registryIntegrity: string; packedSha256: string; provenanceSubject: { name: string; digest: string }; workflow: { repository: string; ref: string; sha: string }; tag: { annotated: boolean; immutable: boolean; receipt: unknown } };
export type ReceiptObserver = { observe(receipt: ComponentReceiptV1): Promise<ReceiptObservation | null> };
export type ReceiptDependencies = { store: GitStateStore; observer: ReceiptObserver; dispatcher: WorkflowDispatcher; authenticate(value: unknown): Promise<{ actor: string; appId: number }>; expectedActor: string; readPlan(repository: string, releaseCommit: string): Promise<unknown>; now(): Date; nonce(): string; appId: number };

function exactReceipt(receipt: ComponentReceiptV1, observed: ReceiptObservation, state: PlanStateV1): void {
  assertComponentReceipt(observed.tag.receipt);
  if (observed.registryIntegrity !== receipt.registryIntegrity || observed.packedSha256 !== receipt.packedSha256 || observed.provenanceSubject.name !== receipt.provenanceSubject.name || observed.provenanceSubject.digest !== receipt.provenanceSubject.digest) throw new Error("receipt registry or provenance contradiction");
  if (observed.workflow.repository !== state.repository || observed.workflow.sha !== state.releaseCommit || observed.workflow.ref !== `release-execution/${state.planId.slice(7)}`) throw new Error("receipt workflow contradiction");
  if (!observed.tag.annotated || !observed.tag.immutable || (observed.tag.receipt as ComponentReceiptV1).receiptId !== receipt.receiptId) throw new Error("receipt tag contradiction");
}

async function block(deps: ReceiptDependencies, path: string, reason: string, eventId: Sha256): Promise<StoredPlanState> {
  const at = deps.now().toISOString();
  return mutateState(deps.store, path, (state) => ({ ...state, status: "blocked", reason, evidence: [...state.evidence, { kind: "contradiction", url: null, digest: null }], attempts: [...state.attempts, { eventId, kind: "receipt", at, outcome: "blocked", detail: reason }], revision: state.revision + 1, updatedAt: at }));
}

export async function acceptReceiptEvent(value: unknown, deps: ReceiptDependencies): Promise<StoredPlanState> {
  assertReleaseEvent(value);
  if (value.eventType !== "lenso-publish-receipt") throw new Error("event type must be lenso-publish-receipt");
  const authentication = await deps.authenticate(value);
  if (value.expectedAppId !== deps.appId || authentication.appId !== deps.appId || authentication.actor !== deps.expectedActor) throw new Error("receipt GitHub App authentication mismatch");
  const receipt = value.receipt;
  const path = planStatePath(receipt.repository, receipt.planId);
  const current = await deps.store.read(path);
  if (!current) throw new Error("plan state not found");
  if (current.state.receipts.some(({ receiptId }) => receiptId === receipt.receiptId)) return current;
  if (receipt.planId !== current.state.planId || receipt.repository !== current.state.repository || receipt.sourceCommit !== current.state.releaseCommit) return block(deps, path, "receipt plan identity contradiction", value.eventId);
  const selected = current.state.packages.find(({ id, version }) => id === receipt.packageId && version === receipt.version);
  if (!selected || selected.requestEventId !== value.correlationId) return block(deps, path, "receipt package or correlation contradiction", value.eventId);
  const observation = await deps.observer.observe(receipt);
  if (!observation) throw new Error("receipt evidence is not yet visible");
  try { exactReceipt(receipt, observation, current.state); } catch (error) { return block(deps, path, error instanceof Error ? error.message : "receipt contradiction", value.eventId); }
  const planValue = await deps.readPlan(current.state.repository, current.state.releaseCommit); assertReleasePlan(planValue); const plan: ReleasePlanV1 = planValue;
  const at = deps.now().toISOString();
  return mutateState(deps.store, path, async (state) => {
    if (state.receipts.some(({ receiptId }) => receiptId === receipt.receiptId)) return state;
    const packages = state.packages.map((item) => item.id === receipt.packageId && item.version === receipt.version ? { ...item, status: "received" as const } : item);
    const receipts = [...state.receipts, receipt].sort((a, b) => `${a.packageId}:${a.version}`.localeCompare(`${b.packageId}:${b.version}`));
    const occupancyKeys = state.occupancyKeys.filter((key) => key !== `package:${receipt.packageId}:${receipt.version}`);
    const next = newlyReadyPackages(packages);
    const verified = packages.every(({ status }) => status === "received");
    let result: PlanStateV1 = { ...state, packages, receipts, occupancyKeys: verified ? [] : occupancyKeys, status: verified ? "verified" : "publishing", reason: null, attempts: [...state.attempts, { eventId: value.eventId, kind: "receipt", at, outcome: "accepted", detail: null }], revision: state.revision + 1, previousBlobSha: current.blobSha, updatedAt: at };
    if (!verified && next.length > 0) { const request = publishRequest(plan, state.planSha256, state.releaseCommit, next, at, deps.nonce(), deps.appId); await deps.dispatcher.dispatch(dispatchCommand(plan, request)); const ids = new Set(next.map(({ id }) => id)); result = { ...result, packages: result.packages.map((item) => ids.has(item.id) ? { ...item, status: "dispatched", requestEventId: request.eventId } : item), attempts: [...result.attempts, { eventId: request.eventId, kind: "dispatch", at, outcome: "accepted", detail: null }] }; }
    return result;
  });
}

export async function recoverLostReceipt(state: PlanStateV1, candidate: ComponentReceiptV1, deps: ReceiptDependencies): Promise<StoredPlanState | null> {
  const observation = await deps.observer.observe(candidate);
  if (!observation) return null;
  const correlationId = state.packages.find(({ id, version }) => id === candidate.packageId && version === candidate.version)?.requestEventId;
  if (!correlationId) throw new Error("lost receipt has no matching dispatch request");
  const event = { schema: "lenso.release-event.v1", eventType: "lenso-publish-receipt", eventId: candidate.receiptId, issuedAt: deps.now().toISOString(), nonce: deps.nonce(), sourceRepository: state.repository, expectedAppId: deps.appId, planId: state.planId, planUrl: candidate.tagUrl, planSha256: state.planSha256, releaseCommit: state.releaseCommit, correlationId, receipt: candidate };
  return acceptReceiptEvent(event, deps);
}
