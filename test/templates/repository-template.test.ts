import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { syncRepositoryTemplate, type TemplateManifest } from "../../src/commands/sync-repository-template.js";
import type { ReleasePlanV1 } from "../../src/contracts/types.js";
import { canonicalBytes, sha256, type JsonValue } from "../../src/core/canonical.js";
import { executionRef } from "../../src/publisher/contract.js";
import { cargoVerificationOrder, consumePreflightProof, createPreflightProof, npmRegistryAuthentication, preflight, publicationOrder, publishSelected, stageCargoArchives } from "../../src/repository/runtime.js";

process.env.LENSO_RELEASE_MODE = "production";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const template = join(root, "templates/repository");
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => {
    const resolved = resolve(path); const prefix = `${resolve(tmpdir())}/lenso-template-test-`;
    if (!resolved.startsWith(prefix) || resolved === resolve(process.cwd()) || resolve(process.cwd()).startsWith(`${resolved}/`)) throw new Error(`refusing unsafe test cleanup: ${resolved}`);
    await rm(resolved, { recursive: true, force: true });
  }));
  await expect(lstat(root)).resolves.toMatchObject({});
});
async function temp(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "lenso-template-test-")); temporary.push(path); return path; }
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

describe("npm shadow registry authentication", () => {
  it("normalizes the registry and token scope to the same trailing-slash path", () => {
    expect(npmRegistryAuthentication("https://registry.example/npm")).toEqual({
      registry: "https://registry.example/npm/",
      authKey: "//registry.example/npm/:_authToken",
    });
  });

  it("rejects registry URLs that could redirect or disclose credentials", () => {
    expect(() => npmRegistryAuthentication("https://user:secret@registry.example/npm")).toThrow(/must not contain credentials/u);
    expect(() => npmRegistryAuthentication("https://registry.example/npm?target=other")).toThrow(/query parameters/u);
  });
});

async function assertVendorLicenses(modules: string): Promise<void> {
  const packages: string[] = [];
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const child of await readdir(join(modules, entry.name), { withFileTypes: true })) if (child.isDirectory()) packages.push(join(modules, entry.name, child.name));
    } else { packages.push(join(modules, entry.name)); }
  }
  for (const directory of packages) {
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; license?: string };
    if (!metadata.name || !metadata.license || !(await readdir(directory)).some((name) => /^(?:LICENSE|COPYING|NOTICE)(?:\.|$)/iu.test(name))) throw new Error(`missing vendored license: ${directory}`);
  }
}

