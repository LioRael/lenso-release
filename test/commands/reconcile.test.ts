import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { assertReconciliationReport } from "../../src/contracts/validate.js";
import { observeCrateVersion } from "../../src/registry/crates.js";
import { observeNpmVersion } from "../../src/registry/npm.js";
import { reconcileSnapshot, runReconcile } from "../../src/commands/reconcile.js";

const known = ["npm:@lenso/auth-console"];

describe("reconcileSnapshot", () => {
  it("blocks catalog versions missing from a registry", () => {
    const report = reconcileSnapshot({
      known,
      source: { "npm:@lenso/auth-console": "0.1.4" },
      registry: { "npm:@lenso/auth-console": "0.1.3" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.4" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.4" },
      tag: { "npm:@lenso/auth-console": "0.1.4" },
    });
    expect(report.status).toBe("blocked");
    expect(report.issues.map(({ code }) => code)).toContain("catalog.registry-version-missing");
    expect(() => assertReconciliationReport(report)).not.toThrow();
  });

  it("classifies aligned truth", () => {
    const report = reconcileSnapshot({
      known,
      source: { "npm:@lenso/auth-console": { version: "0.1.3", digest: "sha512-abc" } },
      registry: { "npm:@lenso/auth-console": { version: "0.1.3", digest: "sha512-abc" } },
      tag: { "npm:@lenso/auth-console": "0.1.3" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    });
    expect(report.status).toBe("aligned");
    expect(report.issues).toEqual([]);
  });

  it("classifies reconcilable source and catalog divergence as drift", () => {
    const report = reconcileSnapshot({
      known,
      source: { "npm:@lenso/auth-console": "0.1.3" },
      registry: { "npm:@lenso/auth-console": "0.1.3" },
      tag: { "npm:@lenso/auth-console": "0.1.3" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.2" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    });
    expect(report.status).toBe("drift");
    expect(report.issues.map(({ code }) => code)).toContain("catalog.embedded-worker-mismatch");
  });

  it("blocks version reuse with conflicting bytes", () => {
    const report = reconcileSnapshot({
      known,
      source: { "npm:@lenso/auth-console": { version: "0.1.3", digest: "sha512-new" } },
      registry: { "npm:@lenso/auth-console": { version: "0.1.3", digest: "sha512-old" } },
      tag: { "npm:@lenso/auth-console": "0.1.3" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    });
    expect(report.status).toBe("blocked");
    expect(report.issues.map(({ code }) => code)).toContain("registry.version-bytes-conflict");
  });

  it("maps observation failures and malformed or unknown input to observation-failure", () => {
    const failed = reconcileSnapshot({
      known,
      source: { "npm:@lenso/auth-console": "0.1.3", "npm:@lenso/unknown": "0.1.0" },
      registry: { "npm:@lenso/auth-console": { failure: "transport", detail: "request failed" } },
      tag: { "npm:@lenso/auth-console": "not-semver" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    });
    expect(failed.status).toBe("observation-failure");
    expect(failed.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "observation.failed", "observation.malformed-version", "observation.unknown-component",
    ]));
  });
});

describe("immutable registry observations", () => {
  it("uses an encoded npm package and exact version and validates the response", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/0.1.3") ? {
        name: "@lenso/auth-console", version: "0.1.3",
        dist: { integrity: "sha512-abc", tarball: "https://registry.npmjs.org/t.tgz" },
      } : { time: { "0.1.3": "2026-07-11T00:00:00.000Z" } },
    ), { status: 200 }));
    const observed = await observeNpmVersion("@lenso/auth-console", "0.1.3", { fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/%40lenso%2Fauth-console/0.1.3");
    expect(observed).toMatchObject({ version: "0.1.3", digest: "sha512-abc", publishedAt: "2026-07-11T00:00:00.000Z" });
  });

  it("distinguishes npm 404, HTTP, schema, and transport failures", async () => {
    const missing = await observeNpmVersion("pkg", "1.0.0", { fetch: async () => new Response("", { status: 404 }) });
    const http = await observeNpmVersion("pkg", "1.0.0", { fetch: async () => new Response("oops", { status: 500 }) });
    const schema = await observeNpmVersion("pkg", "1.0.0", { fetch: async () => new Response("{}", { status: 200 }) });
    const transport = await observeNpmVersion("pkg", "1.0.0", { fetch: async () => { throw new Error("secret token"); } });
    expect(missing).toMatchObject({ missing: true });
    expect(http).toMatchObject({ failure: "http" });
    expect(schema).toMatchObject({ failure: "schema" });
    expect(transport).toEqual({ failure: "transport", detail: "registry request failed" });
  });

  it("captures crates checksum, publication time, and canonical URL", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ version: {
      crate: "lenso", num: "0.1.0", checksum: "a".repeat(64), created_at: "2026-07-11T00:00:00Z",
    } }), { status: 200 }));
    const observed = await observeCrateVersion("lenso", "0.1.0", { fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://crates.io/api/v1/crates/lenso/0.1.0");
    expect(observed).toMatchObject({ digest: `sha256:${"a".repeat(64)}`, canonicalUrl: "https://crates.io/crates/lenso/0.1.0" });
  });
});

it("writes a validated report atomically and returns status exit codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lenso-reconcile-"));
  const output = join(directory, "report.json");
  const exit = await runReconcile(["--snapshot", new URL("../fixtures/reconciliation/current-state.json", import.meta.url).pathname, "--output", output]);
  expect(exit).toBe(1);
  const report = JSON.parse(await readFile(output, "utf8"));
  expect(report.schema).toBe("lenso.reconciliation-report.v1");
  expect(() => assertReconciliationReport(report)).not.toThrow();
});
