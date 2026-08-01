import { afterEach, describe, expect, it, vi } from "vitest";

import { draftReleaseObservation, fetchGithubReleaseAsset, type RuntimeEnvironment } from "../../src/repository/runtime.js";

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

describe("GitHub release asset download", () => {
  it("downloads an authenticated same-origin shadow asset without redirecting", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://shadow.example/github/assets/42");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer shadow-token");
      expect(init?.redirect).toBe("manual");
      return new Response("artifact");
    });
    await expect(fetchGithubReleaseAsset(
      "https://shadow.example/github/assets/42",
      "https://shadow.example/github",
      { authorization: "Bearer shadow-token", accept: "application/octet-stream" },
      request as typeof fetch,
    )).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows the trusted signed storage redirect without forwarding authorization", async () => {
    const target = "https://release-assets.githubusercontent.com/github-production-release-asset/1267394330/f6a2a6fc-810e-4c23-aae3-23cd6d62d9ad?sig=opaque";
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === target) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(init?.redirect).toBe("error");
        return new Response("artifact");
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: target } });
    });
    await expect(fetchGithubReleaseAsset(
      "https://api.github.com/repos/LioRael/lenso-console/releases/assets/123",
      "https://api.github.com",
      { authorization: "Bearer token", accept: "application/octet-stream" },
      request as typeof fetch,
    )).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "https://evil.example/github-production-release-asset/1267394330/f6a2a6fc-810e-4c23-aae3-23cd6d62d9ad?sig=opaque",
    "https://release-assets.githubusercontent.com/other/1267394330/f6a2a6fc-810e-4c23-aae3-23cd6d62d9ad?sig=opaque",
    "https://release-assets.githubusercontent.com/github-production-release-asset/1267394330/f6a2a6fc-810e-4c23-aae3-23cd6d62d9ad",
  ])("rejects an untrusted storage redirect: %s", async (target) => {
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: target } }));
    await expect(fetchGithubReleaseAsset(
      "https://api.github.com/repos/LioRael/lenso-console/releases/assets/123",
      "https://api.github.com",
      { authorization: "Bearer token" },
      request as typeof fetch,
    )).rejects.toThrow("redirect is not trusted");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
