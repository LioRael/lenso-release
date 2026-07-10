import type { EventPackage, ReleasePlanV1 } from "../contracts/types.js";
import type { ObservedPublishRequest, PublishRequestV1, VerifiedPublishRequest } from "../contracts/events.js";
import { assertReleaseEvent, assertReleasePlan } from "../contracts/validate.js";
import { sha256, type JsonValue } from "../core/canonical.js";

export type { ObservedPublishRequest } from "../contracts/events.js";

export type ObservedPublisherEnvironment = {
  repository: string;
  workflowPath: string;
  workflowSha256: string;
  sharedRevision: string;
  sharedBundleSha256: string;
  executionRef: string;
  executionRefTip: string;
  githubSha: string;
  runner: string;
  node: string;
  npm: string;
  rust: string;
  planId: string;
  sourceCommit: string;
  releaseCommit: string;
  sourceCommitRepository: string;
  releaseCommitRepository: string;
  releaseCommitContainsSourceCommit: boolean;
  packages: readonly EventPackage[];
};

/** Must atomically insert (nonce,eventId), returning false when nonce already exists. */
export type NonceConsumer = {
  consume(nonce: string, eventId: string): Promise<boolean>;
};

export type PublishRequestPolicy = {
  expectedAppId: number;
  expectedActor: string;
  expectedSourceRepository: string;
  planPath: string;
  maxAgeMs: number;
  maxFutureSkewMs: number;
  now: () => Date;
  nonceConsumer: NonceConsumer;
};

export function executionRef(planId: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(planId);
  if (!match) throw new Error("planId must be a SHA-256 digest");
  return `release-execution/${match[1]}`;
}

function equalPackages(actual: readonly EventPackage[], expected: readonly EventPackage[], context: string): void {
  const keys = actual.map(({ id, version }) => `${id}\0${version}`);
  if (new Set(actual.map(({ id }) => id)).size !== actual.length) {
    throw new Error(`${context} package selection contains duplicates`);
  }
  const expectedKeys = expected.map(({ id, version }) => `${id}\0${version}`);
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${context} package selection mismatch`);
  }
}

function assertObservedOid(value: string, name: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error(`${name} must be a full lowercase Git OID`);
}

export function verifyPublisherContract(planValue: unknown, observed: ObservedPublisherEnvironment): void {
  assertReleasePlan(planValue);
  const plan = planValue;
  assertObservedOid(observed.sourceCommit, "publisher source commit");
  assertObservedOid(observed.releaseCommit, "publisher release commit");
  const expectedPackages = plan.packages.map(({ id, nextVersion: version }) => ({ id, version }));
  const checks: readonly [unknown, unknown, string][] = [
    [observed.workflowPath, plan.publisher.workflow, "publisher workflow path mismatch"],
    [observed.workflowSha256, plan.publisher.workflowSha256, "publisher workflow digest mismatch"],
    [observed.sharedRevision, plan.publisher.sharedRevision, "shared publisher revision mismatch"],
    [observed.sharedBundleSha256, plan.publisher.sharedBundleSha256, "shared publisher bundle digest mismatch"],
    [observed.executionRef, executionRef(plan.planId), "execution ref mismatch"],
    [observed.executionRefTip, observed.releaseCommit, "execution ref tip mismatch"],
    [observed.githubSha, observed.releaseCommit, "github.sha mismatch"],
    [observed.runner, plan.publisher.runner, "publisher runner mismatch"],
    [observed.node, plan.publisher.node, "publisher Node version mismatch"],
    [observed.npm, plan.publisher.npm, "publisher npm version mismatch"],
    [observed.rust, plan.publisher.rust, "publisher Rust version mismatch"],
    [observed.repository, plan.repository, "publisher repository mismatch"],
    [observed.planId, plan.planId, "publisher planId mismatch"],
    [observed.sourceCommit, plan.sourceCommit, "publisher source commit mismatch"],
    [observed.sourceCommitRepository, plan.repository, "source commit repository mismatch"],
    [observed.releaseCommitRepository, plan.repository, "release commit repository mismatch"],
  ];
  for (const [actual, expected, message] of checks) if (actual !== expected) throw new Error(message);
  if (observed.releaseCommit === observed.sourceCommit) throw new Error("publisher release commit must be distinct from source commit");
  if (!observed.releaseCommitContainsSourceCommit) throw new Error("release commit does not contain source commit");
  equalPackages(observed.packages, expectedPackages, "publisher");
}

function expectedPlanUrl(plan: ReleasePlanV1, releaseCommit: string, path: string): string {
  if (path.startsWith("/") || path.includes("..") || path.includes("\\") || path.split("/").some((part) => part === "" || part === ".")) {
    throw new Error("plan path must be normalized");
  }
  return `https://raw.githubusercontent.com/${plan.repository}/${releaseCommit}/${path}`;
}

