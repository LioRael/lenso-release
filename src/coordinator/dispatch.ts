import type { PlanStatePackage, ReleaseEventV1, ReleasePlanV1, Sha256 } from "../contracts/types.js";
import { sha256, type JsonValue } from "../core/canonical.js";
import { executionRef } from "../publisher/contract.js";

export const PUBLISH_INPUT_FIELDS = ["event", "plan_id", "plan_sha256", "release_commit", "packages", "source_repository"] as const;
export type DispatchCommand = { repository: string; workflow: string; ref: string; inputs: Record<(typeof PUBLISH_INPUT_FIELDS)[number], string> };
export type WorkflowDispatcher = { dispatch(command: DispatchCommand): Promise<void> };

export function newlyReadyPackages(packages: readonly PlanStatePackage[]): PlanStatePackage[] {
  const pending = packages.filter((item) => item.status === "pending");
  if (pending.length === 0) return [];
  const phase = Math.min(...pending.map(({ phase }) => phase));
  if (packages.some((item) => item.phase < phase && item.status !== "received")) return [];
  return pending.filter((item) => item.phase === phase).sort((a, b) => a.id.localeCompare(b.id));
}

export function publishRequest(plan: ReleasePlanV1, planSha256: Sha256, releaseCommit: string, packages: readonly PlanStatePackage[], issuedAt: string, nonce: string, appId: number): Extract<ReleaseEventV1, { eventType: "lenso-publish-requested" }> {
  const identity = { schema: "lenso.release-event.v1" as const, eventType: "lenso-publish-requested" as const, issuedAt, nonce, sourceRepository: "LioRael/lenso-release", expectedAppId: appId, planId: plan.planId, planUrl: `https://raw.githubusercontent.com/${plan.repository}/${releaseCommit}/.lenso/release-plan.json`, planSha256, releaseCommit, packages: packages.map(({ id, version }) => ({ id, version })) };
  return { eventId: sha256(identity as JsonValue) as Sha256, ...identity };
}

export function dispatchCommand(plan: ReleasePlanV1, event: Extract<ReleaseEventV1, { eventType: "lenso-publish-requested" }>): DispatchCommand {
  return { repository: plan.repository, workflow: plan.publisher.workflow, ref: executionRef(plan.planId), inputs: { event: JSON.stringify(event), plan_id: plan.planId, plan_sha256: event.planSha256, release_commit: event.releaseCommit, packages: JSON.stringify(event.packages), source_repository: event.sourceRepository } };
}
