import { afterEach, describe, expect, it, vi } from "vitest";

import { draftReleaseObservation, type RuntimeEnvironment } from "../../src/repository/runtime.js";

const environment = {
  githubToken: "token",
  releaseCommit: "a".repeat(40),
  repository: "LioRael/lenso-console",
} as RuntimeEnvironment;

afterEach(() => vi.unstubAllGlobals());

describe("draft release observation", () => {
  it("finds an exact draft tag through the authenticated release list", async () => {
    const release = {
      draft: true,
      tag_name: "v0.1.4",
      target_commitish: environment.releaseCommit,
      assets: [],
    };
    const request = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/releases/tags/")
        ? new Response(null, { status: 404 })
        : Response.json([release]));
    vi.stubGlobal("fetch", request);
    await expect(draftReleaseObservation("0.1.4", environment)).resolves.toEqual(release);
    expect(String(request.mock.calls[1]![0])).toContain("/releases?per_page=100&page=1");
  });

  it("rejects a draft that is not anchored to the recovery commit", async () => {
    vi.stubGlobal("fetch", async () => Response.json({
      draft: true,
      tag_name: "v0.1.4",
      target_commitish: "b".repeat(40),
    }));
    await expect(draftReleaseObservation("0.1.4", environment)).rejects.toThrow("release commit");
  });
});
