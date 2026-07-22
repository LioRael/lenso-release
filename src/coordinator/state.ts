import type {
  ComponentReceiptV1,
  PlanDispatchOutbox,
  PlanStateV1,
  Sha256,
} from "../contracts/types.js";
import { assertComponentReceipt } from "../contracts/validate.js";
import { sha256, type JsonValue } from "../core/canonical.js";
import { isRfc3339, SEMVER, SHA256 } from "../registry/validation.js";

export type ReleaseStateSnapshot = {
  headSha: string;
  plans: Record<string, PlanStateV1>;
  activeRepositories: Record<string, string>;
  occupiedPackages: Record<string, string>;
};
export type GitStateStore = {
  readSnapshot(): Promise<ReleaseStateSnapshot>;
  compareAndSwap(
    expectedHeadSha: string,
    next: ReleaseStateSnapshot,
  ): Promise<ReleaseStateSnapshot>;
};
export type StoredPlanState = { state: PlanStateV1; headSha: string };
export class StateConflictError extends Error {}

const RETIRED_FAILED_SHADOW_PLAN = "retired failed shadow dispatch";

export function isRetiredPlan(state: PlanStateV1): boolean {
  return state.status === "blocked" && (
    state.reason?.startsWith("cancelled before dispatch") === true ||
    state.reason === RETIRED_FAILED_SHADOW_PLAN
  );
}

const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const OID = /^[0-9a-f]{40}$/u;
const PACKAGE_KEY = /^package:(?:cargo|npm|artifact):[^:]+:.+$/u;

export function planDigestHex(planId: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(planId);
  if (!match) throw new TypeError("planId must be a sha256 digest");
  return match[1]!;
}
export function normalizeRepository(repository: string): string {
  if (
    !REPOSITORY.test(repository) ||
    repository.includes("..") ||
    repository.includes("\\")
  )
    throw new TypeError("repository must be a normalized owner/name");
  return repository;
}
export function planStatePath(repository: string, planId: string): string {
  return `plans/${encodeURIComponent(normalizeRepository(repository))}/${planDigestHex(planId)}.json`;
}
export function planStateSha256(state: PlanStateV1): Sha256 {
  return sha256(state as unknown as JsonValue) as Sha256;
}

export function assertReleaseStateSnapshot(
  value: ReleaseStateSnapshot,
): void {
  if (!OID.test(value.headSha)) throw new TypeError("snapshot head invalid");
  const active: Record<string, string> = {};
  const occupied: Record<string, string> = {};
  for (const [path, state] of Object.entries(value.plans)) {
    assertPlanState(state);
    if (path !== planStatePath(state.repository, state.planId))
      throw new TypeError("snapshot plan path mismatch");
    if (state.status !== "verified" && !isRetiredPlan(state)) {
      if (active[state.repository])
        throw new TypeError("snapshot contains multiple active repository plans");
      active[state.repository] = state.planId;
    }
    for (const key of state.occupancyKeys)
      if (key.startsWith("package:")) {
        if (occupied[key])
          throw new TypeError("snapshot contains duplicate package occupancy");
        occupied[key] = state.planId;
      }
  }
  if (
    JSON.stringify(Object.fromEntries(Object.entries(value.activeRepositories).sort())) !==
      JSON.stringify(Object.fromEntries(Object.entries(active).sort())) ||
    JSON.stringify(Object.fromEntries(Object.entries(value.occupiedPackages).sort())) !==
      JSON.stringify(Object.fromEntries(Object.entries(occupied).sort()))
  )
    throw new TypeError("snapshot occupancy index mismatch");
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  )
    throw new TypeError(`${path} fields mismatch`);
}
function sortedUnique(values: readonly string[], path: string): void {
  if (
    values.some(
      (value, index) =>
        typeof value !== "string" || (index > 0 && value <= values[index - 1]!),
    )
  )
    throw new TypeError(`${path} must be sorted and unique`);
}

