import { assertReleaseEvent, assertReleasePlan } from "../contracts/validate.js";
import { sha256 } from "../core/canonical.js";
export function executionRef(planId) {
    const match = /^sha256:([0-9a-f]{64})$/u.exec(planId);
    if (!match)
        throw new Error("planId must be a SHA-256 digest");
    return `release-execution/${match[1]}`;
}
function legalPackageSubset(actual, plan, context) {
    const keys = actual.map(({ id, version }) => `${id}\0${version}`);
    if (actual.length === 0)
        throw new Error(`${context} package selection mismatch: must not be empty`);
    if (new Set(actual.map(({ id }) => id)).size !== actual.length) {
        throw new Error(`${context} package selection contains duplicates`);
    }
    const expected = new Set(plan.packages.map(({ id, nextVersion }) => `${id}\0${nextVersion}`));
    if (keys.some((key) => !expected.has(key))) {
        throw new Error(`${context} package selection mismatch`);
    }
    const order = new Map(plan.packages.map(({ id }, index) => [id, index]));
    if (actual.some(({ id }, index) => index > 0 && order.get(id) <= order.get(actual[index - 1].id)))
        throw new Error(`${context} package selection mismatch: must preserve plan order`);
    const packages = new Map(plan.packages.map((item) => [item.id, item]));
    const memo = new Map();
    const phase = (id, visiting = new Set()) => {
        const found = memo.get(id);
        if (found !== undefined)
            return found;
        if (visiting.has(id))
            throw new Error(`${context} plan dependency cycle`);
        visiting.add(id);
        const item = packages.get(id);
        if (!item)
            throw new Error(`${context} package selection mismatch`);
        const local = item.dependencies.filter(({ source, id: dependency }) => source === "plan" && packages.has(dependency));
        const result = local.length === 0 ? 0 : 1 + Math.max(...local.map(({ id: dependency }) => phase(dependency, new Set(visiting))));
        memo.set(id, result);
        return result;
    };
    const phases = new Set(actual.map(({ id }) => phase(id)));
    if (phases.size !== 1)
        throw new Error(`${context} package selection crosses dependency phases`);
}
function assertObservedOid(value, name) {
    if (!/^[0-9a-f]{40}$/u.test(value))
        throw new Error(`${name} must be a full lowercase Git OID`);
}
export function verifyPublisherContract(planValue, observed) {
    assertReleasePlan(planValue);
    const plan = planValue;
    assertObservedOid(observed.sourceCommit, "publisher source commit");
    assertObservedOid(observed.releaseCommit, "publisher release commit");
    const checks = [
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
    for (const [actual, expected, message] of checks)
        if (actual !== expected)
            throw new Error(message);
    if (observed.releaseCommit === observed.sourceCommit)
        throw new Error("publisher release commit must be distinct from source commit");
    if (!observed.releaseCommitContainsSourceCommit)
        throw new Error("release commit does not contain source commit");
    legalPackageSubset(observed.packages, plan, "publisher");
}
function expectedPlanUrl(plan, releaseCommit, path) {
    if (path.startsWith("/") || path.includes("..") || path.includes("\\") || path.split("/").some((part) => part === "" || part === ".")) {
        throw new Error("plan path must be normalized");
    }
    return `https://raw.githubusercontent.com/${plan.repository}/${releaseCommit}/${path}`;
}
function assertCanonicalEventId(event) {
    const { eventId, ...identity } = event;
    if (eventId !== sha256(identity))
        throw new Error("eventId must match canonical request payload");
    if (eventId === event.planId)
        throw new Error("eventId must not equal planId");
}
export async function assertPublishRequest(eventValue, planValue, observed, policy) {
    // Task 2 owns structural/schema validation and must remain the first gate.
    assertReleaseEvent(eventValue);
    if (eventValue.eventType !== "lenso-publish-requested")
        throw new Error("event type must be lenso-publish-requested");
    assertReleasePlan(planValue);
    const event = eventValue;
    const plan = planValue;
    assertCanonicalEventId(event);
    assertObservedOid(observed.sourceCommit, "observed source commit");
    assertObservedOid(observed.releaseCommit, "observed release commit");
    if (event.expectedAppId !== policy.expectedAppId || observed.appId !== policy.expectedAppId)
        throw new Error("GitHub App ID mismatch");
    if (observed.actor !== policy.expectedActor)
        throw new Error("GitHub actor mismatch");
    if (event.sourceRepository !== policy.expectedSourceRepository)
        throw new Error("source repository mismatch");
    if (observed.sourceRepository !== policy.expectedSourceRepository)
        throw new Error("observed source repository mismatch");
    if (observed.repository !== plan.repository)
        throw new Error("observed repository mismatch");
    if (event.planId !== plan.planId || event.planSha256 !== observed.planSha256)
        throw new Error("plan digest mismatch");
    if (observed.sourceCommit !== plan.sourceCommit)
        throw new Error("observed source commit mismatch");
    if (observed.sourceCommitRepository !== plan.repository)
        throw new Error("source commit repository mismatch");
    if (observed.releaseCommitRepository !== plan.repository)
        throw new Error("release commit repository mismatch");
    if (!observed.releaseCommitContainsSourceCommit)
        throw new Error("release commit does not contain source commit");
    if (observed.releaseCommit === observed.sourceCommit)
        throw new Error("release commit must be distinct from source commit");
    if (event.releaseCommit !== observed.releaseCommit)
        throw new Error("observed release commit mismatch");
    if (observed.ref !== executionRef(plan.planId))
        throw new Error("observed execution ref mismatch");
    if (observed.workflowPath !== plan.publisher.workflow)
        throw new Error("observed workflow path mismatch");
    if (event.planUrl !== expectedPlanUrl(plan, observed.releaseCommit, policy.planPath))
        throw new Error("plan URL mismatch");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(event.issuedAt)) {
        throw new Error("issuedAt must be canonical RFC 3339 UTC");
    }
    const issuedAt = Date.parse(event.issuedAt);
    const current = policy.now().getTime();
    if (issuedAt < current - policy.maxAgeMs)
        throw new Error("publish request is stale");
    if (issuedAt > current + policy.maxFutureSkewMs)
        throw new Error("publish request is from the future");
    legalPackageSubset(event.packages, plan, "publish request");
    // This is deliberately last. Implementations must use an atomic insert-if-absent.
    if (!await policy.nonceConsumer.consume(event.nonce, event.eventId)) {
        throw new Error("publish request nonce was already consumed");
    }
    return { event, observed, packages: event.packages };
}
