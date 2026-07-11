import { sha256 as canonicalSha256 } from "../core/canonical.js";
import { isCanonicalNpmIntegrity, isRfc3339, SEMVER, SHA256 } from "../registry/validation.js";
export function assertReconciliationReport(value) {
    const root = record(value, "report", ["schema", "status", "observedAt", "components", "issues"]);
    literal(root.schema, "report.schema", "lenso.reconciliation-report.v1");
    enumeration(root.status, "report.status", ["aligned", "drift", "blocked", "observation-failure"]);
    const observedAt = string(root.observedAt, "report.observedAt");
    if (!isRfc3339(observedAt))
        fail("report.observedAt", "must be a real RFC 3339 timestamp");
    const components = array(root.components, "report.components", true);
    let previousId = "";
    for (const [index, component] of components.entries()) {
        const item = record(component, `report.components[${index}]`, ["id", "source", "registry", "tag", "embeddedCatalog", "workerCatalog"]);
        const id = string(item.id, `report.components[${index}].id`);
        if (id <= previousId)
            fail(`report.components[${index}].id`, "must be unique and sorted");
        previousId = id;
        for (const surface of ["source", "registry", "tag", "embeddedCatalog", "workerCatalog"]) {
            const observation = record(item[surface], `report.components[${index}].${surface}`, ["state", "version", "digest", "publishedAt", "canonicalUrl", "failure"]);
            const state = enumeration(observation.state, `report.components[${index}].${surface}.state`, ["present", "missing", "failure", "not-applicable"]);
            for (const field of ["version", "digest", "publishedAt", "canonicalUrl", "failure"]) {
                if (observation[field] !== null && typeof observation[field] !== "string")
                    fail(`report.components[${index}].${surface}.${field}`, "must be a string or null");
            }
            if (state === "present" && typeof observation.version !== "string")
                fail(`report.components[${index}].${surface}.version`, "is required when present");
            if (state === "failure" && typeof observation.failure !== "string")
                fail(`report.components[${index}].${surface}.failure`, "is required on failure");
            if (state === "present" && observation.failure !== null)
                fail(`report.components[${index}].${surface}.failure`, "must be null when present");
            if (state === "missing" && [observation.version, observation.digest, observation.publishedAt, observation.failure].some((field) => field !== null))
                fail(`report.components[${index}].${surface}`, "missing observations may contain only a canonical URL");
            if (state === "failure" && [observation.version, observation.digest, observation.publishedAt, observation.canonicalUrl].some((field) => field !== null))
                fail(`report.components[${index}].${surface}`, "failure observations may contain only a failure code");
            if (state === "not-applicable" && [observation.version, observation.digest, observation.publishedAt, observation.canonicalUrl, observation.failure].some((field) => field !== null))
                fail(`report.components[${index}].${surface}`, "not-applicable observations must not contain evidence");
            if (typeof observation.version === "string" && !SEMVER.test(observation.version))
                fail(`report.components[${index}].${surface}.version`, "must be semantic version");
            if (typeof observation.digest === "string" && !SHA256.test(observation.digest) && !isCanonicalNpmIntegrity(observation.digest) && !/^git:[a-f0-9]{40}$/u.test(observation.digest))
                fail(`report.components[${index}].${surface}.digest`, "must be a supported canonical digest");
            if (typeof observation.publishedAt === "string" && !isRfc3339(observation.publishedAt))
                fail(`report.components[${index}].${surface}.publishedAt`, "must be a real RFC 3339 timestamp");
            if (typeof observation.canonicalUrl === "string" && !/^https:\/\//u.test(observation.canonicalUrl))
                fail(`report.components[${index}].${surface}.canonicalUrl`, "must be HTTPS");
        }
    }
    const issues = array(root.issues, "report.issues", true);
    for (const [index, issue] of issues.entries()) {
        const item = record(issue, `report.issues[${index}]`, ["code", "severity", "componentId", "detail"]);
        string(item.code, `report.issues[${index}].code`);
        enumeration(item.severity, `report.issues[${index}].severity`, ["drift", "blocked", "observation-failure"]);
        string(item.componentId, `report.issues[${index}].componentId`);
        string(item.detail, `report.issues[${index}].detail`);
    }
    const expected = issues.some((issue) => issue.severity === "observation-failure")
        ? "observation-failure"
        : issues.some((issue) => issue.severity === "blocked")
            ? "blocked"
            : issues.length > 0 ? "drift" : "aligned";
    if (root.status !== expected)
        fail("report.status", `must equal derived status ${expected}`);
}
function fail(path, message) {
    throw new TypeError(`${path} ${message}`);
}
function record(value, path, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(path, "must be an object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail(path, "must be a plain object");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string"))
        fail(path, "must not contain symbol keys");
    const actual = ownKeys;
    const unknown = actual.find((key) => !keys.includes(key));
    if (unknown)
        fail(`${path}.${unknown}`, "is not allowed");
    const missing = keys.find((key) => !Object.hasOwn(value, key));
    if (missing)
        fail(`${path}.${missing}`, "is required");
    const result = {};
    for (const key of actual) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            fail(`${path}.${key}`, "must be an enumerable data property");
        }
        result[key] = descriptor.value;
    }
    return result;
}
function string(value, path) {
    if (typeof value !== "string" || value.length === 0)
        fail(path, "must be a non-empty string");
    return value;
}
function literal(value, path, expected) {
    if (value !== expected)
        fail(path, `must equal ${expected}`);
    return expected;
}
function enumeration(value, path, values) {
    if (typeof value !== "string" || !values.includes(value)) {
        fail(path, `must be one of ${values.join(", ")}`);
    }
    return value;
}
function array(value, path, allowEmpty = false) {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
        fail(path, `must be ${allowEmpty ? "an array" : "a non-empty array"}`);
    }
    if (Object.getPrototypeOf(value) !== Array.prototype)
        fail(path, "must be a plain array");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
        fail(path, "must have a valid array length");
    }
    const length = lengthDescriptor.value;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1)
        fail(path, "must be dense and contain only indexed entries");
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            fail(`${path}[${index}]`, "must be an enumerable data property");
        }
        result.push(descriptor.value);
    }
    return result;
}
function sha256(value, path) {
    const result = string(value, path);
    if (!/^sha256:[0-9a-f]{64}$/u.test(result))
        fail(path, "must be a sha256: digest");
    return result;
}
function oid(value, path) {
    const result = string(value, path);
    if (!/^[0-9a-f]{40}$/u.test(result))
        fail(path, "must be a 40-character Git OID");
    return result;
}
function semver(value, path) {
    const result = string(value, path);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(result)) {
        fail(path, "must be a SemVer version");
    }
    return result;
}
function stableSemver(value, path) {
    const result = string(value, path);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(result)) {
        fail(path, "must be a stable SemVer version without prerelease or build metadata");
    }
    return result;
}
function timestamp(value, path) {
    const result = string(value, path);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(result);
    if (!match) {
        fail(path, "must be an RFC 3339 timestamp");
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) {
        fail(path, "must contain a real calendar date");
    }
    return result;
}
function immutableRequirement(value, path) {
    const result = string(value, path);
    const version = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
    const token = `(?:\\^|~|=|>=|<=|>|<)?${version}`;
    const comparatorSet = `${token}(?:[ ,]+${token})*`;
    if (!new RegExp(`^${comparatorSet}(?: *\\|\\| *${comparatorSet})*$`, "u").test(result)) {
        fail(path, "must be an immutable registry version requirement");
    }
    return result;
}
function packageEcosystem(packageId, path) {
    const result = string(packageId, path);
    if (/^cargo:.+/u.test(result))
        return "cargo";
    if (/^npm:.+/u.test(result))
        return "npm";
    if (/^artifact:.+/u.test(result))
        return "artifact";
    fail(path, "must use a cargo:, npm:, or artifact: component ID");
}
function registryIntegrity(value, ecosystem, path) {
    const result = string(value, path);
    if (ecosystem === "artifact") {
        if (!/^sha256:[0-9a-f]{64}$/u.test(result))
            fail(path, "must be a canonical artifact SHA-256 digest");
        return result;
    }
    if (ecosystem === "cargo") {
        if (!/^[0-9a-f]{64}$/u.test(result))
            fail(path, "must be a crates.io lowercase SHA-256 checksum");
        return result;
    }
    const sri = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(result);
    if (!sri)
        fail(path, "must be an npm sha512 SRI");
    const encoded = sri[1];
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length !== 64 || decoded.toString("base64") !== encoded) {
        fail(path, "must contain a canonical 64-byte npm sha512 SRI digest");
    }
    return result;
}
function digestRecord(value) {
    return canonicalSha256(value);
}
function url(value, path) {
    const result = string(value, path);
    let parsed;
    try {
        parsed = new URL(result);
    }
    catch {
        fail(path, "must be an absolute URL");
    }
    if (parsed.protocol !== "https:")
        fail(path, "must use https");
    return result;
}
function integer(value, path) {
    if (!Number.isSafeInteger(value) || value <= 0)
        fail(path, "must be a positive integer");
    return value;
}
function boolean(value, path) {
    if (typeof value !== "boolean")
        fail(path, "must be a boolean");
    return value;
}
function unique(items, key, path) {
    const seen = new Set();
    for (const [index, item] of items.entries()) {
        const id = string(item[key], `${path}[${index}].${key}`);
        if (seen.has(id))
            fail(`${path}[${index}].${key}`, `duplicates ${id}`);
        seen.add(id);
    }
}
function assertPublisher(value, path) {
    const item = record(value, path, [
        "workflow", "workflowSha256", "sharedRevision", "sharedBundleSha256",
        "runner", "node", "npm", "rust",
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
    stableSemver(item.npm, `${path}.npm`);
    stableSemver(item.rust, `${path}.rust`);
}
export function assertReleasePlan(value) {
    const plan = record(value, "releasePlan", [
        "schema", "planId", "repository", "sourceCommit", "tegamiVersion", "publisher", "generatedFiles", "packages",
    ]);
    literal(plan.schema, "releasePlan.schema", "lenso.release-plan.v1");
    sha256(plan.planId, "releasePlan.planId");
    string(plan.repository, "releasePlan.repository");
    oid(plan.sourceCommit, "releasePlan.sourceCommit");
    literal(plan.tegamiVersion, "releasePlan.tegamiVersion", "1.2.5");
    assertPublisher(plan.publisher, "releasePlan.publisher");
    const generatedFiles = array(plan.generatedFiles, "releasePlan.generatedFiles").map((entry, index) => {
        const path = `releasePlan.generatedFiles[${index}]`;
        const item = record(entry, path, ["path", "sha256"]);
        const filePath = string(item.path, `${path}.path`);
        if (filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
            fail(`${path}.path`, "must be a normalized workspace-relative path");
        }
        sha256(item.sha256, `${path}.sha256`);
        return item;
    });
    unique(generatedFiles, "path", "releasePlan.generatedFiles");
    for (let index = 1; index < generatedFiles.length; index += 1) {
        if (generatedFiles[index - 1].path >= generatedFiles[index].path) {
            fail("releasePlan.generatedFiles", "must be sorted by path");
        }
    }
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
            immutableRequirement(resolved.requirement, `${dependencyPath}.requirement`);
            stableSemver(resolved.resolvedVersion, `${dependencyPath}.resolvedVersion`);
            enumeration(resolved.source, `${dependencyPath}.source`, ["registry", "plan"]);
            return resolved;
        });
        unique(dependencies, "id", `${path}.dependencies`);
        return item;
    });
    unique(packages, "id", "releasePlan.packages");
    const { planId, ...identity } = plan;
    if (planId !== digestRecord(identity))
        fail("releasePlan.planId", "must match the canonical plan identity payload");
}
function assertEventPackage(value, path) {
    const item = record(value, path, ["id", "version"]);
    string(item.id, `${path}.id`);
    semver(item.version, `${path}.version`);
    return item;
}
export function assertReleaseEvent(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        fail("releaseEvent", "must be an object");
    const eventType = enumeration(value.eventType, "releaseEvent.eventType", [
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
    if (string(event.nonce, "releaseEvent.nonce").length < 12)
        fail("releaseEvent.nonce", "must contain at least 12 characters");
    string(event.sourceRepository, "releaseEvent.sourceRepository");
    integer(event.expectedAppId, "releaseEvent.expectedAppId");
    sha256(event.planId, "releaseEvent.planId");
    url(event.planUrl, "releaseEvent.planUrl");
    sha256(event.planSha256, "releaseEvent.planSha256");
    oid(event.releaseCommit, "releaseEvent.releaseCommit");
    if (eventType === "lenso-publish-requested") {
        const packages = array(event.packages, "releaseEvent.packages").map((item, index) => assertEventPackage(item, `releaseEvent.packages[${index}]`));
        unique(packages, "id", "releaseEvent.packages");
    }
    else if (eventType === "lenso-publish-receipt") {
        sha256(event.correlationId, "releaseEvent.correlationId");
        assertComponentReceipt(event.receipt);
        const receipt = event.receipt;
        if (event.planId !== receipt.planId)
            fail("releaseEvent.planId", "must match receipt.planId");
        if (event.sourceRepository !== receipt.repository)
            fail("releaseEvent.sourceRepository", "must match receipt.repository");
        if (event.releaseCommit !== receipt.sourceCommit)
            fail("releaseEvent.releaseCommit", "must match receipt.sourceCommit");
    }
}
export function assertComponentReceipt(value) {
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
    const packedSha256 = sha256(receipt.packedSha256, "componentReceipt.packedSha256");
    const ecosystem = packageEcosystem(receipt.packageId, "componentReceipt.packageId");
    registryIntegrity(receipt.registryIntegrity, ecosystem, "componentReceipt.registryIntegrity");
    url(receipt.registryUrl, "componentReceipt.registryUrl");
    url(receipt.provenanceUrl, "componentReceipt.provenanceUrl");
    const subject = record(receipt.provenanceSubject, "componentReceipt.provenanceSubject", ["name", "digest"]);
    string(subject.name, "componentReceipt.provenanceSubject.name");
    const subjectDigest = sha256(subject.digest, "componentReceipt.provenanceSubject.digest");
    if (subjectDigest !== packedSha256) {
        fail("componentReceipt.provenanceSubject.digest", "must match packedSha256");
    }
    url(receipt.workflowUrl, "componentReceipt.workflowUrl");
    url(receipt.tagUrl, "componentReceipt.tagUrl");
    timestamp(receipt.publishedAt, "componentReceipt.publishedAt");
}
function assertSystemComponents(value, path) {
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
        const ecosystem = packageEcosystem(item.id, `${itemPath}.id`);
        registryIntegrity(item.registryIntegrity, ecosystem, `${itemPath}.registryIntegrity`);
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
    const requirements = record(value.requirements, `${path}.requirements`, ["minimumNode", "minimumRust"]);
    stableSemver(requirements.minimumNode, `${path}.requirements.minimumNode`);
    stableSemver(requirements.minimumRust, `${path}.requirements.minimumRust`);
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
    array(value.systemSmokeRunUrls, `${path}.systemSmokeRunUrls`).forEach((entry, index) => url(entry, `${path}.systemSmokeRunUrls[${index}]`));
}
const systemKeys = [
    "schema", "systemVersion", "createdAt", "repositories", "packages", "artifacts",
    "catalog", "requirements", "receipts", "systemSmokeRunUrls",
];
export function assertSystemRelease(value) {
    const release = record(value, "systemRelease", systemKeys);
    literal(release.schema, "systemRelease.schema", "lenso.system-release.v1");
    stableSemver(release.systemVersion, "systemRelease.systemVersion");
    assertSystemComponents(release, "systemRelease");
}
export function assertSystemCandidate(value) {
    const candidate = record(value, "systemCandidate", [
        ...systemKeys, "candidateId", "proposedSystemVersion", "bumpReason", "validation",
    ]);
    literal(candidate.schema, "systemCandidate.schema", "lenso.system-candidate.v1");
    const candidateId = sha256(candidate.candidateId, "systemCandidate.candidateId");
    const proposed = stableSemver(candidate.proposedSystemVersion, "systemCandidate.proposedSystemVersion");
    const expectedVersion = `${proposed}-next.c${candidateId.slice("sha256:".length)}`;
    if (candidate.systemVersion !== expectedVersion)
        fail("systemCandidate.systemVersion", `must equal ${expectedVersion}`);
    string(candidate.bumpReason, "systemCandidate.bumpReason");
    const validation = record(candidate.validation, "systemCandidate.validation", ["status", "systemSmokeRunUrls"]);
    enumeration(validation.status, "systemCandidate.validation.status", ["pending", "passed", "failed"]);
    array(validation.systemSmokeRunUrls, "systemCandidate.validation.systemSmokeRunUrls", true).forEach((entry, index) => url(entry, `systemCandidate.validation.systemSmokeRunUrls[${index}]`));
    assertSystemComponents(candidate, "systemCandidate");
    const { candidateId: _candidateId, systemVersion: _systemVersion, ...identity } = candidate;
    const computedCandidateId = digestRecord(identity);
    if (candidateId !== computedCandidateId) {
        fail("systemCandidate.candidateId", "must match the canonical candidate identity payload");
    }
}
export function assertSystemChannel(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        fail("systemChannel", "must be an object");
    const channel = enumeration(value.channel, "systemChannel.channel", ["stable", "next"]);
    const pointer = record(value, "systemChannel", channel === "next"
        ? ["schema", "channel", "systemVersion", "candidateId", "manifestUrl", "manifestSha256", "updatedAt"]
        : ["schema", "channel", "systemVersion", "manifestUrl", "manifestSha256", "updatedAt"]);
    literal(pointer.schema, "systemChannel.schema", "lenso.system-channel.v1");
    if (channel === "next") {
        const candidateId = sha256(pointer.candidateId, "systemChannel.candidateId");
        const version = string(pointer.systemVersion, "systemChannel.systemVersion");
        const match = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-next\.c([0-9a-f]{64})$/u.exec(version);
        if (!match || `sha256:${match[2]}` !== candidateId) {
            fail("systemChannel.systemVersion", "must be an exact candidate version matching candidateId");
        }
    }
    else {
        stableSemver(pointer.systemVersion, "systemChannel.systemVersion");
    }
    url(pointer.manifestUrl, "systemChannel.manifestUrl");
    sha256(pointer.manifestSha256, "systemChannel.manifestSha256");
    timestamp(pointer.updatedAt, "systemChannel.updatedAt");
}
export function assertFrameworkLock(value) {
    const lock = record(value, "frameworkLock", [
        "schema", "systemVersion", "channel", "manifestSha256", "resolvedAt", "manifest",
    ]);
    literal(lock.schema, "frameworkLock.schema", "lenso.framework-lock.v1");
    const version = semver(lock.systemVersion, "frameworkLock.systemVersion");
    const channel = enumeration(lock.channel, "frameworkLock.channel", ["stable", "next"]);
    const manifestSha256 = sha256(lock.manifestSha256, "frameworkLock.manifestSha256");
    timestamp(lock.resolvedAt, "frameworkLock.resolvedAt");
    if (channel === "stable")
        assertSystemRelease(lock.manifest);
    else
        assertSystemCandidate(lock.manifest);
    if (lock.manifest.systemVersion !== version) {
        fail("frameworkLock.systemVersion", "must match manifest.systemVersion");
    }
    if (manifestSha256 !== canonicalSha256(lock.manifest)) {
        fail("frameworkLock.manifestSha256", "must match the exact embedded manifest bytes");
    }
}
