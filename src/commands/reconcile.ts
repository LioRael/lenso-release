import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReconciliationIssue, ReconciliationObservation, ReconciliationReportV1, ReconciliationStatus } from "../contracts/types.js";
import { assertReconciliationReport } from "../contracts/validate.js";
import { loadComponents } from "../config/components.js";
import { observeCrateVersion } from "../registry/crates.js";
import { observeNpmVersion } from "../registry/npm.js";
import { observeGithubTag } from "../registry/github.js";
import { compatibleDigests, isCanonicalNpmIntegrity, isRfc3339, SEMVER } from "../registry/validation.js";

type Failure = { failure: string; detail: string };
type Missing = { missing: true; canonicalUrl?: string };
type VersionObservation = string | { version: string; digest?: string; publishedAt?: string; canonicalUrl?: string } | Failure | Missing;
type Surface = Record<string, VersionObservation>;

export type ReconciliationSnapshot = {
  schema?: "lenso.reconciliation-snapshot.v1";
  asOf?: string;
  known: string[];
  nonPublishable?: string[];
  source: Surface;
  registry: Surface;
  tag: Surface;
  embeddedCatalog: Surface;
  workerCatalog: Surface;
};

const VERSION = SEMVER;
const DIGEST = /^(?:git:[a-f0-9]{40}|sha256:[a-f0-9]{64}|sha512-[A-Za-z0-9+/]+={0,2})$/u;
const SURFACES = ["source", "registry", "tag", "embeddedCatalog", "workerCatalog"] as const;

function observationVersion(value: VersionObservation | undefined): string | undefined {
  return typeof value === "string" ? value : value && "version" in value ? value.version : undefined;
}

function issue(code: string, severity: ReconciliationIssue["severity"], componentId: string, detail: string): ReconciliationIssue {
  return { code, severity, componentId, detail };
}

function normalizeObservation(value: VersionObservation | undefined): ReconciliationObservation {
  if (value === undefined) return { state: "failure", version: null, digest: null, publishedAt: null, canonicalUrl: null, failure: "not-observed" };
  if (typeof value === "string") return { state: "present", version: value, digest: null, publishedAt: null, canonicalUrl: null, failure: null };
  if ("failure" in value) return { state: "failure", version: null, digest: null, publishedAt: null, canonicalUrl: null, failure: value.failure };
  if ("missing" in value) return { state: "missing", version: null, digest: null, publishedAt: null, canonicalUrl: value.canonicalUrl ?? null, failure: null };
  return {
    state: "present",
    version: value.version,
    digest: value.digest ?? null,
    publishedAt: value.publishedAt ?? null,
    canonicalUrl: value.canonicalUrl ?? null,
    failure: null,
  };
}

function deriveStatus(issues: ReconciliationIssue[]): ReconciliationStatus {
  if (issues.some(({ severity }) => severity === "observation-failure")) return "observation-failure";
  if (issues.some(({ severity }) => severity === "blocked")) return "blocked";
  return issues.length > 0 ? "drift" : "aligned";
}

