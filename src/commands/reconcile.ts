import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReconciliationIssue, ReconciliationObservation, ReconciliationReportV1, ReconciliationStatus } from "../contracts/types.js";
import { assertReconciliationReport } from "../contracts/validate.js";
import { loadComponents } from "../config/components.js";
import { observeCrateVersion } from "../registry/crates.js";
import { observeNpmVersion } from "../registry/npm.js";

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

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const DIGEST = /^(?:sha256:[a-f0-9]{64}|sha(?:1|256|384|512)-[A-Za-z0-9+/=_-]+)$/u;
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

function compareVersions(left: string, right: string): number {
  const a = left.split("-")[0]!.split(".").map(Number);
  const b = right.split("-")[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return left.localeCompare(right);
}

export function reconcileSnapshot(snapshot: ReconciliationSnapshot): ReconciliationReportV1 {
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
    if (versions.source && versions.registry === versions.source && sourceDigest && registryDigest && sourceDigest !== registryDigest) {
      issues.push(issue("registry.version-bytes-conflict", "blocked", id, "source reuses an immutable registry version with different bytes; use the next unused patch version"));
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

async function catalogVersions(path: string): Promise<Surface> {
  try {
    const document = JSON.parse(await readFile(path, "utf8")) as { modules?: Array<{ consolePackages?: Array<{ packageName?: string; version?: string }> }> };
    const result: Surface = {};
    for (const module of document.modules ?? []) {
      for (const packageEntry of module.consolePackages ?? []) {
        if (packageEntry.packageName && packageEntry.version) result[`npm:${packageEntry.packageName}`] = packageEntry.version;
      }
    }
    return result;
  } catch {
    return {};
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
  const embedded = await catalogVersions(resolve(frameworkRoot, "lenso/crates/platform-admin-data/catalogs/lenso-official-module-catalog.json"));
  const worker = await catalogVersions(resolve(frameworkRoot, "lenso-catalog-worker/catalogs/lenso-official-module-catalog.json"));
  const embeddedCatalog: Surface = {};
  const workerCatalog: Surface = {};
  for (const id of known) {
    const observedSource = await sourceVersion(frameworkRoot, id);
    source[id] = observedSource;
    const version = observationVersion(observedSource);
    if (id.startsWith("npm:") && version) registry[id] = await observeNpmVersion(id.slice(4), version);
    else if (id.startsWith("cargo:") && version) registry[id] = await observeCrateVersion(id.slice(6), version);
    else registry[id] = { failure: "unavailable", detail: "no public immutable registry observer is configured for this component kind" };
    tag[id] = { failure: "unavailable", detail: "GitHub tag truth was not observed without an authenticated GitHub observer" };
    embeddedCatalog[id] = embedded[id] ?? { missing: true };
    workerCatalog[id] = worker[id] ?? { missing: true };
  }
  return {
    schema: "lenso.reconciliation-snapshot.v1",
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
      issues: [issue("observation.invalid-input", "observation-failure", "snapshot", error instanceof Error ? error.message : "invalid observation input")],
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
