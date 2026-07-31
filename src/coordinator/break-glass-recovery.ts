import type {
  PlanDispatchOutbox,
  PlanStateV1,
  ReleasePlanV1,
  Sha256,
} from "../contracts/types.js";
import { outboxEntry } from "./dispatch.js";
import {
  assertLegalTransition,
  AUTHORIZED_PRODUCTION_BREAK_GLASS_RECOVERY,
  planStatePath,
  transact,
  type GitStateStore,
  type StoredPlanState,
} from "./state.js";

export type ProductionBreakGlassRecoveryAuthorization = {
  repository: string;
  planId: Sha256;
  plan: ReleasePlanV1;
  defaultBranch: string;
  workflowCommit: string;
  authorizedRunUrl: string;
  authorizedRunSha256: Sha256;
  now: Date;
  nonce: string;
  appId: number;
};

export async function authorizeProductionBreakGlassRecovery(
  store: GitStateStore,
  authorization: ProductionBreakGlassRecoveryAuthorization,
): Promise<StoredPlanState> {
  const path = planStatePath(authorization.repository, authorization.planId);
  let result!: PlanStateV1;
  const committed = await transact(store, (snapshot) => {
    const state = snapshot.plans[path];
    if (!state) throw new Error("plan state not found");
    const existing = state.outbox.find(
      (entry) =>
        entry.recovery?.kind === "production-break-glass" &&
        entry.recovery.authorizedRunUrl === authorization.authorizedRunUrl,
    );
    if (existing) {
      result = state;
      return snapshot;
    }
    if (
      state.environment !== "production" ||
      state.status !== "publishing" ||
      state.reason !== null
    )
      throw new Error("production publishing plan is required");
    if (
      state.receipts.length !== 0 ||
      state.packages.some(({ status }) => status === "received") ||
      state.outbox.some(({ status }) => status !== "dispatched")
    )
      throw new Error("break-glass recovery requires an unreconciled completed publication");
    if (
      authorization.plan.repository !== state.repository ||
      authorization.plan.planId !== state.planId ||
      authorization.plan.packages.length !== state.packages.length ||
      authorization.plan.packages.some((item) =>
        !state.packages.some(
          ({ id, version }) => id === item.id && version === item.nextVersion,
        )
      )
    )
      throw new Error("break-glass recovery plan binding mismatch");
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/u.test(
        authorization.defaultBranch,
      ) ||
      authorization.defaultBranch.includes("..") ||
      !/^[0-9a-f]{40}$/u.test(authorization.workflowCommit)
    )
      throw new TypeError("break-glass recovery workflow ref invalid");

    const at = authorization.now.toISOString();
    const entry: PlanDispatchOutbox = {
      ...outboxEntry(
        authorization.plan,
        state.planSha256,
        state.releaseCommit,
        state.packages,
        at,
        authorization.nonce,
        authorization.appId,
      ),
      ref: authorization.defaultBranch,
      recovery: {
        kind: "production-break-glass",
        authorizedRunUrl: authorization.authorizedRunUrl,
        authorizedRunSha256: authorization.authorizedRunSha256,
        workflowCommit: authorization.workflowCommit,
      },
    };
    const packages = state.packages.map((item) => ({
      ...item,
      status: "dispatched" as const,
      requestEventId: entry.eventId,
    }));
    result = {
      ...state,
      packages,
      evidence: [
        ...state.evidence,
        {
          kind: "production-break-glass-recovery",
          url: authorization.authorizedRunUrl,
          digest: authorization.authorizedRunSha256,
        },
      ],
      attempts: [
        ...state.attempts,
        {
          eventId: entry.eventId,
          kind: "recovery",
          at,
          outcome: "accepted",
          detail: AUTHORIZED_PRODUCTION_BREAK_GLASS_RECOVERY,
        },
      ],
      outbox: [...state.outbox, entry].sort((left, right) =>
        left.eventId.localeCompare(right.eventId)
      ),
      revision: state.revision + 1,
      updatedAt: at,
    };
    assertLegalTransition(state, result);
    snapshot.plans[path] = result;
    return snapshot;
  });
  return { state: result, headSha: committed.headSha };
}