describe("repository template workflow contracts", () => {
  it("pins every action, exposes exactly six non-secret inputs, and keeps npm auth shadow-scoped", async () => {
    const source = await readFile(join(template, ".github/workflows/publish.yml"), "utf8");
    const workflow = parse(source) as Record<string, any>;
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(["event_id", "plan_id", "plan_sha256", "release_commit", "packages_json", "nonce"]);
    expect(source).not.toMatch(/secrets\.NPM_TOKEN|registry-url/u);
    expect(source).toContain("NODE_AUTH_TOKEN: ${{ env.LENSO_RELEASE_MODE == 'shadow' && secrets.LENSO_SHADOW_NPM_TOKEN || '' }}");
    expect(source).toContain("LENSO_ATTESTATION_TOKEN: ${{ github.token }}");
    expect(source).toContain("fetch-depth: 0");
    expect(source).toContain("owner: ${{ github.repository_owner }}");
    expect(source).toContain("${{ github.event.repository.name }}");
    expect(source).toContain("lenso-release");
    expect(source).toContain("pnpm run --if-present build");
    expect(source.indexOf("pnpm run --if-present build")).toBeLessThan(source.indexOf("cli.js preflight"));
    expect(source).toContain("rust-lang/crates-io-auth-action@c6f97d42243bad5fab37ca0427f495c86d5b1a18");
    expect(source.indexOf("cli.js preflight")).toBeLessThan(source.indexOf("rust-lang/crates-io-auth-action"));
    expect(source.indexOf("cli.js consume-preflight")).toBeLessThan(source.indexOf("rust-lang/crates-io-auth-action"));
    for (const match of source.matchAll(/uses:\s*([^\s]+)/gu)) expect(match[1]).toMatch(/@[0-9a-f]{40}$/u);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.publish.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
  });

  it("uses scoped App authentication and prioritizes fresh intent over a retained plan", async () => {
    const source = await readFile(join(template, ".github/workflows/release-plan.yml"), "utf8");
    expect(source).toContain("x-access-token:${GH_TOKEN}");
    expect(source).toContain("ready-event.js");
    expect(source).toContain("owner: ${{ github.repository_owner }}");
    expect(source).toContain("${{ github.event.repository.name }}");
    expect(source).toContain("lenso-release");
    expect(source).toContain("if: ${{ hashFiles('.lenso-release/plan.json') != '' && hashFiles('.tegami/*.md') == '' }}");
    expect(source).toContain("if: ${{ hashFiles('.tegami/*.md') != '' }}");
    expect(source).toContain("if: ${{ steps.draft.outputs.created == 'true' }}");
    expect(source).toContain("cargo fetch --locked");
    expect(source).not.toContain("cache: pnpm");
    expect(source).toContain("curl --fail-with-body --proto '=https'");
    expect(source).not.toContain("--location-trusted");
    expect(source).toContain('remote_ref="$(git ls-remote --heads "$remote" "refs/heads/$BRANCH")"');
    expect(source).toContain('remote_oid="${remote_ref%%[[:space:]]*}"');
    expect(source).toContain('git fetch --no-tags "$remote" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"');
    expect(source).toContain('git push --force-with-lease="refs/heads/$BRANCH:$remote_oid"');
    expect(source.indexOf("git ls-remote --heads")).toBeLessThan(source.indexOf("git push --force-with-lease"));
    expect(source).not.toMatch(/github\.token|git push origin/u);
    expect(source).not.toMatch(/rm\s+.*plan\.json/u);
    for (const match of source.matchAll(/uses:\s*([^\s]+)/gu)) expect(match[1]).toMatch(/@[0-9a-f]{40}$/u);
  });

  it("keeps wrappers thin and the Cargo entrypoint fail-closed", async () => {
    expect(await readFile(join(template, "scripts/release-plan.mjs"), "utf8")).toContain("runtime/lib/repository/cli.js");
    expect(await readFile(join(template, "scripts/release-mode.mjs"), "utf8")).not.toContain("NPM_CONFIG_REGISTRY");
    const cargo = await readFile(join(template, "scripts/publish-cargo.sh"), "utf8");
    expect(cargo).toContain("official crates.io token action did not provide a token");
    await expect(execute("sh", ["-n", join(template, "scripts/publish-cargo.sh")])).resolves.toBeDefined();
    await expect(execute("sh", [join(template, "scripts/publish-cargo.sh")], { cwd: template, env: { PATH: process.env.PATH } })).rejects.toThrow();
    const bin = await temp(); await writeFile(join(bin, "node"), "#!/bin/sh\nexit 42\n"); await chmod(join(bin, "node"), 0o755);
    await expect(execute("sh", [join(template, "scripts/publish-cargo.sh")], { cwd: template, env: { PATH: `${bin}:${process.env.PATH}`, CARGO_REGISTRY_TOKEN: "short-lived" } })).rejects.toMatchObject({ code: 42 });
    await expect(lstat(join(template, ".lenso-release/runtime/node_modules/tegami/package.json"))).resolves.toMatchObject({});
  });

  it("retains license evidence for every vendored runtime package and contains no credential material", async () => {
    const modules = join(template, ".lenso-release/runtime/node_modules");
    await expect(assertVendorLicenses(modules)).resolves.toBeUndefined();
    const broken = await temp(); const packageDirectory = join(broken, "unscoped"); await mkdir(packageDirectory); await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "unscoped", license: "MIT" }));
    await expect(assertVendorLicenses(broken)).rejects.toThrow("missing vendored license");
    const manifest = await readFile(join(template, ".lenso-release/runtime/manifest.json"), "utf8");
    expect(manifest).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{20}|npm_[A-Za-z0-9]{20}/u);
  });
});

