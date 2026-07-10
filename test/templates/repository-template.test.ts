import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { syncRepositoryTemplate, type TemplateManifest } from "../../src/commands/sync-repository-template.js";
import type { ReleasePlanV1 } from "../../src/contracts/types.js";
import { sha256, type JsonValue } from "../../src/core/canonical.js";
import { executionRef } from "../../src/publisher/contract.js";
import { preflight, publishSelected } from "../../src/repository/runtime.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const template = join(root, "templates/repository");
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temp(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "lenso-template-test-")); temporary.push(path); return path; }
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

describe("repository template workflow contracts", () => {
  it("pins every action, exposes exactly six non-secret inputs, and never provisions an npm token", async () => {
    const source = await readFile(join(template, ".github/workflows/publish.yml"), "utf8");
    const workflow = parse(source) as Record<string, any>;
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(["event_id", "plan_id", "plan_sha256", "release_commit", "packages_json", "nonce"]);
    expect(source).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|registry-url/u);
    expect(source).toContain("rust-lang/crates-io-auth-action@c6f97d42243bad5fab37ca0427f495c86d5b1a18");
    for (const match of source.matchAll(/uses:\s*([^\s]+)/gu)) expect(match[1]).toMatch(/@[0-9a-f]{40}$/u);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.publish.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
  });

  it("uses scoped App authentication for pushes and emits a ready event instead of cleaning optimistically", async () => {
    const source = await readFile(join(template, ".github/workflows/release-plan.yml"), "utf8");
    expect(source).toContain("x-access-token:${GH_TOKEN}");
    expect(source).toContain("ready-event.js");
    expect(source).not.toMatch(/github\.token|git push origin/u);
    expect(source).not.toMatch(/rm\s+.*plan\.json/u);
    for (const match of source.matchAll(/uses:\s*([^\s]+)/gu)) expect(match[1]).toMatch(/@[0-9a-f]{40}$/u);
  });

  it("keeps wrappers thin and the Cargo entrypoint fail-closed", async () => {
    expect(await readFile(join(template, "scripts/release-plan.mjs"), "utf8")).toContain("runtime/lib/repository/cli.js");
    const cargo = await readFile(join(template, "scripts/publish-cargo.sh"), "utf8");
    expect(cargo).toContain("official crates.io token action did not provide a token");
    await expect(execute("sh", ["-n", join(template, "scripts/publish-cargo.sh")])).resolves.toBeDefined();
    await expect(execute("sh", [join(template, "scripts/publish-cargo.sh")], { cwd: template, env: { PATH: process.env.PATH } })).rejects.toThrow();
    await expect(lstat(join(template, ".lenso-release/runtime/node_modules/tegami/package.json"))).resolves.toMatchObject({});
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
  });

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
  it("accepts the exact reviewed runtime and rejects workflow, bundle and generated-file drift before publish", async () => {
    const fixture = await repositoryFixture();
    const workflow = await readFile(join(fixture.cwd, ".github/workflows/publish.yml")); const manifestBytes = await readFile(join(fixture.cwd, ".lenso-release/runtime/manifest.json"));
    const identity = {
      schema: "lenso.release-plan.v1" as const, repository: "LioRael/lenso-runtime-console", sourceCommit: fixture.sourceCommit, tegamiVersion: "1.2.5" as const,
      publisher: { workflow: ".github/workflows/publish.yml", workflowSha256: digest(workflow), sharedRevision: fixture.manifest.sourceRevision, sharedBundleSha256: digest(manifestBytes), runner: "ubuntu-24.04", node: process.version.slice(1), npm: "11.7.0", rust: "1.92.0" },
      generatedFiles: [{ path: "generated.txt", sha256: digest(Buffer.from("generated\n")) }],
      packages: [{ id: "npm:@lenso/runtime-console-api", previousVersion: "0.1.0", nextVersion: "0.1.1", bump: "patch" as const, releaseGroup: "console", userFacing: true, dependencies: [] }],
    };
    const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as unknown as JsonValue) as ReleasePlanV1["planId"] };
    const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`); await writeFile(join(fixture.cwd, ".lenso-release/plan.json"), planBytes);
    const bin = join(fixture.cwd, "fake-bin"); await mkdir(bin);
    for (const [name, body] of [["npm", "#!/bin/sh\necho 11.7.0\n"], ["rustc", "#!/bin/sh\necho 'rustc 1.92.0 (x)'\n"]] as const) { await writeFile(join(bin, name), body); await chmod(join(bin, name), 0o755); }
    const oldPath = process.env.PATH; const oldRunner = process.env.RUNNER_IMAGE; process.env.PATH = `${bin}:${oldPath}`; process.env.RUNNER_IMAGE = "ubuntu-24.04";
    const environment = { cwd: fixture.cwd, repository: plan.repository, releaseCommit: fixture.releaseCommit, githubSha: fixture.releaseCommit, refName: executionRef(plan.planId), workflowPath: plan.publisher.workflow, runId: "1", runUrl: `https://github.com/${plan.repository}/actions/runs/1`, githubToken: "redacted", eventId: `sha256:${"e".repeat(64)}`, planId: plan.planId, planSha256: digest(planBytes), packages: [{ id: plan.packages[0]!.id, version: plan.packages[0]!.nextVersion }] };
    try {
      await expect(preflight(environment)).resolves.toMatchObject({ planId: plan.planId });
      await writeFile(join(fixture.cwd, "generated.txt"), "tampered\n"); await expect(preflight(environment)).rejects.toThrow("generated file mismatch");
      await writeFile(join(fixture.cwd, "generated.txt"), "generated\n"); await writeFile(join(fixture.cwd, ".github/workflows/publish.yml"), `${workflow.toString()}# drift\n`); await expect(preflight(environment)).rejects.toThrow("workflow digest mismatch");
      await writeFile(join(fixture.cwd, ".github/workflows/publish.yml"), workflow); const manifest = JSON.parse(manifestBytes.toString("utf8")); manifest.sourceRevision = "f".repeat(40); await writeFile(join(fixture.cwd, ".lenso-release/runtime/manifest.json"), `${JSON.stringify(manifest)}\n`); await expect(preflight(environment)).rejects.toThrow("shared publisher revision mismatch");
    } finally { process.env.PATH = oldPath; process.env.RUNNER_IMAGE = oldRunner; }
  });

  it("recovers an already-published npm archive, dispatches a deterministic receipt, and waits for verified cleanup", async () => {
    const fixture = await repositoryFixture();
    const workflow = await readFile(join(fixture.cwd, ".github/workflows/publish.yml")); const manifestBytes = await readFile(join(fixture.cwd, ".lenso-release/runtime/manifest.json"));
    const identity = { schema: "lenso.release-plan.v1" as const, repository: "LioRael/lenso-runtime-console", sourceCommit: fixture.sourceCommit, tegamiVersion: "1.2.5" as const,
      publisher: { workflow: ".github/workflows/publish.yml", workflowSha256: digest(workflow), sharedRevision: fixture.manifest.sourceRevision, sharedBundleSha256: digest(manifestBytes), runner: "ubuntu-24.04", node: process.version.slice(1), npm: "11.7.0", rust: "1.92.0" }, generatedFiles: [{ path: "generated.txt", sha256: digest(Buffer.from("generated\n")) }],
      packages: [{ id: "npm:@lenso/runtime-console-api", previousVersion: "0.1.0", nextVersion: "0.1.1", bump: "patch" as const, releaseGroup: "console", userFacing: true, dependencies: [] }] };
    const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as unknown as JsonValue) as ReleasePlanV1["planId"] }; const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`); await writeFile(join(fixture.cwd, ".lenso-release/plan.json"), planBytes);
    const requests: { method?: string; url?: string; body: string }[] = []; const archive = Buffer.from("reviewed archive"); let base = "";
    const server = createServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { requests.push({ method: request.method, url: request.url, body }); response.setHeader("content-type", "application/json");
      if (request.url === "/artifact.tgz") { response.setHeader("content-type", "application/octet-stream"); response.end(archive); }
      else if (request.url?.startsWith("/registry/")) response.end(JSON.stringify({ date: "2026-07-11T00:00:00.000Z", dist: { integrity: "sha512-ZmFrZQ==", tarball: `${base}/artifact.tgz` } }));
      else if (request.url?.includes("/git/ref/tags/")) { response.statusCode = 404; response.end("{}"); }
      else if (request.url?.endsWith("/git/tags")) response.end(JSON.stringify({ sha: "a".repeat(40) }));
      else if (request.url?.endsWith("/git/refs")) response.end("{}");
      else if (request.url === "/receipt") { const receiptId = JSON.parse(body).receipt.receiptId; response.end(JSON.stringify({ receiptId, planStatus: "verified" })); }
      else if (request.url === "/cleanup") { response.end(JSON.stringify({ accepted: true, planId: plan.planId })); }
      else { response.statusCode = 404; response.end("{}"); } }); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("server missing"); base = `http://127.0.0.1:${address.port}`;
    const bin = join(fixture.cwd, "fake-bin"); await mkdir(bin); const npmLog = join(fixture.cwd, "npm.log");
    await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$*" >> '${npmLog}'\necho 11.7.0\n`); await chmod(join(bin, "npm"), 0o755);
    await writeFile(join(bin, "rustc"), "#!/bin/sh\necho 'rustc 1.92.0 (x)'\n"); await chmod(join(bin, "rustc"), 0o755);
    await writeFile(join(bin, "gh"), "#!/bin/sh\necho 'https://github.com/LioRael/lenso-runtime-console/attestations/1'\n"); await chmod(join(bin, "gh"), 0o755);
    const saved = { PATH: process.env.PATH, RUNNER_IMAGE: process.env.RUNNER_IMAGE, npm: process.env.LENSO_NPM_REGISTRY_URL, github: process.env.LENSO_GITHUB_API_URL, receipt: process.env.LENSO_COORDINATOR_RECEIPT_URL, cleanup: process.env.LENSO_COORDINATOR_CLEANUP_URL, app: process.env.LENSO_APP_ID };
    Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, RUNNER_IMAGE: "ubuntu-24.04", LENSO_NPM_REGISTRY_URL: `${base}/registry`, LENSO_GITHUB_API_URL: base, LENSO_COORDINATOR_RECEIPT_URL: `${base}/receipt`, LENSO_COORDINATOR_CLEANUP_URL: `${base}/cleanup`, LENSO_APP_ID: "123" });
    const environment = { cwd: fixture.cwd, repository: plan.repository, releaseCommit: fixture.releaseCommit, githubSha: fixture.releaseCommit, refName: executionRef(plan.planId), workflowPath: plan.publisher.workflow, runId: "1", runUrl: `https://github.com/${plan.repository}/actions/runs/1`, githubToken: "app-token", eventId: `sha256:${"e".repeat(64)}`, planId: plan.planId, planSha256: digest(planBytes), packages: [{ id: plan.packages[0]!.id, version: plan.packages[0]!.nextVersion }] };
    try {
      const first = await publishSelected(environment); const second = await publishSelected(environment);
      expect(first[0]?.receiptId).toBe(second[0]?.receiptId); expect(await readFile(npmLog, "utf8")).not.toContain("publish");
      expect(requests.filter(({ url }) => url === "/receipt")).toHaveLength(2); expect(requests.filter(({ url }) => url === "/cleanup")).toHaveLength(2);
    } finally { server.close(); for (const [key, value] of Object.entries({ PATH: saved.PATH, RUNNER_IMAGE: saved.RUNNER_IMAGE, LENSO_NPM_REGISTRY_URL: saved.npm, LENSO_GITHUB_API_URL: saved.github, LENSO_COORDINATOR_RECEIPT_URL: saved.receipt, LENSO_COORDINATOR_CLEANUP_URL: saved.cleanup, LENSO_APP_ID: saved.app })) value === undefined ? delete process.env[key] : process.env[key] = value; }
  });
});
