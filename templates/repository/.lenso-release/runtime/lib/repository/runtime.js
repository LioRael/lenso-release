import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { loadComponents } from "../config/components.js";
import { assertComponentReceipt, assertReleasePlan } from "../contracts/validate.js";
import { canonicalBytes, sha256 } from "../core/canonical.js";
import { executionRef, publisherPackagePhases, verifyPublisherContract, } from "../publisher/contract.js";
import { exportReleasePlan } from "../tegami/export-plan.js";
import { inspectOciReleaseArtifact } from "./oci-release-artifact.js";
import { publishOciImage } from "./oci-registry-publisher.js";
import { observeOciImage } from "../registry/oci.js";
const execFile = promisify(execFileCallback);
const OID = /^[0-9a-f]{40}$/u;
const PACKAGE = /^(cargo:[a-z0-9]+(?:-[a-z0-9]+)*|npm:@lenso\/[a-z0-9]+(?:-[a-z0-9]+)*|artifact:[a-z0-9]+(?:-[a-z0-9]+)*|oci:[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
function fail(message) { throw new Error(`repository runtime: ${message}`); }
function hash(bytes) { return sha256(bytes); }
function tarOctal(field) {
    const value = Buffer.from(field).toString("ascii").replace(/\0.*$/u, "").trim();
    if (!/^[0-7]+$/u.test(value))
        throw new Error("invalid tar octal field");
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed))
        throw new Error("oversized tar field");
    return parsed;
}
function cargoLockRange(tar) {
    const matches = [];
    let offset = 0;
    let ended = false;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            ended = true;
            break;
        }
        const storedChecksum = tarOctal(header.subarray(148, 156));
        let checksum = 0;
        for (let index = 0; index < header.length; index += 1)
            checksum += index >= 148 && index < 156 ? 32 : header[index];
        if (checksum !== storedChecksum)
            throw new Error("invalid tar header checksum");
        const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/u, "");
        const name = `${text(345, 500)}${text(345, 500) ? "/" : ""}${text(0, 100)}`;
        if (!name || name.startsWith("/") || name.split("/").includes(".."))
            throw new Error("unsafe tar path");
        const size = tarOctal(header.subarray(124, 136));
        const start = offset + 512;
        const end = start + size;
        if (end > tar.length)
            throw new Error("truncated tar entry");
        const type = header[156];
        if ((type === 0 || type === 48) && name.endsWith("/Cargo.lock"))
            matches.push({ start, end });
        offset = start + Math.ceil(size / 512) * 512;
    }
    if (!ended || matches.length !== 1)
        throw new Error("Cargo.lock tar entry is missing or ambiguous");
    return matches[0];
}
function normalizeCargoLockChecksums(tar, substitutions) {
    if (substitutions.length === 0)
        return tar;
    const normalized = Buffer.from(tar);
    const range = cargoLockRange(normalized);
    for (const { reviewed, registry } of substitutions) {
        if (reviewed === registry)
            continue;
        const needle = Buffer.from(`checksum = "${registry.slice("sha256:".length)}"`);
        const replacement = Buffer.from(`checksum = "${reviewed.slice("sha256:".length)}"`);
        let cursor = range.start;
        let matches = 0;
        while (cursor + needle.length <= range.end) {
            const found = normalized.indexOf(needle, cursor);
            if (found < 0 || found + needle.length > range.end)
                break;
            replacement.copy(normalized, found);
            cursor = found + needle.length;
            matches += 1;
        }
        if (matches > 1)
            throw new Error("Cargo.lock checksum substitution is ambiguous");
    }
    return normalized;
}
export function cargoArchiveEquivalent(reviewed, registry, substitutions = []) {
    if (Buffer.from(reviewed).equals(Buffer.from(registry)))
        return true;
    try {
        const limit = 512 * 1024 * 1024;
        const reviewedTar = gunzipSync(reviewed, { maxOutputLength: limit });
        const registryTar = gunzipSync(registry, { maxOutputLength: limit });
        return reviewedTar.equals(normalizeCargoLockChecksums(registryTar, substitutions));
    }
    catch {
        return false;
    }
}
function verifiedCargoArchiveDigests(digests) {
    // Packaged Cargo.lock files include transitive same-plan dependencies, not
    // only the current package's direct plan edges. Every pair in this map was
    // established by a complete archive-equivalence check earlier in the
    // publication order, so it is safe to normalize those exact checksums.
    return [...digests.values()];
}
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
async function reviewedRegistryBindings(cwd, plan) {
    const registry = await loadComponents(join(cwd, ".lenso-release/runtime/components.yaml"));
    const config = parseJson(await safeRead(cwd, ".lenso-release/config.json"), "repository config");
    const registries = {};
    for (const item of plan.packages) {
        const component = registry.packages[item.id];
        if (!component || component.repository !== plan.repository || !component.publishable || component.releaseGroup !== item.releaseGroup || component.userFacing !== item.userFacing)
            fail(`unreviewed component metadata: ${item.id}`);
        const allowed = new Set(component.dependencies);
        if (item.dependencies.some(({ id }) => !allowed.has(id)))
            fail(`unreviewed dependency edge: ${item.id}`);
        if (item.id.startsWith("oci:")) {
            const configured = config.ociImages?.[item.id]?.registryRepository;
            if (!component.registryPath || configured !== component.registryPath)
                fail(`unreviewed OCI registry destination: ${item.id}`);
            registries[item.id] = component.registryPath;
        }
    }
    return registries;
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
    await reviewedRegistryBindings(environment.cwd, plan);
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
        registries: await reviewedRegistryBindings(environment.cwd, plan),
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
        const kind = item.id.startsWith("npm:") ? "npm" : item.id.startsWith("cargo:") ? "cargo" : item.id.startsWith("oci:") ? "oci" : "artifact";
        const cargoMetadata = kind === "cargo" ? await cargoWireMetadataFromCrate(destination, name, item.version) : null;
        const attachments = [];
        if (packed.oci) {
            const archiveDestination = join(artifactDirectory, basename(packed.oci.archivePath));
            if (archiveDestination === destination)
                fail("OCI archive and install manifest filenames must differ");
            await copyFile(packed.oci.archivePath, archiveDestination, constants.COPYFILE_EXCL);
            await chmod(archiveDestination, 0o400);
            const archiveInfo = await stat(archiveDestination);
            if (!archiveInfo.isFile() || archiveInfo.nlink !== 1)
                fail("sealed OCI archive is not an isolated regular file");
            attachments.push({ role: "oci-archive", path: relative(environment.cwd, archiveDestination), sha256: hash(packed.oci.archiveBytes), size: archiveInfo.size, ino: archiveInfo.ino, mode: 0o400 });
        }
        artifacts.push({ id: item.id, name, version: item.version, kind, path: relative(environment.cwd, destination), sha256: hash(packed.bytes), size: info.size, ino: info.ino, mode: 0o400, cargoMetadata, cargoMetadataSha256: cargoMetadata ? sha256(cargoMetadata) : null, attachments, ociMetadata: packed.oci ? { registryRepository: packed.oci.registryRepository, manifestDigest: packed.oci.manifestDigest, archiveSha256: hash(packed.oci.archiveBytes) } : null });
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
        let oci = null;
        if (binding.kind === "oci") {
            const attachment = binding.attachments?.[0];
            if (!attachment || !binding.ociMetadata)
                fail("sealed OCI authorization is incomplete");
            const archiveBytes = await safeRead(environment.cwd, attachment.path);
            const archiveInfo = await stat(join(environment.cwd, attachment.path));
            if (archiveInfo.ino !== attachment.ino || archiveInfo.size !== attachment.size || archiveInfo.mode % 0o1000 !== 0o400 || archiveInfo.nlink !== 1 || hash(archiveBytes) !== attachment.sha256)
                fail("sealed OCI archive changed after OIDC authorization");
            const inspected = inspectOciReleaseArtifact({ archiveBytes, installManifestBytes: artifactBytes, registryRepository: binding.ociMetadata.registryRepository, sourceCommit: environment.releaseCommit, version: binding.version });
            if (inspected.manifestDigest !== binding.ociMetadata.manifestDigest || hash(archiveBytes) !== binding.ociMetadata.archiveSha256)
                fail("sealed OCI graph contradicts authorization");
            oci = { ...inspected, archivePath: join(environment.cwd, attachment.path) };
        }
        artifacts.set(`${binding.id}\0${binding.version}`, { path: join(environment.cwd, binding.path), bytes: artifactBytes, cargoMetadata: binding.cargoMetadata, oci });
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
const CRATES_IO_USER_AGENT = "lenso-release-publisher/1.0 (https://github.com/LioRael/lenso-release)";
export async function fetchCargoArchive(download, headers) {
    const source = new URL(download);
    const response = await fetch(download, { headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status))
        return response;
    const location = response.headers.get("location");
    if (!location)
        fail("crates registry redirect location is missing");
    const target = new URL(location, source);
    if (source.origin !== "https://crates.io" ||
        target.origin !== "https://static.crates.io" ||
        target.username !== "" ||
        target.password !== "" ||
        target.search !== "" ||
        target.hash !== "" ||
        !target.pathname.startsWith("/crates/"))
        fail("crates registry redirect is not trusted");
    return fetch(target, { headers, redirect: "error" });
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
    const headers = { "user-agent": CRATES_IO_USER_AGENT };
    const { response, body } = await requestJson(`${base}/api/v1/crates/${encodeURIComponent(name)}/${version}`, { headers });
    if (response.status === 404)
        return { exists: false };
    if (!response.ok)
        fail(`crates registry observation ${response.status}`);
    const crate = body.version;
    const checksum = String(crate?.checksum ?? "");
    const publishedAt = String(crate?.created_at ?? "");
    const download = `${base}/api/v1/crates/${encodeURIComponent(name)}/${version}/download`;
    const artifact = await fetchCargoArchive(download, headers);
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
async function releaseAssetObservation(assetName, version, environment) {
    const api = process.env.LENSO_GITHUB_API_URL ?? "https://api.github.com";
    const headers = { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json" };
    const response = await fetch(`${api}/repos/${environment.repository}/releases/tags/${encodeURIComponent(`v${version}`)}`, { headers, redirect: "error" });
    if (response.status === 404)
        return { exists: false };
    if (!response.ok)
        fail(`release asset observation ${response.status}`);
    const release = await response.json();
    if (release.draft !== true)
        fail("release asset must remain in the reviewed draft");
    const asset = release.assets?.find(({ name }) => name === assetName);
    if (!asset)
        return { exists: false };
    if (!asset.url || !asset.browser_download_url)
        fail("release asset metadata is incomplete");
    const download = await fetch(asset.url, { headers: { ...headers, accept: "application/octet-stream" }, redirect: "error" });
    if (!download.ok)
        fail(`release asset download ${download.status}`);
    return { exists: true, bytes: Buffer.from(await download.arrayBuffer()), url: asset.browser_download_url };
}
async function ociObservation(name, version, artifact, environment) {
    if (!artifact.oci)
        fail("sealed OCI image graph is missing");
    const registry = process.env.LENSO_OCI_REGISTRY_URL ?? "https://ghcr.io";
    const observed = await observeOciImage(name, version, { registry, repository: artifact.oci.registryRepository });
    if ("missing" in observed)
        return { exists: false };
    if ("failure" in observed)
        fail(`OCI registry observation ${observed.failure}: ${observed.detail}`);
    if (observed.digest !== artifact.oci.manifestDigest)
        fail("OCI registry manifest contradicts the sealed image");
    const manifest = await releaseAssetObservation(basename(artifact.path), version, environment);
    if (!manifest.exists)
        return { exists: false };
    if (!manifest.bytes.equals(artifact.bytes))
        fail("remote Console install manifest contradicts the sealed manifest");
    return { exists: true, bytes: manifest.bytes, integrity: observed.digest, url: observed.canonicalUrl, publishedAt: observed.publishedAt };
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
    if (item.id.startsWith("oci:")) {
        const config = parseJson(await safeRead(cwd, ".lenso-release/config.json"), "repository config");
        const image = config.ociImages?.[item.id];
        if (!image)
            fail(`OCI image configuration is missing: ${item.id}`);
        safeRelative(image.archivePath);
        safeRelative(image.installManifestPath);
        const archiveBytes = await safeRead(cwd, image.archivePath);
        const installManifestBytes = await safeRead(cwd, image.installManifestPath);
        const inspected = inspectOciReleaseArtifact({ archiveBytes, installManifestBytes, registryRepository: image.registryRepository, sourceCommit: (await execFile("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(), version: item.version });
        return { path: join(cwd, image.installManifestPath), bytes: installManifestBytes, oci: { ...inspected, archivePath: join(cwd, image.archivePath) } };
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
    else if (item.id.startsWith("oci:")) {
        if (!artifact.oci)
            fail("sealed OCI image graph is missing");
        const token = process.env.LENSO_OCI_TOKEN;
        if (!token)
            fail("OCI registry credential is required");
        const shadow = process.env.LENSO_RELEASE_MODE === "shadow";
        await publishOciImage({ artifact: artifact.oci, registry: process.env.LENSO_OCI_REGISTRY_URL ?? "https://ghcr.io", version: item.version, credential: shadow ? { bearer: token } : { username: process.env.GITHUB_ACTOR ?? "github-actions", password: token } });
        await ensureDraftReleaseAsset(environment, item.version, basename(artifact.path), artifact.bytes, `Lenso Console ${item.version}`);
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
async function ensureDraftReleaseAsset(environment, version, assetName, bytes, title) {
    const api = process.env.LENSO_GITHUB_API_URL ?? "https://api.github.com";
    const headers = { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json", "content-type": "application/json" };
    const releaseUrl = `${api}/repos/${environment.repository}/releases/tags/${encodeURIComponent(`v${version}`)}`;
    let response = await fetch(releaseUrl, { headers, redirect: "error" });
    if (response.status === 404)
        response = await fetch(`${api}/repos/${environment.repository}/releases`, { method: "POST", headers, redirect: "error", body: JSON.stringify({ tag_name: `v${version}`, target_commitish: environment.releaseCommit, name: title, draft: true, prerelease: false }) });
    if (!response.ok)
        fail(`draft release creation ${response.status}`);
    const release = await response.json();
    if (release.draft !== true || release.target_commitish !== environment.releaseCommit)
        fail("draft release identity mismatch");
    const existing = release.assets?.find(({ name }) => name === assetName);
    if (existing?.url) {
        const downloaded = await fetch(existing.url, { headers: { ...headers, accept: "application/octet-stream" }, redirect: "error" });
        if (!downloaded.ok || !Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(bytes)))
            fail("draft release asset contradicts the sealed bytes");
        return;
    }
    const uploadBase = release.upload_url?.replace(/\{.*$/u, "");
    if (!uploadBase)
        fail("draft release upload URL is missing");
    const uploaded = await fetch(`${uploadBase}?name=${encodeURIComponent(assetName)}`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${environment.githubToken}`, accept: "application/vnd.github+json", "content-type": "application/json", "content-length": String(bytes.length) }, body: Buffer.from(bytes) });
    if (!uploaded.ok)
        fail(`draft release asset upload ${uploaded.status}`);
}
export async function uploadCargoArtifact(item, bytes, upload) {
    const json = canonicalBytes(upload);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(json.length, 0);
    header.writeUInt32LE(bytes.length, 4);
    const body = Buffer.concat([header.subarray(0, 4), json, header.subarray(4), bytes]);
    const endpoint = process.env.LENSO_CRATES_UPLOAD_URL ?? "https://crates.io/api/v1/crates/new";
    const response = await fetch(endpoint, { method: "PUT", redirect: "error", headers: { authorization: process.env.CARGO_REGISTRY_TOKEN, "content-type": "application/octet-stream", "content-length": String(body.length), "user-agent": CRATES_IO_USER_AGENT }, body });
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
    const value = process.env.LENSO_PUBLISH_ATTESTATION_URL;
    if (!value)
        fail("official publish attestation URL is required");
    return validateOfficialAttestationUrl(value, environment.repository);
}
function receiptFor(plan, item, observation, provenanceUrl, environment, subjectName, tagName) {
    const componentName = item.id.startsWith("npm:@lenso/") ? item.id.slice("npm:@lenso/".length) : item.id.slice(item.id.indexOf(":") + 1);
    const identity = {
        schema: "lenso.component-receipt.v1", environment: process.env.LENSO_RELEASE_MODE,
        planId: plan.planId, packageId: item.id, version: item.version,
        repository: plan.repository, sourceCommit: environment.releaseCommit,
        packedSha256: hash(observation.bytes), registryIntegrity: observation.integrity, registryUrl: observation.url,
        provenanceUrl, provenanceSubject: { name: subjectName, digest: hash(observation.bytes) },
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
        const artifact = artifacts.get(`${item.id}\0${item.version}`);
        if (!artifact)
            fail("sealed artifact is missing");
        const observe = () => item.id.startsWith("npm:")
            ? npmObservation(name, item.version)
            : item.id.startsWith("cargo:") ? cargoObservation(name, item.version)
                : item.id.startsWith("oci:") ? ociObservation(name, item.version, artifact, environment) : artifactObservation(name, item.version, environment);
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
        if (!observed.exists) {
            await publishOnce(environment, item, artifact);
            observed = await observe();
            if (!observed.exists)
                fail("published package is not registry-visible");
        }
        if (hash(observed.bytes) !== hash(artifact.bytes))
            fail("registry archive differs from packed archive");
        const provenanceUrl = await createAttestation(artifact.path, artifact.bytes, environment);
        const receipt = receiptFor(plan, item, observed, provenanceUrl, environment, basename(artifact.path), fixedGroup ? `${fixedGroup.name}@${fixedGroup.version}` : undefined);
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
async function readRecoveryState(environment) {
    const repositorySegment = encodeURIComponent(encodeURIComponent(environment.repository));
    const planDigest = environment.planId.slice("sha256:".length);
    const endpoint = `https://api.github.com/repos/LioRael/lenso-release/contents/plans/${repositorySegment}/${planDigest}.json?ref=release-state`;
    let lastError;
    for (const waitMs of [0, 1_000, 2_000, 4_000, 8_000, 8_000]) {
        if (waitMs > 0)
            await delay(waitMs);
        try {
            const response = await fetch(endpoint, {
                redirect: "error",
                headers: {
                    authorization: `Bearer ${environment.githubToken}`,
                    accept: "application/vnd.github+json",
                },
            });
            if (!response.ok)
                throw new Error(`release-state observation ${response.status}`);
            const body = await response.json();
            if (body.encoding !== "base64" || typeof body.content !== "string")
                throw new Error("release-state content encoding invalid");
            const state = JSON.parse(Buffer.from(body.content.replace(/\n/gu, ""), "base64").toString("utf8"));
            const outbox = Array.isArray(state.outbox)
                ? state.outbox
                : [];
            const entry = outbox.find(({ eventId }) => eventId === environment.eventId);
            if (entry?.status !== "dispatched" ||
                entry.runUrl !== environment.runUrl)
                throw new Error("recovery dispatch is not authoritative yet");
            return state;
        }
        catch (error) {
            lastError = error;
        }
    }
    throw new Error("authoritative recovery dispatch is unavailable", {
        cause: lastError,
    });
}
export async function verifyRecoveryAuthorization(environment, expectedKind = "production-break-glass") {
    if (process.env.LENSO_RELEASE_MODE !== "production")
        fail("break-glass recovery is production-only");
    const state = await readRecoveryState(environment);
    if (state.schema !== "lenso.plan-state.v1" ||
        state.environment !== "production" ||
        state.repository !== environment.repository ||
        state.planId !== environment.planId ||
        state.planSha256 !== environment.planSha256 ||
        state.releaseCommit !== environment.releaseCommit ||
        !["publishing", "verified"].includes(String(state.status)))
        fail("authoritative recovery plan binding mismatch");
    const outbox = state.outbox;
    const entry = outbox.find(({ eventId }) => eventId === environment.eventId);
    const recovery = entry?.recovery;
    if (entry?.ref !== environment.refName ||
        entry.workflow !== environment.workflowPath ||
        entry.runUrl !== environment.runUrl ||
        recovery?.kind !== expectedKind ||
        recovery.workflowCommit !== environment.githubSha ||
        (expectedKind === "production-break-glass" &&
            (!/^https:\/\/github\.com\/LioRael\/lenso\/actions\/runs\/[1-9][0-9]*$/u.test(String(recovery.authorizedRunUrl)) ||
                !/^sha256:[0-9a-f]{64}$/u.test(String(recovery.authorizedRunSha256)))) ||
        (expectedKind === "production-partial" &&
            (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/u.test(String(recovery.failedRunUrl)) ||
                !Array.isArray(recovery.publishedPackages))))
        fail("authoritative recovery authorization mismatch");
    const selected = JSON.stringify(environment.packages.map(({ id, version }) => ({ id, version })));
    if (JSON.stringify(entry.packages) !== selected ||
        entry.inputs?.event_id !==
            environment.eventId ||
        entry.inputs?.plan_id !==
            environment.planId ||
        entry.inputs?.plan_sha256 !==
            environment.planSha256 ||
        entry.inputs?.release_commit !==
            environment.releaseCommit ||
        entry.inputs?.packages_json !==
            selected ||
        entry.inputs?.nonce !==
            environment.nonce)
        fail("authoritative recovery outbox payload mismatch");
    return recovery;
}
async function recoveryPlan(environment, expectedKind = "production-break-glass") {
    await verifyRecoveryAuthorization(environment, expectedKind);
    const candidateEnvironment = {
        ...environment,
        githubSha: environment.releaseCommit,
        refName: executionRef(environment.planId),
    };
    const planBytes = await safeRead(candidateEnvironment.cwd, ".lenso-release/plan.json");
    if (hash(planBytes) !== candidateEnvironment.planSha256)
        fail("plan byte digest mismatch");
    const candidatePlan = parseJson(planBytes, "release plan");
    assertReleasePlan(candidatePlan);
    if (candidatePlan.planId !== candidateEnvironment.planId ||
        candidatePlan.repository !== candidateEnvironment.repository)
        fail("plan identity mismatch");
    exactSelection(candidatePlan, candidateEnvironment.packages);
    candidateEnvironment.workflowPath = candidatePlan.publisher.workflow;
    return { candidateEnvironment, plan: candidatePlan };
}
async function partialRecoveryArtifacts(environment, plan, publishedPackages, writeSubjects) {
    await stageCargoArchives(environment.cwd, plan, environment.packages);
    const published = new Set(publishedPackages.map(({ id, version }) => `${id}\0${version}`));
    const artifacts = new Map();
    const subjectDirectory = join(environment.cwd, "target/recovery-attestations");
    if (writeSubjects)
        await mkdir(subjectDirectory, { recursive: true, mode: 0o700 });
    for (const item of publicationOrder(plan, environment.packages)) {
        if (!item.id.startsWith("cargo:") && !item.id.startsWith("npm:"))
            fail("partial recovery currently supports Cargo and npm packages only");
        const artifact = await packedArtifact(environment.cwd, item);
        const name = item.id.slice(item.id.indexOf(":") + 1);
        const observed = item.id.startsWith("cargo:")
            ? await cargoObservation(name, item.version)
            : await npmObservation(name, item.version);
        const expectedPublished = published.has(`${item.id}\0${item.version}`);
        if (observed.exists !== expectedPublished)
            fail(`registry state changed after partial recovery authorization: ${item.id}`);
        let subjectBytes = artifact.bytes;
        if (observed.exists) {
            if (!observed.bytes || !observed.integrity)
                fail(`published package observation is incomplete: ${item.id}`);
            const matches = item.id.startsWith("cargo:")
                ? cargoArchiveEquivalent(artifact.bytes, observed.bytes)
                : hash(artifact.bytes) === hash(observed.bytes);
            if (!matches)
                fail(`registry archive differs from reviewed artifact: ${item.id}`);
            subjectBytes = Buffer.from(observed.bytes);
        }
        const cargoMetadata = item.id.startsWith("cargo:")
            ? await cargoWireMetadataFromCrate(artifact.path, name, item.version)
            : null;
        const recovered = { path: artifact.path, bytes: subjectBytes, cargoMetadata, oci: null };
        artifacts.set(`${item.id}\0${item.version}`, recovered);
        if (writeSubjects) {
            const subject = join(subjectDirectory, basename(artifact.path));
            const handle = await open(subject, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            try {
                await handle.writeFile(subjectBytes);
            }
            finally {
                await handle.close();
            }
        }
    }
    return artifacts;
}
export async function preparePartialRecovery(environment) {
    const authorization = await verifyRecoveryAuthorization(environment, "production-partial");
    const { candidateEnvironment, plan } = await recoveryPlan(environment, "production-partial");
    const phases = publisherPackagePhases(candidateEnvironment.packages, plan, "recovery");
    for (const packages of phases)
        await preflight({ ...candidateEnvironment, packages });
    await partialRecoveryArtifacts(environment, plan, authorization.publishedPackages, true);
}
export async function recoverPartialPublished(environment) {
    const authorization = await verifyRecoveryAuthorization(environment, "production-partial");
    const { plan } = await recoveryPlan(environment, "production-partial");
    const artifacts = await partialRecoveryArtifacts(environment, plan, authorization.publishedPackages, false);
    const config = parseJson(await safeRead(environment.cwd, ".lenso-release/config.json"), "repository config");
    const fixedGroup = selectedFixedGroup(config, environment.packages);
    const provenanceUrl = recoveryAttestationUrl(environment);
    const receipts = [];
    for (const item of publicationOrder(plan, environment.packages)) {
        const artifact = artifacts.get(`${item.id}\0${item.version}`);
        if (!artifact)
            fail("recovery artifact is missing");
        const name = item.id.slice(item.id.indexOf(":") + 1);
        const observe = () => item.id.startsWith("cargo:") ? cargoObservation(name, item.version) : npmObservation(name, item.version);
        let observed = await observe();
        if (!observed.exists) {
            await publishOnce(environment, item, artifact);
            observed = await observe();
        }
        if (!observed.exists || !observed.bytes || !observed.integrity || !observed.url || !observed.publishedAt)
            fail(`recovered package is not registry-visible: ${item.id}`);
        const matches = item.id.startsWith("cargo:")
            ? cargoArchiveEquivalent(artifact.bytes, observed.bytes)
            : hash(artifact.bytes) === hash(observed.bytes);
        if (!matches)
            fail(`recovered registry archive differs from reviewed artifact: ${item.id}`);
        const receipt = receiptFor(plan, item, observed, provenanceUrl, environment, basename(artifact.path), fixedGroup ? `${fixedGroup.name}@${fixedGroup.version}` : undefined);
        assertComponentReceipt(receipt);
        if (!fixedGroup) {
            await createImmutableTag(receipt, environment);
            await dispatchReceipt(receipt, environment);
        }
        receipts.push(receipt);
    }
    if (fixedGroup) {
        await createFixedGroupRelease(fixedGroup, receipts, artifacts, environment);
        for (const receipt of receipts)
            await dispatchReceipt(receipt, environment);
    }
    return receipts;
}
export async function prepareRecovery(environment) {
    const { candidateEnvironment, plan: candidatePlan } = await recoveryPlan(environment);
    const phases = publisherPackagePhases(candidateEnvironment.packages, candidatePlan, "recovery");
    let plan = candidatePlan;
    for (const packages of phases) {
        plan = await preflight({ ...candidateEnvironment, packages });
    }
    const config = parseJson(await safeRead(environment.cwd, ".lenso-release/config.json"), "repository config");
    if (selectedFixedGroup(config, environment.packages))
        fail("fixed-group break-glass recovery is not supported");
    await stageCargoArchives(environment.cwd, plan, environment.packages);
    const subjectDirectory = join(environment.cwd, "target/recovery-attestations");
    await mkdir(subjectDirectory, { mode: 0o700 });
    const cargoDigests = new Map();
    for (const item of publicationOrder(plan, environment.packages)) {
        if (!item.id.startsWith("cargo:"))
            fail("break-glass recovery supports Cargo packages only");
        const artifact = await packedArtifact(environment.cwd, item);
        const observed = await cargoObservation(item.id.slice("cargo:".length), item.version);
        if (!observed.exists ||
            !observed.bytes ||
            !observed.integrity ||
            !observed.url ||
            !observed.publishedAt)
            fail(`published package is not registry-visible: ${item.id}`);
        if (!cargoArchiveEquivalent(artifact.bytes, observed.bytes, verifiedCargoArchiveDigests(cargoDigests)) ||
            observed.integrity !== hash(observed.bytes).slice("sha256:".length))
            fail(`registry archive differs from reviewed artifact: ${item.id}`);
        cargoDigests.set(item.id, {
            reviewed: hash(artifact.bytes),
            registry: hash(observed.bytes),
        });
        const subjectPath = join(subjectDirectory, basename(artifact.path));
        const handle = await open(subjectPath, constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(observed.bytes);
        }
        finally {
            await handle.close();
        }
    }
}
export function validateOfficialAttestationUrl(value, repository) {
    const url = new URL(value);
    if (url.origin !== "https://github.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(`/${repository}/attestations/`))
        fail("official attestation URL is invalid");
    return url.toString();
}
export const validateRecoveryAttestationUrl = validateOfficialAttestationUrl;
function recoveryAttestationUrl(environment) {
    const value = process.env.LENSO_RECOVERY_ATTESTATION_URL;
    if (!value)
        fail("official recovery attestation URL is required");
    return validateRecoveryAttestationUrl(value, environment.repository);
}
export async function recoverPublished(environment) {
    const { plan } = await recoveryPlan(environment);
    const config = parseJson(await safeRead(environment.cwd, ".lenso-release/config.json"), "repository config");
    if (selectedFixedGroup(config, environment.packages))
        fail("fixed-group break-glass recovery is not supported");
    const provenanceUrl = recoveryAttestationUrl(environment);
    const receipts = [];
    const cargoDigests = new Map();
    for (const item of publicationOrder(plan, environment.packages)) {
        if (!item.id.startsWith("cargo:"))
            fail("break-glass recovery supports Cargo packages only");
        const artifact = await packedArtifact(environment.cwd, item);
        const observed = await cargoObservation(item.id.slice("cargo:".length), item.version);
        if (!observed.exists ||
            !observed.bytes ||
            !observed.integrity ||
            !observed.url ||
            !observed.publishedAt)
            fail(`published package is not registry-visible: ${item.id}`);
        if (!cargoArchiveEquivalent(artifact.bytes, observed.bytes, verifiedCargoArchiveDigests(cargoDigests)) ||
            observed.integrity !== hash(observed.bytes).slice("sha256:".length))
            fail(`registry archive differs from reviewed artifact: ${item.id}`);
        cargoDigests.set(item.id, {
            reviewed: hash(artifact.bytes),
            registry: hash(observed.bytes),
        });
        const receipt = receiptFor(plan, item, observed, provenanceUrl, environment, basename(artifact.path));
        assertComponentReceipt(receipt);
        await createImmutableTag(receipt, environment);
        await dispatchReceipt(receipt, environment);
        receipts.push(receipt);
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
    if (config.aliases && Object.entries(config.aliases).some(([target, source]) => !/^(?:artifact|oci):[a-z0-9-]+$/u.test(target) || !/^npm:@lenso\/[a-z0-9-]+$/u.test(source)))
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