function assertSnapshot(snapshot: unknown): asserts snapshot is ReconciliationSnapshot {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("snapshot must be an object");
  const root = snapshot as Record<string, unknown>;
  const allowed = new Set(["schema", "asOf", "known", "nonPublishable", ...SURFACES]);
  for (const key of Object.keys(root)) if (!allowed.has(key)) throw new TypeError(`snapshot.${key} is not allowed`);
  if (root.schema !== "lenso.reconciliation-snapshot.v1") throw new TypeError("snapshot.schema must equal lenso.reconciliation-snapshot.v1");
  if (typeof root.asOf !== "string" || !isRfc3339(root.asOf)) throw new TypeError("snapshot.asOf must be a real RFC3339 timestamp");
  if (!Array.isArray(root.known) || root.known.some((id) => typeof id !== "string" || !/^(?:npm|cargo|artifact|catalog):\S+$/u.test(id))) throw new TypeError("snapshot.known must contain valid component IDs");
  const known = root.known as string[];
  if (root.nonPublishable !== undefined && (!Array.isArray(root.nonPublishable) || root.nonPublishable.some((id) => typeof id !== "string" || !known.includes(id)))) throw new TypeError("snapshot.nonPublishable must contain known component IDs");
  for (const surfaceName of SURFACES) {
    const surface = root[surfaceName];
    if (surface === null || typeof surface !== "object" || Array.isArray(surface)) throw new TypeError(`snapshot.${surfaceName} must be an object`);
    for (const [id, value] of Object.entries(surface as Record<string, unknown>)) {
      if (!known.includes(id)) throw new TypeError(`snapshot.${surfaceName}.${id} is unknown`);
      if (typeof value === "string") { if (!VERSION.test(value)) throw new TypeError(`snapshot.${surfaceName}.${id} has invalid version`); continue; }
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`snapshot.${surfaceName}.${id} has invalid observation`);
      const observation = value as Record<string, unknown>;
      const forms = [Object.hasOwn(observation, "version"), observation.missing === true, typeof observation.failure === "string"].filter(Boolean).length;
      if (forms !== 1) throw new TypeError(`snapshot.${surfaceName}.${id} must have exactly one observation state`);
      const observationAllowed = Object.hasOwn(observation, "version") ? ["version", "digest", "publishedAt", "canonicalUrl"] : observation.missing === true ? ["missing", "canonicalUrl"] : ["failure", "detail"];
      for (const key of Object.keys(observation)) if (!observationAllowed.includes(key)) throw new TypeError(`snapshot.${surfaceName}.${id}.${key} is not allowed`);
      if (Object.hasOwn(observation, "version") && (typeof observation.version !== "string" || !VERSION.test(observation.version))) throw new TypeError(`snapshot.${surfaceName}.${id} has invalid version`);
      if (observation.digest !== undefined && (typeof observation.digest !== "string" || !DIGEST.test(observation.digest) || (observation.digest.startsWith("sha512-") && !isCanonicalNpmIntegrity(observation.digest)))) throw new TypeError(`snapshot.${surfaceName}.${id} has invalid digest`);
      if (observation.publishedAt !== undefined && (typeof observation.publishedAt !== "string" || !isRfc3339(observation.publishedAt))) throw new TypeError(`snapshot.${surfaceName}.${id} has invalid publication time`);
    }
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split("-")[0]!.split(".").map(Number);
  const b = right.split("-")[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return left.localeCompare(right);
}

export function reconcileSnapshot(snapshot: ReconciliationSnapshot): ReconciliationReportV1 {
  assertSnapshot(snapshot);
  const issues: ReconciliationIssue[] = [];
  const known = new Set(Array.isArray(snapshot.known) ? snapshot.known : []);
  const nonPublishable = new Set(snapshot.nonPublishable ?? []);
  if (known.size !== snapshot.known?.length) {
    issues.push(issue("observation.duplicate-component", "observation-failure", "snapshot", "known component IDs must be unique"));
  }
  for (const surfaceName of SURFACES) {
    const surface = snapshot[surfaceName];
    if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
      issues.push(issue("observation.invalid-surface", "observation-failure", "snapshot", `${surfaceName} must be an object`));
      continue;
    }
    for (const id of Object.keys(surface)) {
      if (!known.has(id)) issues.push(issue("observation.unknown-component", "observation-failure", id, `${surfaceName} contains an unknown component ID`));
    }
  }

  for (const id of [...known].sort()) {
    const versions: Partial<Record<(typeof SURFACES)[number], string>> = {};
    for (const surfaceName of SURFACES) {
      const value = snapshot[surfaceName]?.[id];
      if (value === undefined) {
        issues.push(issue("observation.missing-surface", "observation-failure", id, `${surfaceName} was not observed`));
      } else if (typeof value === "object" && "failure" in value) {
        issues.push(issue("observation.failed", "observation-failure", id, `${surfaceName}: ${value.failure}`));
      } else if (typeof value === "object" && "missing" in value) {
        // Registry absence is useful truth; other absent surfaces mean the observation was successful but empty.
      } else {
        const version = observationVersion(value);
        if (!version || !VERSION.test(version)) {
          issues.push(issue("observation.malformed-version", "observation-failure", id, `${surfaceName} has an invalid semantic version`));
        } else {
          versions[surfaceName] = version;
          if (typeof value === "object" && "digest" in value && value.digest !== undefined && !DIGEST.test(value.digest)) {
            issues.push(issue("observation.malformed-digest", "observation-failure", id, `${surfaceName} has an invalid digest`));
          }
        }
      }
    }

    const source = snapshot.source?.[id];
    const registry = snapshot.registry?.[id];
    const sourceDigest = typeof source === "object" && "digest" in source ? source.digest : undefined;
    const registryDigest = typeof registry === "object" && "digest" in registry ? registry.digest : undefined;
    const tagValue = snapshot.tag?.[id];
    const tagDigest = typeof tagValue === "object" && "digest" in tagValue ? tagValue.digest : undefined;
    if (versions.source && versions.registry === versions.source && registryDigest) {
      const safetyDigest = sourceDigest ?? (versions.tag === versions.source ? tagDigest : undefined);
      if (!safetyDigest || !compatibleDigests(safetyDigest, registryDigest)) {
        issues.push(issue("observation.digest-evidence-missing", "observation-failure", id, "same-version safety comparison lacks a compatible source or receipt digest"));
      } else if (safetyDigest !== registryDigest) {
        issues.push(issue("registry.version-bytes-conflict", "blocked", id, "source reuses an immutable registry version with different bytes; use the next unused patch version"));
      }
    }
    if (versions.tag && versions.registry === versions.tag && tagDigest && registryDigest && compatibleDigests(tagDigest, registryDigest) && tagDigest !== registryDigest) {
      issues.push(issue("tag.registry-digest-conflict", "blocked", id, "immutable tag receipt contradicts registry integrity"));
    }
    if (versions.source && versions.registry !== versions.source && !nonPublishable.has(id)) {
      const severity = versions.registry && compareVersions(versions.source, versions.registry) < 0 ? "drift" : "blocked";
      issues.push(issue("source.registry-version-missing", severity, id, `source ${versions.source} is not the observed registry version`));
    }
    for (const catalog of ["embeddedCatalog", "workerCatalog"] as const) {
      if (versions[catalog] && versions.registry !== versions[catalog]) {
        const severity = versions.registry && compareVersions(versions[catalog], versions.registry) < 0 ? "drift" : "blocked";
        issues.push(issue("catalog.registry-version-missing", severity, id, `${catalog} ${versions[catalog]} is not the observed registry version`));
      }
    }
    if (versions.embeddedCatalog && versions.workerCatalog && versions.embeddedCatalog !== versions.workerCatalog) {
      issues.push(issue("catalog.embedded-worker-mismatch", "drift", id, "embedded and Worker catalog versions differ"));
    }
    if (versions.tag && versions.source && versions.tag !== versions.source) {
      issues.push(issue("tag.source-version-mismatch", "drift", id, "release tag and source versions differ"));
    }
    if (registry && typeof registry === "object" && "version" in registry && tagValue && typeof tagValue === "object" && "missing" in tagValue) {
      issues.push(issue("tag.missing", "drift", id, "registry publication exists but its immutable package tag is missing"));
    }
  }

  issues.sort((left, right) => left.componentId.localeCompare(right.componentId) || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail));
  const report: ReconciliationReportV1 = {
    schema: "lenso.reconciliation-report.v1",
    status: deriveStatus(issues),
    observedAt: snapshot.asOf && Number.isFinite(Date.parse(snapshot.asOf)) ? new Date(snapshot.asOf).toISOString() : new Date().toISOString(),
    components: [...known].sort().map((id) => ({
      id,
      source: normalizeObservation(snapshot.source?.[id]),
      registry: normalizeObservation(snapshot.registry?.[id]),
      tag: normalizeObservation(snapshot.tag?.[id]),
      embeddedCatalog: normalizeObservation(snapshot.embeddedCatalog?.[id]),
      workerCatalog: normalizeObservation(snapshot.workerCatalog?.[id]),
    })),
    issues,
  };
  assertReconciliationReport(report);
  return report;
}

