import type { ComponentReceiptV1, PlanStateV1, Sha256 } from "../contracts/types.js";
import { assertComponentReceipt } from "../contracts/validate.js";
import { sha256, type JsonValue } from "../core/canonical.js";
import { isRfc3339, SEMVER, SHA256 } from "../registry/validation.js";

export type StoredPlanState = { state: PlanStateV1; blobSha: string };
export type GitStateStore = {
  read(path: string): Promise<StoredPlanState | null>;
  create(path: string, state: PlanStateV1): Promise<StoredPlanState>;
  compareAndSwap(path: string, previousBlobSha: string, state: PlanStateV1): Promise<StoredPlanState>;
  findActiveByRepository?(repository: string): Promise<readonly StoredPlanState[]>;
  findByOccupancyKey?(key: string): Promise<readonly StoredPlanState[]>;
};

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const OID = /^[0-9a-f]{40}$/u;

export function planDigestHex(planId: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(planId);
  if (!match) throw new TypeError("planId must be a sha256 digest");
  return match[1]!;
}

export function normalizeRepository(repository: string): string {
  if (!REPOSITORY.test(repository) || repository.includes("..") || repository.includes("\\")) {
    throw new TypeError("repository must be a normalized owner/name");
  }
  return repository;
}

export function planStatePath(repository: string, planId: string): string {
  return `plans/${encodeURIComponent(normalizeRepository(repository))}/${planDigestHex(planId)}.json`;
}

export function planStateSha256(state: PlanStateV1): Sha256 {
  return sha256(state as unknown as JsonValue) as Sha256;
}

export function assertPlanState(value: unknown): asserts value is PlanStateV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("state must be an object");
  const state = value as Record<string, unknown>;
  const keys = ["schema", "repository", "planId", "planSha256", "sourceCommit", "releaseCommit", "status", "reason", "evidence", "packages", "receipts", "attempts", "occupancyKeys", "revision", "previousBlobSha", "createdAt", "updatedAt"];
  if (Object.keys(state).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(state, key))) throw new TypeError("state fields mismatch");
  if (state.schema !== "lenso.plan-state.v1") throw new TypeError("state schema mismatch");
  normalizeRepository(String(state.repository));
  planDigestHex(String(state.planId));
  if (!SHA256.test(String(state.planSha256))) throw new TypeError("state planSha256 invalid");
  if (!OID.test(String(state.sourceCommit)) || !OID.test(String(state.releaseCommit)) || state.sourceCommit === state.releaseCommit) throw new TypeError("state commit invalid");
  if (!["ready", "publishing", "blocked", "verified"].includes(String(state.status))) throw new TypeError("state status invalid");
  if (state.reason !== null && typeof state.reason !== "string") throw new TypeError("state reason invalid");
  if (!Number.isSafeInteger(state.revision) || Number(state.revision) < 0) throw new TypeError("state revision invalid");
  if (state.previousBlobSha !== null && !OID.test(String(state.previousBlobSha))) throw new TypeError("state previousBlobSha invalid");
  if (!isRfc3339(String(state.createdAt)) || !isRfc3339(String(state.updatedAt))) throw new TypeError("state timestamp invalid");
  if (String(state.updatedAt) < String(state.createdAt)) throw new TypeError("state timestamps out of order");
  for (const field of ["evidence", "packages", "receipts", "attempts", "occupancyKeys"] as const) if (!Array.isArray(state[field])) throw new TypeError(`state ${field} invalid`);
  const packages = state.packages as Record<string, unknown>[];
  let previous = "";
  for (const item of packages) {
    const key = `${item.id}:${item.version}`;
    if (!/^(?:cargo|npm):/u.test(String(item.id)) || !SEMVER.test(String(item.version)) || key <= previous) throw new TypeError("state packages must be unique and sorted");
    previous = key;
  }
  const receipts = state.receipts as ComponentReceiptV1[];
  for (const receipt of receipts) assertComponentReceipt(receipt);
  if (receipts.some((receipt, index) => index > 0 && `${receipt.packageId}:${receipt.version}` <= `${receipts[index - 1]!.packageId}:${receipts[index - 1]!.version}`)) throw new TypeError("state receipts must be unique and sorted");
  const keysSorted = state.occupancyKeys as string[];
  if (keysSorted.some((key, index) => typeof key !== "string" || (index > 0 && key <= keysSorted[index - 1]!))) throw new TypeError("state occupancy keys must be unique and sorted");
}

export class StateConflictError extends Error {}

export async function mutateState(
  store: GitStateStore,
  path: string,
  mutate: (state: PlanStateV1) => PlanStateV1 | Promise<PlanStateV1>,
  retries = 3,
): Promise<StoredPlanState> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const current = await store.read(path);
    if (!current) throw new Error("plan state not found");
    assertPlanState(current.state);
    const proposed = await mutate(structuredClone(current.state));
    const next = { ...proposed, revision: current.state.revision + 1, previousBlobSha: current.blobSha };
    assertPlanState(next);
    try { return await store.compareAndSwap(path, current.blobSha, next); }
    catch (error) { if (attempt + 1 === retries) throw new StateConflictError("state compare-and-swap conflict", { cause: error }); }
  }
  throw new StateConflictError("state compare-and-swap conflict");
}

export async function cancelPlan(store: GitStateStore, repository: string, planId: string, eventId: Sha256, now: Date): Promise<StoredPlanState> {
  const path = planStatePath(repository, planId);
  return mutateState(store, path, (state) => {
    if (state.receipts.length > 0 || state.packages.some(({ status }) => status === "received") || state.evidence.some(({ kind }) => kind === "registry-upload")) {
      throw new Error("cancellation forbidden after receipt or registry upload evidence");
    }
    const at = now.toISOString();
    return { ...state, status: "blocked", reason: "cancelled before publication", occupancyKeys: [], attempts: [...state.attempts, { eventId, kind: "cancel", at, outcome: "accepted", detail: null }], revision: state.revision + 1, updatedAt: at };
  });
}
