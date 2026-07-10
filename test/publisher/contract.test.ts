import { describe, expect, it, vi } from "vitest";

import type { ReleaseEventV1, ReleasePlanV1 } from "../../src/contracts/types.js";
import { sha256, type JsonValue } from "../../src/core/canonical.js";
import {
  assertPublishRequest,
  executionRef,
  verifyPublisherContract,
  type NonceConsumer,
  type ObservedPublishRequest,
  type ObservedPublisherEnvironment,
} from "../../src/publisher/contract.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const oid = (character: string) => character.repeat(40);
const now = new Date("2026-07-11T12:00:00.000Z");
const releaseCommit = oid("4");

const planIdentity = {
  schema: "lenso.release-plan.v1" as const,
  repository: "LioRael/lenso",
  sourceCommit: oid("1"),
  tegamiVersion: "1.2.5" as const,
  publisher: {
    workflow: ".github/workflows/publish.yml",
    workflowSha256: digest("b"),
    sharedRevision: oid("2"),
    sharedBundleSha256: digest("c"),
    runner: "ubuntu-24.04",
    node: "24.0.0",
    npm: "11.7.0",
    rust: "1.94.0",
  },
  generatedFiles: [{ path: ".lenso-release/plan.json", sha256: digest("9") }],
  packages: [{
    id: "cargo:lenso-contracts", previousVersion: "0.3.4", nextVersion: "0.3.5",
    bump: "patch" as const, releaseGroup: "foundation", userFacing: true, dependencies: [],
  }],
};
const plan: ReleasePlanV1 = { ...planIdentity, planId: sha256(planIdentity as JsonValue) as ReleasePlanV1["planId"] };

const environment = (change: Partial<ObservedPublisherEnvironment> = {}): ObservedPublisherEnvironment => ({
  repository: plan.repository,
  workflowPath: plan.publisher.workflow,
  workflowSha256: plan.publisher.workflowSha256,
  sharedRevision: plan.publisher.sharedRevision,
  sharedBundleSha256: plan.publisher.sharedBundleSha256,
  executionRef: executionRef(plan.planId),
  executionRefTip: releaseCommit,
  githubSha: releaseCommit,
  runner: plan.publisher.runner,
  node: plan.publisher.node,
  npm: plan.publisher.npm,
  rust: plan.publisher.rust,
  planId: plan.planId,
  sourceCommit: plan.sourceCommit,
  releaseCommit,
  sourceCommitRepository: plan.repository,
  releaseCommitRepository: plan.repository,
  releaseCommitContainsSourceCommit: true,
  packages: plan.packages.map(({ id, nextVersion: version }) => ({ id, version })),
  ...change,
});

function request(change: Partial<ReleaseEventV1> = {}): ReleaseEventV1 {
  const identity = {
    schema: "lenso.release-event.v1" as const,
    eventType: "lenso-publish-requested" as const,
    issuedAt: "2026-07-11T11:59:30.000Z",
    nonce: "nonce-0123456789abcdef",
    sourceRepository: "LioRael/lenso-release",
    expectedAppId: 12345,
    planId: plan.planId,
    planUrl: `https://raw.githubusercontent.com/${plan.repository}/${releaseCommit}/.lenso-release/plan.json`,
    planSha256: plan.planId,
    releaseCommit,
    packages: plan.packages.map(({ id, nextVersion: version }) => ({ id, version })),
  };
  const { eventId, ...identityChange } = change as Partial<ReleaseEventV1> & { eventId?: ReleaseEventV1["eventId"] };
  const changed = { ...identity, ...identityChange };
  return { ...changed, eventId: eventId ?? sha256(changed as JsonValue) } as ReleaseEventV1;
}

const observedRequest = (change: Partial<ObservedPublishRequest> = {}): ObservedPublishRequest => ({
  actor: "lenso-release[bot]",
  appId: 12345,
  repository: plan.repository,
  sourceRepository: "LioRael/lenso-release",
  sourceCommit: plan.sourceCommit,
  releaseCommit,
  sourceCommitRepository: plan.repository,
  releaseCommitRepository: plan.repository,
  releaseCommitContainsSourceCommit: true,
  planSha256: plan.planId,
  ref: executionRef(plan.planId),
  workflowPath: plan.publisher.workflow,
  ...change,
});

function consumer(result = true): NonceConsumer {
  return { consume: vi.fn(async () => result) };
}

