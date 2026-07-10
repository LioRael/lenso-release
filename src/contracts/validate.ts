import type {
  ComponentReceiptV1,
  FrameworkLockV1,
  ReleaseEventV1,
  ReleasePlanV1,
  SystemCandidateV1,
  SystemChannelV1,
  SystemReleaseV1,
} from "./types.js";

type RecordValue = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}

function record(value: unknown, path: string, keys: readonly string[]): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail(path, "must not contain symbol keys");
  const actual = ownKeys as string[];
  const unknown = actual.find((key) => !keys.includes(key));
  if (unknown) fail(`${path}.${unknown}`, "is not allowed");
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) fail(`${path}.${missing}`, "is required");
  const result: RecordValue = {};
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable data property");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  return value;
}

function literal<T extends string>(value: unknown, path: string, expected: T): T {
  if (value !== expected) fail(path, `must equal ${expected}`);
  return expected;
}

function enumeration<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(path, `must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function array(value: unknown, path: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(path, `must be ${allowEmpty ? "an array" : "a non-empty array"}`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, "must be a plain array");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    fail(path, "must have a valid array length");
  }
  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) fail(path, "must be dense and contain only indexed entries");
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(`${path}[${index}]`, "must be an enumerable data property");
    }
    result.push(descriptor.value);
  }
  return result;
}

function sha256(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) fail(path, "must be a sha256: digest");
  return result;
}

function oid(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[0-9a-f]{40}$/u.test(result)) fail(path, "must be a 40-character Git OID");
  return result;
}

function semver(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(result)) {
    fail(path, "must be a SemVer version");
  }
  return result;
}

function stableSemver(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(result)) {
    fail(path, "must be a stable SemVer version without prerelease or build metadata");
  }
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) || Number.isNaN(Date.parse(result))) {
    fail(path, "must be an RFC 3339 timestamp");
  }
  return result;
}

function url(value: unknown, path: string): string {
  const result = string(value, path);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    fail(path, "must be an absolute URL");
  }
  if (parsed.protocol !== "https:") fail(path, "must use https");
  return result;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(path, "must be a positive integer");
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function unique(items: RecordValue[], key: string, path: string): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const id = string(item[key], `${path}[${index}].${key}`);
    if (seen.has(id)) fail(`${path}[${index}].${key}`, `duplicates ${id}`);
    seen.add(id);
  }
}

function assertPublisher(value: unknown, path: string): void {
  const item = record(value, path, [
    "workflow", "workflowSha256", "sharedRevision", "sharedBundleSha256",
    "runner", "node", "rust",
  ]);
  const workflow = string(item.workflow, `${path}.workflow`);
  if (!/^\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml$/u.test(workflow)) {
    fail(`${path}.workflow`, "must be a repository workflow path");
  }
  sha256(item.workflowSha256, `${path}.workflowSha256`);
  oid(item.sharedRevision, `${path}.sharedRevision`);
  sha256(item.sharedBundleSha256, `${path}.sharedBundleSha256`);
  const runner = string(item.runner, `${path}.runner`);
  if (!/^(?!.*(?:^|-)latest$)[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*$/u.test(runner)) {
    fail(`${path}.runner`, "must be a pinned runner label");
  }
  stableSemver(item.node, `${path}.node`);
  stableSemver(item.rust, `${path}.rust`);
}

export function assertReleasePlan(value: unknown): asserts value is ReleasePlanV1 {
  const plan = record(value, "releasePlan", [
    "schema", "planId", "repository", "sourceCommit", "tegamiVersion", "publisher", "packages",
  ]);
  literal(plan.schema, "releasePlan.schema", "lenso.release-plan.v1");
  sha256(plan.planId, "releasePlan.planId");
  string(plan.repository, "releasePlan.repository");
  oid(plan.sourceCommit, "releasePlan.sourceCommit");
  literal(plan.tegamiVersion, "releasePlan.tegamiVersion", "1.2.5");
  assertPublisher(plan.publisher, "releasePlan.publisher");
  const packages = array(plan.packages, "releasePlan.packages").map((entry, index) => {
    const path = `releasePlan.packages[${index}]`;
    const item = record(entry, path, [
      "id", "previousVersion", "nextVersion", "bump", "releaseGroup", "userFacing", "dependencies",
    ]);
    string(item.id, `${path}.id`);
    semver(item.previousVersion, `${path}.previousVersion`);
    semver(item.nextVersion, `${path}.nextVersion`);
    enumeration(item.bump, `${path}.bump`, ["patch", "minor", "major"]);
    string(item.releaseGroup, `${path}.releaseGroup`);
    boolean(item.userFacing, `${path}.userFacing`);
    const dependencies = array(item.dependencies, `${path}.dependencies`, true).map((dependency, dependencyIndex) => {
      const dependencyPath = `${path}.dependencies[${dependencyIndex}]`;
      const resolved = record(dependency, dependencyPath, ["id", "requirement", "resolvedVersion", "source"]);
      string(resolved.id, `${dependencyPath}.id`);
      string(resolved.requirement, `${dependencyPath}.requirement`);
      semver(resolved.resolvedVersion, `${dependencyPath}.resolvedVersion`);
      enumeration(resolved.source, `${dependencyPath}.source`, ["registry", "plan"]);
      return resolved;
    });
    unique(dependencies, "id", `${path}.dependencies`);
    return item;
  });
  unique(packages, "id", "releasePlan.packages");
}

function assertEventPackage(value: unknown, path: string): RecordValue {
  const item = record(value, path, ["id", "version"]);
  string(item.id, `${path}.id`);
  semver(item.version, `${path}.version`);
  return item;
}

export function assertReleaseEvent(value: unknown): asserts value is ReleaseEventV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("releaseEvent", "must be an object");
  const eventType = enumeration((value as RecordValue).eventType, "releaseEvent.eventType", [
    "lenso-plan-ready", "lenso-publish-requested", "lenso-publish-receipt",
  ]);
  const base = [
    "schema", "eventId", "eventType", "issuedAt", "nonce", "sourceRepository",
    "expectedAppId", "planId", "planUrl", "planSha256", "releaseCommit",
  ];
  const keys = eventType === "lenso-publish-requested"
    ? [...base, "packages"]
    : eventType === "lenso-publish-receipt"
      ? [...base, "correlationId", "receipt"]
      : base;
  const event = record(value, "releaseEvent", keys);
  literal(event.schema, "releaseEvent.schema", "lenso.release-event.v1");
  sha256(event.eventId, "releaseEvent.eventId");
  timestamp(event.issuedAt, "releaseEvent.issuedAt");
  if (string(event.nonce, "releaseEvent.nonce").length < 12) fail("releaseEvent.nonce", "must contain at least 12 characters");
  string(event.sourceRepository, "releaseEvent.sourceRepository");
  integer(event.expectedAppId, "releaseEvent.expectedAppId");
  sha256(event.planId, "releaseEvent.planId");
  url(event.planUrl, "releaseEvent.planUrl");
  sha256(event.planSha256, "releaseEvent.planSha256");
  oid(event.releaseCommit, "releaseEvent.releaseCommit");
  if (eventType === "lenso-publish-requested") {
    const packages = array(event.packages, "releaseEvent.packages").map((item, index) =>
      assertEventPackage(item, `releaseEvent.packages[${index}]`));
    unique(packages, "id", "releaseEvent.packages");
  } else if (eventType === "lenso-publish-receipt") {
    sha256(event.correlationId, "releaseEvent.correlationId");
    assertComponentReceipt(event.receipt);
  }
}

export function assertComponentReceipt(value: unknown): asserts value is ComponentReceiptV1 {
  const receipt = record(value, "componentReceipt", [
    "schema", "receiptId", "planId", "packageId", "version", "repository", "sourceCommit",
    "packedSha256", "registryIntegrity", "registryUrl", "provenanceUrl", "provenanceSubject",
    "workflowUrl", "tagUrl", "publishedAt",
  ]);
  literal(receipt.schema, "componentReceipt.schema", "lenso.component-receipt.v1");
  sha256(receipt.receiptId, "componentReceipt.receiptId");
  sha256(receipt.planId, "componentReceipt.planId");
  string(receipt.packageId, "componentReceipt.packageId");
  semver(receipt.version, "componentReceipt.version");
  string(receipt.repository, "componentReceipt.repository");
  oid(receipt.sourceCommit, "componentReceipt.sourceCommit");
  sha256(receipt.packedSha256, "componentReceipt.packedSha256");
  string(receipt.registryIntegrity, "componentReceipt.registryIntegrity");
  url(receipt.registryUrl, "componentReceipt.registryUrl");
  url(receipt.provenanceUrl, "componentReceipt.provenanceUrl");
  const subject = record(receipt.provenanceSubject, "componentReceipt.provenanceSubject", ["name", "digest"]);
  string(subject.name, "componentReceipt.provenanceSubject.name");
  string(subject.digest, "componentReceipt.provenanceSubject.digest");
  url(receipt.workflowUrl, "componentReceipt.workflowUrl");
  url(receipt.tagUrl, "componentReceipt.tagUrl");
  timestamp(receipt.publishedAt, "componentReceipt.publishedAt");
}

function assertSystemComponents(value: RecordValue, path: string): void {
  timestamp(value.createdAt, `${path}.createdAt`);
  const repositories = array(value.repositories, `${path}.repositories`).map((entry, index) => {
    const itemPath = `${path}.repositories[${index}]`;
    const item = record(entry, itemPath, ["repository", "releaseCommit"]);
    string(item.repository, `${itemPath}.repository`);
    oid(item.releaseCommit, `${itemPath}.releaseCommit`);
    return item;
  });
  unique(repositories, "repository", `${path}.repositories`);
  const packages = array(value.packages, `${path}.packages`).map((entry, index) => {
    const itemPath = `${path}.packages[${index}]`;
    const item = record(entry, itemPath, ["id", "version", "tagUrl", "registryUrl", "registryIntegrity"]);
    string(item.id, `${itemPath}.id`);
    semver(item.version, `${itemPath}.version`);
    url(item.tagUrl, `${itemPath}.tagUrl`);
    url(item.registryUrl, `${itemPath}.registryUrl`);
    string(item.registryIntegrity, `${itemPath}.registryIntegrity`);
    return item;
  });
  unique(packages, "id", `${path}.packages`);
  const artifacts = array(value.artifacts, `${path}.artifacts`, true).map((entry, index) => {
    const itemPath = `${path}.artifacts[${index}]`;
    const item = record(entry, itemPath, ["id", "url", "sha256", "provenanceUrl"]);
    string(item.id, `${itemPath}.id`);
    url(item.url, `${itemPath}.url`);
    sha256(item.sha256, `${itemPath}.sha256`);
    url(item.provenanceUrl, `${itemPath}.provenanceUrl`);
    return item;
  });
  unique(artifacts, "id", `${path}.artifacts`);
  const catalog = record(value.catalog, `${path}.catalog`, ["url", "sha256"]);
  url(catalog.url, `${path}.catalog.url`);
  sha256(catalog.sha256, `${path}.catalog.sha256`);
  const requirements = record(value.requirements, `${path}.requirements`, ["node", "rust"]);
  string(requirements.node, `${path}.requirements.node`);
  string(requirements.rust, `${path}.requirements.rust`);
  const receipts = array(value.receipts, `${path}.receipts`).map((entry, index) => {
    const itemPath = `${path}.receipts[${index}]`;
    const item = record(entry, itemPath, ["receiptId", "packageId", "version", "sourceCommit", "packedSha256", "tagUrl"]);
    sha256(item.receiptId, `${itemPath}.receiptId`);
    string(item.packageId, `${itemPath}.packageId`);
    semver(item.version, `${itemPath}.version`);
    oid(item.sourceCommit, `${itemPath}.sourceCommit`);
    sha256(item.packedSha256, `${itemPath}.packedSha256`);
    url(item.tagUrl, `${itemPath}.tagUrl`);
    return item;
  });
  unique(receipts, "receiptId", `${path}.receipts`);
  array(value.systemSmokeRunUrls, `${path}.systemSmokeRunUrls`).forEach((entry, index) =>
    url(entry, `${path}.systemSmokeRunUrls[${index}]`));
}

const systemKeys = [
  "schema", "systemVersion", "createdAt", "repositories", "packages", "artifacts",
  "catalog", "requirements", "receipts", "systemSmokeRunUrls",
] as const;

export function assertSystemRelease(value: unknown): asserts value is SystemReleaseV1 {
  const release = record(value, "systemRelease", systemKeys);
  literal(release.schema, "systemRelease.schema", "lenso.system-release.v1");
  stableSemver(release.systemVersion, "systemRelease.systemVersion");
  assertSystemComponents(release, "systemRelease");
}

export function assertSystemCandidate(value: unknown): asserts value is SystemCandidateV1 {
  const candidate = record(value, "systemCandidate", [
    ...systemKeys, "candidateId", "proposedSystemVersion", "bumpReason", "validation",
  ]);
  literal(candidate.schema, "systemCandidate.schema", "lenso.system-candidate.v1");
  const candidateId = sha256(candidate.candidateId, "systemCandidate.candidateId");
  const proposed = stableSemver(candidate.proposedSystemVersion, "systemCandidate.proposedSystemVersion");
  const expectedVersion = `${proposed}-next.c${candidateId.slice("sha256:".length)}`;
  if (candidate.systemVersion !== expectedVersion) fail("systemCandidate.systemVersion", `must equal ${expectedVersion}`);
  string(candidate.bumpReason, "systemCandidate.bumpReason");
  const validation = record(candidate.validation, "systemCandidate.validation", ["status", "systemSmokeRunUrls"]);
  enumeration(validation.status, "systemCandidate.validation.status", ["pending", "passed", "failed"]);
  array(validation.systemSmokeRunUrls, "systemCandidate.validation.systemSmokeRunUrls", true).forEach((entry, index) =>
    url(entry, `systemCandidate.validation.systemSmokeRunUrls[${index}]`));
  assertSystemComponents(candidate, "systemCandidate");
}

export function assertSystemChannel(value: unknown): asserts value is SystemChannelV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("systemChannel", "must be an object");
  const channel = enumeration((value as RecordValue).channel, "systemChannel.channel", ["stable", "next"]);
  const pointer = record(value, "systemChannel", channel === "next"
    ? ["schema", "channel", "systemVersion", "candidateId", "manifestUrl", "manifestSha256", "updatedAt"]
    : ["schema", "channel", "systemVersion", "manifestUrl", "manifestSha256", "updatedAt"]);
  literal(pointer.schema, "systemChannel.schema", "lenso.system-channel.v1");
  const version = semver(pointer.systemVersion, "systemChannel.systemVersion");
  if (channel === "next") {
    const candidateId = sha256(pointer.candidateId, "systemChannel.candidateId");
    if (!version.endsWith(`-next.c${candidateId.slice("sha256:".length)}`)) {
      fail("systemChannel.systemVersion", "must match candidateId");
    }
  } else {
    stableSemver(version, "systemChannel.systemVersion");
  }
  url(pointer.manifestUrl, "systemChannel.manifestUrl");
  sha256(pointer.manifestSha256, "systemChannel.manifestSha256");
  timestamp(pointer.updatedAt, "systemChannel.updatedAt");
}

export function assertFrameworkLock(value: unknown): asserts value is FrameworkLockV1 {
  const lock = record(value, "frameworkLock", [
    "schema", "systemVersion", "channel", "manifestSha256", "resolvedAt", "manifest",
  ]);
  literal(lock.schema, "frameworkLock.schema", "lenso.framework-lock.v1");
  const version = semver(lock.systemVersion, "frameworkLock.systemVersion");
  const channel = enumeration(lock.channel, "frameworkLock.channel", ["stable", "next"]);
  sha256(lock.manifestSha256, "frameworkLock.manifestSha256");
  timestamp(lock.resolvedAt, "frameworkLock.resolvedAt");
  if (channel === "stable") assertSystemRelease(lock.manifest);
  else assertSystemCandidate(lock.manifest);
  if ((lock.manifest as SystemReleaseV1 | SystemCandidateV1).systemVersion !== version) {
    fail("frameworkLock.systemVersion", "must match manifest.systemVersion");
  }
}