describe("transactional template synchronization", () => {
  it("installs deterministically, rejects manifest takeover and rolls back every partial write", async () => {
    const target = await temp();
    const installed = await syncRepositoryTemplate({ source: template, target });
    const before = await readFile(join(target, "scripts/release-plan.mjs"));
    await writeFile(join(target, "scripts/release-plan.mjs"), "forged\n");
    const forged = structuredClone(installed);
    forged.files.find(({ path }) => path === "scripts/release-plan.mjs")!.sha256 = sha256(Buffer.from("forged\n"));
    await writeFile(join(target, ".lenso-release/template-manifest.json"), `${JSON.stringify(forged)}\n`);
    await expect(syncRepositoryTemplate({ source: template, target, trustedPreviousManifests: [installed] })).rejects.toThrow("trusted upgrade catalog");

    await rm(target, { recursive: true, force: true }); await mkdir(target);
    const clean = await syncRepositoryTemplate({ source: template, target });
    await expect(syncRepositoryTemplate({ source: template, target, trustedPreviousManifests: [clean], failAfterWrites: 2 })).rejects.toThrow("injected sync failure");
    expect(await readFile(join(target, "scripts/release-plan.mjs"))).toEqual(before);
    expect(JSON.parse(await readFile(join(target, ".lenso-release/template-manifest.json"), "utf8"))).toEqual(clean);
  }, 20_000);

  it("rejects parent symlinks before the first mutation", async () => {
    const target = await temp(); const outside = await temp();
    await symlink(outside, join(target, ".github"));
    await expect(syncRepositoryTemplate({ source: template, target })).rejects.toThrow("symlink is forbidden");
    await expect(lstat(join(outside, "workflows/publish.yml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function repositoryFixture(): Promise<{ cwd: string; sourceCommit: string; releaseCommit: string; manifest: any }> {
  const cwd = await temp(); await cp(template, cwd, { recursive: true });
  await writeFile(join(cwd, ".lenso-release/config.json"), `${JSON.stringify({ schema: "lenso.repository-config.v1", repository: "LioRael/lenso-runtime-console" })}\n`);
  await execute("git", ["init", "-b", "main"], { cwd }); await execute("git", ["config", "user.email", "test@example.com"], { cwd }); await execute("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "generated.txt"), "generated\n"); await execute("git", ["add", "."], { cwd }); await execute("git", ["commit", "-m", "source"], { cwd });
  const sourceCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await writeFile(join(cwd, "reviewed.txt"), "reviewed\n"); await execute("git", ["add", "."], { cwd }); await execute("git", ["commit", "-m", "release"], { cwd });
  const releaseCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const manifestBytes = await readFile(join(cwd, ".lenso-release/runtime/manifest.json"));
  return { cwd, sourceCommit, releaseCommit, manifest: JSON.parse(manifestBytes.toString("utf8")) };
}

describe("publisher preflight execution gate", () => {
  it("publishes selected packages after their selected plan dependencies", () => {
    const service = { id: "cargo:lenso-service", version: "0.1.5" } as const;
    const autonomous = { id: "cargo:lenso-autonomous-service", version: "0.1.1" } as const;
    const plan = {
      packages: [
        { id: autonomous.id, dependencies: [{ id: service.id }] },
        { id: service.id, dependencies: [] },
      ],
    } as unknown as ReleasePlanV1;
    expect(publicationOrder(plan, [autonomous, service])).toEqual([service, autonomous]);

    plan.packages[1]!.dependencies = [{ id: autonomous.id }] as ReleasePlanV1["packages"][number]["dependencies"];
    expect(() => publicationOrder(plan, [autonomous, service])).toThrow("selected package dependency cycle");
  });

  it("materializes Cargo archives after the joint dry-run removes them", async () => {
    const cwd = await temp(); const bin = join(cwd, "bin"); const log = join(cwd, "cargo.log");
    await mkdir(bin); await mkdir(join(cwd, "target/package"), { recursive: true });
    await writeFile(join(cwd, "target/package/lenso-service-0.1.5.crate"), "stale");
    await writeFile(join(bin, "cargo"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif test "$1" = package; then\n  mkdir -p target/package\n  printf 'fresh-contracts' > target/package/lenso-contracts-0.3.8.crate\n  printf 'fresh-lenso-service' > target/package/lenso-service-0.1.5.crate\n  printf 'fresh-lenso-autonomous-service' > target/package/lenso-autonomous-service-0.1.1.crate\nfi\n`); await chmod(join(bin, "cargo"), 0o755);
    const service = { id: "cargo:lenso-service", version: "0.1.5" } as const;
    const autonomous = { id: "cargo:lenso-autonomous-service", version: "0.1.1" } as const;
    const contracts = { id: "cargo:lenso-contracts", version: "0.3.8" } as const;
    const testing = { id: "cargo:lenso-platform-testing", version: "0.1.2" } as const;
    const plan = { packages: [
      { id: autonomous.id, nextVersion: autonomous.version, dependencies: [{ id: service.id, source: "plan", resolvedVersion: service.version }] },
      { id: service.id, nextVersion: service.version, dependencies: [{ id: contracts.id, source: "plan", resolvedVersion: contracts.version }] },
      { id: contracts.id, nextVersion: contracts.version, dependencies: [] },
      { id: testing.id, nextVersion: testing.version, dependencies: [] },
    ] } as unknown as ReleasePlanV1;
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    try {
      await stageCargoArchives(cwd, plan, [autonomous, service]);
      expect(cargoVerificationOrder(plan, [autonomous, service])).toEqual([contracts, service, autonomous]);
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "publish --dry-run --locked --allow-dirty -p lenso-contracts -p lenso-service -p lenso-autonomous-service -p lenso-platform-testing",
        "package --locked --no-verify --allow-dirty -p lenso-contracts -p lenso-service -p lenso-autonomous-service -p lenso-platform-testing",
      ]);
      expect(await readFile(join(cwd, "target/package/lenso-service-0.1.5.crate"), "utf8")).toBe("fresh-lenso-service");
      expect(await readFile(join(cwd, "target/package/lenso-autonomous-service-0.1.1.crate"), "utf8")).toBe("fresh-lenso-autonomous-service");
    } finally { process.env.PATH = oldPath; }
  });

  it("accepts the exact reviewed runtime and rejects workflow, bundle and generated-file drift before publish", async () => {
    const fixture = await repositoryFixture();
    const workflow = await readFile(join(fixture.cwd, ".github/workflows/publish.yml")); const manifestBytes = await readFile(join(fixture.cwd, ".lenso-release/runtime/manifest.json"));
    const identity = {
      schema: "lenso.release-plan.v1" as const, repository: "LioRael/lenso-runtime-console", sourceCommit: fixture.sourceCommit, tegamiVersion: "1.2.5" as const,
      publisher: { workflow: ".github/workflows/publish.yml", workflowSha256: digest(workflow), sharedRevision: fixture.manifest.sourceRevision, sharedBundleSha256: digest(manifestBytes), runner: "ubuntu-24.04", node: process.version.slice(1), npm: "11.7.0", rust: "1.94.0" },
      generatedFiles: [{ path: "generated.txt", sha256: digest(Buffer.from("generated\n")) }],
      packages: [{ id: "npm:@lenso/runtime-console-api", previousVersion: "0.1.0", nextVersion: "0.1.1", bump: "patch" as const, releaseGroup: "console", userFacing: true, dependencies: [] }],
    };
    const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as unknown as JsonValue) as ReleasePlanV1["planId"] };
    const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`); await writeFile(join(fixture.cwd, ".lenso-release/plan.json"), planBytes);
    const bin = join(fixture.cwd, "fake-bin"); await mkdir(bin);
    for (const [name, body] of [["npm", "#!/bin/sh\necho 11.7.0\n"], ["rustc", "#!/bin/sh\necho 'rustc 1.94.0 (x)'\n"]] as const) { await writeFile(join(bin, name), body); await chmod(join(bin, name), 0o755); }
    const oldPath = process.env.PATH; const oldRunner = process.env.RUNNER_IMAGE; process.env.PATH = `${bin}:${oldPath}`; process.env.RUNNER_IMAGE = "ubuntu-24.04";
    const environment = { cwd: fixture.cwd, repository: plan.repository, releaseCommit: fixture.releaseCommit, githubSha: fixture.releaseCommit, refName: executionRef(plan.planId), workflowPath: plan.publisher.workflow, runId: "1", runUrl: `https://github.com/${plan.repository}/actions/runs/1`, githubToken: "redacted", eventId: `sha256:${"e".repeat(64)}`, nonce: "12345678-1234-4234-8234-123456789abc", planId: plan.planId, planSha256: digest(planBytes), packages: [{ id: plan.packages[0]!.id, version: plan.packages[0]!.nextVersion }] };
    try {
      await expect(preflight(environment)).resolves.toMatchObject({ planId: plan.planId });
      process.env.LENSO_RELEASE_MODE = "disabled"; await expect(preflight(environment)).rejects.toThrow("LENSO_RELEASE_MODE must be shadow or production"); process.env.LENSO_RELEASE_MODE = "production";
      await writeFile(join(fixture.cwd, ".lenso-release/config.json"), `${JSON.stringify({ schema: "lenso.repository-config.v1", repository: plan.repository, fixedGroups: { "lenso-cli": ["npm:@lenso/runtime-console-api", "cargo:lenso-cli"] } })}\n`);
      await expect(preflight(environment)).rejects.toThrow("fixed group lenso-cli must publish atomically");
      await writeFile(join(fixture.cwd, ".lenso-release/config.json"), `${JSON.stringify({ schema: "lenso.repository-config.v1", repository: plan.repository })}\n`);
      await writeFile(join(fixture.cwd, "generated.txt"), "tampered\n"); await expect(preflight(environment)).rejects.toThrow("generated file mismatch");
      await writeFile(join(fixture.cwd, "generated.txt"), "generated\n"); await writeFile(join(fixture.cwd, ".github/workflows/publish.yml"), `${workflow.toString()}# drift\n`); await expect(preflight(environment)).rejects.toThrow("workflow digest mismatch");
      await writeFile(join(fixture.cwd, ".github/workflows/publish.yml"), workflow); const manifest = JSON.parse(manifestBytes.toString("utf8")); manifest.sourceRevision = "f".repeat(40); await writeFile(join(fixture.cwd, ".lenso-release/runtime/manifest.json"), `${JSON.stringify(manifest)}\n`); await expect(preflight(environment)).rejects.toThrow("shared publisher revision mismatch");
    } finally { process.env.PATH = oldPath; process.env.RUNNER_IMAGE = oldRunner; }
  });

  it("recovers an already-published npm archive and enqueues a deterministic receipt", async () => {
    const fixture = await repositoryFixture();
    const workflow = await readFile(join(fixture.cwd, ".github/workflows/publish.yml")); const manifestBytes = await readFile(join(fixture.cwd, ".lenso-release/runtime/manifest.json"));
    const identity = { schema: "lenso.release-plan.v1" as const, repository: "LioRael/lenso-runtime-console", sourceCommit: fixture.sourceCommit, tegamiVersion: "1.2.5" as const,
      publisher: { workflow: ".github/workflows/publish.yml", workflowSha256: digest(workflow), sharedRevision: fixture.manifest.sourceRevision, sharedBundleSha256: digest(manifestBytes), runner: "ubuntu-24.04", node: process.version.slice(1), npm: "11.7.0", rust: "1.94.0" }, generatedFiles: [{ path: "generated.txt", sha256: digest(Buffer.from("generated\n")) }],
      packages: [{ id: "npm:@lenso/runtime-console-api", previousVersion: "0.1.0", nextVersion: "0.1.1", bump: "patch" as const, releaseGroup: "console", userFacing: true, dependencies: [] }] };
    const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as unknown as JsonValue) as ReleasePlanV1["planId"] }; const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`); await writeFile(join(fixture.cwd, ".lenso-release/plan.json"), planBytes);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519"); const requests: { method?: string; url?: string; body: string }[] = []; const archiveSource = join(fixture.cwd, "archive-source"); await mkdir(join(archiveSource, "package"), { recursive: true }); await writeFile(join(archiveSource, "package/package.json"), JSON.stringify({ name: "@lenso/runtime-console-api", version: "0.1.1" })); const packedSource = join(fixture.cwd, "runtime-console-api-0.1.1.tgz"); await execute("tar", ["-czf", packedSource, "package"], { cwd: archiveSource }); const archive = await readFile(packedSource); let base = "";
    const server = createServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { requests.push({ method: request.method, url: request.url, body }); response.setHeader("content-type", "application/json");
      if (request.url === "/artifact.tgz") { response.setHeader("content-type", "application/octet-stream"); response.end(archive); }
      else if (request.url?.startsWith("/registry/")) response.end(JSON.stringify({ time: { "0.1.1": "2026-07-11T00:00:00.000Z" }, versions: { "0.1.1": { dist: { integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`, tarball: "https://registry.npmjs.org/@lenso/runtime-console-api/-/runtime-console-api-0.1.1.tgz" } } } }));
      else if (request.url?.includes("/git/ref/tags/")) { response.statusCode = 404; response.end("{}"); }
      else if (request.url?.endsWith("/git/tags")) response.end(JSON.stringify({ sha: "a".repeat(40) }));
      else if (request.url?.endsWith("/git/refs")) response.end("{}");
      else if (request.url === "/preflight") { const bindingDigest = JSON.parse(body).bindingDigest; const issuedAt = new Date().toISOString(); response.end(JSON.stringify({ schema: "lenso.publisher-preflight-proof.v1", proofId: `sha256:${"a".repeat(64)}`, bindingDigest, issuedAt, expiresAt: new Date(Date.now() + 120_000).toISOString(), token: "signed-proof-token-signed-proof-token" })); }
      else if (request.url === "/consume") { const value = JSON.parse(body); const authorization = { schema: "lenso.publisher-authorization.v1", proofId: value.proof.proofId, bindingDigest: value.proof.bindingDigest, eventId: value.facts.eventId, nonce: value.facts.nonce, planId: value.facts.planId, releaseCommit: value.facts.releaseCommit, ref: value.facts.ref, expiresAt: value.proof.expiresAt, artifacts: value.artifacts }; const signature = sign(null, canonicalBytes(authorization), privateKey).toString("base64url"); response.end(JSON.stringify({ accepted: true, eventId: value.facts.eventId, proofId: value.proof.proofId, authorization, signature })); }
      else if (request.url === "/receipt") { response.statusCode = 202; response.end(JSON.stringify({ queued: true })); }
      else if (request.url === "/cleanup") { response.end(JSON.stringify({ accepted: true, planId: plan.planId })); }
      else { response.statusCode = 404; response.end("{}"); } }); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("server missing"); base = `http://127.0.0.1:${address.port}`;
    const bin = join(fixture.cwd, "fake-bin"); await mkdir(bin); const npmLog = join(fixture.cwd, "npm.log");
    const sri = `sha512-${createHash("sha512").update(archive).digest("base64")}`; const shasum = createHash("sha1").update(archive).digest("hex");
    await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$*" >> '${npmLog}'\nif test "$1" = "--version"; then echo 11.7.0; elif test "$1" = "pack"; then cp '${packedSource}' runtime-console-api-0.1.1.tgz; printf '%s\\n' '[{"filename":"runtime-console-api-0.1.1.tgz","name":"@lenso/runtime-console-api","version":"0.1.1","integrity":"${sri}","shasum":"${shasum}"}]'; else exit 0; fi\n`); await chmod(join(bin, "npm"), 0o755);
    await writeFile(join(bin, "rustc"), "#!/bin/sh\necho 'rustc 1.94.0 (x)'\n"); await chmod(join(bin, "rustc"), 0o755);
    await writeFile(join(bin, "gh"), "#!/bin/sh\necho 'https://github.com/LioRael/lenso-runtime-console/attestations/1'\n"); await chmod(join(bin, "gh"), 0o755);
    const saved = { PATH: process.env.PATH, RUNNER_IMAGE: process.env.RUNNER_IMAGE, npm: process.env.LENSO_NPM_REGISTRY_URL, proxy: process.env.LENSO_TEST_ARTIFACT_PROXY_URL, github: process.env.LENSO_GITHUB_API_URL, preflight: process.env.LENSO_COORDINATOR_PREFLIGHT_URL, consume: process.env.LENSO_COORDINATOR_PREFLIGHT_CONSUME_URL, publicKey: process.env.LENSO_PREFLIGHT_AUTHORITY_PUBLIC_KEY, receipt: process.env.LENSO_COORDINATOR_RECEIPT_URL, cleanup: process.env.LENSO_COORDINATOR_CLEANUP_URL, app: process.env.LENSO_APP_ID, attestation: process.env.LENSO_ATTESTATION_TOKEN };
    Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, RUNNER_IMAGE: "ubuntu-24.04", LENSO_NPM_REGISTRY_URL: `${base}/registry`, LENSO_TEST_ARTIFACT_PROXY_URL: `${base}/artifact.tgz`, LENSO_GITHUB_API_URL: base, LENSO_COORDINATOR_PREFLIGHT_URL: `${base}/preflight`, LENSO_COORDINATOR_PREFLIGHT_CONSUME_URL: `${base}/consume`, LENSO_PREFLIGHT_AUTHORITY_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }), LENSO_COORDINATOR_RECEIPT_URL: `${base}/receipt`, LENSO_COORDINATOR_CLEANUP_URL: `${base}/cleanup`, LENSO_APP_ID: "123", LENSO_ATTESTATION_TOKEN: "workflow-token" });
    const environment = { cwd: fixture.cwd, repository: plan.repository, releaseCommit: fixture.releaseCommit, githubSha: fixture.releaseCommit, refName: executionRef(plan.planId), workflowPath: plan.publisher.workflow, runId: "1", runUrl: `https://github.com/${plan.repository}/actions/runs/1`, githubToken: "app-token", eventId: `sha256:${"e".repeat(64)}`, nonce: "12345678-1234-4234-8234-123456789abc", planId: plan.planId, planSha256: digest(planBytes), packages: [{ id: plan.packages[0]!.id, version: plan.packages[0]!.nextVersion }] };
    try {
      await createPreflightProof(environment);
      const proofPath = join(fixture.cwd, ".lenso-release/preflight-proof.json"); const tampered = JSON.parse(await readFile(proofPath, "utf8")); tampered.bindingDigest = `sha256:${"f".repeat(64)}`; await writeFile(proofPath, JSON.stringify(tampered));
      await expect(consumePreflightProof(environment)).rejects.toThrow(/does not bind/u); expect(requests.filter(({ url }) => url === "/consume")).toHaveLength(0);
      await createPreflightProof(environment); await consumePreflightProof(environment);
      const markerPath = join(fixture.cwd, ".lenso-release/preflight-marker.json"); const marker = JSON.parse(await readFile(markerPath, "utf8")); const sealed = marker.authorization.artifacts[0]; const sealedPath = join(fixture.cwd, sealed.path); await rm(sealedPath); await writeFile(sealedPath, "attacker artifact"); await chmod(sealedPath, 0o400); const replaced = await lstat(sealedPath); sealed.sha256 = digest(Buffer.from("attacker artifact")); sealed.size = replaced.size; sealed.ino = replaced.ino; await chmod(markerPath, 0o600); await writeFile(markerPath, JSON.stringify(marker)); await chmod(markerPath, 0o400);
      await expect(publishSelected(environment)).rejects.toThrow(/server publish authorization signature/u); await rm(markerPath); await rm(dirname(sealedPath), { recursive: true, force: true });
      await createPreflightProof(environment); await consumePreflightProof(environment); const first = await publishSelected(environment);
      expect(first[0]?.receiptId).toMatch(/^sha256:/u); expect((await readFile(npmLog, "utf8")).split("\n").filter((line) => line.startsWith("publish")).every((line) => line.includes("--dry-run"))).toBe(true);
      await expect(publishSelected(environment)).rejects.toThrow(/sealed marker/u);
      expect(requests.filter(({ url }) => url === "/preflight")).toHaveLength(3); expect(requests.filter(({ url }) => url === "/consume")).toHaveLength(2); expect(requests.filter(({ url }) => url === "/receipt")).toHaveLength(1); expect(requests.filter(({ url }) => url === "/cleanup")).toHaveLength(0);
    } finally { server.close(); for (const [key, value] of Object.entries({ PATH: saved.PATH, RUNNER_IMAGE: saved.RUNNER_IMAGE, LENSO_NPM_REGISTRY_URL: saved.npm, LENSO_TEST_ARTIFACT_PROXY_URL: saved.proxy, LENSO_GITHUB_API_URL: saved.github, LENSO_COORDINATOR_PREFLIGHT_URL: saved.preflight, LENSO_COORDINATOR_PREFLIGHT_CONSUME_URL: saved.consume, LENSO_PREFLIGHT_AUTHORITY_PUBLIC_KEY: saved.publicKey, LENSO_COORDINATOR_RECEIPT_URL: saved.receipt, LENSO_COORDINATOR_CLEANUP_URL: saved.cleanup, LENSO_APP_ID: saved.app, LENSO_ATTESTATION_TOKEN: saved.attestation })) value === undefined ? delete process.env[key] : process.env[key] = value; }
  });
});
