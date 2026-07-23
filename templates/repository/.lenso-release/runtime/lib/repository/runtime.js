import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadComponents } from "../config/components.js";
import { assertComponentReceipt, assertReleasePlan } from "../contracts/validate.js";
import { canonicalBytes, sha256 } from "../core/canonical.js";
import { verifyPublisherContract } from "../publisher/contract.js";
import { exportReleasePlan } from "../tegami/export-plan.js";
const execFile = promisify(execFileCallback);
const OID = /^[0-9a-f]{40}$/u;
const PACKAGE = /^(cargo:[a-z0-9]+(?:-[a-z0-9]+)*|npm:@lenso\/[a-z0-9]+(?:-[a-z0-9]+)*|artifact:[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
function fail(message) { throw new Error(`repository runtime: ${message}`); }
function hash(bytes) { return sha256(bytes); }
export function npmRegistryAuthentication(registry) {
    const url = new URL(registry);
    if (url.username || url.password || url.search || url.hash)
        fail("npm registry URL must not contain credentials, query parameters, or a fragment");
    url.pathname = url.pathname.replace(/\/?$/u, "/");
    return { registry: url.toString(), authKey: `//${url.host}${url.pathname}:_authToken` };
}
function safeRelative(path) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === ".."))
        fail(`unsafe path ${path}`);
}
async function safeRead(root, path) {
    safeRelative(path);
    let current = resolve(root);
    for (const segment of path.split("/")) {
        current = join(current, segment);
        const info = await lstat(current);
        if (info.isSymbolicLink())
            fail(`symlink is forbidden: ${path}`);
    }
    if (!resolve(current).startsWith(`${resolve(root)}/`))
        fail(`path escaped root: ${path}`);
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
function parseJson(bytes, name) {
    try {
        return JSON.parse(Buffer.from(bytes).toString("utf8"));
    }
    catch (error) {
        throw new Error(`invalid ${name} JSON`, { cause: error });
    }
}
async function readRuntimeManifest(cwd) {
    const bytes = await safeRead(cwd, ".lenso-release/runtime/manifest.json");
    const manifest = parseJson(bytes, "runtime manifest");
    if (manifest.schema !== "lenso.repository-runtime.v1" || !OID.test(manifest.sourceRevision) || !Array.isArray(manifest.files))
        fail("invalid runtime manifest");
    let previous = "";
    for (const file of manifest.files) {
        safeRelative(file.path);
        if (file.path <= previous || !/^sha256:[0-9a-f]{64}$/u.test(file.sha256))
            fail("runtime manifest files must be sorted and digested");
        previous = file.path;
        if (hash(await safeRead(cwd, file.path)) !== file.sha256)
            fail(`runtime digest mismatch for ${file.path}`);
    }
    return { manifest, bytes };
}
function exactSelection(plan, selected) {
    if (selected.length === 0 || new Set(selected.map(({ id }) => id)).size !== selected.length)
        fail("empty or duplicate package selection");
    for (const item of selected) {
        if (!PACKAGE.test(item.id) || !VERSION.test(item.version))
            fail("invalid package selection");
        if (!plan.packages.some(({ id, nextVersion }) => id === item.id && nextVersion === item.version))
            fail(`package selection is not in plan: ${item.id}`);
    }
}
function selectedFixedGroup(config, selected) {
    const selectedIds = new Set(selected.map(({ id }) => id));
    const matching = Object.entries(config.fixedGroups ?? {}).filter(([, members]) => members.some((id) => selectedIds.has(id)));
    if (matching.length === 0)
        return undefined;
    if (matching.length !== 1)
        fail("package selection spans multiple fixed groups");
    const [name, members] = matching[0];
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || members.length < 2 || new Set(members).size !== members.length || members.some((id) => !PACKAGE.test(id)))
        fail("repository fixed group is invalid");
    if (selected.length !== members.length || members.some((id) => !selectedIds.has(id)))
        fail(`fixed group ${name} must publish atomically`);
    const versions = new Set(selected.map(({ version }) => version));
    if (versions.size !== 1)
        fail(`fixed group ${name} versions must match`);
    return { name, version: selected[0].version };
}
async function verifyReviewedComponents(cwd, plan) {
    const registry = await loadComponents(join(cwd, ".lenso-release/runtime/components.yaml"));
    for (const item of plan.packages) {
        const component = registry.packages[item.id];
        if (!component || component.repository !== plan.repository || !component.publishable || component.releaseGroup !== item.releaseGroup || component.userFacing !== item.userFacing)
            fail(`unreviewed component metadata: ${item.id}`);
        const allowed = new Set(component.dependencies);
        if (item.dependencies.some(({ id }) => !allowed.has(id)))
            fail(`unreviewed dependency edge: ${item.id}`);
    }
}
export async function preflight(environment) {
    if (process.env.LENSO_RELEASE_MODE !== "shadow" && process.env.LENSO_RELEASE_MODE !== "production")
        fail("LENSO_RELEASE_MODE must be shadow or production");
    if (!/^sha256:[0-9a-f]{64}$/u.test(environment.eventId) || !/^[0-9a-f-]{16,64}$/u.test(environment.nonce))
        fail("invalid event ID or nonce");
    if (!OID.test(environment.releaseCommit) || environment.githubSha !== environment.releaseCommit)
        fail("github.sha/release commit mismatch");
    const planBytes = await safeRead(environment.cwd, ".lenso-release/plan.json");
    if (hash(planBytes) !== environment.planSha256)
        fail("plan byte digest mismatch");
    const plan = parseJson(planBytes, "release plan");
    assertReleasePlan(plan);
    if (plan.planId !== environment.planId || plan.repository !== environment.repository)
        fail("plan identity mismatch");
    exactSelection(plan, environment.packages);
    const config = parseJson(await safeRead(environment.cwd, ".lenso-release/config.json"), "repository config");
    selectedFixedGroup(config, environment.packages);
    const runtime = await readRuntimeManifest(environment.cwd);
    const workflowBytes = await safeRead(environment.cwd, environment.workflowPath);
    verifyPublisherContract(plan, {
        repository: environment.repository,
        workflowPath: environment.workflowPath,
        workflowSha256: hash(workflowBytes),
        sharedRevision: runtime.manifest.sourceRevision,
        sharedBundleSha256: hash(runtime.bytes),
        executionRef: environment.refName,
        executionRefTip: environment.releaseCommit,
        githubSha: environment.githubSha,
        runner: process.env.RUNNER_IMAGE ?? "ubuntu-24.04",
        node: process.version.slice(1),
        npm: (await execFile("npm", ["--version"])).stdout.trim(),
        rust: (await execFile("rustc", ["--version"])).stdout.trim().split(" ")[1] ?? "",
        planId: environment.planId,
        sourceCommit: plan.sourceCommit,
        releaseCommit: environment.releaseCommit,
        sourceCommitRepository: environment.repository,
        releaseCommitRepository: environment.repository,
        releaseCommitContainsSourceCommit: (await execFile("git", ["merge-base", "--is-ancestor", plan.sourceCommit, environment.releaseCommit], { cwd: environment.cwd }).then(() => true, () => false)),
        packages: environment.packages,
    });
    for (const generated of plan.generatedFiles)
        if (hash(await safeRead(environment.cwd, generated.path)) !== generated.sha256)
            fail(`generated file mismatch: ${generated.path}`);
    await verifyReviewedComponents(environment.cwd, plan);
    return plan;
}
async function gateBinding(environment) {
    const plan = await preflight(environment);
    const generated = await Promise.all(plan.generatedFiles.map(async ({ path }) => ({ path, sha256: hash(await safeRead(environment.cwd, path)) })));
    const binding = {
        eventId: environment.eventId, nonce: environment.nonce, planId: environment.planId, planSha256: environment.planSha256,
        repository: environment.repository, releaseCommit: environment.releaseCommit, ref: environment.refName,
        workflowSha256: hash(await safeRead(environment.cwd, environment.workflowPath)),
        runtimeManifestSha256: hash(await safeRead(environment.cwd, ".lenso-release/runtime/manifest.json")),
        packages: environment.packages, generated: generated,
    };
    return { plan, binding, digest: sha256(binding) };
}
async function writeProof(cwd, proof) {
    const directory = join(cwd, ".lenso-release");
    await mkdir(directory, { recursive: false }).catch((error) => { if (error.code !== "EEXIST")
        throw error; });
    const target = join(directory, "preflight-proof.json");
    const temporary = join(directory, `.preflight-proof-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        await handle.writeFile(Buffer.concat([canonicalBytes(proof), Buffer.from("\n")]));
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temporary, target);
}
export async function createPreflightProof(environment) {
    const { plan, binding, digest } = await gateBinding(environment);
    await stageCargoArchives(environment.cwd, plan, environment.packages);
    const endpoint = process.env.LENSO_COORDINATOR_PREFLIGHT_URL;
    if (!endpoint)
        fail("coordinator preflight endpoint is required");
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${environment.githubToken}`, "content-type": "application/json", "idempotency-key": environment.eventId }, body: JSON.stringify({ schema: "lenso.publisher-preflight.v1", binding, bindingDigest: digest }) });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        fail(`coordinator preflight confirmation ${response.status}: ${detail}`);
    }
    const proof = await response.json();
    const now = Date.now();
    const issued = Date.parse(proof.issuedAt);
    const expires = Date.parse(proof.expiresAt);
    if (proof.schema !== "lenso.publisher-preflight-proof.v1" || !/^sha256:[0-9a-f]{64}$/u.test(proof.proofId) || proof.bindingDigest !== digest || typeof proof.token !== "string" || proof.token.length < 32 || !Number.isFinite(issued) || !Number.isFinite(expires) || issued < now - 30_000 || issued > now + 30_000 || expires <= now || expires > now + 300_000)
        fail("invalid coordinator preflight proof");
    await writeProof(environment.cwd, proof);
    return proof;
}
export async function consumePreflightProof(environment) {
    const { digest } = await gateBinding(environment);
    let proofBytes;
    try {
        proofBytes = await safeRead(environment.cwd, ".lenso-release/preflight-proof.json");
    }
    catch (error) {
        if (error.code === "ENOENT")
            fail("preflight proof is missing or already consumed");
        throw error;
    }
    const proof = parseJson(proofBytes, "preflight proof");
    if (proof.schema !== "lenso.publisher-preflight-proof.v1" || proof.bindingDigest !== digest || Date.parse(proof.expiresAt) <= Date.now())
        fail("preflight proof is stale or does not bind this execution");
    const artifactDirectory = join(environment.cwd, ".lenso-release/preflight-artifacts", proof.proofId.slice(7));
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    const artifacts = [];
    for (const item of environment.packages) {
        const packed = await packedArtifact(environment.cwd, item);
        const destination = join(artifactDirectory, basename(packed.path));
        await copyFile(packed.path, destination, constants.COPYFILE_EXCL);
        await chmod(destination, 0o400);
        const info = await stat(destination);
        if (!info.isFile() || info.nlink !== 1)
            fail("sealed artifact is not an isolated regular file");
        if (item.id.startsWith("npm:"))
            await execFile("npm", ["publish", destination, "--dry-run", "--ignore-scripts"], { cwd: environment.cwd });
        const name = item.id.startsWith("npm:@lenso/") ? item.id.slice("npm:@lenso/".length) : item.id.slice(item.id.indexOf(":") + 1);
        const kind = item.id.startsWith("npm:") ? "npm" : item.id.startsWith("cargo:") ? "cargo" : "artifact";
        const cargoMetadata = kind === "cargo" ? await cargoWireMetadataFromCrate(destination, name, item.version) : null;
        artifacts.push({ id: item.id, name, version: item.version, kind, path: relative(environment.cwd, destination), sha256: hash(packed.bytes), size: info.size, ino: info.ino, mode: 0o400, cargoMetadata, cargoMetadataSha256: cargoMetadata ? sha256(cargoMetadata) : null });
    }
    const endpoint = process.env.LENSO_COORDINATOR_PREFLIGHT_CONSUME_URL;
    if (!endpoint)
        fail("coordinator proof consumption endpoint is required");
    const facts = { eventId: environment.eventId, nonce: environment.nonce, planId: environment.planId, releaseCommit: environment.releaseCommit, ref: environment.refName };
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${environment.githubToken}`, "content-type": "application/json", "idempotency-key": proof.proofId }, body: JSON.stringify({ proof, facts, artifacts }) });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        fail(`coordinator preflight proof consumption ${response.status}: ${detail}`);
    }
    const confirmation = await response.json();
    if (confirmation.accepted !== true || confirmation.eventId !== environment.eventId || confirmation.proofId !== proof.proofId || !confirmation.authorization || typeof confirmation.signature !== "string")
        fail("coordinator preflight proof was not atomically consumed");
    verifyAuthorization(confirmation.authorization, confirmation.signature, digest, environment, artifacts);
    const marker = { schema: "lenso.publisher-sealed-marker.v1", authorization: confirmation.authorization, signature: confirmation.signature };
    await writeSealedMarker(environment.cwd, marker);
    await rm(join(environment.cwd, ".lenso-release/preflight-proof.json"), { force: true });
    return marker;
}
export async function stageCargoArchives(cwd, plan, selected) {
    const cargoPackages = publicationOrder(plan, selected).filter(({ id }) => id.startsWith("cargo:"));
    if (cargoPackages.length === 0)
        return;
    const materializationPackages = publicationOrder(plan, plan.packages
        .filter(({ id }) => id.startsWith("cargo:"))
        .map(({ id, nextVersion }) => ({ id, version: nextVersion })));
    const planArgs = materializationPackages.flatMap(({ id }) => ["-p", id.slice(6)]);
    // One Cargo invocation creates a temporary local registry containing all
    // planned packages, so same-plan dependencies and workspace dev-dependencies
    // can be verified without weakening the no-write preflight boundary.
    await execFile("cargo", ["publish", "--dry-run", "--locked", "--allow-dirty", ...planArgs], { cwd });
    // Cargo removes archives produced by `publish --dry-run`. Materialize the
    // already-verified source in one dependency-aware invocation as well. Use
    // every Cargo package in the plan because `cargo package` also resolves
    // workspace dev-dependencies that are intentionally absent from the
    // publication DAG and may exist only in the shadow registry.
    for (const item of cargoPackages) {
        const name = item.id.slice(6);
        const path = join(cwd, "target/package", `${name}-${item.version}.crate`);
        await rm(path, { force: true });
    }
    await execFile("cargo", ["package", "--locked", "--no-verify", "--allow-dirty", ...planArgs], { cwd });
    for (const item of cargoPackages) {
        const name = item.id.slice(6);
        const path = join(cwd, "target/package", `${name}-${item.version}.crate`);
        const info = await lstat(path).catch((error) => { if (error.code === "ENOENT")
            fail(`Cargo did not materialize archive: ${name} ${item.version}`); throw error; });
        if (!info.isFile() || info.nlink !== 1)
            fail(`Cargo archive is not an isolated regular file: ${name} ${item.version}`);
    }
}
export function cargoVerificationOrder(plan, selected) {
    const packagesById = new Map(plan.packages.map((item) => [item.id, item]));
    const visiting = new Set();
    const visited = new Set();
    const ordered = [];
    const visit = (item) => {
        if (visited.has(item.id))
            return;
        if (visiting.has(item.id))
            fail(`selected package dependency cycle: ${item.id}`);
        const planned = packagesById.get(item.id);
        if (!planned)
            fail(`selected package missing from plan: ${item.id}`);
        visiting.add(item.id);
        for (const dependency of planned.dependencies) {
            if (dependency.source !== "plan" || !dependency.id.startsWith("cargo:"))
                continue;
            const plannedDependency = packagesById.get(dependency.id);
            if (!plannedDependency || plannedDependency.nextVersion !== dependency.resolvedVersion)
                fail(`planned Cargo dependency is missing or inconsistent: ${dependency.id}`);
            visit({ id: plannedDependency.id, version: plannedDependency.nextVersion });
        }
        visiting.delete(item.id);
        visited.add(item.id);
        ordered.push(item);
    };
    for (const item of selected)
        visit(item);
    return ordered;
}
async function writeSealedMarker(cwd, marker) {
    const path = join(cwd, ".lenso-release/preflight-marker.json");
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try {
        await handle.writeFile(Buffer.concat([canonicalBytes(marker), Buffer.from("\n")]));
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function consumeSealedMarker(environment) {
    const { plan, digest } = await gateBinding(environment);
    const path = join(environment.cwd, ".lenso-release/preflight-marker.json");
    let bytes;
    try {
        bytes = await safeRead(environment.cwd, ".lenso-release/preflight-marker.json");
    }
    catch (error) {
        if (error.code === "ENOENT")
            fail("sealed marker is missing or already consumed");
        throw error;
    }
    const marker = parseJson(bytes, "sealed marker");
    if (marker.schema !== "lenso.publisher-sealed-marker.v1")
        fail("sealed marker binding is invalid");
    verifyAuthorization(marker.authorization, marker.signature, digest, environment, marker.authorization.artifacts);
    const artifacts = new Map();
    for (const binding of marker.authorization.artifacts) {
        const artifactBytes = await safeRead(environment.cwd, binding.path);
        const info = await stat(join(environment.cwd, binding.path));
        if (info.ino !== binding.ino || info.size !== binding.size || info.mode % 0o1000 !== 0o400 || info.nlink !== 1 || hash(artifactBytes) !== binding.sha256)
            fail("sealed artifact changed after OIDC authorization");
        artifacts.set(`${binding.id}\0${binding.version}`, { path: join(environment.cwd, binding.path), bytes: artifactBytes, cargoMetadata: binding.cargoMetadata });
    }
    if (artifacts.size !== environment.packages.length)
        fail("sealed artifact selection mismatch");
    await rm(path, { force: true });
    return { plan, artifacts };
}
function verifyAuthorization(authorization, signature, digest, environment, artifacts) {
    const publicKey = process.env.LENSO_PREFLIGHT_AUTHORITY_PUBLIC_KEY;
    if (!publicKey)
        fail("preflight authority public key is required");
    if (authorization.schema !== "lenso.publisher-authorization.v1" || authorization.bindingDigest !== digest || authorization.eventId !== environment.eventId || authorization.nonce !== environment.nonce || authorization.planId !== environment.planId || authorization.releaseCommit !== environment.releaseCommit || authorization.ref !== environment.refName || Date.parse(authorization.expiresAt) <= Date.now() || !canonicalBytes(authorization.artifacts).equals(canonicalBytes(artifacts)) || !verifySignature(null, canonicalBytes(authorization), createPublicKey(publicKey), Buffer.from(signature, "base64url")))
        fail("server publish authorization signature is invalid");
}
async function cargoWireMetadataFromCrate(cratePath, name, version) {
    const directory = await mkdtemp(join(tmpdir(), "lenso-crate-metadata-"));
    try {
        await execFile("tar", ["-xzf", cratePath, "-C", directory]);
        const roots = await readdir(directory);
        if (roots.length !== 1 || roots[0] !== `${name}-${version}`)
            fail("Cargo archive root identity mismatch");
        const manifest = join(directory, roots[0], "Cargo.toml");
        const metadata = JSON.parse((await execFile("cargo", ["metadata", "--manifest-path", manifest, "--no-deps", "--format-version", "1"])).stdout);
        const pkg = metadata.packages?.find((entry) => entry.name === name && entry.version === version);
        if (!pkg)
            fail("Cargo sealed manifest identity mismatch");
        return cargoWireMetadata(pkg, name, version);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
function cargoWireMetadata(pkg, name, version) {
    return { name, vers: version, deps: pkg.dependencies ?? [], features: pkg.features ?? {}, authors: pkg.authors ?? [], description: pkg.description ?? null, documentation: pkg.documentation ?? null, homepage: pkg.homepage ?? null, readme: pkg.readme ?? null, keywords: pkg.keywords ?? [], categories: pkg.categories ?? [], license: pkg.license ?? null, license_file: pkg.license_file ?? null, repository: pkg.repository ?? null, badges: {}, links: pkg.links ?? null, rust_version: pkg.rust_version ?? null };
}
async function requestJson(url, init) {
    const response = await fetch(url, { ...init, redirect: "error" });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}
async function npmObservation(name, version) {
    const base = process.env.LENSO_NPM_REGISTRY_URL ?? "https://registry.npmjs.org";
    const encoded = name.replace("/", "%2f");
    const { response, body } = await requestJson(`${base}/${encoded}`);
    if (response.status === 404)
        return { exists: false };
    if (!response.ok)
        fail(`npm registry observation ${response.status}`);
    const metadata = body.versions?.[version];
    if (!metadata)
        return { exists: false };
    const dist = metadata.dist;
    const tarball = String(dist?.tarball ?? "");
    const integrity = String(dist?.integrity ?? "");
    const publishedAt = String(body.time?.[version] ?? "");
    if (!tarball || !integrity || !publishedAt)
        fail("npm registry observation incomplete");
    const artifactUrl = process.env.LENSO_TEST_ARTIFACT_PROXY_URL || tarball;
    if (process.env.LENSO_TEST_ARTIFACT_PROXY_URL && process.env.NODE_ENV !== "test")
        fail("artifact proxy is test-only");
    const artifact = await fetch(artifactUrl, { redirect: "error" });
    if (!artifact.ok)
        fail(`npm tarball fetch ${artifact.status}`);
    return { exists: true, bytes: new Uint8Array(await artifact.arrayBuffer()), integrity, url: tarball, publishedAt };
}
async function cargoObservation(name, version) {
    const base = process.env.LENSO_CRATES_API_URL ?? "https://crates.io";
    const { response, body } = await requestJson(`${base}/api/v1/crates/${encodeURIComponent(name)}/${version}`);
    if (response.status === 404)
        return { exists: false };
    if (!response.ok)
        fail(`crates registry observation ${response.status}`);
    const crate = body.version;
    const checksum = String(crate?.checksum ?? "");
    const publishedAt = String(crate?.created_at ?? "");
    const download = `${base}/api/v1/crates/${encodeURIComponent(name)}/${version}/download`;
    const artifact = await fetch(download, { redirect: "error" });
    if (!artifact.ok || !checksum || !publishedAt)
        fail("crates registry observation incomplete");
    return { exists: true, bytes: new Uint8Array(await artifact.arrayBuffer()), integrity: checksum, url: download, publishedAt };
}
async function artifactObservation(name, version, environment) {
    const api = process.env.LENSO_GITHUB_API_URL ?? "https://api.github.com";
    const headers = { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json" };
    const release = await fetch(`${api}/repos/${environment.repository}/releases/tags/${encodeURIComponent(`v${version}`)}`, { headers, redirect: "error" });
    if (release.status === 404)
        return { exists: false };
    if (!release.ok)
        fail(`hosted artifact release observation ${release.status}`);
    const body = await release.json();
    if (body.draft !== true || !body.created_at)
        fail("hosted artifact release must remain a verified draft");
    const assetName = `${name}.tar.gz`;
    const asset = body.assets?.find(({ name: candidate }) => candidate === assetName);
    const checksumAsset = body.assets?.find(({ name: candidate }) => candidate === `${assetName}.sha256`);
    if (!asset || !checksumAsset)
        return { exists: false };
    if (!asset.url || !asset.browser_download_url || !checksumAsset.url)
        fail("hosted artifact release asset is incomplete");
    const download = await fetch(asset.url, { headers: { ...headers, accept: "application/octet-stream" }, redirect: "error" });
    if (!download.ok)
        fail(`hosted artifact download ${download.status}`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    const checksum = await fetch(checksumAsset.url, { headers: { ...headers, accept: "application/octet-stream" }, redirect: "error" });
    if (!checksum.ok)
        fail(`hosted artifact checksum download ${checksum.status}`);
    const expectedChecksum = `${hash(bytes).slice("sha256:".length)}  ${assetName}\n`;
    if (Buffer.from(await checksum.arrayBuffer()).toString("utf8") !== expectedChecksum)
        fail("hosted artifact checksum contradicts archive");
    return { exists: true, bytes, integrity: hash(bytes), url: asset.browser_download_url, publishedAt: body.created_at };
}
async function npmWorkspaceDirectory(cwd, name) {
    const matches = [];
    const visit = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                if ([".git", ".lenso-release", "dist", "node_modules", "target"].includes(entry.name))
                    continue;
                await visit(join(directory, entry.name));
            }
            else if (entry.name === "package.json") {
                const path = join(directory, entry.name);
                const manifest = parseJson(await readFile(path), "npm workspace manifest");
                if (manifest.name === name)
                    matches.push(directory);
            }
        }
    };
    await visit(cwd);
    if (matches.length !== 1)
        fail(`npm workspace package is missing or ambiguous: ${name}`);
    return matches[0];
}
async function packedArtifact(cwd, item) {
    if (item.id.startsWith("npm:")) {
        if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN)
            fail("npm token fallback is forbidden");
        const name = item.id.slice(4);
        const packageDirectory = await npmWorkspaceDirectory(cwd, name);
        const { stdout } = await execFile("npm", ["pack", packageDirectory, "--json", "--ignore-scripts"], { cwd });
        const result = JSON.parse(stdout);
        const packed = result[0];
        if (result.length !== 1 || !packed || packed.name !== name || packed.version !== item.version || basename(packed.filename) !== packed.filename || !/^[a-z0-9][a-z0-9._-]*\.tgz$/u.test(packed.filename) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(packed.integrity) || !/^[0-9a-f]{40}$/u.test(packed.shasum))
            fail("npm archive identity mismatch");
        const path = join(cwd, packed.filename);
        const bytes = await readFile(path);
        const sri = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        const shasum = createHash("sha1").update(bytes).digest("hex");
        if (sri !== packed.integrity || shasum !== packed.shasum)
            fail("npm archive digest mismatch");
        const manifest = JSON.parse((await execFile("tar", ["-xOf", path, "package/package.json"])).stdout);
        if (manifest.name !== name || manifest.version !== item.version)
            fail("npm archive manifest identity mismatch");
        return { path, bytes };
    }
    if (item.id.startsWith("artifact:")) {
        const config = parseJson(await safeRead(cwd, ".lenso-release/config.json"), "repository config");
        const artifact = config.artifacts?.[item.id];
        if (!artifact)
            fail(`hosted artifact configuration is missing: ${item.id}`);
        safeRelative(artifact.path);
        const path = join(cwd, artifact.path);
        const bytes = await safeRead(cwd, artifact.path);
        const manifest = JSON.parse((await execFile("tar", ["-xOf", path, "./manifest.json"])).stdout);
        if (manifest.name !== item.id.slice("artifact:".length) || manifest.version !== item.version)
            fail("hosted artifact manifest identity mismatch");
        return { path, bytes };
    }
    const name = item.id.slice(6);
    const path = join(cwd, "target/package", `${name}-${item.version}.crate`);
    return { path, bytes: await readFile(path) };
}
export function publicationOrder(plan, selected) {
    const selectedById = new Map(selected.map((item) => [item.id, item]));
    const packagesById = new Map(plan.packages.map((item) => [item.id, item]));
    const visiting = new Set();
    const visited = new Set();
    const ordered = [];
    const visit = (item) => {
        if (visited.has(item.id))
            return;
        if (visiting.has(item.id))
            fail(`selected package dependency cycle: ${item.id}`);
        visiting.add(item.id);
        const planned = packagesById.get(item.id);
        if (!planned)
            fail(`selected package missing from plan: ${item.id}`);
        for (const dependency of planned.dependencies) {
            const selectedDependency = selectedById.get(dependency.id);
            if (selectedDependency)
                visit(selectedDependency);
        }
        visiting.delete(item.id);
        visited.add(item.id);
        ordered.push(item);
    };
    for (const item of selected)
        visit(item);
    return ordered;
}
async function publishOnce(environment, item, artifact) {
    if (item.id.startsWith("npm:")) {
        const shadow = process.env.LENSO_RELEASE_MODE === "shadow";
        const npmAuth = npmRegistryAuthentication(process.env.LENSO_NPM_REGISTRY_URL ?? "https://registry.npmjs.org");
        const registry = npmAuth.registry;
        let authDirectory;
        try {
            const authArgs = [];
            if (shadow) {
                const token = process.env.NODE_AUTH_TOKEN;
                if (!token)
                    fail("shadow npm registry token is required");
                authDirectory = await mkdtemp(join(tmpdir(), "lenso-npm-auth-"));
                const userConfig = join(authDirectory, "npmrc");
                await writeFile(userConfig, `registry=${registry}\n${npmAuth.authKey}=${token}\n`, { mode: 0o600 });
                authArgs.push("--userconfig", userConfig);
            }
            else if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
                fail("npm token fallback is forbidden");
            }
            await execFile("npm", ["publish", artifact.path, "--registry", registry, ...authArgs, ...(shadow ? [] : ["--provenance"]), "--access", "public", "--ignore-scripts"], { cwd: environment.cwd });
        }
        finally {
            if (authDirectory)
                await rm(authDirectory, { recursive: true, force: true });
        }
    }
    else if (item.id.startsWith("cargo:")) {
        if (!process.env.CARGO_REGISTRY_TOKEN || process.env.CARGO_TOKEN)
            fail("official crates.io token is required without fallback");
        if (!artifact.cargoMetadata)
            fail("signed Cargo upload metadata missing");
        await uploadCargoArtifact(item, artifact.bytes, artifact.cargoMetadata);
    }
    else {
        const api = process.env.LENSO_GITHUB_API_URL ?? "https://api.github.com";
        const headers = { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json", "content-type": "application/json" };
        const releaseUrl = `${api}/repos/${environment.repository}/releases/tags/${encodeURIComponent(`v${item.version}`)}`;
        let releaseResponse = await fetch(releaseUrl, { headers, redirect: "error" });
        if (releaseResponse.status === 404) {
            releaseResponse = await fetch(`${api}/repos/${environment.repository}/releases`, {
                method: "POST", headers, redirect: "error",
                body: JSON.stringify({ tag_name: `v${item.version}`, target_commitish: environment.releaseCommit, name: `Lenso Runtime Console ${item.version}`, draft: true, prerelease: false }),
            });
        }
        if (!releaseResponse.ok)
            fail(`draft hosted artifact release creation ${releaseResponse.status}`);
        const release = await releaseResponse.json();
        if (release.draft !== true || release.target_commitish !== environment.releaseCommit)
            fail("hosted artifact draft identity mismatch");
        const uploadBase = release.upload_url?.replace(/\{.*$/u, "");
        if (!uploadBase)
            fail("draft hosted artifact upload URL is missing");
        const assetName = `${item.id.slice("artifact:".length)}.tar.gz`;
        const upload = async (name, bytes, contentType) => fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
            method: "POST", redirect: "error",
            headers: { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json", "content-type": contentType, "content-length": String(bytes.length) },
            body: Buffer.from(bytes),
        });
        const checksum = Buffer.from(`${hash(artifact.bytes).slice("sha256:".length)}  ${assetName}\n`);
        const ensureAsset = async (name, bytes, contentType) => {
            const existing = release.assets?.find(({ name: candidate }) => candidate === name);
            if (existing?.url) {
                const downloaded = await fetch(existing.url, { headers: { ...headers, accept: "application/octet-stream" }, redirect: "error" });
                if (!downloaded.ok || !Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(bytes)))
                    fail(`draft hosted artifact asset contradicts sealed bytes: ${name}`);
                return;
            }
            const response = await upload(name, bytes, contentType);
            if (!response.ok)
                fail(`draft hosted artifact upload ${response.status}: ${name}`);
        };
        await ensureAsset(assetName, artifact.bytes, "application/gzip");
        await ensureAsset(`${assetName}.sha256`, checksum, "text/plain");
    }
}
export async function uploadCargoArtifact(item, bytes, upload) {
    const json = canonicalBytes(upload);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(json.length, 0);
    header.writeUInt32LE(bytes.length, 4);
    const body = Buffer.concat([header.subarray(0, 4), json, header.subarray(4), bytes]);
    const endpoint = process.env.LENSO_CRATES_UPLOAD_URL ?? "https://crates.io/api/v1/crates/new";
    const response = await fetch(endpoint, { method: "PUT", redirect: "error", headers: { authorization: process.env.CARGO_REGISTRY_TOKEN, "content-type": "application/octet-stream", "content-length": String(body.length) }, body });
    if (!response.ok)
        fail(`crates exact archive upload ${response.status}`);
}
async function createAttestation(artifactPath, artifactBytes, environment) {
    if (process.env.LENSO_RELEASE_MODE === "shadow") {
        const endpoint = process.env.LENSO_SHADOW_ATTESTATION_URL;
        if (!endpoint)
            fail("shadow attestation adapter is required");
        const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${environment.githubToken}`, "content-type": "application/json" }, body: JSON.stringify({ repository: environment.repository, releaseCommit: environment.releaseCommit, artifactSha256: hash(artifactBytes), artifactName: basename(artifactPath) }) });
        if (!response.ok)
            fail(`shadow attestation adapter ${response.status}`);
        const result = await response.json();
        if (!result.url || !result.url.startsWith("https://"))
            fail("shadow attestation URL is invalid");
        return result.url;
    }
    let cleanup;
    if (!artifactPath) {
        cleanup = await mkdtemp(join(tmpdir(), "lenso-recovery-"));
        artifactPath = join(cleanup, "artifact");
        const handle = await open(artifactPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(artifactBytes);
        }
        finally {
            await handle.close();
        }
    }
    try {
        const token = process.env.LENSO_ATTESTATION_TOKEN;
        if (!token)
            fail("workflow attestation token is required");
        const { stdout } = await execFile("gh", ["attestation", "sign", artifactPath, "--repo", environment.repository], { env: { ...process.env, GH_TOKEN: token } });
        const url = /https:\/\/github\.com\/[^\s]+/u.exec(stdout)?.[0];
        if (!url)
            fail("attestation URL missing");
        return url;
    }
    finally {
        if (cleanup)
            await rm(cleanup, { recursive: true, force: true });
    }
}
function receiptFor(plan, item, observation, provenanceUrl, environment, tagName) {
    const componentName = item.id.startsWith("npm:@lenso/") ? item.id.slice("npm:@lenso/".length) : item.id.slice(item.id.indexOf(":") + 1);
    const artifactName = item.id.startsWith("artifact:") ? `${componentName}.tar.gz` : `${componentName}-${item.version}.${item.id.startsWith("npm:") ? "tgz" : "crate"}`;
    const identity = {
        schema: "lenso.component-receipt.v1", environment: process.env.LENSO_RELEASE_MODE,
        planId: plan.planId, packageId: item.id, version: item.version,
        repository: plan.repository, sourceCommit: environment.releaseCommit,
        packedSha256: hash(observation.bytes), registryIntegrity: observation.integrity, registryUrl: observation.url,
        provenanceUrl, provenanceSubject: { name: artifactName, digest: hash(observation.bytes) },
        workflowUrl: environment.runUrl,
        tagUrl: `https://github.com/${environment.repository}/releases/tag/${encodeURIComponent(tagName ?? `${componentName}@${item.version}`)}`,
        publishedAt: observation.publishedAt,
    };
    return { ...identity, receiptId: sha256(identity) };
}
async function dispatchReceipt(receipt, environment) {
    const identity = { schema: "lenso.release-event.v1", eventType: "lenso-publish-receipt", issuedAt: new Date().toISOString(), nonce: crypto.randomUUID(), sourceRepository: environment.repository, expectedAppId: Number(process.env.LENSO_APP_ID), planId: environment.planId, planUrl: receipt.tagUrl, planSha256: environment.planSha256, releaseCommit: environment.releaseCommit, correlationId: environment.eventId, receipt };
    const event = { ...identity, eventId: sha256(identity) };
    const endpoint = process.env.LENSO_COORDINATOR_RECEIPT_URL;
    if (!endpoint)
        fail("coordinator receipt endpoint is required");
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${environment.githubToken}`, "content-type": "application/json", "idempotency-key": receipt.receiptId }, body: JSON.stringify(event) });
    if (!response.ok)
        fail(`coordinator receipt enqueue ${response.status}`);
}
export async function publishSelected(environment) {
    const { plan, artifacts } = await consumeSealedMarker(environment);
    const config = parseJson(await safeRead(environment.cwd, ".lenso-release/config.json"), "repository config");
    const fixedGroup = selectedFixedGroup(config, environment.packages);
    const receipts = [];
    for (const item of publicationOrder(plan, environment.packages)) {
        const name = item.id.slice(item.id.indexOf(":") + 1);
        const observe = () => item.id.startsWith("npm:")
            ? npmObservation(name, item.version)
            : item.id.startsWith("cargo:") ? cargoObservation(name, item.version) : artifactObservation(name, item.version, environment);
        let observed = await observe();
        if (observed.exists) {
            const recovered = await readExistingReceipt(item, environment, fixedGroup);
            if (recovered) {
                if (recovered.planId !== plan.planId || recovered.sourceCommit !== environment.releaseCommit || recovered.packedSha256 !== hash(observed.bytes) || recovered.registryIntegrity !== observed.integrity || recovered.registryUrl !== observed.url || recovered.publishedAt !== observed.publishedAt)
                    fail("existing receipt contradicts authoritative registry state");
                if (!fixedGroup)
                    await dispatchReceipt(recovered, environment);
                receipts.push(recovered);
                continue;
            }
        }
        const artifact = artifacts.get(`${item.id}\0${item.version}`);
        if (!artifact)
            fail("sealed artifact is missing");
        if (!observed.exists) {
            await publishOnce(environment, item, artifact);
            observed = await observe();
            if (!observed.exists)
                fail("published package is not registry-visible");
        }
        if (hash(observed.bytes) !== hash(artifact.bytes))
            fail("registry archive differs from packed archive");
        const provenanceUrl = await createAttestation(artifact.path, artifact.bytes, environment);
        const receipt = receiptFor(plan, item, observed, provenanceUrl, environment, fixedGroup ? `${fixedGroup.name}@${fixedGroup.version}` : undefined);
        assertComponentReceipt(receipt);
        if (!fixedGroup)
            await createImmutableTag(receipt, environment);
        if (!fixedGroup)
            await dispatchReceipt(receipt, environment);
        receipts.push(receipt);
    }
    if (fixedGroup) {
        await createFixedGroupRelease(fixedGroup, receipts, artifacts, environment);
        for (const receipt of receipts)
            await dispatchReceipt(receipt, environment);
    }
    return receipts;
}
async function createFixedGroupRelease(group, receipts, artifacts, environment) {
    const tag = `${group.name}@${group.version}`;
    const identity = { schema: "lenso.fixed-group-receipt.v1", group: group.name, version: group.version, receipts };
    const message = canonicalBytes(identity).toString("utf8");
    const api = process.env.LENSO_GITHUB_API_URL ?? "https://api.github.com";
    const auth = { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json", "content-type": "application/json" };
    const refUrl = `${api}/repos/${environment.repository}/git/ref/tags/${encodeURIComponent(tag)}`;
    const existing = await fetch(refUrl, { headers: auth, redirect: "error" });
    if (existing.status === 404) {
        const object = await fetch(`${api}/repos/${environment.repository}/git/tags`, { method: "POST", headers: auth, redirect: "error", body: JSON.stringify({ tag, message, object: environment.releaseCommit, type: "commit" }) });
        if (!object.ok)
            fail(`fixed-group annotated tag creation ${object.status}`);
        const { sha } = await object.json();
        const ref = await fetch(`${api}/repos/${environment.repository}/git/refs`, { method: "POST", headers: auth, redirect: "error", body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }) });
        if (!ref.ok)
            fail(`fixed-group tag ref creation ${ref.status}`);
    }
    else if (existing.ok) {
        const body = await existing.json();
        if (body.object?.type !== "tag" || !body.object.sha)
            fail("fixed-group tag is not annotated");
        const object = await fetch(`${api}/repos/${environment.repository}/git/tags/${body.object.sha}`, { headers: auth, redirect: "error" });
        if (!object.ok)
            fail("fixed-group annotated tag is unreadable");
        const value = await object.json();
        if (value.object?.sha !== environment.releaseCommit || value.message !== message)
            fail("fixed-group tag receipt contradiction");
    }
    else
        fail(`fixed-group tag observation ${existing.status}`);
    const releaseUrl = `${api}/repos/${environment.repository}/releases/tags/${encodeURIComponent(tag)}`;
    let response = await fetch(releaseUrl, { headers: auth, redirect: "error" });
    if (response.status === 404)
        response = await fetch(`${api}/repos/${environment.repository}/releases`, { method: "POST", headers: auth, redirect: "error", body: JSON.stringify({ tag_name: tag, target_commitish: environment.releaseCommit, name: `Lenso CLI ${group.version}`, draft: false, prerelease: false }) });
    if (!response.ok)
        fail(`fixed-group GitHub Release ${response.status}`);
    const release = await response.json();
    if (release.draft !== false || release.tag_name !== tag || release.target_commitish !== environment.releaseCommit)
        fail("fixed-group GitHub Release identity mismatch");
    const uploadBase = release.upload_url?.replace(/\{.*$/u, "");
    if (!uploadBase)
        fail("fixed-group GitHub Release upload URL is missing");
    for (const item of environment.packages) {
        const artifact = artifacts.get(`${item.id}\0${item.version}`);
        if (!artifact)
            fail("fixed-group sealed artifact is missing");
        const name = basename(artifact.path);
        const existingAsset = release.assets?.find((asset) => asset.name === name);
        if (existingAsset?.url) {
            const downloaded = await fetch(existingAsset.url, { headers: { ...auth, accept: "application/octet-stream" }, redirect: "error" });
            if (!downloaded.ok || !Buffer.from(await downloaded.arrayBuffer()).equals(artifact.bytes))
                fail(`fixed-group Release asset contradiction: ${name}`);
            continue;
        }
        const uploaded = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream", "content-length": String(artifact.bytes.length) }, redirect: "error", body: artifact.bytes });
        if (!uploaded.ok)
            fail(`fixed-group Release asset upload ${uploaded.status}: ${name}`);
    }
}
async function createImmutableTag(receipt, environment) {
    const name = receipt.packageId.startsWith("npm:@lenso/") ? receipt.packageId.slice("npm:@lenso/".length) : receipt.packageId.slice(receipt.packageId.indexOf(":") + 1);
    const tag = `${name}@${receipt.version}`;
    const api = process.env.LENSO_GITHUB_API_URL ?? "https://api.github.com";
    const auth = { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json", "content-type": "application/json" };
    const existing = await fetch(`${api}/repos/${environment.repository}/git/ref/tags/${encodeURIComponent(tag)}`, { headers: auth, redirect: "error" });
    if (existing.ok) {
        const body = await existing.json();
        const tagObject = await fetch(`${api}/repos/${environment.repository}/git/tags/${body.object?.sha ?? ""}`, { headers: auth, redirect: "error" });
        if (!tagObject.ok)
            fail("existing annotated tag is unreadable");
        const value = await tagObject.json();
        if (value.object?.sha !== environment.releaseCommit || value.message !== canonicalBytes(receipt).toString("utf8"))
            fail("existing tag receipt contradiction");
        return;
    }
    if (existing.status !== 404)
        fail(`tag observation ${existing.status}`);
    const object = await fetch(`${api}/repos/${environment.repository}/git/tags`, { method: "POST", headers: auth, redirect: "error", body: JSON.stringify({ tag, message: canonicalBytes(receipt).toString("utf8"), object: environment.releaseCommit, type: "commit" }) });
    if (!object.ok)
        fail(`annotated tag creation ${object.status}`);
    const { sha } = await object.json();
    const ref = await fetch(`${api}/repos/${environment.repository}/git/refs`, { method: "POST", headers: auth, redirect: "error", body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }) });
    if (!ref.ok)
        fail(`tag ref creation ${ref.status}`);
}
async function readExistingReceipt(item, environment, fixedGroup) {
    const name = item.id.startsWith("npm:@lenso/") ? item.id.slice("npm:@lenso/".length) : item.id.slice(item.id.indexOf(":") + 1);
    const tag = fixedGroup ? `${fixedGroup.name}@${fixedGroup.version}` : `${name}@${item.version}`;
    const api = process.env.LENSO_GITHUB_API_URL ?? "https://api.github.com";
    const headers = { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json" };
    const ref = await fetch(`${api}/repos/${environment.repository}/git/ref/tags/${encodeURIComponent(tag)}`, { headers, redirect: "error" });
    if (ref.status === 404)
        return null;
    if (!ref.ok)
        fail(`tag observation ${ref.status}`);
    const refBody = await ref.json();
    if (refBody.object?.type !== "tag" || !refBody.object.sha)
        fail("release tag is not annotated");
    const object = await fetch(`${api}/repos/${environment.repository}/git/tags/${refBody.object.sha}`, { headers, redirect: "error" });
    if (!object.ok)
        fail(`annotated tag observation ${object.status}`);
    const tagBody = await object.json();
    if (tagBody.object?.sha !== environment.releaseCommit || typeof tagBody.message !== "string")
        fail("annotated tag target contradiction");
    const tagReceipt = parseJson(Buffer.from(tagBody.message), "tag receipt");
    const receipt = fixedGroup && tagReceipt && typeof tagReceipt === "object" && !Array.isArray(tagReceipt)
        ? tagReceipt.schema === "lenso.fixed-group-receipt.v1"
            ? tagReceipt.receipts?.find((candidate) => candidate && typeof candidate === "object" && candidate.packageId === item.id && candidate.version === item.version)
            : undefined
        : tagReceipt;
    assertComponentReceipt(receipt);
    if (receipt.packageId !== item.id || receipt.version !== item.version || receipt.repository !== environment.repository)
        fail("annotated tag receipt identity contradiction");
    return receipt;
}
export async function createPlan(cwd, repository, sourceCommit) {
    const { manifest, bytes } = await readRuntimeManifest(cwd);
    const config = parseJson(await safeRead(cwd, ".lenso-release/config.json"), "repository config");
    if (config.schema !== "lenso.repository-config.v1" || config.repository !== repository)
        fail("repository config mismatch");
    if (config.aliases && Object.entries(config.aliases).some(([target, source]) => !/^artifact:[a-z0-9-]+$/u.test(target) || !/^npm:@lenso\/[a-z0-9-]+$/u.test(source)))
        fail("repository component alias is invalid");
    if (config.ignore && (!Array.isArray(config.ignore) || config.ignore.some((name) => !/^(?:(?:cargo:)?[a-z0-9]+(?:-[a-z0-9]+)*|(?:npm:)?@lenso\/[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(name))))
        fail("repository ignore list is invalid");
    if (config.fixedGroups) {
        for (const [name, members] of Object.entries(config.fixedGroups)) {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || !Array.isArray(members) || members.length < 2 || new Set(members).size !== members.length || members.some((id) => !PACKAGE.test(id)))
                fail("repository fixed group is invalid");
        }
    }
    const registry = await loadComponents(join(cwd, ".lenso-release/runtime/components.yaml"));
    const components = Object.fromEntries(Object.values(registry.packages).map(({ id, releaseGroup, userFacing }) => [id, { releaseGroup, userFacing }]));
    return exportReleasePlan({ cwd, repository, sourceCommit, components, aliases: config.aliases, ignore: config.ignore, publisher: {
            workflow: ".github/workflows/publish.yml", workflowSha256: hash(await safeRead(cwd, ".github/workflows/publish.yml")),
            sharedRevision: manifest.sourceRevision, sharedBundleSha256: hash(bytes), runner: "ubuntu-24.04", node: "24.18.0", npm: "11.7.0", rust: "1.94.0",
        } });
}
