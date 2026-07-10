import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { tegami, type WorkspacePackage } from "tegami";
import { cargo } from "tegami/plugins/cargo";
import { parse as parseYaml } from "yaml";

import { assertReleasePlan } from "../contracts/validate.js";
import type { Bump, PublisherContract, ReleasePackage, ReleasePlanV1, Sha256 } from "../contracts/types.js";
import { canonicalBytes, sha256, type JsonValue } from "../core/canonical.js";
import { capturePackages } from "./capture-plugin.js";

const execFileAsync = promisify(execFile);

export type ReleaseComponentMetadata = { releaseGroup: string; userFacing: boolean };
export type ExportReleasePlanOptions = {
  cwd: string;
  repository: string;
  sourceCommit: string;
  publisher: PublisherContract;
  components: Readonly<Record<string, ReleaseComponentMetadata>>;
};

type DependencyObservation = { id: string; requirement: string; resolvedVersion: string };
type Snapshot = Map<string, Buffer | undefined>;
const SUPPORTED_BUMPS = new Set<Bump>(["patch", "minor", "major"]);

function fail(message: string): never {
  throw new TypeError(`cannot export Tegami release plan: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function normalizeRequirement(value: string, id: string): string {
  const requirement = value.startsWith("workspace:") ? value.slice(10) : value;
  if (!requirement || requirement === "*" || /^(?:git|github|https?|file|link|path):/u.test(requirement)) {
    fail(`${id} has floating dependency source ${value}`);
  }
  return requirement;
}

function assertKnown(id: string, components: ExportReleasePlanOptions["components"], owner: string): void {
  if (!Object.hasOwn(components, id)) fail(`${owner} dependency ${id} has no component registry metadata`);
}

async function npmObservations(
  cwd: string, pkg: WorkspacePackage, components: ExportReleasePlanOptions["components"], planned: ReadonlyMap<string, string>,
): Promise<DependencyObservation[]> {
  const manifest = record(JSON.parse(await readFile(join(pkg.path, "package.json"), "utf8")), `${pkg.id} manifest`);
  const hasDependencies = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .some((field) => manifest[field] !== undefined && Object.keys(record(manifest[field], `${pkg.id} ${field}`)).length > 0);
  if (!hasDependencies) return [];
  const lock = record(parseYaml(await readFile(join(cwd, "pnpm-lock.yaml"), "utf8")), "pnpm lock");
  const importers = record(lock.importers, "pnpm lock importers");
  const importerKey = relative(cwd, pkg.path).replaceAll("\\", "/") || ".";
  const importer = record(importers[importerKey], `pnpm importer ${importerKey}`);
  const result: DependencyObservation[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const rawDependencies = manifest[field];
    if (rawDependencies === undefined) continue;
    const manifestDependencies = record(rawDependencies, `${pkg.id} ${field}`);
    const lockedDependencies = importer[field] === undefined ? {} : record(importer[field], `pnpm importer ${importerKey}.${field}`);
    for (const [alias, rawRequirement] of Object.entries(manifestDependencies)) {
      if (typeof rawRequirement !== "string") fail(`${pkg.id} dependency ${alias} requirement must be a string`);
      const aliasMatch = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/u.exec(rawRequirement);
      const name = aliasMatch?.[1] ?? alias;
      const id = `npm:${name}`;
      assertKnown(id, components, pkg.id);
      const localVersion = planned.get(id);
      const manifestRequirement = aliasMatch?.[2] ?? rawRequirement;
      const workspaceRequirement = manifestRequirement.startsWith("workspace:") ? manifestRequirement.slice(10) : undefined;
      if (workspaceRequirement !== undefined && !localVersion) fail(`${id} is a workspace dependency absent from the plan`);
      const requirement = workspaceRequirement === "^" || workspaceRequirement === "~"
        ? `${workspaceRequirement}${localVersion}`
        : workspaceRequirement === "*" ? `=${localVersion}` : normalizeRequirement(manifestRequirement, id);
      const locked = record(lockedDependencies[alias], `pnpm lock ${pkg.id} dependency ${alias}`);
      const keys = Object.keys(locked);
      if (keys.some((key) => key !== "specifier" && key !== "version")) fail(`ambiguous pnpm lock resolution for ${id}`);
      if (locked.specifier !== rawRequirement || typeof locked.version !== "string") {
        fail(`pnpm lock observation for ${id} does not match its manifest requirement`);
      }
      const resolvedVersion = localVersion ?? locked.version.replace(/\(.+\)$/u, "");
      if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(resolvedVersion)) {
        fail(`pnpm lock resolution for ${id} is not an exact version`);
      }
      result.push({ id, requirement, resolvedVersion });
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

type CargoMetadata = {
  packages: Array<{
    id: string; name: string; version: string; manifest_path: string;
    dependencies: Array<{ name: string; rename?: string | null; req: string; source?: string | null; path?: string | null }>;
  }>;
  resolve: { nodes: Array<{ id: string; deps: Array<{ name: string; pkg: string }> }> } | null;
};

async function cargoObservations(
  cwd: string, pkg: WorkspacePackage, components: ExportReleasePlanOptions["components"],
  planned: ReadonlyMap<string, string>, locked = true,
): Promise<DependencyObservation[]> {
  let metadataCwd = cwd;
  let cleanup: string | undefined;
  if (!locked) {
    cleanup = await mkdtemp(join(tmpdir(), "lenso-cargo-observe-"));
    await cp(cwd, cleanup, { recursive: true, filter: (source) => !source.includes(`${join(cwd, ".git")}`) });
    metadataCwd = cleanup;
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("cargo", ["metadata", ...(locked ? ["--locked"] : ["--offline"]), "--format-version", "1"], { cwd: metadataCwd }));
  } finally {
    if (cleanup) await rm(cleanup, { recursive: true, force: true });
  }
  const metadata = JSON.parse(stdout) as CargoMetadata;
  const owners = metadata.packages.filter((item) => item.name === pkg.name);
  if (owners.length !== 1) fail(`cargo metadata has ambiguous package identity for ${pkg.id}`);
  const owner = owners[0];
  if (!owner) fail(`cargo metadata omitted ${pkg.id}`);
  const node = metadata.resolve?.nodes.find((item) => item.id === owner.id);
  if (!node) fail(`cargo metadata has no resolved node for ${pkg.id}`);
  return owner.dependencies.map((dependency) => {
    const id = `cargo:${dependency.name}`;
    assertKnown(id, components, pkg.id);
    const localVersion = planned.get(id);
    if ((dependency.path || !dependency.source) && !localVersion) fail(`${id} is a workspace dependency absent from the plan`);
    const matches = node.deps.filter((entry) => entry.name === (dependency.rename ?? dependency.name));
    if (matches.length !== 1) fail(`ambiguous cargo lock resolution for ${id}`);
    const resolved = metadata.packages.find((item) => item.id === matches[0]!.pkg);
    if (!resolved) fail(`cargo lock observation for ${id} is missing`);
    return { id, requirement: normalizeRequirement(dependency.req, id), resolvedVersion: localVersion ?? resolved.version };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

async function observeDependencies(
  cwd: string, pkg: WorkspacePackage, components: ExportReleasePlanOptions["components"],
  planned: ReadonlyMap<string, string>, locked = true,
): Promise<DependencyObservation[]> {
  return pkg.manager === "cargo" ? cargoObservations(cwd, pkg, components, planned, locked) : npmObservations(cwd, pkg, components, planned);
}

async function assertSafePlanPath(cwd: string): Promise<string> {
  const directory = join(cwd, ".lenso-release");
  try {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) fail("unsafe plan persistence path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const path = join(directory, "plan.json");
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) fail("unsafe plan persistence path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) fail("unsafe plan persistence path");
  try {
    const targetStatus = await lstat(path);
    if (!targetStatus.isFile() || targetStatus.isSymbolicLink()) fail("unsafe plan persistence path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function snapshotWorkspace(cwd: string, packages: Iterable<WorkspacePackage>): Promise<Snapshot> {
  const paths = new Set<string>([join(cwd, "Cargo.lock"), join(cwd, "pnpm-lock.yaml"), join(cwd, ".tegami/publish-lock.yaml")]);
  for (const pkg of packages) {
    paths.add(join(pkg.path, pkg.manager === "cargo" ? "Cargo.toml" : "package.json"));
    paths.add(join(pkg.path, "CHANGELOG.md"));
  }
  try {
    for (const entry of await readdir(join(cwd, ".tegami"), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) paths.add(join(cwd, ".tegami", entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const snapshot: Snapshot = new Map();
  for (const path of paths) {
    try { snapshot.set(path, await readFile(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") snapshot.set(path, undefined);
      else throw error;
    }
  }
  return snapshot;
}

async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  for (const [path, content] of snapshot) {
    if (content === undefined) await rm(path, { force: true });
    else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  }
}

async function verifyApplied(cwd: string, plan: ReleasePlanV1, packages: ReadonlyMap<string, WorkspacePackage>): Promise<void> {
  const lock = await lstat(join(cwd, ".tegami/publish-lock.yaml"));
  if (!lock.isFile() || lock.isSymbolicLink()) fail("Tegami publish lock was not safely generated");
  for (const item of plan.packages) {
    const pkg = packages.get(item.id);
    if (!pkg) fail(`applied package ${item.id} was not captured`);
    const manifest = await readFile(join(pkg.path, pkg.manager === "cargo" ? "Cargo.toml" : "package.json"), "utf8");
    const version = pkg.manager === "cargo"
      ? /^version\s*=\s*"([^"]+)"/mu.exec(manifest)?.[1]
      : (JSON.parse(manifest) as { version?: string }).version;
    if (version !== item.nextVersion) fail(`applied manifest version for ${item.id} does not match the plan`);
    const changelog = await lstat(join(pkg.path, "CHANGELOG.md"));
    if (!changelog.isFile() || changelog.isSymbolicLink()) fail(`Tegami changelog for ${item.id} was not safely generated`);
  }
}

function buildPlan(
  options: ExportReleasePlanOptions,
  pending: Array<{ id: string; previousVersion: string; nextVersion: string; bump: Bump; metadata: ReleaseComponentMetadata }>,
  observations: ReadonlyMap<string, DependencyObservation[]>,
): ReleasePlanV1 {
  const planned = new Map(pending.map((item) => [item.id, item.nextVersion]));
  const releasePackages: ReleasePackage[] = pending.map((item) => ({
    id: item.id, previousVersion: item.previousVersion, nextVersion: item.nextVersion, bump: item.bump,
    releaseGroup: item.metadata.releaseGroup, userFacing: item.metadata.userFacing,
    dependencies: (observations.get(item.id) ?? []).map((dependency) => ({
      ...dependency,
      resolvedVersion: planned.get(dependency.id) ?? dependency.resolvedVersion,
      source: planned.has(dependency.id) ? "plan" as const : "registry" as const,
    })),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const identity = {
    schema: "lenso.release-plan.v1" as const, repository: options.repository, sourceCommit: options.sourceCommit,
    tegamiVersion: "1.2.5" as const, publisher: options.publisher, packages: releasePackages,
  };
  const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as unknown as JsonValue) as Sha256 };
  assertReleasePlan(plan);
  return plan;
}

async function readExisting(path: string): Promise<ReleasePlanV1 | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    assertReleasePlan(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function verifyExisting(
  options: ExportReleasePlanOptions, plan: ReleasePlanV1, packages: ReadonlyMap<string, WorkspacePackage>,
): Promise<void> {
  const observations = new Map<string, DependencyObservation[]>();
  const planned = new Map(plan.packages.map((item) => [item.id, item.nextVersion]));
  for (const item of plan.packages) {
    const pkg = packages.get(item.id);
    const metadata = options.components[item.id];
    if (!pkg || !metadata || pkg.version !== item.nextVersion || metadata.releaseGroup !== item.releaseGroup || metadata.userFacing !== item.userFacing) {
      fail("persisted plan does not match current workspace");
    }
    observations.set(item.id, await observeDependencies(options.cwd, pkg, options.components, planned, false));
  }
  const rebuilt = buildPlan(options, plan.packages.map((item) => ({ ...item, metadata: options.components[item.id]! })), observations);
  if (!canonicalBytes(rebuilt as unknown as JsonValue).equals(canonicalBytes(plan as unknown as JsonValue))) {
    fail("persisted plan does not match current workspace");
  }
  await verifyApplied(options.cwd, plan, packages);
}

export async function exportReleasePlan(options: ExportReleasePlanOptions): Promise<ReleasePlanV1> {
  const path = await assertSafePlanPath(options.cwd);
  const captured = new Map<string, WorkspacePackage>();
  const project = tegami({ cwd: options.cwd, plugins: [cargo(), capturePackages(captured)] });
  const draft = await project.draft();
  const pending = [...draft.getPackageDrafts()].flatMap(([id, packageDraft]) => {
    const pkg = captured.get(id);
    if (!pkg) return fail(`Tegami package ${id} was not captured`);
    if (!pkg.version) return fail(`${id} has no exact previous version`);
    const nextVersion = packageDraft.bumpVersion(pkg);
    if (nextVersion === pkg.version) return [];
    const metadata = options.components[id];
    if (!metadata) return fail(`missing component registry metadata for ${id}`);
    if (!packageDraft.type || !SUPPORTED_BUMPS.has(packageDraft.type as Bump)) return fail(`${id} has unsupported bump ${String(packageDraft.type)}`);
    if (!nextVersion) return fail(`${id} has no exact next version`);
    return [{ id, previousVersion: pkg.version, nextVersion, bump: packageDraft.type as Bump, metadata }];
  });

  if (pending.length === 0) {
    const existing = await readExisting(path);
    if (!existing) return fail("draft contains no release changes");
    await verifyExisting(options, existing, captured);
    return existing;
  }

  const observations = new Map<string, DependencyObservation[]>();
  const planned = new Map(pending.map((item) => [item.id, item.nextVersion]));
  for (const item of pending) observations.set(item.id, await observeDependencies(options.cwd, captured.get(item.id)!, options.components, planned));
  const plan = buildPlan(options, pending, observations);
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(plan, null, 2)), Buffer.from("\n")]);
  const snapshot = await snapshotWorkspace(options.cwd, captured.values());
  try {
    await draft.apply();
    await verifyApplied(options.cwd, plan, captured);
    await atomicWrite(path, bytes);
  } catch (error) {
    await restoreSnapshot(snapshot);
    throw error;
  }
  return plan;
}
