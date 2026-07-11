import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ComponentRegistry } from "../../src/config/components.js";
import type { ComponentReceiptV1, PlanStateV1, ReleasePlanV1, Sha256 } from "../../src/contracts/types.js";
import { sha256, type JsonValue } from "../../src/core/canonical.js";
import {
  newlyReadyPackages,
  runDispatchOutbox,
  type DispatchRunContext,
} from "../../src/coordinator/dispatch.js";
import {
  assertLegalTransition,
  assertPlanState,
  assertReleaseStateSnapshot,
  cancelPlan,
  planStatePath,
  StateConflictError,
  transact,
  type GitStateStore,
  type ReleaseStateSnapshot,
} from "../../src/coordinator/state.js";
import { acceptReadyEvent } from "../../src/coordinator/ready.js";
import { acceptReceiptEvent, recoverLostReceipt } from "../../src/coordinator/receipt.js";
import { IncompleteEvidenceError } from "../../src/coordinator/receipt.js";
import { scanActiveRecovery } from "../../src/coordinator/production-facts.js";
import { HANDLE_EVENT_EXIT, handleEvent, runHandleEventCli } from "../../src/commands/handle-event.js";

const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
const observedRun = (context: DispatchRunContext, eventId: string, id = 1) => ({
  ...context,
  event: "workflow_dispatch" as const,
  runName: `lenso-publish-requested:${eventId}`,
  runUrl: `https://github.com/${context.repository}/actions/runs/${id}`,
});
function state(): PlanStateV1 {
  const planId = digest("a");
  return {
    schema: "lenso.plan-state.v1",
    repository: "LioRael/lenso",
    planId,
    planSha256: digest("b"),
    sourceCommit: "1".repeat(40),
    releaseCommit: "2".repeat(40),
    status: "publishing",
    reason: null,
    evidence: [
      {
        kind: "execution-ref-protected",
        url: null,
        digest: `git:${"2".repeat(40)}`,
      },
    ],
    packages: [
      {
        id: "cargo:lenso-contracts",
        version: "1.0.0",
        phase: 0,
        status: "dispatched",
        requestEventId: digest("c"),
      },
    ],
    receipts: [],
    attempts: [],
    outbox: [
      {
        eventId: digest("c"),
        nonce: "nonce",
        ref: `release-execution/${"a".repeat(64)}`,
        workflow: ".github/workflows/publish.yml",
        packages: [{ id: "cargo:lenso-contracts", version: "1.0.0" }],
        inputs: {
          event_id: digest("c"),
          plan_id: planId,
          plan_sha256: digest("b"),
          release_commit: "2".repeat(40),
          packages_json: JSON.stringify([
            { id: "cargo:lenso-contracts", version: "1.0.0" },
          ]),
          nonce: "nonce",
        },
        status: "pending",
        claimOwner: null,
        leaseExpiresAt: null,
        runUrl: null,
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    occupancyKeys: [
      `package:cargo:lenso-contracts:1.0.0`,
      `plan:LioRael/lenso:${planId}`,
    ].sort(),
    executionRef: {
      name: `release-execution/${"a".repeat(64)}`,
      tip: "2".repeat(40),
      protected: true,
    },
    revision: 0,
    previousBlobSha: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}
class MemoryStore implements GitStateStore {
  snapshot: ReleaseStateSnapshot;
  conflicts = 0;
  constructor(initial: ReleaseStateSnapshot) {
    this.snapshot = initial;
  }
  async readSnapshot() {
    return structuredClone(this.snapshot);
  }
  async compareAndSwap(expected: string, next: ReleaseStateSnapshot) {
    if (this.conflicts-- > 0 || expected !== this.snapshot.headSha)
      throw new StateConflictError("conflict");
    this.snapshot = {
      ...structuredClone(next),
      headSha: (Number(this.snapshot.headSha[0]) + 1).toString().repeat(40),
    };
    return this.readSnapshot();
  }
}
function snapshot(value = state()): ReleaseStateSnapshot {
  return {
    headSha: "3".repeat(40),
    plans: { [planStatePath(value.repository, value.planId)]: value },
    activeRepositories: { [value.repository]: value.planId },
    occupiedPackages: { "package:cargo:lenso-contracts:1.0.0": value.planId },
  };
}

describe("atomic coordinator state", () => {
  it("keeps same-phase package ordering stable across state and dispatch", async () => {
    const identity = {
      schema: "lenso.release-plan.v1" as const,
      repository: "LioRael/lenso",
      sourceCommit: "1".repeat(40),
      tegamiVersion: "1.2.5" as const,
      publisher: { workflow: ".github/workflows/publish.yml", workflowSha256: digest("b"), sharedRevision: "4".repeat(40), sharedBundleSha256: digest("c"), runner: "ubuntu-24.04", node: "24.0.0", npm: "11.7.0", rust: "1.94.0" },
      generatedFiles: [{ path: "Cargo.lock", sha256: digest("d") }],
      packages: [
        { id: "cargo:lenso", previousVersion: "0.3.18", nextVersion: "0.3.19", bump: "patch" as const, releaseGroup: "foundation", userFacing: true, dependencies: [] },
        { id: "cargo:lenso-service", previousVersion: "0.1.0", nextVersion: "0.1.1", bump: "patch" as const, releaseGroup: "foundation", userFacing: true, dependencies: [] },
      ],
    };
    const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as JsonValue) as Sha256 };
    const planBytes = Buffer.from(JSON.stringify(plan));
    const planSha = sha256(planBytes);
    const registry: ComponentRegistry = {
      schema: "lenso.component-registry.v1",
      internalPackages: [],
      packages: Object.fromEntries(identity.packages.map(({ id, releaseGroup, userFacing }) => [id, { id, repository: identity.repository, registry: "crates-io", releaseGroup, userFacing, publishable: true, dependencies: [] }])),
    } as ComponentRegistry;
    const releaseCommit = "2".repeat(40);
    const accepted = await acceptReadyEvent({ schema: "lenso.release-event.v1", eventId: digest("e"), eventType: "lenso-plan-ready", issuedAt: "2026-07-11T00:00:00Z", nonce: "ready-nonce-123", sourceRepository: plan.repository, expectedAppId: 42, planId: plan.planId, planUrl: "https://example.com/plan", planSha256: planSha, releaseCommit }, {
      store: new MemoryStore({ headSha: "3".repeat(40), plans: {}, activeRepositories: {}, occupiedPackages: {} }), registry, appId: 42, expectedActor: "lenso-app[bot]",
      now: () => new Date("2026-07-11T00:00:00Z"), nonce: () => "dispatch-nonce-1",
      github: {
        async readAtReleaseCommit() { return { actor: "lenso-app[bot]", appId: 42, planBytes, plan, planSha256: planSha, sourceCommitRepository: plan.repository, releaseCommitRepository: plan.repository, releaseCommitContainsSourceCommit: true, workflowSha256: plan.publisher.workflowSha256, sharedRevision: plan.publisher.sharedRevision, sharedBundleSha256: plan.publisher.sharedBundleSha256, runner: plan.publisher.runner, node: plan.publisher.node, npm: plan.publisher.npm, rust: plan.publisher.rust, branchProtected: true, generatedFilesValid: true, externalDependenciesVisible: true }; },
        async ensureExecutionRef(_repository, name) { return { tip: releaseCommit, protected: true as const, name }; },
      },
    });
    expect(accepted.state.outbox[0]!.packages.map(({ id }) => id)).toEqual([
      "cargo:lenso",
      "cargo:lenso-service",
    ]);
  });
  it("runs ready and exact receipts through a two-phase plan to verified", async () => {
    const identity = {
      schema: "lenso.release-plan.v1" as const,
      repository: "LioRael/lenso",
      sourceCommit: "1".repeat(40),
      tegamiVersion: "1.2.5" as const,
      publisher: {
        workflow: ".github/workflows/publish.yml",
        workflowSha256: digest("b"),
        sharedRevision: "4".repeat(40),
        sharedBundleSha256: digest("c"),
        runner: "ubuntu-24.04",
        node: "24.0.0",
        npm: "11.7.0",
        rust: "1.94.0",
      },
      generatedFiles: [{ path: "Cargo.lock", sha256: digest("d") }],
      packages: [
        { id: "cargo:a", previousVersion: "0.9.0", nextVersion: "1.0.0", bump: "major" as const, releaseGroup: "foundation", userFacing: true, dependencies: [] },
        { id: "cargo:b", previousVersion: "0.9.0", nextVersion: "1.0.0", bump: "major" as const, releaseGroup: "foundation", userFacing: true, dependencies: [{ id: "cargo:a", requirement: "=1.0.0", resolvedVersion: "1.0.0", source: "plan" as const }] },
      ],
    };
    const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as JsonValue) as Sha256 };
    const planBytes = Buffer.from(JSON.stringify(plan));
    const planSha = sha256(planBytes);
    const registry: ComponentRegistry = {
      schema: "lenso.component-registry.v1",
      internalPackages: [],
      packages: {
        "cargo:a": { id: "cargo:a", repository: "LioRael/lenso", registry: "crates-io", releaseGroup: "foundation", userFacing: true, publishable: true, dependencies: [] },
        "cargo:b": { id: "cargo:b", repository: "LioRael/lenso", registry: "crates-io", releaseGroup: "foundation", userFacing: true, publishable: true, dependencies: [] },
      },
    };
    const store = new MemoryStore({ headSha: "3".repeat(40), plans: {}, activeRepositories: {}, occupiedPackages: {} });
    let nonce = 0;
    const visibilityChecks: string[][] = [];
    const releaseCommit = "2".repeat(40);
    const readyEvent = { schema: "lenso.release-event.v1" as const, eventId: digest("e"), eventType: "lenso-plan-ready" as const, issuedAt: "2026-07-11T00:00:00Z", nonce: "ready-nonce-123", sourceRepository: plan.repository, expectedAppId: 42, planId: plan.planId, planUrl: "https://example.com/plan", planSha256: planSha, releaseCommit };
    let current = (await acceptReadyEvent(readyEvent, {
      store, registry, appId: 42, expectedActor: "lenso-app[bot]",
      now: () => new Date("2026-07-11T00:00:00Z"), nonce: () => `dispatch-nonce-${++nonce}`,
      github: {
        async readAtReleaseCommit() { return { actor: "lenso-app[bot]", appId: 42, planBytes, plan, planSha256: planSha, sourceCommitRepository: plan.repository, releaseCommitRepository: plan.repository, releaseCommitContainsSourceCommit: true, workflowSha256: plan.publisher.workflowSha256, sharedRevision: plan.publisher.sharedRevision, sharedBundleSha256: plan.publisher.sharedBundleSha256, runner: plan.publisher.runner, node: plan.publisher.node, npm: plan.publisher.npm, rust: plan.publisher.rust, branchProtected: true, generatedFilesValid: true, externalDependenciesVisible: true }; },
        async ensureExecutionRef(_repository, name) { return { tip: releaseCommit, protected: true as const, name }; },
      },
    })).state;
    expect(current.packages.map(({ status }) => status)).toEqual(["dispatched", "pending"]);
    const makeReceipt = (packageId: "cargo:a" | "cargo:b", correlationId: string) => {
      const bytes = Buffer.from(packageId);
      const packedSha256 = sha256(bytes) as Sha256;
      const receipt: ComponentReceiptV1 = { schema: "lenso.component-receipt.v1", environment: "production", receiptId: digest(packageId === "cargo:a" ? "6" : "7"), planId: plan.planId, packageId, version: "1.0.0", repository: plan.repository, sourceCommit: releaseCommit, packedSha256, registryIntegrity: packedSha256.slice(7), registryUrl: `https://registry.example/${packageId}`, provenanceUrl: `https://example.com/provenance/${packageId}`, provenanceSubject: { name: `${packageId}.crate`, digest: packedSha256 }, workflowUrl: `https://github.com/LioRael/lenso/actions/runs/${packageId}`, tagUrl: `https://github.com/LioRael/lenso/releases/tag/${packageId}`, publishedAt: "2026-07-11T00:01:00Z" };
      const event = { schema: "lenso.release-event.v1" as const, eventType: "lenso-publish-receipt" as const, eventId: receipt.receiptId, issuedAt: "2026-07-11T00:02:00Z", nonce: "receipt-nonce-123", sourceRepository: plan.repository, expectedAppId: 42, planId: plan.planId, planUrl: "https://example.com/plan", planSha256: planSha, releaseCommit, correlationId: correlationId as PlanStateV1["planId"], receipt };
      return { bytes, receipt, event };
    };
    for (const packageId of ["cargo:a", "cargo:b"] as const) {
      current = (await runDispatchOutbox(
        store,
        plan.repository,
        plan.planId,
        {
          async findByEventId() { return null; },
          async dispatch(command, eventId) { return observedRun({ repository: command.repository, workflow: command.workflow, ref: command.ref, sha: command.inputs.release_commit }, eventId, 10); },
        },
        { async tokenFor() { return "secret"; } },
        () => new Date("2026-07-11T00:00:30Z"),
      )).state;
      const selected = current.packages.find(({ id }) => id === packageId)!;
      const fixture = makeReceipt(packageId, selected.requestEventId!);
      current = (await acceptReceiptEvent(fixture.event, {
        store, appId: 42, expectedActor: "lenso-app[bot]", environment: "production", now: () => new Date("2026-07-11T00:02:00Z"), nonce: () => `dispatch-nonce-${++nonce}`,
        authenticate: async () => ({ actor: "lenso-app[bot]", appId: 42 }), readPlan: async () => ({ plan, planBytes }),
        dependenciesVisible: async (_plan, ids) => { visibilityChecks.push(ids); return true; },
        observer: { async observe(context) { return { registry: { packedBytes: fixture.bytes, nativeIntegrity: fixture.receipt.registryIntegrity, url: fixture.receipt.registryUrl, publishedAt: fixture.receipt.publishedAt }, provenance: { url: fixture.receipt.provenanceUrl, subject: fixture.receipt.provenanceSubject }, workflow: { url: fixture.receipt.workflowUrl, repository: plan.repository, ref: current.executionRef.name, sha: releaseCommit, runName: `lenso-publish-requested:${context.eventId}`, workflowPath: context.workflow }, tag: { url: fixture.receipt.tagUrl, annotated: true, immutable: true, targetSha: releaseCommit, receipt: fixture.receipt } }; }, async createAnnotatedTag() {} },
      })).state;
    }
    expect(current.status).toBe("verified");
    expect(current.receipts).toHaveLength(2);
    expect(visibilityChecks).toEqual([["cargo:b"]]);
    expect(store.snapshot.activeRepositories).toEqual({});
    expect(store.snapshot.occupiedPackages).toEqual({});
  });
  it("uses traversal-safe state paths and validates the full contract", () => {
    expect(planStatePath("LioRael/lenso", digest("a"))).toContain(
      "LioRael%2Flenso",
    );
    expect(() => planStatePath("../lenso", digest("a"))).toThrow("repository");
    expect(() => assertPlanState(state())).not.toThrow();
  });
  it("round-trips hosted artifact package and occupancy identities", () => {
    const value = state();
    value.packages[0]!.id = "artifact:lenso-runtime-console";
    value.outbox[0]!.packages[0]!.id = "artifact:lenso-runtime-console";
    value.outbox[0]!.inputs.packages_json = JSON.stringify([
      { id: "artifact:lenso-runtime-console", version: "1.0.0" },
    ]);
    value.occupancyKeys = [
      "package:artifact:lenso-runtime-console:1.0.0",
      `plan:LioRael/lenso:${value.planId}`,
    ].sort();
    const artifactSnapshot: ReleaseStateSnapshot = {
      headSha: "3".repeat(40),
      plans: { [planStatePath(value.repository, value.planId)]: value },
      activeRepositories: { [value.repository]: value.planId },
      occupiedPackages: {
        "package:artifact:lenso-runtime-console:1.0.0": value.planId,
      },
    };
    expect(() => assertReleaseStateSnapshot(artifactSnapshot)).not.toThrow();
  });
  it("re-reads the branch snapshot after a lost update", async () => {
    const store = new MemoryStore(snapshot());
    store.conflicts = 1;
    let reads = 0;
    const original = store.readSnapshot.bind(store);
    store.readSnapshot = async () => {
      reads++;
      return original();
    };
    await transact(store, (current) => ({
      ...current,
      plans: Object.fromEntries(
        Object.entries(current.plans).map(([path, value]) => [
          path,
          {
            ...value,
            evidence: [
              ...value.evidence,
              { kind: "retry-observed", url: null, digest: null },
            ],
          },
        ]),
      ),
    }));
    expect(reads).toBeGreaterThanOrEqual(3);
  });
  it("serializes global package occupancy and repository ownership", async () => {
    const store = new MemoryStore({
      headSha: "3".repeat(40),
      plans: {},
      activeRepositories: {},
      occupiedPackages: {},
    });
    const acquire = (repo: string, plan: string) =>
      transact(
        store,
        async (current) => {
          if (current.occupiedPackages["package:cargo:lenso-contracts:1.0.0"])
            throw new StateConflictError("occupied");
          await Promise.resolve();
          const claimed = state();
          claimed.repository = repo;
          claimed.planId = plan as PlanStateV1["planId"];
          claimed.executionRef.name = `release-execution/${plan.slice("sha256:".length)}`;
          claimed.outbox[0]!.ref = claimed.executionRef.name;
          claimed.outbox[0]!.inputs.plan_id = claimed.planId;
          claimed.occupancyKeys = [
            "package:cargo:lenso-contracts:1.0.0",
            `plan:${repo}:${plan}`,
          ].sort();
          current.plans[planStatePath(repo, plan)] = claimed;
          current.occupiedPackages["package:cargo:lenso-contracts:1.0.0"] = plan;
          current.activeRepositories[repo] = plan;
          return current;
        },
        1,
      );
    const results = await Promise.allSettled([
      acquire("LioRael/lenso", digest("a")),
      acquire("LioRael/lenso-cli", digest("b")),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
  });
  it("observes an existing run after a crash and never dispatches twice", async () => {
    const store = new MemoryStore(snapshot());
    let calls = 0;
    let visible = false;
    const dispatcher = {
      async findByEventId(context: DispatchRunContext, eventId: string) {
        return visible ? observedRun(context, eventId, 1) : null;
      },
      async dispatch(command: { repository: string; workflow: string; ref: string; inputs: { release_commit: string } }, eventId: string) {
        calls++;
        visible = true;
        store.conflicts = 3;
        return observedRun({ repository: command.repository, workflow: command.workflow, ref: command.ref, sha: command.inputs.release_commit }, eventId, 1);
      },
    };
    await expect(
      runDispatchOutbox(
        store,
        "LioRael/lenso",
        digest("a"),
        dispatcher,
        {
          async tokenFor() {
            return "secret";
          },
        },
        () => new Date("2026-07-11T00:01:00Z"),
      ),
    ).rejects.toThrow("conflict");
    store.conflicts = 0;
    await runDispatchOutbox(
      store,
      "LioRael/lenso",
      digest("a"),
      dispatcher,
      {
        async tokenFor() {
          return "secret";
        },
      },
      () => new Date("2026-07-11T00:02:00Z"),
    );
    expect(calls).toBe(1);
    expect(
      store.snapshot.plans[planStatePath("LioRael/lenso", digest("a"))]!
        .outbox[0]!.status,
    ).toBe("dispatched");
  });
  it("allows only the CAS owner to perform an outbox side effect", async () => {
    const store = new MemoryStore(snapshot());
    let calls = 0;
    let releaseDispatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatcher = {
      async findByEventId() {
        return null;
      },
      async dispatch(command: { repository: string; workflow: string; ref: string; inputs: { release_commit: string } }, eventId: string) {
        calls++;
        await gate;
        return observedRun({ repository: command.repository, workflow: command.workflow, ref: command.ref, sha: command.inputs.release_commit }, eventId, 2);
      },
    };
    const execute = () =>
      runDispatchOutbox(
        store,
        "LioRael/lenso",
        digest("a"),
        dispatcher,
        { async tokenFor() { return "secret"; } },
        () => new Date("2026-07-11T00:01:00Z"),
      );
    const first = execute();
    await vi.waitFor(() => expect(calls).toBe(1));
    await expect(execute()).rejects.toThrow("already in flight");
    releaseDispatch();
    await first;
    expect(calls).toBe(1);
  });
  it("blocks an ambiguous stale claim without automatically redispatching", async () => {
    const stale = state();
    stale.outbox[0] = {
      ...stale.outbox[0]!,
      status: "in-flight",
      claimOwner: "crashed-worker",
      leaseExpiresAt: "2026-07-11T00:01:00Z",
    };
    const store = new MemoryStore(snapshot(stale));
    const dispatch = vi.fn(async (command, eventId) => observedRun({ repository: command.repository, workflow: command.workflow, ref: command.ref, sha: command.inputs.release_commit }, eventId, 3));
    const result = await runDispatchOutbox(
      store, stale.repository, stale.planId,
      { async findByEventId() { return null; }, dispatch },
      { async tokenFor() { return "secret"; } },
      () => new Date("2026-07-11T00:10:00Z"),
      "recovery-worker",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.state).toMatchObject({ status: "blocked", reason: "dispatch outcome unknown" });
    expect(result.state.occupancyKeys).not.toEqual([]);
  });
  it("acknowledges a delayed post-send run after lease expiry without redispatch", async () => {
    const stale = state();
    stale.outbox[0] = { ...stale.outbox[0]!, status: "in-flight", claimOwner: "crashed-after-send", leaseExpiresAt: "2026-07-11T00:01:00Z" };
    const store = new MemoryStore(snapshot(stale));
    let observations = 0;
    const dispatch = vi.fn();
    const result = await runDispatchOutbox(
      store, stale.repository, stale.planId,
      {
        async findByEventId(context, eventId) { observations++; return observedRun(context, eventId, 4); },
        async dispatch(command, eventId) { dispatch(); return observedRun({ repository: command.repository, workflow: command.workflow, ref: command.ref, sha: command.inputs.release_commit }, eventId, 5); },
      },
      { async tokenFor() { return "secret"; } },
      () => new Date("2026-07-11T00:10:00Z"),
      "recovery-worker",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.state.outbox[0]).toMatchObject({ status: "dispatched", runUrl: "https://github.com/LioRael/lenso/actions/runs/4" });
  });
  it("blocks a post-send pre-visibility ambiguity with one POST maximum", async () => {
    const store = new MemoryStore(snapshot());
    let posts = 0;
    const dispatcher = {
      async findByEventId() { return null; },
      async dispatch() { posts++; throw new Error("workflow run is not yet visible"); },
    };
    await expect(runDispatchOutbox(store, "LioRael/lenso", digest("a"), dispatcher, { async tokenFor() { return "secret"; } }, () => new Date("2026-07-11T00:01:00Z"))).rejects.toThrow("not yet visible");
    const retry = await runDispatchOutbox(store, "LioRael/lenso", digest("a"), dispatcher, { async tokenFor() { return "secret"; } }, () => new Date("2026-07-11T00:10:00Z"));
    expect(posts).toBe(1);
    expect(retry.state).toMatchObject({ status: "blocked", reason: "dispatch outcome unknown" });
    expect(retry.state.occupancyKeys.length).toBeGreaterThan(0);
  });
  it("reconstructs a lost receipt and creates a missing annotated tag without publishing", async () => {
    const identity = {
      schema: "lenso.release-plan.v1" as const,
      repository: "LioRael/lenso",
      sourceCommit: "1".repeat(40),
      tegamiVersion: "1.2.5" as const,
      publisher: { workflow: ".github/workflows/publish.yml", workflowSha256: digest("1"), sharedRevision: "3".repeat(40), sharedBundleSha256: digest("2"), runner: "ubuntu-24.04", node: "24.0.0", npm: "11.7.0", rust: "1.94.0" },
      generatedFiles: [{ path: "Cargo.lock", sha256: digest("3") }],
      packages: [{ id: "cargo:lenso-contracts", previousVersion: "0.9.0", nextVersion: "1.0.0", bump: "major" as const, releaseGroup: "foundation", userFacing: true, dependencies: [] }],
    };
    const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as JsonValue) as Sha256 };
    const planBytes = Buffer.from(JSON.stringify(plan));
    const value = state();
    value.planId = plan.planId;
    value.planSha256 = sha256(planBytes) as Sha256;
    value.executionRef.name = `release-execution/${plan.planId.slice(7)}`;
    value.outbox[0] = { ...value.outbox[0]!, status: "dispatched", runUrl: "https://github.com/LioRael/lenso/actions/runs/7", ref: value.executionRef.name, inputs: { ...value.outbox[0]!.inputs, plan_id: plan.planId, plan_sha256: value.planSha256 }, claimOwner: null, leaseExpiresAt: null };
    value.occupancyKeys = ["package:cargo:lenso-contracts:1.0.0", `plan:${value.repository}:${value.planId}`].sort();
    const store = new MemoryStore(snapshot(value));
    const bytes = Buffer.from("published crate");
    const packed = sha256(bytes) as Sha256;
    let tagReceipt: ComponentReceiptV1 | null = null;
    let creates = 0;
    const observation = () => ({
      registry: { packedBytes: bytes, nativeIntegrity: packed.slice(7), url: "https://static.crates.io/crates/lenso-contracts/lenso-contracts-1.0.0.crate", publishedAt: "2026-07-11T00:02:00Z" },
      provenance: { url: "https://github.com/LioRael/lenso/attestations/1", subject: { name: "lenso-contracts-1.0.0.crate", digest: packed } },
      workflow: { url: "https://github.com/LioRael/lenso/actions/runs/7", repository: value.repository, ref: value.executionRef.name, sha: value.releaseCommit, runName: `lenso-publish-requested:${value.packages[0]!.requestEventId!}`, workflowPath: value.outbox[0]!.workflow },
      tag: { url: "https://github.com/LioRael/lenso/releases/tag/lenso-contracts%401.0.0", annotated: tagReceipt !== null, immutable: tagReceipt !== null, targetSha: value.releaseCommit, receipt: tagReceipt },
    });
    const recovered = await recoverLostReceipt(value.repository, value.planId, value.packages[0]!.id, value.packages[0]!.version, {
      store, appId: 42, expectedActor: "lenso-app[bot]", environment: "production", now: () => new Date("2026-07-11T00:03:00Z"), nonce: () => "recovery-nonce-123",
      authenticate: async () => ({ actor: "lenso-app[bot]", appId: 42 }), readPlan: async () => ({ plan, planBytes }),
      observer: { async observe() { return observation(); }, async createAnnotatedTag(_repository, receipt) { creates++; tagReceipt = receipt; } },
    });
    expect(creates).toBe(1);
    expect(recovered?.state.status).toBe("verified");
    expect(recovered?.state.receipts).toEqual([tagReceipt]);
  });
  it("continues active recovery after incomplete evidence but aborts security errors", async () => {
    const first = state();
    const second = structuredClone(first);
    second.repository = "LioRael/lenso-cli";
    const calls: string[] = [];
    const summary = await scanActiveRecovery({ b: second, a: first }, async (plan) => {
      calls.push(plan.repository);
      if (plan.repository === "LioRael/lenso-cli") throw new IncompleteEvidenceError("not yet visible");
    });
    expect(calls).toEqual(["LioRael/lenso-cli", "LioRael/lenso"]);
    expect(summary.incomplete).toHaveLength(1);
    expect(summary.recovered).toHaveLength(1);
    await expect(scanActiveRecovery({ a: first, b: second }, async (plan) => {
      if (plan.repository === "LioRael/lenso-cli") throw new TypeError("security contradiction");
    })).rejects.toThrow("security contradiction");
  });
  it("rejects identity rewrites and premature later phases", () => {
    const previous = state();
    expect(() =>
      assertLegalTransition(previous, {
        ...previous,
        repository: "LioRael/lenso-cli",
        occupancyKeys: previous.occupancyKeys.map((key) => key.startsWith("plan:") ? `plan:LioRael/lenso-cli:${previous.planId}` : key),
      }),
    ).toThrow("immutable");
    expect(
      newlyReadyPackages([
        {
          id: "cargo:a",
          version: "1.0.0",
          phase: 0,
          status: "dispatched",
          requestEventId: digest("c"),
        },
        {
          id: "cargo:b",
          version: "1.0.0",
          phase: 1,
          status: "pending",
          requestEventId: null,
        },
      ]),
    ).toEqual([]);
  });
  it("cancels only before any outbox dispatch begins", async () => {
    const store = new MemoryStore(snapshot());
    const cancelled = await cancelPlan(store, "LioRael/lenso", digest("a"), digest("e"), new Date("2026-07-11T00:03:00Z"));
    expect(cancelled.state.occupancyKeys).toEqual([]);
    expect(cancelled.state.outbox[0]!.status).toBe("cancelled");
    expect(() => assertLegalTransition(cancelled.state, {
      ...cancelled.state,
      status: "publishing",
      reason: null,
      occupancyKeys: state().occupancyKeys,
      evidence: [...cancelled.state.evidence, { kind: "recovery", url: null, digest: null }],
    })).toThrow("cancelled state is immutable");
    const dispatch = vi.fn();
    await runDispatchOutbox(store, "LioRael/lenso", digest("a"), {
      async findByEventId() { return null; },
      async dispatch(command, eventId) { dispatch(); return observedRun({ repository: command.repository, workflow: command.workflow, ref: command.ref, sha: command.inputs.release_commit }, eventId, 8); },
    }, { async tokenFor() { return "secret"; } }, () => new Date());
    expect(dispatch).not.toHaveBeenCalled();
    const running = state(); running.outbox[0] = { ...running.outbox[0]!, status: "in-flight", claimOwner: "worker", leaseExpiresAt: "2026-07-11T00:10:00Z" };
    await expect(cancelPlan(new MemoryStore(snapshot(running)), "LioRael/lenso", digest("a"), digest("e"), new Date())).rejects.toThrow("dispatch begins");
  });
  it("routes CLI ready and receipt payloads with explicit exit codes", async () => {
    const ready = vi.fn(async () => ({ state: state(), headSha: "3".repeat(40) }));
    const receipt = vi.fn(async () => ({ state: state(), headSha: "3".repeat(40) }));
    await handleEvent({ eventType: "lenso-plan-ready" }, { ready, receipt });
    await handleEvent({ eventType: "lenso-publish-receipt" }, { ready, receipt });
    expect(ready).toHaveBeenCalledOnce(); expect(receipt).toHaveBeenCalledOnce();
    const directory = await mkdtemp(join(tmpdir(), "lenso-event-")); const path = join(directory, "event.json");
    await writeFile(path, JSON.stringify({ client_payload: { eventType: "lenso-plan-ready" } }));
    expect(await runHandleEventCli(["--event-file", path, "--event-key", "client_payload"], {}, async () => ({ ready, receipt }))).toBe(HANDLE_EVENT_EXIT.ok);
    expect(await runHandleEventCli(["--event-file", "relative", "--event-key", "client_payload"], {}, async () => ({ ready, receipt }))).toBe(HANDLE_EVENT_EXIT.validation);
    const recoverActive = vi.fn(async () => []);
    expect(await runHandleEventCli(["--recover-active"], {}, async () => ({ ready, receipt, recoverActive }))).toBe(HANDLE_EVENT_EXIT.ok);
    expect(recoverActive).toHaveBeenCalledOnce();
    await rm(directory, { recursive: true });
  });
  it("keeps receiver workflows read-only and passes github.event_path", async () => {
    for (const file of ["plan-ready.yml", "publish-receipt.yml"]) {
      const workflow = await readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
      expect(workflow).toContain("contents: read"); expect(workflow).not.toMatch(/actions:\s*write|id-token:\s*write/u); expect(workflow).toContain("github.event_path");
      expect(workflow).toContain("LENSO_EVENT_ACTOR: ${{ github.actor }}");
    }
  });
});
