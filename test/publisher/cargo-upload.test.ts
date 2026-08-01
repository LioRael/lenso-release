import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cargoRegistryTokenFor, uploadCargoArtifact, type RuntimeEnvironment } from "../../src/repository/runtime.js";

const servers: ReturnType<typeof createServer>[] = []; const directories: string[] = [];
const execute = promisify(execFileCallback);
afterEach(async () => { servers.splice(0).forEach((server) => server.close()); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); delete process.env.LENSO_CRATES_UPLOAD_URL; delete process.env.CARGO_REGISTRY_TOKEN; delete process.env.LENSO_CARGO_BOOTSTRAP_TOKEN; delete process.env.LENSO_CARGO_BOOTSTRAP_RECOVERY; delete process.env.LENSO_RELEASE_MODE; });
async function runtimeEnvironment(policy?: unknown): Promise<RuntimeEnvironment> {
  const cwd = await mkdtemp(join(tmpdir(), "lenso-cargo-bootstrap-")); directories.push(cwd);
  await execute("git", ["init", "-q"], { cwd }); await execute("git", ["config", "user.name", "Test"], { cwd }); await execute("git", ["config", "user.email", "test@example.com"], { cwd });
  if (policy) { await mkdir(join(cwd, ".lenso-release")); await writeFile(join(cwd, ".lenso-release", "cargo-bootstrap.json"), JSON.stringify(policy)); }
  else await writeFile(join(cwd, "README.md"), "fixture\n");
  await execute("git", ["add", "."], { cwd }); await execute("git", ["commit", "-qm", "fixture"], { cwd }); const releaseCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  return { cwd, repository: "LioRael/lenso", releaseCommit, githubSha: releaseCommit, refName: "release-execution/test", workflowPath: ".github/workflows/publish.yml", runId: "1", runUrl: "https://github.com/LioRael/lenso/actions/runs/1", githubToken: "github", eventId: "event", nonce: "nonce", planId: `sha256:${"b".repeat(64)}`, planSha256: `sha256:${"b".repeat(64)}`, packages: [{ id: "cargo:lenso-platform-provider", version: "0.1.4" }] };
}
describe("sealed Cargo upload", () => {
  it("uploads signed metadata framing plus exact crate bytes without workspace reads", async () => {
    let captured = Buffer.alloc(0); let authorization = ""; let userAgent = ""; const server = createServer((request, response) => { authorization = String(request.headers.authorization); userAgent = String(request.headers["user-agent"]); const chunks: Buffer[] = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { captured = Buffer.concat(chunks); response.setHeader("content-type", "application/json"); response.end("{}"); }); }); servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server"); process.env.LENSO_CRATES_UPLOAD_URL = `http://127.0.0.1:${address.port}/api/v1/crates/new`; process.env.CARGO_REGISTRY_TOKEN = "short-lived";
    const metadata = { name: "lenso-contracts", vers: "1.2.3", deps: [], features: {} }; const crate = Buffer.from("immutable crate bytes");
    await uploadCargoArtifact({ id: "cargo:lenso-contracts", version: "1.2.3" }, crate, metadata);
    const jsonLength = captured.readUInt32LE(0); const decoded = JSON.parse(captured.subarray(4, 4 + jsonLength).toString("utf8")); const crateLength = captured.readUInt32LE(4 + jsonLength); const uploaded = captured.subarray(8 + jsonLength);
    expect(decoded).toEqual(metadata); expect(crateLength).toBe(crate.length); expect(uploaded).toEqual(crate); expect(authorization).toBe("short-lived");
    expect(userAgent).toBe("lenso-release-publisher/1.0 (https://github.com/LioRael/lenso-release)");
  });
  it("uses the bootstrap token only for an exact reviewed first-publish selection", async () => {
    const environment = await runtimeEnvironment({ schema: "lenso.cargo-bootstrap.v1", packages: [{ id: "cargo:lenso-platform-provider", version: "0.1.4" }] });
    process.env.LENSO_RELEASE_MODE = "production"; process.env.CARGO_REGISTRY_TOKEN = "oidc"; process.env.LENSO_CARGO_BOOTSTRAP_TOKEN = "bootstrap";
    await expect(cargoRegistryTokenFor(environment, { id: "cargo:lenso-platform-provider", version: "0.1.4" })).resolves.toBe("bootstrap");
    await expect(cargoRegistryTokenFor(environment, { id: "cargo:lenso-platform-core", version: "0.1.20" })).resolves.toBe("oidc");
  });
  it("reads the bootstrap policy from the reviewed commit instead of the mutable worktree", async () => {
    const environment = await runtimeEnvironment({ schema: "lenso.cargo-bootstrap.v1", packages: [{ id: "cargo:lenso-platform-provider", version: "0.1.4" }] });
    await writeFile(join(environment.cwd, ".lenso-release", "cargo-bootstrap.json"), JSON.stringify({ schema: "lenso.cargo-bootstrap.v1", packages: [{ id: "cargo:lenso-platform-core", version: "0.1.20" }] }));
    process.env.LENSO_RELEASE_MODE = "production"; process.env.CARGO_REGISTRY_TOKEN = "oidc"; process.env.LENSO_CARGO_BOOTSTRAP_TOKEN = "bootstrap";
    await expect(cargoRegistryTokenFor(environment, { id: "cargo:lenso-platform-provider", version: "0.1.4" })).resolves.toBe("bootstrap");
    await expect(cargoRegistryTokenFor(environment, { id: "cargo:lenso-platform-core", version: "0.1.20" })).resolves.toBe("oidc");
  });
  it("binds a reviewed zero-write bootstrap recovery to the exact old plan", async () => {
    const environment = await runtimeEnvironment(); await mkdir(join(environment.cwd, ".lenso-release"));
    await writeFile(join(environment.cwd, ".lenso-release", "cargo-bootstrap-recovery.json"), JSON.stringify({ schema: "lenso.cargo-bootstrap-recovery.v1", planId: environment.planId, releaseCommit: environment.releaseCommit, packages: [{ id: "cargo:lenso-platform-provider", version: "0.1.4" }] }));
    await execute("git", ["add", "."], { cwd: environment.cwd }); await execute("git", ["commit", "-qm", "recovery policy"], { cwd: environment.cwd }); environment.githubSha = (await execute("git", ["rev-parse", "HEAD"], { cwd: environment.cwd })).stdout.trim();
    process.env.LENSO_RELEASE_MODE = "production"; process.env.CARGO_REGISTRY_TOKEN = "oidc"; process.env.LENSO_CARGO_BOOTSTRAP_TOKEN = "bootstrap"; process.env.LENSO_CARGO_BOOTSTRAP_RECOVERY = "production-zero-write";
    await expect(cargoRegistryTokenFor(environment, { id: "cargo:lenso-platform-provider", version: "0.1.4" })).resolves.toBe("bootstrap");
    await expect(cargoRegistryTokenFor(environment, { id: "cargo:lenso-platform-core", version: "0.1.20" })).resolves.toBe("oidc");
  });
  it("fails closed when an exact bootstrap selection has no bootstrap credential", async () => {
    const environment = await runtimeEnvironment({ schema: "lenso.cargo-bootstrap.v1", packages: [{ id: "cargo:lenso-platform-provider", version: "0.1.4" }] });
    process.env.LENSO_RELEASE_MODE = "production"; process.env.CARGO_REGISTRY_TOKEN = "oidc";
    await expect(cargoRegistryTokenFor(environment, { id: "cargo:lenso-platform-provider", version: "0.1.4" })).rejects.toThrow("Cargo bootstrap token is required");
  });
});
