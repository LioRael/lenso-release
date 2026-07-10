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
} from "../../src/coordinator/dispatch.js";
import {
  assertLegalTransition,
  assertPlanState,
  cancelPlan,
  planStatePath,
  StateConflictError,
  transact,
  type GitStateStore,
  type ReleaseStateSnapshot,
} from "../../src/coordinator/state.js";
import { acceptReadyEvent } from "../../src/coordinator/ready.js";
import { acceptReceiptEvent } from "../../src/coordinator/receipt.js";
import { HANDLE_EVENT_EXIT, handleEvent, runHandleEventCli } from "../../src/commands/handle-event.js";

const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
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
          event: "{}",
          plan_id: planId,
          plan_sha256: digest("b"),
          release_commit: "2".repeat(40),
          packages: JSON.stringify([
            { id: "cargo:lenso-contracts", version: "1.0.0" },
          ]),
          source_repository: "LioRael/lenso-release",
        },
        status: "pending",
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
        "cargo:b": { id: "cargo:b", repository: "LioRael/lenso", registry: "crates-io", releaseGroup: "foundation", userFacing: true, publishable: true, dependencies: ["cargo:a"] },
      },
    };
    const store = new MemoryStore({ headSha: "3".repeat(40), plans: {}, activeRepositories: {}, occupiedPackages: {} });
    let nonce = 0;
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
      const receipt: ComponentReceiptV1 = { schema: "lenso.component-receipt.v1", receiptId: digest(packageId === "cargo:a" ? "6" : "7"), planId: plan.planId, packageId, version: "1.0.0", repository: plan.repository, sourceCommit: releaseCommit, packedSha256, registryIntegrity: packedSha256.slice(7), registryUrl: `https://registry.example/${packageId}`, provenanceUrl: `https://example.com/provenance/${packageId}`, provenanceSubject: { name: `${packageId}.crate`, digest: packedSha256 }, workflowUrl: `https://github.com/LioRael/lenso/actions/runs/${packageId}`, tagUrl: `https://github.com/LioRael/lenso/releases/tag/${packageId}`, publishedAt: "2026-07-11T00:01:00Z" };
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
          async dispatch(_command, eventId) { return { runUrl: `https://github.com/run/${eventId}` }; },
        },
        { async tokenFor() { return "secret"; } },
        () => new Date("2026-07-11T00:00:30Z"),
      )).state;
      const selected = current.packages.find(({ id }) => id === packageId)!;
      const fixture = makeReceipt(packageId, selected.requestEventId!);
      current = (await acceptReceiptEvent(fixture.event, {
        store, appId: 42, expectedActor: "lenso-app[bot]", now: () => new Date("2026-07-11T00:02:00Z"), nonce: () => `dispatch-nonce-${++nonce}`,
        authenticate: async () => ({ actor: "lenso-app[bot]", appId: 42 }), readPlan: async () => ({ plan, planBytes }),
        observer: { async observe() { return { registry: { packedBytes: fixture.bytes, nativeIntegrity: fixture.receipt.registryIntegrity, url: fixture.receipt.registryUrl, publishedAt: fixture.receipt.publishedAt }, provenance: { url: fixture.receipt.provenanceUrl, subject: fixture.receipt.provenanceSubject }, workflow: { url: fixture.receipt.workflowUrl, repository: plan.repository, ref: current.executionRef.name, sha: releaseCommit, eventId: selected.requestEventId!, correlationId: selected.requestEventId!, packages: [{ id: packageId, version: "1.0.0" }] }, tag: { url: fixture.receipt.tagUrl, annotated: true, immutable: true, receipt: fixture.receipt } }; }, async createAnnotatedTag() {} },
      })).state;
    }
    expect(current.status).toBe("verified");
    expect(current.receipts).toHaveLength(2);
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
      async findByEventId() {
        return visible ? { runUrl: "https://github.com/run/1" } : null;
      },
      async dispatch() {
        calls++;
        visible = true;
        store.conflicts = 3;
        return { runUrl: "https://github.com/run/1" };
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
      async dispatch() {
        calls++;
        await gate;
        return { runUrl: "https://github.com/run/atomic" };
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
    const running = state(); running.outbox[0] = { ...running.outbox[0]!, status: "in-flight" };
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