function parseArgs(args: string[]): { snapshot?: string; output?: string } {
  const result: { snapshot?: string; output?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--") continue;
    if (key !== "--snapshot" && key !== "--output") throw new TypeError(`unknown argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${key} requires a path`);
    if (key === "--snapshot") result.snapshot = value; else result.output = value;
    index += 1;
  }
  return result;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const destination = resolve(path);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target" || entry.name === ".worktrees") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === fileName) found.push(path);
    }
  }
  await visit(root);
  return found.sort();
}

async function sourceVersion(root: string, id: string): Promise<VersionObservation> {
  const separator = id.indexOf(":");
  const kind = id.slice(0, separator);
  const name = id.slice(separator + 1);
  if (kind === "npm") {
    for (const path of await findFiles(root, "package.json")) {
      try {
        const manifest = JSON.parse(await readFile(path, "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === name && typeof manifest.version === "string") return manifest.version;
      } catch { /* continue to the next checkout manifest */ }
    }
  } else if (kind === "cargo") {
    for (const path of await findFiles(root, "Cargo.toml")) {
      const manifest = await readFile(path, "utf8");
      const packageSection = manifest.match(/\[package\]([\s\S]*?)(?=\n\[|$)/u)?.[1];
      if (!packageSection || packageSection.match(/^name\s*=\s*"([^"]+)"/mu)?.[1] !== name) continue;
      const version = packageSection.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
      if (version) return version;
      return { failure: "schema", detail: "workspace-inherited Cargo version could not be resolved" };
    }
  }
  return { failure: "unavailable", detail: "component source manifest was not found in the sibling checkout" };
}

export async function observeCatalogFile(path: string): Promise<{ values: Surface } | Failure> {
  try {
    const document = JSON.parse(await readFile(path, "utf8")) as { modules?: Array<{ consolePackages?: Array<{ packageName?: string; version?: string }> }> };
    if (!document || !Array.isArray(document.modules)) return { failure: "schema", detail: "catalog root must contain a modules array" };
    const result: Surface = {};
    for (const module of document.modules) {
      if (!module || typeof module !== "object" || (module.consolePackages !== undefined && !Array.isArray(module.consolePackages))) return { failure: "schema", detail: "catalog module shape is invalid" };
      for (const packageEntry of module.consolePackages ?? []) {
        if (!packageEntry || typeof packageEntry.packageName !== "string" || typeof packageEntry.version !== "string" || !VERSION.test(packageEntry.version)) return { failure: "schema", detail: "catalog console package shape is invalid" };
        result[`npm:${packageEntry.packageName}`] = packageEntry.version;
      }
    }
    return { values: result };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" || code === "EACCES"
      ? { failure: "unavailable", detail: "catalog file could not be read" }
      : { failure: "schema", detail: "catalog file was not valid JSON" };
  }
}

async function liveSnapshot(): Promise<ReconciliationSnapshot> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
  const frameworkRoot = resolve(repositoryRoot, "..");
  const componentRegistry = await loadComponents(resolve(repositoryRoot, "config/components.yaml"));
  const known = Object.keys(componentRegistry.packages).sort();
  const nonPublishable = known.filter((id) => !componentRegistry.packages[id]!.publishable);
  const source: Surface = {};
  const registry: Surface = {};
  const tag: Surface = {};
  const embedded = await observeCatalogFile(resolve(frameworkRoot, "lenso/crates/platform-admin-data/catalogs/lenso-official-module-catalog.json"));
  const worker = await observeCatalogFile(resolve(frameworkRoot, "lenso-catalog-worker/catalogs/lenso-official-module-catalog.json"));
  const embeddedCatalog: Surface = {};
  const workerCatalog: Surface = {};
  for (const id of known) {
    const observedSource = await sourceVersion(frameworkRoot, id);
    source[id] = observedSource;
    const version = observationVersion(observedSource);
    if (id.startsWith("npm:") && version) registry[id] = await observeNpmVersion(id.slice(4), version);
    else if (id.startsWith("cargo:") && version) registry[id] = await observeCrateVersion(id.slice(6), version);
    else registry[id] = { failure: "unavailable", detail: "no public immutable registry observer is configured for this component kind" };
    const component = componentRegistry.packages[id]!;
    if ((id.startsWith("npm:") || id.startsWith("cargo:")) && version && component.publishable) {
      const packageName = id.slice(id.indexOf(":") + 1);
      const tagName = (id === "cargo:lenso-cli" || id === "npm:@lenso/cli") ? `lenso-cli@${version}` : `${packageName}@${version}`;
      tag[id] = await observeGithubTag(component.repository, tagName, id, version, { token: process.env.GITHUB_TOKEN });
    } else {
      tag[id] = { failure: "unsupported-kind", detail: "this component has no package-tag convention" };
    }
    embeddedCatalog[id] = "failure" in embedded ? embedded : embedded.values[id] ?? { missing: true };
    workerCatalog[id] = "failure" in worker ? worker : worker.values[id] ?? { missing: true };
  }
  return {
    schema: "lenso.reconciliation-snapshot.v1",
    asOf: new Date().toISOString(),
    known,
    nonPublishable,
    source,
    registry,
    tag,
    embeddedCatalog,
    workerCatalog,
  };
}

export async function runReconcile(args: string[]): Promise<number> {
  let report: ReconciliationReportV1;
  let output: string | undefined;
  try {
    const parsed = parseArgs(args);
    output = parsed.output;
    const snapshot = parsed.snapshot
      ? JSON.parse(await readFile(resolve(parsed.snapshot), "utf8")) as ReconciliationSnapshot
      : await liveSnapshot();
    report = reconcileSnapshot(snapshot);
  } catch (error) {
    report = {
      schema: "lenso.reconciliation-report.v1",
      status: "observation-failure",
      observedAt: new Date().toISOString(),
      components: [],
      issues: [issue("observation.invalid-input", "observation-failure", "snapshot", "snapshot or arguments failed strict validation")],
    };
    assertReconciliationReport(report);
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await atomicWrite(output, serialized); else process.stdout.write(serialized);
  return report.status === "aligned" ? 0 : report.status === "observation-failure" ? 2 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runReconcile(process.argv.slice(2));
}
