import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { tegami } from "tegami";
import { cargo } from "tegami/plugins/cargo";
import { parse as parseYaml } from "yaml";
import { assertReleasePlan } from "../contracts/validate.js";
import { canonicalBytes, sha256 } from "../core/canonical.js";
import { capturePackages } from "./capture-plugin.js";
import { refreshCargoLock } from "./cargo-lock-plugin.js";
import { repairCargoWorkspace } from "./cargo-workspace-plugin.js";
const execFileAsync = promisify(execFile);
const CARGO_METADATA_BUFFER = 64 * 1024 * 1024;
const RELEASE_GROUP_ORDER = ["foundation", "modules", "console", "host", "distribution"];
const SUPPORTED_BUMPS = new Set(["patch", "minor", "major"]);
function fail(message) {
    throw new TypeError(`cannot export Tegami release plan: ${message}`);
}
function sourceId(options, planId) {
    return options.aliases?.[planId] ?? planId;
}
function planId(options, workspaceId) {
    const matches = Object.entries(options.aliases ?? {}).filter(([, source]) => source === workspaceId);
    if (matches.length > 1)
        fail(`workspace package ${workspaceId} has ambiguous component aliases`);
    return matches[0]?.[0] ?? workspaceId;
}
function record(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(`${context} must be an object`);
    return value;
}
function normalizeRequirement(value, id) {
    const requirement = value.startsWith("workspace:") ? value.slice(10) : value;
    if (!requirement || requirement === "*" || /^(?:git|github|https?|file|link|path):/u.test(requirement)) {
        fail(`${id} has floating dependency source ${value}`);
    }
    return requirement;
}
function assertKnown(id, components, owner) {
    if (!Object.hasOwn(components, id))
        fail(`${owner} dependency ${id} has no component registry metadata`);
}
async function npmObservations(cwd, pkg, components, planned) {
    const manifest = record(JSON.parse(await readFile(join(pkg.path, "package.json"), "utf8")), `${pkg.id} manifest`);
    const hasDependencies = ["dependencies", "peerDependencies", "optionalDependencies"]
        .some((field) => manifest[field] !== undefined && Object.keys(record(manifest[field], `${pkg.id} ${field}`)).length > 0);
    if (!hasDependencies)
        return [];
    const lock = record(parseYaml(await readFile(join(cwd, "pnpm-lock.yaml"), "utf8")), "pnpm lock");
    const importers = record(lock.importers, "pnpm lock importers");
    const importerKey = relative(cwd, pkg.path).replaceAll("\\", "/") || ".";
    const importer = record(importers[importerKey], `pnpm importer ${importerKey}`);
    const result = [];
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const rawDependencies = manifest[field];
        if (rawDependencies === undefined)
            continue;
        const manifestDependencies = record(rawDependencies, `${pkg.id} ${field}`);
        const lockedDependencies = importer[field] === undefined ? {} : record(importer[field], `pnpm importer ${importerKey}.${field}`);
        for (const [alias, rawRequirement] of Object.entries(manifestDependencies)) {
            if (typeof rawRequirement !== "string")
                fail(`${pkg.id} dependency ${alias} requirement must be a string`);
            const aliasMatch = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/u.exec(rawRequirement);
            const name = aliasMatch?.[1] ?? alias;
            const id = `npm:${name}`;
            const tracked = Object.hasOwn(components, id);
            if (!tracked && name.startsWith("@"))
                assertKnown(id, components, pkg.id);
            if (!tracked) {
                normalizeRequirement(aliasMatch?.[2] ?? rawRequirement, id);
                continue;
            }
            const localVersion = planned.get(id);
            const manifestRequirement = aliasMatch?.[2] ?? rawRequirement;
            const workspaceRequirement = manifestRequirement.startsWith("workspace:") ? manifestRequirement.slice(10) : undefined;
            if (workspaceRequirement !== undefined && !localVersion)
                fail(`${id} is a workspace dependency absent from the plan`);
            const requirement = workspaceRequirement === "^" || workspaceRequirement === "~"
                ? `${workspaceRequirement}${localVersion}`
                : workspaceRequirement === "*" ? `=${localVersion}` : normalizeRequirement(manifestRequirement, id);
            const locked = record(lockedDependencies[alias], `pnpm lock ${pkg.id} dependency ${alias}`);
            const keys = Object.keys(locked);
            if (keys.some((key) => key !== "specifier" && key !== "version"))
                fail(`ambiguous pnpm lock resolution for ${id}`);
            if (locked.specifier !== rawRequirement || typeof locked.version !== "string") {
                fail(`pnpm lock observation for ${id} does not match its manifest requirement`);
            }
            const resolvedVersion = localVersion ?? locked.version.replace(/\(.+\)$/u, "");
            if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(resolvedVersion)) {
                fail(`pnpm lock resolution for ${id} is not an exact version`);
            }
            if (tracked)
                result.push({ id, requirement, resolvedVersion });
        }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
}
function isCratesIoSource(source) {
    return source === "registry+https://github.com/rust-lang/crates.io-index" || source === "sparse+https://index.crates.io/";
}
async function assertSupportedCargoSources(cwd) {
    try {
        await lstat(join(cwd, "Cargo.toml"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    const temp = await mkdtemp(join(tmpdir(), "lenso-cargo-source-check-"));
    try {
        await cp(cwd, temp, { recursive: true, filter: (source) => !source.includes(`${join(cwd, ".git")}`) });
        const { stdout } = await execFileAsync("cargo", ["metadata", "--no-deps", "--offline", "--format-version", "1"], { cwd: temp, maxBuffer: CARGO_METADATA_BUFFER });
        const metadata = JSON.parse(stdout);
        for (const owner of metadata.packages) {
            for (const dependency of owner.dependencies) {
                if (dependency.source && !isCratesIoSource(dependency.source)) {
                    fail(`${owner.name} dependency ${dependency.name} has unsupported Cargo dependency source ${dependency.source}`);
                }
            }
        }
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
}
async function cargoObservations(cwd, pkg, components, planned, locked = true) {
    let metadataCwd = cwd;
    let cleanup;
    if (!locked) {
        cleanup = await mkdtemp(join(tmpdir(), "lenso-cargo-observe-"));
        await cp(cwd, cleanup, { recursive: true, filter: (source) => !source.includes(`${join(cwd, ".git")}`) });
        metadataCwd = cleanup;
    }
    let stdout;
    try {
        ({ stdout } = await execFileAsync("cargo", ["metadata", ...(locked ? ["--locked"] : ["--offline"]), "--format-version", "1"], { cwd: metadataCwd, maxBuffer: CARGO_METADATA_BUFFER }));
    }
    finally {
        if (cleanup)
            await rm(cleanup, { recursive: true, force: true });
    }
    const metadata = JSON.parse(stdout);
    const owners = metadata.packages.filter((item) => item.name === pkg.name);
    if (owners.length !== 1)
        fail(`cargo metadata has ambiguous package identity for ${pkg.id}`);
    const owner = owners[0];
    if (!owner)
        fail(`cargo metadata omitted ${pkg.id}`);
    const node = metadata.resolve?.nodes.find((item) => item.id === owner.id);
    if (!node)
        fail(`cargo metadata has no resolved node for ${pkg.id}`);
    return owner.dependencies.flatMap((dependency) => {
        if (dependency.kind && dependency.kind !== "normal")
            return [];
        const id = `cargo:${dependency.name}`;
        if (!components[id]) {
            if (dependency.path || !dependency.source)
                fail(`${id} is a workspace dependency without component registry metadata`);
            if (!isCratesIoSource(dependency.source))
                fail(`${id} has unsupported Cargo dependency source ${dependency.source}`);
            return [];
        }
        const localVersion = planned.get(id);
        if (dependency.source && !isCratesIoSource(dependency.source))
            fail(`${id} has unsupported Cargo dependency source ${dependency.source}`);
        const matches = node.deps.filter((entry) => metadata.packages.some((candidate) => candidate.id === entry.pkg && candidate.name === dependency.name));
        if (matches.length === 0 && dependency.optional)
            return [];
        if (matches.length !== 1)
            fail(`ambiguous cargo lock resolution for ${id}`);
        const resolved = metadata.packages.find((item) => item.id === matches[0].pkg);
        if (!resolved)
            fail(`cargo lock observation for ${id} is missing`);
        return { id, requirement: normalizeRequirement(dependency.req, id), resolvedVersion: localVersion ?? resolved.version };
    }).sort((left, right) => left.id.localeCompare(right.id));
}
async function observeDependencies(cwd, pkg, components, planned, locked = true) {
    return pkg.manager === "cargo" ? cargoObservations(cwd, pkg, components, planned, locked) : npmObservations(cwd, pkg, components, planned);
}
async function assertSafePlanPath(cwd) {
    const directory = join(cwd, ".lenso-release");
    try {
        const status = await lstat(directory);
        if (!status.isDirectory() || status.isSymbolicLink())
            fail("unsafe plan persistence path");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const path = join(directory, "plan.json");
    try {
        const status = await lstat(path);
        if (!status.isFile() || status.isSymbolicLink())
            fail("unsafe plan persistence path");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    return path;
}
async function atomicWrite(path, bytes) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: false }).catch((error) => {
        if (error.code !== "EEXIST")
            throw error;
    });
    const directoryStatus = await lstat(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink())
        fail("unsafe plan persistence path");
    try {
        const targetStatus = await lstat(path);
        if (!targetStatus.isFile() || targetStatus.isSymbolicLink())
            fail("unsafe plan persistence path");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const temp = join(directory, `.plan-${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temp, path);
        const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
    }
    finally {
        await handle?.close().catch(() => undefined);
        await rm(temp, { force: true }).catch(() => undefined);
    }
}
async function assertSafeWorkspacePath(cwd, path, allowMissing) {
    const relativePath = relative(resolve(cwd), resolve(path));
    if (!relativePath || relativePath.startsWith("..") || relativePath.includes("\\"))
        fail(`unsafe workspace path ${path}`);
    const segments = relativePath.split("/");
    let current = resolve(cwd);
    for (const [index, segment] of segments.entries()) {
        current = join(current, segment);
        try {
            const status = await lstat(current);
            if (status.isSymbolicLink())
                fail(`unsafe workspace symlink ${relativePath}`);
            if (index < segments.length - 1 && !status.isDirectory())
                fail(`unsafe workspace parent ${relativePath}`);
            if (index === segments.length - 1 && !status.isFile())
                fail(`unsafe workspace target ${relativePath}`);
        }
        catch (error) {
            if (error.code === "ENOENT" && allowMissing && index === segments.length - 1)
                return;
            throw error;
        }
    }
}
async function safeRead(cwd, path) {
    await assertSafeWorkspacePath(cwd, path, false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
async function snapshotWorkspace(cwd, packages) {
    const paths = new Set([join(cwd, "Cargo.toml"), join(cwd, "Cargo.lock"), join(cwd, "pnpm-lock.yaml"), join(cwd, ".tegami/publish-lock.yaml")]);
    for (const pkg of packages) {
        paths.add(join(pkg.path, pkg.manager === "cargo" ? "Cargo.toml" : "package.json"));
        paths.add(join(pkg.path, "CHANGELOG.md"));
    }
    try {
        const tegamiDirectory = await lstat(join(cwd, ".tegami"));
        if (!tegamiDirectory.isDirectory() || tegamiDirectory.isSymbolicLink())
            fail("unsafe workspace .tegami directory");
        for (const entry of await readdir(join(cwd, ".tegami"), { withFileTypes: true })) {
            if (entry.name.endsWith(".md")) {
                if (!entry.isFile() || entry.isSymbolicLink())
                    fail(`unsafe Tegami intent ${entry.name}`);
                paths.add(join(cwd, ".tegami", entry.name));
            }
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const snapshot = new Map();
    for (const path of paths) {
        await assertSafeWorkspacePath(cwd, path, true);
        try {
            snapshot.set(path, await safeRead(cwd, path));
        }
        catch (error) {
            if (error.code === "ENOENT")
                snapshot.set(path, undefined);
            else
                throw error;
        }
    }
    return snapshot;
}
async function restoreSnapshot(cwd, snapshot) {
    for (const [path, content] of snapshot) {
        await assertSafeWorkspacePath(cwd, path, true);
        if (content === undefined) {
            try {
                const status = await lstat(path);
                if (!status.isFile() || status.isSymbolicLink())
                    fail(`unsafe rollback target ${relative(cwd, path)}`);
                await rm(path);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        else {
            const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
            try {
                await handle.writeFile(content);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        }
    }
}
async function verifyApplied(options, releasePackages, packages) {
    const { cwd } = options;
    const lock = await lstat(join(cwd, ".tegami/publish-lock.yaml"));
    if (!lock.isFile() || lock.isSymbolicLink())
        fail("Tegami publish lock was not safely generated");
    for (const item of releasePackages) {
        const pkg = packages.get(sourceId(options, item.id));
        if (!pkg)
            fail(`applied package ${item.id} was not captured`);
        const manifest = await readFile(join(pkg.path, pkg.manager === "cargo" ? "Cargo.toml" : "package.json"), "utf8");
        const version = pkg.manager === "cargo"
            ? /^version\s*=\s*"([^"]+)"/mu.exec(manifest)?.[1]
            : JSON.parse(manifest).version;
        if (version !== item.nextVersion)
            fail(`applied manifest version for ${item.id} does not match the plan`);
    }
    const cargoPackages = releasePackages.filter(({ id }) => id.startsWith("cargo:"));
    if (cargoPackages.length > 0) {
        const { stdout } = await execFileAsync("cargo", ["metadata", "--locked", "--offline", "--format-version", "1"], { cwd, maxBuffer: CARGO_METADATA_BUFFER });
        const metadata = JSON.parse(stdout);
        for (const item of cargoPackages) {
            if (!metadata.packages.some((pkg) => pkg.name === item.id.slice(6) && pkg.version === item.nextVersion)) {
                fail(`Cargo.lock does not agree with ${item.id}@${item.nextVersion}`);
            }
        }
    }
}
function buildPackages(options, pending, observations) {
    const planned = new Map(pending.map((item) => [item.id, item.nextVersion]));
    return pending.map((item) => ({
        id: item.id, previousVersion: item.previousVersion, nextVersion: item.nextVersion, bump: item.bump,
        releaseGroup: item.metadata.releaseGroup, userFacing: item.metadata.userFacing,
        dependencies: (observations.get(item.id) ?? []).map((dependency) => ({
            ...dependency,
            resolvedVersion: planned.get(dependency.id) ?? dependency.resolvedVersion,
            source: planned.has(dependency.id) ? "plan" : "registry",
        })),
    })).sort((left, right) => {
        const leftGroup = RELEASE_GROUP_ORDER.indexOf(left.releaseGroup);
        const rightGroup = RELEASE_GROUP_ORDER.indexOf(right.releaseGroup);
        const groupOrder = (leftGroup === -1 ? RELEASE_GROUP_ORDER.length : leftGroup) - (rightGroup === -1 ? RELEASE_GROUP_ORDER.length : rightGroup);
        return groupOrder || left.id.localeCompare(right.id);
    });
}
function buildPlan(options, releasePackages, generatedFiles) {
    const identity = {
        schema: "lenso.release-plan.v1", repository: options.repository, sourceCommit: options.sourceCommit,
        tegamiVersion: "1.2.5", publisher: options.publisher, generatedFiles, packages: releasePackages,
    };
    const plan = { ...identity, planId: sha256(identity) };
    assertReleasePlan(plan);
    return plan;
}
async function expectedGeneratedPaths(options, releasePackages, packages) {
    const { cwd } = options;
    const paths = new Set([".tegami/publish-lock.yaml"]);
    for (const item of releasePackages) {
        const pkg = packages.get(sourceId(options, item.id));
        if (!pkg)
            fail(`generated package ${item.id} was not captured`);
        paths.add(relative(cwd, join(pkg.path, pkg.manager === "cargo" ? "Cargo.toml" : "package.json")));
        const changelog = join(pkg.path, "CHANGELOG.md");
        try {
            const status = await lstat(changelog);
            if (!status.isFile() || status.isSymbolicLink())
                fail(`unsafe Tegami changelog for ${item.id}`);
            paths.add(relative(cwd, changelog));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        paths.add(pkg.manager === "cargo" ? "Cargo.lock" : "pnpm-lock.yaml");
    }
    if (![...paths].some((path) => path.endsWith("CHANGELOG.md")))
        fail("Tegami generated no package changelog");
    return [...paths].sort();
}
async function collectGeneratedFiles(cwd, paths) {
    return Promise.all(paths.map(async (path) => ({
        path,
        sha256: sha256(await safeRead(cwd, join(cwd, path))),
    })));
}
async function verifyGeneratedFiles(options, plan, packages) {
    const { cwd } = options;
    const expected = await expectedGeneratedPaths(options, plan.packages, packages);
    if (expected.join("\n") !== plan.generatedFiles.map(({ path }) => path).join("\n")) {
        fail("generated file set does not match the plan");
    }
    const actual = await collectGeneratedFiles(cwd, expected);
    for (const [index, item] of actual.entries()) {
        if (item.sha256 !== plan.generatedFiles[index].sha256)
            fail(`generated file digest mismatch for ${item.path}`);
    }
    const expectedSet = new Set(expected);
    for (const pkg of packages.values()) {
        const changelogPath = relative(cwd, join(pkg.path, "CHANGELOG.md"));
        try {
            await lstat(join(cwd, changelogPath));
            if (!expectedSet.has(changelogPath))
                fail(`unexpected generated file ${changelogPath}`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
}
async function readExisting(path) {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        assertReleasePlan(value);
        return value;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function verifyExisting(options, plan, packages) {
    const observations = new Map();
    const planned = new Map(plan.packages.map((item) => [item.id, item.nextVersion]));
    for (const item of plan.packages) {
        const pkg = packages.get(sourceId(options, item.id));
        const metadata = options.components[item.id];
        if (!pkg || !metadata || pkg.version !== item.nextVersion || metadata.releaseGroup !== item.releaseGroup || metadata.userFacing !== item.userFacing) {
            fail("persisted plan does not match current workspace");
        }
        observations.set(item.id, item.id.startsWith("artifact:")
            ? []
            : await observeDependencies(options.cwd, pkg, options.components, planned, false));
    }
    const rebuiltPackages = buildPackages(options, plan.packages.map((item) => ({ ...item, metadata: options.components[item.id] })), observations);
    const rebuilt = buildPlan(options, rebuiltPackages, plan.generatedFiles);
    if (!canonicalBytes(rebuilt).equals(canonicalBytes(plan))) {
        fail("persisted plan does not match current workspace");
    }
    await verifyApplied(options, plan.packages, packages);
    await verifyGeneratedFiles(options, plan, packages);
}
export async function exportReleasePlan(options) {
    const path = await assertSafePlanPath(options.cwd);
    await assertSupportedCargoSources(options.cwd);
    const captured = new Map();
    const ignored = new Set(options.ignore ?? []);
    const project = tegami({ cwd: options.cwd, ignore: [...ignored], plugins: [cargo({
                bumpDep: ({ dependent, kind }) => ignored.has(dependent.id) || ignored.has(dependent.name)
                    ? false
                    : kind === "dependencies" ? "patch" : false,
            }), repairCargoWorkspace(), refreshCargoLock(), capturePackages(captured)] });
    const draft = await project.draft();
    const pending = [...draft.getPackageDrafts()].flatMap(([id, packageDraft]) => {
        const pkg = captured.get(id);
        if (!pkg)
            return fail(`Tegami package ${id} was not captured`);
        if (options.ignore?.some((entry) => entry === id || entry === pkg.name))
            return [];
        if (!pkg.version)
            return fail(`${id} has no exact previous version`);
        const nextVersion = packageDraft.bumpVersion(pkg);
        if (nextVersion === pkg.version)
            return [];
        const componentId = planId(options, id);
        const metadata = options.components[componentId];
        if (!metadata)
            return fail(`missing component registry metadata for ${componentId}`);
        if (!packageDraft.type || !SUPPORTED_BUMPS.has(packageDraft.type))
            return fail(`${id} has unsupported bump ${String(packageDraft.type)}`);
        if (!nextVersion)
            return fail(`${id} has no exact next version`);
        return [{ id: componentId, previousVersion: pkg.version, nextVersion, bump: packageDraft.type, metadata }];
    });
    if (pending.length === 0) {
        const existing = await readExisting(path);
        if (!existing)
            return fail("draft contains no release changes");
        await verifyExisting(options, existing, captured);
        return existing;
    }
    const observations = new Map();
    const planned = new Map(pending.map((item) => [item.id, item.nextVersion]));
    for (const item of pending) {
        const pkg = captured.get(sourceId(options, item.id));
        if (!pkg)
            fail(`Tegami package ${sourceId(options, item.id)} was not captured`);
        observations.set(item.id, item.id.startsWith("artifact:")
            ? []
            : await observeDependencies(options.cwd, pkg, options.components, planned));
    }
    const releasePackages = buildPackages(options, pending, observations);
    const snapshot = await snapshotWorkspace(options.cwd, captured.values());
    try {
        await draft.apply();
        await verifyApplied(options, releasePackages, captured);
        const generatedFiles = await collectGeneratedFiles(options.cwd, await expectedGeneratedPaths(options, releasePackages, captured));
        const plan = buildPlan(options, releasePackages, generatedFiles);
        const bytes = Buffer.concat([Buffer.from(JSON.stringify(plan, null, 2)), Buffer.from("\n")]);
        await atomicWrite(path, bytes);
        return plan;
    }
    catch (error) {
        await restoreSnapshot(options.cwd, snapshot);
        throw error;
    }
}
