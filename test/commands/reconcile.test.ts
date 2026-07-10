import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { assertReconciliationReport } from "../../src/contracts/validate.js";
import { observeCrateVersion } from "../../src/registry/crates.js";
import { observeNpmVersion } from "../../src/registry/npm.js";
import { observeGithubTag } from "../../src/registry/github.js";
import { observeCatalogFile, reconcileSnapshot, runReconcile, type ReconciliationSnapshot } from "../../src/commands/reconcile.js";

const known = ["npm:@lenso/auth-console"];
const sri = (byte: number) => `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
const snapshotMeta = { schema: "lenso.reconciliation-snapshot.v1" as const, asOf: "2026-07-11T00:00:00Z" };

describe("reconcileSnapshot", () => {
  it("blocks catalog versions missing from a registry", () => {
    const report = reconcileSnapshot({ ...snapshotMeta,
      known,
      source: { "npm:@lenso/auth-console": "0.1.4" },
      registry: { "npm:@lenso/auth-console": "0.1.3" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.4" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.4" },
      tag: { "npm:@lenso/auth-console": "0.1.4" },
    });
    expect(report.status).toBe("blocked");
    expect(report.issues.map(({ code }) => code)).toContain("catalog.registry-version-missing");
    expect(report.issues).toEqual([...report.issues].sort((left, right) => left.componentId.localeCompare(right.componentId) || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail)));
    expect(() => assertReconciliationReport(report)).not.toThrow();
  });

  it("classifies aligned truth", () => {
    const report = reconcileSnapshot({ ...snapshotMeta,
      known,
      source: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(1) } },
      registry: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(1) } },
      tag: { "npm:@lenso/auth-console": "0.1.3" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    });
    expect(report.status).toBe("aligned");
    expect(report.issues).toEqual([]);
  });

  it("classifies reconcilable source and catalog divergence as drift", () => {
    const report = reconcileSnapshot({ ...snapshotMeta,
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
    const report = reconcileSnapshot({ ...snapshotMeta,
      known,
      source: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(1) } },
      registry: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(2) } },
      tag: { "npm:@lenso/auth-console": "0.1.3" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    });
    expect(report.status).toBe("blocked");
    expect(report.issues.map(({ code }) => code)).toContain("registry.version-bytes-conflict");
  });

  it("fails observation when same-version safety evidence has no compatible digest", () => {
    const report = reconcileSnapshot({ schema: "lenso.reconciliation-snapshot.v1", asOf: "2026-07-11T00:00:00Z", known,
      source: { "npm:@lenso/auth-console": "0.1.3" },
      registry: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(1) } },
      tag: { "npm:@lenso/auth-console": "0.1.3" }, embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" }, workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    });
    expect(report.status).toBe("observation-failure");
    expect(report.issues.map(({ code }) => code)).toContain("observation.digest-evidence-missing");
  });

  it("classifies a missing immutable tag as drift and contradictory tag evidence as blocked", () => {
    const base = { schema: "lenso.reconciliation-snapshot.v1" as const, asOf: "2026-07-11T00:00:00Z", known,
      source: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(1) } },
      registry: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(1) } },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" }, workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    };
    expect(reconcileSnapshot({ ...base, tag: { "npm:@lenso/auth-console": { missing: true } } }).issues.map(({ code }) => code)).toContain("tag.missing");
    expect(reconcileSnapshot({ ...base, tag: { "npm:@lenso/auth-console": { version: "0.1.3", digest: sri(2) } } }).status).toBe("blocked");
  });

  it("rejects malformed and unknown snapshot observations fail closed", () => {
    expect(() => reconcileSnapshot({ ...snapshotMeta,
      known,
      source: { "npm:@lenso/auth-console": "0.1.3", "npm:@lenso/unknown": "0.1.0" },
      registry: { "npm:@lenso/auth-console": { failure: "transport", detail: "request failed" } },
      tag: { "npm:@lenso/auth-console": "not-semver" },
      embeddedCatalog: { "npm:@lenso/auth-console": "0.1.3" },
      workerCatalog: { "npm:@lenso/auth-console": "0.1.3" },
    })).toThrow(/unknown|invalid/u);
  });
});

describe("immutable registry observations", () => {
  it("uses an encoded npm package and exact version and validates the response", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/0.1.3") ? {
        name: "@lenso/auth-console", version: "0.1.3",
        dist: { integrity: sri(1), tarball: "https://registry.npmjs.org/t.tgz" },
      } : { time: { "0.1.3": "2026-07-11T00:00:00.000Z" } },
    ), { status: 200 }));
    const observed = await observeNpmVersion("@lenso/auth-console", "0.1.3", { fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/%40lenso%2Fauth-console/0.1.3");
    expect(observed).toMatchObject({ version: "0.1.3", digest: sri(1), publishedAt: "2026-07-11T00:00:00.000Z" });
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

  it("distinguishes crates 404 and transport failures and aborts timed-out npm/crates requests", async () => {
    const missing = await observeCrateVersion("lenso", "9.9.9", { fetch: async () => new Response("", { status: 404 }) });
    const transport = await observeCrateVersion("lenso", "9.9.9", { fetch: async () => { throw new Error("credential-shaped secret"); } });
    const waitForAbort: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const npmTimeout = await observeNpmVersion("pkg", "1.0.0", { fetch: waitForAbort, timeoutMs: 1 });
    const crateTimeout = await observeCrateVersion("lenso", "1.0.0", { fetch: waitForAbort, timeoutMs: 1 });
    expect(missing).toMatchObject({ missing: true });
    expect(transport).toEqual({ failure: "transport", detail: "registry request failed" });
    expect(npmTimeout).toMatchObject({ failure: "timeout" });
    expect(crateTimeout).toMatchObject({ failure: "timeout" });
  });

  it("rejects malformed npm integrity and timestamps and malformed crates timestamps", async () => {
    const npm = await observeNpmVersion("pkg", "1.0.0", { fetch: async () => new Response(JSON.stringify({ name: "pkg", version: "1.0.0", time: "not-a-time", dist: { integrity: "sha512-abc", tarball: "https://registry.npmjs.org/p.tgz" } })) });
    const crate = await observeCrateVersion("crate", "1.0.0", { fetch: async () => new Response(JSON.stringify({ version: { crate: "crate", num: "1.0.0", checksum: "a".repeat(64), created_at: "not-a-time" } })) });
    expect(npm).toMatchObject({ failure: "schema" });
    expect(crate).toMatchObject({ failure: "schema" });
  });

  it("observes exact public GitHub annotated tags and sanitizes failures", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/git/ref/")
      ? new Response(JSON.stringify({ ref: "refs/tags/%40lenso/auth-console%400.1.3", object: { type: "tag", sha: "a".repeat(40) } }))
      : new Response(JSON.stringify({ tag: "@lenso/auth-console@0.1.3", message: JSON.stringify({ schema: "lenso.component-receipt.v1", packageId: "npm:@lenso/auth-console", version: "0.1.3", registryIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, publishedAt: "2026-07-11T00:00:00Z" }) })));
    const result = await observeGithubTag("LioRael/lenso-auth-module", "@lenso/auth-console@0.1.3", "npm:@lenso/auth-console", "0.1.3", { fetch });
    expect(result).toMatchObject({ version: "0.1.3", digest: expect.stringMatching(/^sha512-/), canonicalUrl: expect.stringContaining("%40lenso%2Fauth-console%400.1.3") });
    expect(fetch.mock.calls[0]?.[0]).toContain("%40lenso%2Fauth-console%400.1.3");
  });

  it("normalizes a valid Cargo annotated receipt checksum and rejects malformed checksums", async () => {
    const checksum = "a".repeat(64);
    const response = (registryIntegrity: string) => vi.fn(async (input: RequestInfo | URL) => String(input).includes("/git/ref/")
      ? new Response(JSON.stringify({ object: { type: "tag", sha: "b".repeat(40) } }))
      : new Response(JSON.stringify({ tag: "lenso@0.1.0", message: JSON.stringify({ schema: "lenso.component-receipt.v1", packageId: "cargo:lenso", version: "0.1.0", registryIntegrity, publishedAt: "2026-07-11T00:00:00Z" }) })));
    const valid = await observeGithubTag("LioRael/lenso", "lenso@0.1.0", "cargo:lenso", "0.1.0", { fetch: response(checksum) });
    expect(valid).toMatchObject({ version: "0.1.0", digest: `sha256:${checksum}` });
    const malformed = await observeGithubTag("LioRael/lenso", "lenso@0.1.0", "cargo:lenso", "0.1.0", { fetch: response("A".repeat(64)) });
    expect(malformed).toMatchObject({ failure: "schema" });
  });

  it("distinguishes GitHub 404, HTTP, transport, and timeout without leaking errors", async () => {
    const args = ["LioRael/lenso", "lenso@1.0.0", "cargo:lenso", "1.0.0"] as const;
    expect(await observeGithubTag(...args, { fetch: async () => new Response("", { status: 404 }) })).toMatchObject({ missing: true });
    expect(await observeGithubTag(...args, { fetch: async () => new Response("", { status: 429 }) })).toEqual({ failure: "http", detail: "GitHub returned HTTP 429" });
    expect(await observeGithubTag(...args, { fetch: async () => { throw new Error("token=do-not-leak"); } })).toEqual({ failure: "transport", detail: "GitHub request failed" });
    const timeoutFetch: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("secret")), { once: true }));
    expect(await observeGithubTag(...args, { fetch: timeoutFetch, timeoutMs: 1 })).toMatchObject({ failure: "timeout" });
  });
});

describe("strict snapshot and catalog input", () => {
  it("distinguishes missing, malformed, wrong-shape, and valid empty catalogs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lenso-catalog-"));
    await expect(observeCatalogFile(join(directory, "missing.json"))).resolves.toMatchObject({ failure: "unavailable" });
    const invalid = join(directory, "invalid.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(invalid, "{"));
    await expect(observeCatalogFile(invalid)).resolves.toMatchObject({ failure: "schema" });
    const wrong = join(directory, "wrong.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(wrong, "{}"));
    await expect(observeCatalogFile(wrong)).resolves.toMatchObject({ failure: "schema" });
    const empty = join(directory, "empty.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(empty, '{"version":"1","modules":[]}'));
    await expect(observeCatalogFile(empty)).resolves.toEqual({ values: {} });
  });

  it("treats non-applicable surfaces as non-failures while unavailable remains exit 2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lenso-not-applicable-"));
    const aligned: ReconciliationSnapshot = {
      schema: "lenso.reconciliation-snapshot.v1", asOf: "2026-07-11T00:00:00Z",
      known: ["catalog:lenso-official-module-catalog"], nonPublishable: [],
      source: { "catalog:lenso-official-module-catalog": "1.0.0" },
      registry: { "catalog:lenso-official-module-catalog": { notApplicable: true } },
      tag: { "catalog:lenso-official-module-catalog": { notApplicable: true } },
      embeddedCatalog: { "catalog:lenso-official-module-catalog": { notApplicable: true } },
      workerCatalog: { "catalog:lenso-official-module-catalog": { notApplicable: true } },
    };
    const alignedPath = join(directory, "aligned.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(alignedPath, JSON.stringify(aligned)));
    expect(await runReconcile(["--snapshot", alignedPath, "--output", join(directory, "aligned.out")])).toBe(0);
    const report = reconcileSnapshot(aligned);
    expect(report.status).toBe("aligned");
    expect(report.components[0]?.registry.state).toBe("not-applicable");
    expect(() => assertReconciliationReport(report)).not.toThrow();
    const unavailable = structuredClone(aligned);
    unavailable.registry["catalog:lenso-official-module-catalog"] = { failure: "unavailable", detail: "observer unavailable" } as never;
    expect(reconcileSnapshot(unavailable).status).toBe("observation-failure");
  });

  it("rejects missing/wrong snapshot schema, invalid time, and unknown properties through exit 2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lenso-snapshot-"));
    for (const [name, value] of Object.entries({ missing: { asOf: "2026-07-11T00:00:00Z" }, wrong: { schema: "wrong", asOf: "2026-07-11T00:00:00Z" }, time: { schema: "lenso.reconciliation-snapshot.v1", asOf: "2026-02-31T00:00:00Z" }, extra: { schema: "lenso.reconciliation-snapshot.v1", asOf: "2026-07-11T00:00:00Z", extra: true } })) {
      const path = join(directory, `${name}.json`);
      await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(value)));
      expect(await runReconcile(["--snapshot", path, "--output", join(directory, `${name}.out`)])).toBe(2);
    }
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
