import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { observeOciImage } from "../../src/registry/oci.js";

const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("OCI registry observer", () => {
  it("binds a version tag to exact manifest and config bytes", async () => {
    const config = Buffer.from(JSON.stringify({
      created: "2026-07-30T08:00:00Z",
      config: { Labels: { "org.opencontainers.image.version": "0.2.0" } },
    }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: digest(config), size: config.length }, layers: [] }));
    const request = vi.fn(async (input: string | URL | Request) => String(input).includes("/manifests/")
      ? new Response(manifest, { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": digest(manifest) } })
      : new Response(config));
    await expect(observeOciImage("lenso-console-service", "0.2.0", {
      registry: "https://shadow.example/oci",
      repository: "liorael/lenso-console-service",
      canonicalUrl: "https://console.example/0.2.0",
      fetch: request as typeof fetch,
    })).resolves.toEqual({ version: "0.2.0", digest: digest(manifest), publishedAt: "2026-07-30T08:00:00Z", canonicalUrl: "https://console.example/0.2.0" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]![0])).toContain("https://shadow.example/oci/v2/liorael/lenso-console-service/manifests/0.2.0");
  });

  it("fails closed on digest and version contradictions", async () => {
    const config = Buffer.from(JSON.stringify({ created: "2026-07-30T08:00:00Z", config: { Labels: { "org.opencontainers.image.version": "0.1.0" } } }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: digest(config) }, layers: [] }));
    const fetch = async (input: string | URL | Request) => String(input).includes("/manifests/")
      ? new Response(manifest, { headers: { "docker-content-digest": `sha256:${"f".repeat(64)}` } })
      : new Response(config);
    await expect(observeOciImage("lenso-console-service", "0.2.0", { fetch: fetch as typeof globalThis.fetch }))
      .resolves.toMatchObject({ failure: "schema" });
    const noHeader = async (input: string | URL | Request) => String(input).includes("/manifests/") ? new Response(manifest) : new Response(config);
    await expect(observeOciImage("lenso-console-service", "0.2.0", { fetch: noHeader as typeof globalThis.fetch }))
      .resolves.toEqual({ failure: "schema", detail: "OCI image config did not bind the requested version and creation time" });
  });

  it("distinguishes absence, transport failure, and timeout", async () => {
    await expect(observeOciImage("lenso-console-service", "0.2.0", { fetch: async () => new Response(null, { status: 404 }) }))
      .resolves.toMatchObject({ missing: true });
    await expect(observeOciImage("lenso-console-service", "0.2.0", { fetch: async () => { throw new Error("secret"); } }))
      .resolves.toEqual({ failure: "transport", detail: "OCI registry request failed" });
    await expect(observeOciImage("lenso-console-service", "0.2.0", { timeoutMs: 1, fetch: (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) }))
      .resolves.toEqual({ failure: "timeout", detail: "OCI registry request timed out" });
  });

  it("uses a same-origin anonymous bearer challenge for public GHCR images", async () => {
    const config = Buffer.from(JSON.stringify({ created: "2026-07-30T08:00:00Z", config: { Labels: { "org.opencontainers.image.version": "0.2.0" } } }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: digest(config) }, layers: [] }));
    let manifestAttempts = 0;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/token?")) return Response.json({ token: "public-token" });
      if (url.includes("/manifests/")) {
        manifestAttempts += 1;
        if (manifestAttempts === 1) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:liorael/lenso-console-service:pull"' } });
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer public-token");
        return new Response(manifest, { headers: { "docker-content-digest": digest(manifest) } });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer public-token");
      return new Response(config);
    });
    await expect(observeOciImage("lenso-console-service", "0.2.0", { fetch: request as typeof fetch }))
      .resolves.toMatchObject({ version: "0.2.0", digest: digest(manifest) });
    expect(request).toHaveBeenCalledTimes(4);
  });
});