export function assertPlanState(value: unknown): asserts value is PlanStateV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("state must be an object");
  const state = value as Record<string, unknown>;
  exactKeys(
    state,
    [
      "schema",
      "repository",
      "planId",
      "planSha256",
      "sourceCommit",
      "releaseCommit",
      "status",
      "reason",
      "evidence",
      "packages",
      "receipts",
      "attempts",
      "outbox",
      "occupancyKeys",
      "executionRef",
      "revision",
      "previousBlobSha",
      "createdAt",
      "updatedAt",
    ],
    "state",
  );
  if (state.schema !== "lenso.plan-state.v1")
    throw new TypeError("state schema mismatch");
  normalizeRepository(String(state.repository));
  planDigestHex(String(state.planId));
  if (!SHA256.test(String(state.planSha256)))
    throw new TypeError("state plan digest invalid");
  if (
    !OID.test(String(state.sourceCommit)) ||
    !OID.test(String(state.releaseCommit)) ||
    state.sourceCommit === state.releaseCommit
  )
    throw new TypeError("state commit invalid");
  if (
    !["ready", "publishing", "blocked", "verified"].includes(
      String(state.status),
    )
  )
    throw new TypeError("state status invalid");
  if (
    (state.status === "blocked") !==
    (typeof state.reason === "string" && state.reason.length > 0)
  )
    throw new TypeError(
      "blocked state requires reason and only blocked may have reason",
    );
  if (
    !Number.isSafeInteger(state.revision) ||
    Number(state.revision) < 0 ||
    (state.previousBlobSha !== null && !OID.test(String(state.previousBlobSha)))
  )
    throw new TypeError("state revision invalid");
  if (
    !isRfc3339(String(state.createdAt)) ||
    !isRfc3339(String(state.updatedAt)) ||
    String(state.updatedAt) < String(state.createdAt)
  )
    throw new TypeError("state timestamp invalid");
  for (const field of [
    "evidence",
    "packages",
    "receipts",
    "attempts",
    "outbox",
    "occupancyKeys",
  ] as const)
    if (!Array.isArray(state[field]))
      throw new TypeError(`state ${field} invalid`);
  for (const item of state.evidence as Record<string, unknown>[]) {
    if (!item || typeof item !== "object")
      throw new TypeError("state evidence invalid");
    exactKeys(item, ["kind", "url", "digest"], "evidence");
    if (
      typeof item.kind !== "string" ||
      item.kind.length === 0 ||
      (item.url !== null && typeof item.url !== "string") ||
      (item.digest !== null && typeof item.digest !== "string")
    )
      throw new TypeError("state evidence invalid");
  }
  for (const item of state.attempts as Record<string, unknown>[]) {
    if (!item || typeof item !== "object")
      throw new TypeError("state attempt invalid");
    exactKeys(item, ["eventId", "kind", "at", "outcome", "detail"], "attempt");
    if (
      !SHA256.test(String(item.eventId)) ||
      !["ready", "dispatch", "receipt", "recovery", "cancel"].includes(String(item.kind)) ||
      !isRfc3339(String(item.at)) ||
      !["accepted", "duplicate", "conflict", "blocked"].includes(String(item.outcome)) ||
      (item.detail !== null && typeof item.detail !== "string")
    )
      throw new TypeError("state attempt invalid");
  }
  const ref = state.executionRef as Record<string, unknown>;
  if (!ref || typeof ref !== "object")
    throw new TypeError("execution ref invalid");
  exactKeys(ref, ["name", "tip", "protected"], "executionRef");
  if (
    ref.name !== `release-execution/${planDigestHex(String(state.planId))}` ||
    ref.tip !== state.releaseCommit ||
    ref.protected !== true
  )
    throw new TypeError("execution ref binding invalid");
  const packages = state.packages as Record<string, unknown>[];
  const packageKeys: string[] = [];
  for (const item of packages) {
    exactKeys(
      item,
      ["id", "version", "phase", "status", "requestEventId"],
      "package",
    );
    const key = `${item.id}:${item.version}`;
    if (
      !/^(?:cargo|npm|artifact):/u.test(String(item.id)) ||
      !SEMVER.test(String(item.version)) ||
      !Number.isSafeInteger(item.phase) ||
      Number(item.phase) < 0 ||
      !["pending", "dispatched", "received"].includes(String(item.status))
    )
      throw new TypeError("package invalid");
    if (
      (item.status === "pending") !== (item.requestEventId === null) ||
      (item.status !== "pending" && !SHA256.test(String(item.requestEventId)))
    )
      throw new TypeError("package request binding invalid");
    packageKeys.push(key);
  }
  sortedUnique(packageKeys, "packages");
  const receipts = state.receipts as ComponentReceiptV1[];
  for (const receipt of receipts) assertComponentReceipt(receipt);
  sortedUnique(
    receipts.map((r) => `${r.packageId}:${r.version}`),
    "receipts",
  );
  for (const receipt of receipts) {
    const item = packages.find(
      (p) => p.id === receipt.packageId && p.version === receipt.version,
    );
    if (
      !item ||
      item.status !== "received" ||
      receipt.planId !== state.planId ||
      receipt.repository !== state.repository ||
      receipt.sourceCommit !== state.releaseCommit
    )
      throw new TypeError("receipt does not bind received package");
  }
  const outbox = state.outbox as PlanDispatchOutbox[];
  sortedUnique(
    outbox.map((entry) => entry.eventId),
    "outbox",
  );
  for (const entry of outbox) {
    exactKeys(entry as unknown as Record<string, unknown>, [
      "eventId", "nonce", "ref", "workflow", "packages", "inputs", "status",
      "claimOwner", "leaseExpiresAt", "runUrl", "createdAt", "updatedAt",
    ], "outbox");
    if (
      !SHA256.test(entry.eventId) ||
      !isRfc3339(entry.createdAt) ||
      !isRfc3339(entry.updatedAt) ||
      !["pending", "in-flight", "dispatched", "cancelled"].includes(entry.status) ||
      entry.ref !== ref.name ||
      typeof entry.nonce !== "string" ||
      entry.nonce.length === 0 ||
      typeof entry.workflow !== "string" ||
      entry.workflow.length === 0 ||
      !Array.isArray(entry.packages) ||
      Object.keys(entry.inputs).sort().join(",") !==
        "event_id,nonce,packages_json,plan_id,plan_sha256,release_commit"
    )
      throw new TypeError("outbox invalid");
    const expectedPackages = packages
      .filter((item) => item.requestEventId === entry.eventId)
      .map(({ id, version }) => ({ id, version }));
    const canonicalSelection = (
      selection: readonly { id: unknown; version: unknown }[],
    ) => selection.map(({ id, version }) => ({
      id: String(id),
      version: String(version),
    })).sort((a, b) => {
      const left = `${a.id}:${a.version}`;
      const right = `${b.id}:${b.version}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (
      JSON.stringify(canonicalSelection(entry.packages)) !==
        JSON.stringify(canonicalSelection(expectedPackages)) ||
      entry.inputs.plan_id !== state.planId ||
      entry.inputs.plan_sha256 !== state.planSha256 ||
      entry.inputs.release_commit !== state.releaseCommit ||
      entry.inputs.event_id !== entry.eventId ||
      entry.inputs.nonce !== entry.nonce ||
      entry.inputs.packages_json !== JSON.stringify(entry.packages)
    )
      throw new TypeError("outbox plan binding invalid");
    if ((entry.status === "dispatched") !== (typeof entry.runUrl === "string"))
      throw new TypeError("outbox run binding invalid");
    if (
      (entry.status === "in-flight") !==
        (typeof entry.claimOwner === "string" && entry.claimOwner.length > 0) ||
      (entry.status === "in-flight") !==
        (typeof entry.leaseExpiresAt === "string" && isRfc3339(entry.leaseExpiresAt))
    )
      throw new TypeError("outbox lease binding invalid");
  }
  const occupancy = state.occupancyKeys as string[];
  sortedUnique(occupancy, "occupancy");
  if (
    occupancy.some(
      (key) =>
        !PACKAGE_KEY.test(key) &&
        key !== `plan:${state.repository}:${state.planId}`,
    )
  )
    throw new TypeError("occupancy key invalid");
  const expectedPackageLocks = packages
    .filter((p) => p.status !== "received")
    .map((p) => `package:${p.id}:${p.version}`);
  const expected =
    state.status === "verified" || isRetiredPlan(state as unknown as PlanStateV1)
      ? []
      : [
          `plan:${state.repository}:${state.planId}`,
          ...expectedPackageLocks,
        ].sort();
  if (JSON.stringify(occupancy) !== JSON.stringify(expected))
    throw new TypeError("occupancy incomplete");
  if (
    state.status === "verified" &&
    (receipts.length !== packages.length ||
      outbox.some((entry) => entry.status !== "dispatched"))
  )
    throw new TypeError("verified state incomplete");
}

export function assertLegalTransition(
  previous: PlanStateV1,
  next: PlanStateV1,
): void {
  assertPlanState(previous);
  assertPlanState(next);
  for (const field of [
    "repository",
    "planId",
    "planSha256",
    "sourceCommit",
    "releaseCommit",
    "createdAt",
  ] as const)
    if (previous[field] !== next[field])
      throw new TypeError(`immutable ${field} rewrite`);
  if (
    JSON.stringify(
      previous.packages.map(({ id, version, phase }) => ({
        id,
        version,
        phase,
      })),
    ) !==
    JSON.stringify(
      next.packages.map(({ id, version, phase }) => ({ id, version, phase })),
    )
  )
    throw new TypeError("immutable package plan rewrite");
  if (previous.status === "verified" && next.status !== "verified")
    throw new TypeError("verified is terminal");
  if (previous.status === "verified" && JSON.stringify(previous) !== JSON.stringify(next))
    throw new TypeError("verified state is immutable");
  if (
    isRetiredPlan(previous) &&
    JSON.stringify(previous) !== JSON.stringify(next)
  )
    throw new TypeError("retired state is immutable");
  const statusRank = { pending: 0, dispatched: 1, received: 2 } as const;
  for (let index = 0; index < previous.packages.length; index += 1) {
    const before = previous.packages[index]!;
    const after = next.packages[index]!;
    if (statusRank[after.status] < statusRank[before.status])
      throw new TypeError("package status regression");
    if (before.requestEventId !== null && before.requestEventId !== after.requestEventId)
      throw new TypeError("immutable package request rewrite");
  }
  if (
    JSON.stringify(next.receipts.slice(0, previous.receipts.length)) !==
      JSON.stringify(previous.receipts) ||
    JSON.stringify(next.attempts.slice(0, previous.attempts.length)) !==
      JSON.stringify(previous.attempts) ||
    JSON.stringify(next.evidence.slice(0, previous.evidence.length)) !==
      JSON.stringify(previous.evidence)
  )
    throw new TypeError("append-only state history rewrite");
  for (const before of previous.outbox) {
    const after = next.outbox.find(({ eventId }) => eventId === before.eventId);
    if (!after) throw new TypeError("outbox deletion");
    const allowed =
      before.status === after.status ||
      (before.status === "pending" && ["in-flight", "cancelled"].includes(after.status)) ||
      (before.status === "in-flight" && after.status === "dispatched") ||
      (before.status === "in-flight" && after.status === "in-flight");
    if (!allowed) throw new TypeError("illegal outbox transition");
    for (const field of ["eventId", "nonce", "ref", "workflow", "createdAt"] as const)
      if (before[field] !== after[field])
        throw new TypeError(`immutable outbox ${field} rewrite`);
    if (
      JSON.stringify(before.packages) !== JSON.stringify(after.packages) ||
      JSON.stringify(before.inputs) !== JSON.stringify(after.inputs)
    )
      throw new TypeError("immutable outbox payload rewrite");
  }
  const legal =
    previous.status === next.status ||
    (previous.status === "ready" &&
      ["publishing", "blocked"].includes(next.status)) ||
    (previous.status === "publishing" &&
      ["verified", "blocked"].includes(next.status)) ||
    (previous.status === "blocked" &&
      next.status === "publishing" &&
      next.evidence.some(({ kind }) => kind === "recovery"));
  if (!legal)
    throw new TypeError(
      `illegal state transition ${previous.status}->${next.status}`,
    );
}

export async function transact(
  store: GitStateStore,
  change: (
    snapshot: ReleaseStateSnapshot,
  ) => ReleaseStateSnapshot | Promise<ReleaseStateSnapshot>,
  retries = 3,
): Promise<ReleaseStateSnapshot> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const current = await store.readSnapshot();
    assertReleaseStateSnapshot(current);
    const next = await change(structuredClone(current));
    assertReleaseStateSnapshot(next);
    try {
      return await store.compareAndSwap(current.headSha, next);
    } catch (error) {
      if (!(error instanceof StateConflictError)) throw error;
      if (attempt + 1 === retries)
        throw new StateConflictError("release-state head conflict", {
          cause: error,
        });
    }
  }
  throw new StateConflictError("release-state head conflict");
}

export async function cancelPlan(
  store: GitStateStore,
  repository: string,
  planId: string,
  eventId: Sha256,
  now: Date,
): Promise<StoredPlanState> {
  let result!: PlanStateV1;
  const snapshot = await transact(store, (current) => {
    const path = planStatePath(repository, planId);
    const state = current.plans[path];
    if (!state) throw new Error("plan state not found");
    if (state.outbox.some(({ status }) => status !== "pending"))
      throw new Error("cancellation forbidden after dispatch begins");
    const at = now.toISOString();
    result = {
      ...state,
      status: "blocked",
      reason: "cancelled before dispatch",
      occupancyKeys: [],
      outbox: state.outbox.map((entry) => ({
        ...entry,
        status: "cancelled" as const,
        claimOwner: null,
        leaseExpiresAt: null,
        updatedAt: at,
      })),
      attempts: [
        ...state.attempts,
        { eventId, kind: "cancel", at, outcome: "accepted", detail: null },
      ],
      revision: state.revision + 1,
      updatedAt: at,
    };
    assertLegalTransition(state, result);
    delete current.activeRepositories[repository];
    for (const [key, owner] of Object.entries(current.occupiedPackages))
      if (owner === planId) delete current.occupiedPackages[key];
    current.plans[path] = result;
    return current;
  });
  return { state: snapshot.plans[planStatePath(repository, planId)]!, headSha: snapshot.headSha };
}

export type FailedShadowRetirementFacts = {
  observeRun(entry: PlanDispatchOutbox): Promise<{
    runUrl: string;
    status: string;
    conclusion: string | null;
  } | null>;
  packageVersionExists(id: string, version: string): Promise<boolean>;
};

export async function retireFailedShadowPlan(
  store: GitStateStore,
  repository: string,
  planId: string,
  eventId: Sha256,
  mode: string | undefined,
  facts: FailedShadowRetirementFacts,
  now: Date,
): Promise<StoredPlanState> {
  if (mode !== "shadow")
    throw new Error("failed plan retirement is restricted to shadow mode");
  const initial = await store.readSnapshot();
  assertReleaseStateSnapshot(initial);
  const path = planStatePath(repository, planId);
  const state = initial.plans[path];
  if (!state) throw new Error("plan state not found");
  if (!(["publishing", "blocked"] as const).includes(state.status as "publishing" | "blocked"))
    throw new Error("plan is not eligible for failed dispatch retirement");
  if (state.receipts.length !== 0)
    throw new Error("failed dispatch retirement requires zero receipts");
  if (state.outbox.some(({ status }) => status === "in-flight"))
    throw new Error("failed dispatch retirement forbids in-flight dispatches");
  const dispatched = state.outbox.filter(({ status }) => status === "dispatched");
  if (dispatched.length === 0)
    throw new Error("failed dispatch retirement requires a dispatched workflow");
  for (const entry of dispatched) {
    const run = await facts.observeRun(entry);
    if (
      !run || run.runUrl !== entry.runUrl || run.status !== "completed" ||
      !["failure", "cancelled"].includes(run.conclusion ?? "")
    ) throw new Error("dispatched workflow is not conclusively failed");
  }
  for (const pkg of state.packages)
    if (await facts.packageVersionExists(pkg.id, pkg.version))
      throw new Error(`package version already exists: ${pkg.id}@${pkg.version}`);

  let result!: PlanStateV1;
  const snapshot = await transact(store, (current) => {
    const currentState = current.plans[path];
    if (!currentState || currentState.revision !== state.revision)
      throw new StateConflictError("plan changed while retirement facts were observed");
    const at = now.toISOString();
    result = {
      ...currentState,
      status: "blocked",
      reason: RETIRED_FAILED_SHADOW_PLAN,
      occupancyKeys: [],
      outbox: currentState.outbox.map((entry) => entry.status === "pending" ? {
        ...entry,
        status: "cancelled" as const,
        claimOwner: null,
        leaseExpiresAt: null,
        updatedAt: at,
      } : entry),
      attempts: [...currentState.attempts, {
        eventId,
        kind: "cancel" as const,
        at,
        outcome: "accepted" as const,
        detail: RETIRED_FAILED_SHADOW_PLAN,
      }],
      revision: currentState.revision + 1,
      updatedAt: at,
    };
    assertLegalTransition(currentState, result);
    delete current.activeRepositories[repository];
    for (const [key, owner] of Object.entries(current.occupiedPackages))
      if (owner === planId) delete current.occupiedPackages[key];
    current.plans[path] = result;
    return current;
  });
  return { state: snapshot.plans[path]!, headSha: snapshot.headSha };
}