describe("publisher execution contract", () => {
  it("creates a valid immutable execution branch and rejects non-exact digests", () => {
    expect(executionRef(`sha256:${"a".repeat(64)}`)).toBe(`release-execution/${"a".repeat(64)}`);
    for (const invalid of [`sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, `sha256:${"a".repeat(65)}`, `${"a".repeat(64)}`]) {
      expect(() => executionRef(invalid)).toThrow("planId must be a SHA-256 digest");
    }
  });

  it.each([
    ["workflowPath", ".github/workflows/other.yml", "publisher workflow path mismatch"],
    ["workflowSha256", digest("d"), "publisher workflow digest mismatch"],
    ["sharedRevision", oid("3"), "shared publisher revision mismatch"],
    ["sharedBundleSha256", digest("d"), "shared publisher bundle digest mismatch"],
    ["executionRef", "release-execution/wrong", "execution ref mismatch"],
    ["executionRefTip", oid("3"), "execution ref tip mismatch"],
    ["githubSha", oid("3"), "github.sha mismatch"],
    ["runner", "ubuntu-22.04", "publisher runner mismatch"],
    ["node", "24.1.0", "publisher Node version mismatch"],
    ["npm", "11.6.0", "publisher npm version mismatch"],
    ["rust", "1.93.0", "publisher Rust version mismatch"],
    ["repository", "attacker/lenso", "publisher repository mismatch"],
    ["planId", digest("d"), "publisher planId mismatch"],
    ["sourceCommit", oid("3"), "publisher source commit mismatch"],
    ["releaseCommit", "A".repeat(40), "publisher release commit must be a full lowercase Git OID"],
    ["releaseCommit", oid("3"), "execution ref tip mismatch"],
    ["sourceCommitRepository", "attacker/lenso", "source commit repository mismatch"],
    ["releaseCommitRepository", "attacker/lenso", "release commit repository mismatch"],
    ["releaseCommitContainsSourceCommit", false, "release commit does not contain source commit"],
  ] as const)("fails closed for %s", (key, value, message) => {
    expect(() => verifyPublisherContract(plan, environment({ [key]: value }))).toThrow(message);
  });

  it("requires exact unambiguous package selection", () => {
    expect(() => verifyPublisherContract(plan, environment({ packages: [] }))).toThrow("publisher package selection mismatch");
    expect(() => verifyPublisherContract(plan, environment({ packages: [environment().packages[0]!, environment().packages[0]!] }))).toThrow("publisher package selection contains duplicates");
    expect(() => verifyPublisherContract(plan, environment())).not.toThrow();
  });

  it("keeps pre-version source and post-merge release identities separate", () => {
    expect(plan.sourceCommit).not.toBe(releaseCommit);
    expect(() => verifyPublisherContract(plan, environment({ executionRefTip: plan.sourceCommit }))).toThrow("execution ref tip mismatch");
    expect(() => verifyPublisherContract(plan, environment({ githubSha: plan.sourceCommit }))).toThrow("github.sha mismatch");
    expect(() => verifyPublisherContract(plan, environment({
      releaseCommit: plan.sourceCommit,
      executionRefTip: plan.sourceCommit,
      githubSha: plan.sourceCommit,
    }))).toThrow("publisher release commit must be distinct from source commit");
  });
});

describe("publish request authentication", () => {
  const verify = (event: unknown, replay = consumer(), observed = observedRequest()) =>
    assertPublishRequest(event, plan, observed, {
      expectedAppId: 12345,
      expectedActor: "lenso-release[bot]",
      expectedSourceRepository: "LioRael/lenso-release",
      planPath: ".lenso-release/plan.json",
      maxAgeMs: 5 * 60_000,
      maxFutureSkewMs: 30_000,
      now: () => now,
      nonceConsumer: replay,
    });

  it("accepts a fully verified request and atomically consumes its nonce last", async () => {
    const replay = consumer();
    await expect(verify(request(), replay)).resolves.toMatchObject({
      event: { eventType: "lenso-publish-requested", planId: plan.planId },
      observed: { repository: plan.repository },
      packages: [{ id: "cargo:lenso-contracts", version: "0.3.5" }],
    });
    expect(replay.consume).toHaveBeenCalledWith("nonce-0123456789abcdef", expect.any(String));
  });

  it("uses the base event validator before request-specific validation", async () => {
    await expect(verify({ ...request(), unexpected: true })).rejects.toThrow("releaseEvent.unexpected is not allowed");
    const { packages: _packages, eventId: _eventId, ...readyIdentity } = request() as Extract<ReleaseEventV1, { eventType: "lenso-publish-requested" }>;
    const ready = { ...readyIdentity, eventType: "lenso-plan-ready" as const };
    await expect(verify({ ...ready, eventId: sha256(ready as JsonValue) })).rejects.toThrow("must be lenso-publish-requested");
  });

  it.each([
    ["wrong requested App", { expectedAppId: 999 }, {}, "GitHub App ID mismatch"],
    ["wrong App", {}, { appId: 999 }, "GitHub App ID mismatch"],
    ["wrong actor", {}, { actor: "someone" }, "GitHub actor mismatch"],
    ["wrong requested source repository", { sourceRepository: "attacker/release" }, {}, "source repository mismatch"],
    ["wrong repository", {}, { repository: "attacker/lenso" }, "observed repository mismatch"],
    ["wrong source repository", {}, { sourceRepository: "attacker/release" }, "observed source repository mismatch"],
    ["wrong commit", {}, { releaseCommit: oid("3") }, "observed release commit mismatch"],
    ["wrong requested commit", { releaseCommit: oid("3") }, {}, "observed release commit mismatch"],
    ["source/release cross-wire", { releaseCommit: plan.sourceCommit }, {}, "observed release commit mismatch"],
    ["wrong observed source commit", {}, { sourceCommit: releaseCommit }, "observed source commit mismatch"],
    ["wrong source owner", {}, { sourceCommitRepository: "attacker/lenso" }, "source commit repository mismatch"],
    ["wrong release owner", {}, { releaseCommitRepository: "attacker/lenso" }, "release commit repository mismatch"],
    ["missing ancestry", {}, { releaseCommitContainsSourceCommit: false }, "release commit does not contain source commit"],
    ["wrong ref", {}, { ref: "main" }, "observed execution ref mismatch"],
    ["wrong workflow", {}, { workflowPath: ".github/workflows/evil.yml" }, "observed workflow path mismatch"],
    ["URL host", { planUrl: `https://example.com/${plan.repository}/${plan.sourceCommit}/.lenso-release/plan.json` }, {}, "plan URL mismatch"],
    ["URL path", { planUrl: `https://raw.githubusercontent.com/${plan.repository}/${plan.sourceCommit}/plan.json` }, {}, "plan URL mismatch"],
    ["URL source/release cross-wire", { planUrl: `https://raw.githubusercontent.com/${plan.repository}/${plan.sourceCommit}/.lenso-release/plan.json` }, {}, "plan URL mismatch"],
    ["plan digest", { planSha256: digest("e") }, {}, "plan digest mismatch"],
    ["observed plan digest", {}, { planSha256: digest("e") }, "plan digest mismatch"],
  ] as const)("rejects %s", async (_name, eventChange, observedChange, message) => {
    const replay = consumer();
    await expect(verify(request(eventChange as Partial<ReleaseEventV1>), replay, observedRequest(observedChange))).rejects.toThrow(message);
    expect(replay.consume).not.toHaveBeenCalled();
  });

  it("rejects stale, future, noncanonical, and identity-confused events", async () => {
    await expect(verify(request({ issuedAt: "2026-07-11T11:54:59.999Z" }))).rejects.toThrow("publish request is stale");
    await expect(verify(request({ issuedAt: "2026-07-11T12:00:30.001Z" }))).rejects.toThrow("publish request is from the future");
    await expect(verify(request({ issuedAt: "2026-07-11T11:59:30Z" }))).rejects.toThrow("issuedAt must be canonical RFC 3339 UTC");
    await expect(verify(request({ eventId: plan.planId }))).rejects.toThrow("eventId must match canonical request payload");
  });

  it("rejects missing, duplicate, extra, reordered, or wrong-version package selections", async () => {
    const fixture = request();
    if (fixture.eventType !== "lenso-publish-requested") throw new Error("fixture failure");
    const selected = fixture.packages[0]!;
    for (const packages of [[], [selected, selected], [selected, { id: "npm:extra", version: "1.0.0" }], [{ ...selected, version: "9.0.0" }]]) {
      await expect(verify(request({ packages } as Partial<ReleaseEventV1>))).rejects.toThrow(/packages|package selection/);
    }
    const twoIdentity = { ...planIdentity, packages: [...planIdentity.packages, { ...planIdentity.packages[0]!, id: "npm:second" }] };
    const twoPlan = { ...twoIdentity, planId: sha256(twoIdentity as JsonValue) };
    const base = request();
    if (base.eventType !== "lenso-publish-requested") throw new Error("fixture failure");
    const { eventId: _eventId, ...baseIdentity } = base;
    const identity = {
      ...baseIdentity,
      planId: twoPlan.planId,
      planSha256: twoPlan.planId,
      planUrl: `https://raw.githubusercontent.com/${twoPlan.repository}/${releaseCommit}/.lenso-release/plan.json`,
      packages: [...twoPlan.packages].reverse().map(({ id, nextVersion: version }) => ({ id, version })),
    };
    const event = { ...identity, eventId: sha256(identity as JsonValue) };
    await expect(assertPublishRequest(event, twoPlan, observedRequest({
      ref: executionRef(twoPlan.planId),
      planSha256: twoPlan.planId,
    }), {
      expectedAppId: 12345, expectedActor: "lenso-release[bot]", expectedSourceRepository: "LioRael/lenso-release",
      planPath: ".lenso-release/plan.json", maxAgeMs: 300_000, maxFutureSkewMs: 30_000, now: () => now, nonceConsumer: consumer(),
    })).rejects.toThrow(/package selection/);
  });

  it("fails a replay when atomic consumption reports an existing nonce", async () => {
    await expect(verify(request(), consumer(false))).rejects.toThrow("publish request nonce was already consumed");
  });

  it("allows exactly one concurrent atomic nonce consumption", async () => {
    const stored = new Map<string, string>();
    const atomic: NonceConsumer = {
      consume: async (nonce, eventId) => {
        if (stored.has(nonce)) return false;
        stored.set(nonce, eventId);
        await Promise.resolve();
        return true;
      },
    };
    const event = request();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => verify(event, atomic)));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(11);
    expect(stored.get(event.nonce)).toBe(event.eventId);
  });

  it("fails closed when atomic nonce storage throws", async () => {
    const failure: NonceConsumer = { consume: async () => { throw new Error("nonce store unavailable"); } };
    await expect(verify(request(), failure)).rejects.toThrow("nonce store unavailable");
  });
});
