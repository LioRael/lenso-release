import { describe, expect, it, vi } from "vitest";

import { createIntegrationSet } from "../../src/commands/create-integration-set.js";

describe("create integration set", () => {
  it("sorts and verifies exact repository commits before assigning a stable ID", async () => {
    const commits = { "LioRael/lenso-runtime-console": "b".repeat(40), "LioRael/lenso-examples": "a".repeat(40) };
    const request = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({ sha: String(url).endsWith("a".repeat(40)) ? "a".repeat(40) : "b".repeat(40) })));
    const first = await createIntegrationSet("0.1.0", commits, { fetch: request as typeof fetch });
    const second = await createIntegrationSet("0.1.0", Object.fromEntries(Object.entries(commits).reverse()), { fetch: request as typeof fetch });
    expect(first).toEqual(second);
    expect(Object.keys(first.repositories)).toEqual(["LioRael/lenso-examples", "LioRael/lenso-runtime-console"]);
    expect(first.integrationSetId).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects floating refs and commits not visible in the named repository", async () => {
    await expect(createIntegrationSet("0.1.0", { "LioRael/lenso": "main" }, { fetch: vi.fn() as typeof fetch })).rejects.toThrow("invalid");
    await expect(createIntegrationSet("0.1.0", { "LioRael/lenso": "a".repeat(40) }, { fetch: (async () => new Response("", { status: 404 })) as typeof fetch })).rejects.toThrow("not visible");
  });
});
