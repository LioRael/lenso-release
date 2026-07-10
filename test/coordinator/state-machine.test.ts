import { describe, expect, it } from "vitest";

import type { PlanStateV1 } from "../../src/contracts/types.js";
import { mutateState, planStatePath, type GitStateStore } from "../../src/coordinator/state.js";
import { newlyReadyPackages } from "../../src/coordinator/dispatch.js";

const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
function state(): PlanStateV1 {
  return {
    schema: "lenso.plan-state.v1", repository: "LioRael/lenso", planId: digest("a"), planSha256: digest("b"),
    sourceCommit: "1".repeat(40), releaseCommit: "2".repeat(40), status: "ready", reason: null, evidence: [],
    packages: [{ id: "cargo:lenso-contracts", version: "1.0.0", phase: 0, status: "pending", requestEventId: null }],
    receipts: [], attempts: [], occupancyKeys: [`package:cargo:lenso-contracts:1.0.0`, `plan:LioRael/lenso:${digest("a")}`].sort(),
    revision: 0, previousBlobSha: null, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

describe("coordinator state", () => {
  it("builds a traversal-safe canonical plan state path", () => {
    expect(planStatePath("LioRael/lenso", `sha256:${"a".repeat(64)}`)).toBe(
      `plans/LioRael%2Flenso/${"a".repeat(64)}.json`,
    );
    expect(() => planStatePath("../lenso", `sha256:${"a".repeat(64)}`)).toThrow("repository");
  });

  it("rejects a lost update and re-reads before retrying", async () => {
    let stored = state();
    let blobSha = "3".repeat(40);
    let reads = 0;
    let swaps = 0;
    const store: GitStateStore = {
      async read() { reads += 1; return { state: structuredClone(stored), blobSha }; },
      async create() { throw new Error("unused"); },
      async compareAndSwap(_path, previous, next) {
        swaps += 1;
        if (swaps === 1) { stored = { ...stored, revision: 1 }; blobSha = "4".repeat(40); throw new Error("409 conflict"); }
        expect(previous).toBe("4".repeat(40)); stored = next; blobSha = "5".repeat(40); return { state: next, blobSha };
      },
    };
    const result = await mutateState(store, planStatePath(stored.repository, stored.planId), (current) => ({ ...current, status: "publishing", revision: current.revision + 1 }));
    expect(reads).toBe(2);
    expect(result.state.revision).toBe(2);
  });

  it("does not schedule a later phase until every prerequisite phase receipt exists", () => {
    expect(newlyReadyPackages([
      { id: "cargo:a", version: "1.0.0", phase: 0, status: "received", requestEventId: digest("c") },
      { id: "cargo:b", version: "1.0.0", phase: 0, status: "dispatched", requestEventId: digest("d") },
      { id: "cargo:c", version: "1.0.0", phase: 1, status: "pending", requestEventId: null },
    ])).toEqual([]);
  });
});