function assertCanonicalEventId(event: PublishRequestV1): void {
  const { eventId, ...identity } = event;
  if (eventId !== sha256(identity as JsonValue)) throw new Error("eventId must match canonical request payload");
  if (eventId === event.planId) throw new Error("eventId must not equal planId");
}

export async function assertPublishRequest(
  eventValue: unknown,
  planValue: unknown,
  observed: ObservedPublishRequest,
  policy: PublishRequestPolicy,
): Promise<VerifiedPublishRequest> {
  // Task 2 owns structural/schema validation and must remain the first gate.
  assertReleaseEvent(eventValue);
  if (eventValue.eventType !== "lenso-publish-requested") throw new Error("event type must be lenso-publish-requested");
  assertReleasePlan(planValue);
  const event: PublishRequestV1 = eventValue;
  const plan: ReleasePlanV1 = planValue;

  assertCanonicalEventId(event);
  assertObservedOid(observed.sourceCommit, "observed source commit");
  assertObservedOid(observed.releaseCommit, "observed release commit");
  if (event.expectedAppId !== policy.expectedAppId || observed.appId !== policy.expectedAppId) throw new Error("GitHub App ID mismatch");
  if (observed.actor !== policy.expectedActor) throw new Error("GitHub actor mismatch");
  if (event.sourceRepository !== policy.expectedSourceRepository) throw new Error("source repository mismatch");
  if (observed.sourceRepository !== policy.expectedSourceRepository) throw new Error("observed source repository mismatch");
  if (observed.repository !== plan.repository) throw new Error("observed repository mismatch");
  if (event.planId !== plan.planId || event.planSha256 !== observed.planSha256) throw new Error("plan digest mismatch");
  if (observed.sourceCommit !== plan.sourceCommit) throw new Error("observed source commit mismatch");
  if (observed.sourceCommitRepository !== plan.repository) throw new Error("source commit repository mismatch");
  if (observed.releaseCommitRepository !== plan.repository) throw new Error("release commit repository mismatch");
  if (!observed.releaseCommitContainsSourceCommit) throw new Error("release commit does not contain source commit");
  if (observed.releaseCommit === observed.sourceCommit) throw new Error("release commit must be distinct from source commit");
  if (event.releaseCommit !== observed.releaseCommit) throw new Error("observed release commit mismatch");
  if (observed.ref !== executionRef(plan.planId)) throw new Error("observed execution ref mismatch");
  if (observed.workflowPath !== plan.publisher.workflow) throw new Error("observed workflow path mismatch");
  if (event.planUrl !== expectedPlanUrl(plan, observed.releaseCommit, policy.planPath)) throw new Error("plan URL mismatch");

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(event.issuedAt)) {
    throw new Error("issuedAt must be canonical RFC 3339 UTC");
  }
  const issuedAt = Date.parse(event.issuedAt);
  const current = policy.now().getTime();
  if (issuedAt < current - policy.maxAgeMs) throw new Error("publish request is stale");
  if (issuedAt > current + policy.maxFutureSkewMs) throw new Error("publish request is from the future");

  equalPackages(event.packages, plan.packages.map(({ id, nextVersion: version }) => ({ id, version })), "publish request");

  // This is deliberately last. Implementations must use an atomic insert-if-absent.
  if (!await policy.nonceConsumer.consume(event.nonce, event.eventId)) {
    throw new Error("publish request nonce was already consumed");
  }
  return { event, observed, packages: event.packages };
}
