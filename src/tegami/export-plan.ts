import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { tegami, type WorkspacePackage } from "tegami";
import { cargo } from "tegami/plugins/cargo";

import { assertReleasePlan } from "../contracts/validate.js";
import type { Bump, PublisherContract, ReleasePackage, ReleasePlanV1, Sha256 } from "../contracts/types.js";
import { sha256, type JsonValue } from "../core/canonical.js";
import { capturePackages } from "./capture-plugin.js";

export type ReleaseComponentMetadata = {
  releaseGroup: string;
  userFacing: boolean;
};

export type ExportReleasePlanOptions = {
  cwd: string;
  repository: string;
  sourceCommit: string;
  publisher: PublisherContract;
  /** Explicit injection seam for reviewed production or fixture registry metadata. */
  components: Readonly<Record<string, ReleaseComponentMetadata>>;
};

const SUPPORTED_BUMPS = new Set<Bump>(["patch", "minor", "major"]);

function fail(message: string): never {
  throw new TypeError(`cannot export Tegami release plan: ${message}`);
}

async function existingPlan(options: ExportReleasePlanOptions): Promise<ReleasePlanV1 | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(options.cwd, ".lenso-release/plan.json"), "utf8"));
    assertReleasePlan(value);
    if (
      value.repository !== options.repository ||
      value.sourceCommit !== options.sourceCommit ||
      JSON.stringify(value.publisher) !== JSON.stringify(options.publisher)
    ) fail("persisted plan belongs to different immutable inputs");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function packageName(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

function normalizeRequirement(value: string, id: string): string {
  const requirement = value.startsWith("workspace:") ? value.slice("workspace:".length) : value;
  if (/^(?:git|github|https?|file|link|path):/u.test(requirement) || requirement === "*" || requirement.length === 0) {
    return fail(`${id} has floating dependency source ${value}`);
  }
  return requirement;
}

async function npmRequirements(pkg: WorkspacePackage): Promise<Map<string, string>> {
  const manifest = JSON.parse(await readFile(join(pkg.path, "package.json"), "utf8")) as Record<string, unknown>;
  const result = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [name, requirement] of Object.entries(dependencies)) {
      if (typeof requirement === "string") result.set(`npm:${name}`, normalizeRequirement(requirement, `npm:${name}`));
    }
  }
  return result;
}

async function cargoRequirements(pkg: WorkspacePackage): Promise<Map<string, string>> {
  const content = await readFile(join(pkg.path, "Cargo.toml"), "utf8");
  const result = new Map<string, string>();
  let dependencySection = false;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    if (line.startsWith("[")) {
      dependencySection = /^\[(?:dev-|build-)?dependencies(?:\.|\])/u.test(line) || /^\[target\..+\.dependencies\]/u.test(line);
      continue;
    }
    if (!dependencySection) continue;
    const simple = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"$/u.exec(line);
    const table = /^([A-Za-z0-9_-]+)\s*=\s*\{([^}]+)\}$/u.exec(line);
    if (simple) result.set(`cargo:${simple[1]}`, normalizeRequirement(simple[2]!, `cargo:${simple[1]}`));
    if (table) {
      const version = /(?:^|,)\s*version\s*=\s*"([^"]+)"/u.exec(table[2]!)?.[1];
      if (!version || /(?:^|,)\s*(?:git|path)\s*=/u.test(table[2]!)) fail(`cargo:${table[1]} lacks an exact registry requirement`);
      result.set(`cargo:${table[1]}`, normalizeRequirement(version, `cargo:${table[1]}`));
    }
  }
  return result;
}

async function lockVersions(cwd: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  try {
    const lock = JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8")) as { packages?: Record<string, { name?: string; version?: string }> };
    for (const [path, item] of Object.entries(lock.packages ?? {})) {
      const name = item.name ?? (/node_modules\/(.+)$/u.exec(path)?.[1]);
      if (name && item.version) versions.set(`npm:${name}`, item.version);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const lock = await readFile(join(cwd, "Cargo.lock"), "utf8");
    for (const block of lock.split("[[package]]").slice(1)) {
      const name = /^\s*name\s*=\s*"([^"]+)"/mu.exec(block)?.[1];
      const version = /^\s*version\s*=\s*"([^"]+)"/mu.exec(block)?.[1];
      if (name && version) versions.set(`cargo:${name}`, version);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return versions;
}

async function dependencies(
  pkg: WorkspacePackage,
  planned: ReadonlyMap<string, string>,
  components: ExportReleasePlanOptions["components"],
  locks: ReadonlyMap<string, string>,
) {
  const requirements = pkg.manager === "cargo" ? await cargoRequirements(pkg) : await npmRequirements(pkg);
  return [...requirements]
    .filter(([id]) => Object.hasOwn(components, id))
    .map(([id, requirement]) => {
      const next = planned.get(id);
      const resolvedVersion = next ?? locks.get(id);
      if (!resolvedVersion) fail(`${pkg.id} dependency ${id} has no exact lock observation`);
      return { id, requirement, resolvedVersion, source: next ? "plan" as const : "registry" as const };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function exportReleasePlan(options: ExportReleasePlanOptions): Promise<ReleasePlanV1> {
  const packages = new Map<string, WorkspacePackage>();
  const project = tegami({ cwd: options.cwd, plugins: [cargo(), capturePackages(packages)] });
  const draft = await project.draft();
  const pending = [...draft.getPackageDrafts()].flatMap(([id, packageDraft]) => {
    const pkg = packages.get(id);
    if (!pkg) return fail(`Tegami package ${id} was not captured`);
    const metadata = options.components[id];
    if (!metadata) return fail(`missing component registry metadata for ${id}`);
    if (!pkg.version) return fail(`${id} has no exact previous version`);
    if (!packageDraft.type || !SUPPORTED_BUMPS.has(packageDraft.type as Bump)) {
      if (packageDraft.bumpVersion(pkg) === pkg.version) return [];
      return fail(`${id} has unsupported bump ${String(packageDraft.type)}`);
    }
    const nextVersion = packageDraft.bumpVersion(pkg);
    if (!nextVersion) return fail(`${id} has no exact next version`);
    if (nextVersion === pkg.version) return [];
    return [{ id, pkg, previousVersion: pkg.version, nextVersion, bump: packageDraft.type as Bump, metadata }];
  });

  if (pending.length === 0) {
    const persisted = await existingPlan(options);
    if (persisted) return persisted;
    return fail("draft contains no release changes");
  }

  await draft.apply();
  const plannedVersions = new Map(pending.map(({ id, nextVersion }) => [id, nextVersion]));
  const locks = await lockVersions(options.cwd);
  const releasePackages: ReleasePackage[] = await Promise.all(pending.map(async (item) => ({
    id: item.id,
    previousVersion: item.previousVersion,
    nextVersion: item.nextVersion,
    bump: item.bump,
    releaseGroup: item.metadata.releaseGroup,
    userFacing: item.metadata.userFacing,
    dependencies: await dependencies(item.pkg, plannedVersions, options.components, locks),
  })));
  releasePackages.sort((left, right) => left.id.localeCompare(right.id));

  const identity = {
    schema: "lenso.release-plan.v1" as const,
    repository: options.repository,
    sourceCommit: options.sourceCommit,
    tegamiVersion: "1.2.5" as const,
    publisher: options.publisher,
    packages: releasePackages,
  };
  const plan: ReleasePlanV1 = { ...identity, planId: sha256(identity as unknown as JsonValue) as Sha256 };
  assertReleasePlan(plan);
  const path = join(options.cwd, ".lenso-release/plan.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}
