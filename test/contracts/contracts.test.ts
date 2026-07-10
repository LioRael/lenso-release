import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";

import {
  assertComponentReceipt,
  assertFrameworkLock,
  assertReleaseEvent,
  assertReleasePlan,
  assertSystemCandidate,
  assertSystemChannel,
  assertSystemRelease,
  assertReconciliationReport,
} from "../../src/contracts/validate.js";
import { sha256 as contentSha256, type JsonValue } from "../../src/core/canonical.js";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const oid = (character: string) => character.repeat(40);

const planIdentity = {
  schema: "lenso.release-plan.v1",
  repository: "LioRael/lenso",
  sourceCommit: oid("1"),
  tegamiVersion: "1.2.5",
  publisher: {
    workflow: ".github/workflows/publish.yml",
    workflowSha256: sha("b"),
    sharedRevision: oid("2"),
    sharedBundleSha256: sha("c"),
    runner: "ubuntu-24.04",
    node: "24.0.0",
    npm: "11.7.0",
    rust: "1.94.0",
  },
  generatedFiles: [
    { path: ".tegami/publish-lock.yaml", sha256: sha("9") },
    { path: "Cargo.lock", sha256: sha("8") },
  ],
  packages: [
    {
      id: "cargo:lenso-contracts",
      previousVersion: "0.3.4",
      nextVersion: "0.3.5",
      bump: "patch",
      releaseGroup: "foundation",
      userFacing: true,
      dependencies: [],
    },
  ],
};

const plan = {
  ...planIdentity,
  planId: contentSha256(planIdentity as JsonValue),
};

it("rejects unsafe, duplicate, and unsorted generated file paths", () => {
  for (const generatedFiles of [
    [{ path: "../outside", sha256: sha("1") }],
    [{ path: "Cargo.lock", sha256: sha("1") }, { path: "Cargo.lock", sha256: sha("2") }],
    [{ path: "z.lock", sha256: sha("1") }, { path: "a.lock", sha256: sha("2") }],
  ]) {
    const identity = { ...planIdentity, generatedFiles };
    expect(() => assertReleasePlan({ ...identity, planId: contentSha256(identity as JsonValue) })).toThrow();
  }
});

const receipt = {
  schema: "lenso.component-receipt.v1",
  receiptId: sha("d"),
  planId: plan.planId,
  packageId: "cargo:lenso-contracts",
  version: "0.3.5",
  repository: "LioRael/lenso",
  sourceCommit: oid("3"),
  packedSha256: sha("e"),
  registryIntegrity: "e".repeat(64),
  registryUrl: "https://crates.io/crates/lenso-contracts/0.3.5",
  provenanceUrl: "https://github.com/LioRael/lenso/attestations/1",
  provenanceSubject: {
    name: "lenso-contracts-0.3.5.crate",
    digest: sha("e"),
  },
  workflowUrl: "https://github.com/LioRael/lenso/actions/runs/1",
  tagUrl: "https://github.com/LioRael/lenso/releases/tag/lenso-contracts%400.3.5",
  publishedAt: "2026-07-11T10:00:00Z",
};

const npmIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const npmReceipt = {
  ...receipt,
  receiptId: sha("c"),
  packageId: "npm:@lenso/runtime-console-api",
  version: "0.5.0",
  registryIntegrity: npmIntegrity,
  registryUrl: "https://registry.npmjs.org/@lenso/runtime-console-api/-/runtime-console-api-0.5.0.tgz",
  provenanceSubject: {
    name: "runtime-console-api-0.5.0.tgz",
    digest: receipt.packedSha256,
  },
};

const release = {
  schema: "lenso.system-release.v1",
  systemVersion: "0.1.0",
  createdAt: "2026-07-11T10:10:00Z",
  repositories: [{ repository: "LioRael/lenso", releaseCommit: oid("3") }],
  packages: [
    {
      id: "cargo:lenso-contracts",
      version: "0.3.5",
      tagUrl: receipt.tagUrl,
      registryUrl: receipt.registryUrl,
      registryIntegrity: receipt.registryIntegrity,
    },
  ],
  artifacts: [
    {
      id: "github:lenso-cli:linux-x64",
      url: "https://github.com/LioRael/lenso-cli/releases/download/v0.1.0/lenso",
      sha256: sha("f"),
      provenanceUrl: "https://github.com/LioRael/lenso-cli/attestations/1",
    },
  ],
  catalog: {
    url: "https://github.com/LioRael/lenso-release/releases/download/v0.1.0/modules.json",
    sha256: sha("0"),
  },
  requirements: { minimumNode: "24.0.0", minimumRust: "1.94.0" },
  receipts: [
    {
      receiptId: receipt.receiptId,
      packageId: receipt.packageId,
      version: receipt.version,
      sourceCommit: receipt.sourceCommit,
      packedSha256: receipt.packedSha256,
      tagUrl: receipt.tagUrl,
    },
  ],
  systemSmokeRunUrls: ["https://github.com/LioRael/lenso-release/actions/runs/2"],
};

const candidateIdentity = {
  schema: "lenso.system-candidate.v1",
  proposedSystemVersion: "0.2.0",
  bumpReason: "highest user-facing component bump is minor",
  validation: {
    status: "passed",
    systemSmokeRunUrls: ["https://github.com/LioRael/lenso-release/actions/runs/3"],
  },
  createdAt: release.createdAt,
  repositories: release.repositories,
  packages: release.packages,
  artifacts: release.artifacts,
  catalog: release.catalog,
  requirements: release.requirements,
  receipts: release.receipts,
  systemSmokeRunUrls: release.systemSmokeRunUrls,
};
const candidateId = contentSha256(candidateIdentity as JsonValue);
const candidate = {
  ...candidateIdentity,
  candidateId,
  systemVersion: `0.2.0-next.c${candidateId.slice("sha256:".length)}`,
};

const event = {
  schema: "lenso.release-event.v1",
  eventId: sha("4"),
  eventType: "lenso-publish-requested",
  issuedAt: "2026-07-11T10:20:00Z",
  nonce: "nonce-1234567890",
  sourceRepository: "LioRael/lenso-release",
  expectedAppId: 123456,
  planId: plan.planId,
  planUrl: "https://raw.githubusercontent.com/LioRael/lenso/main/.lenso-release/plan.json",
  planSha256: sha("5"),
  releaseCommit: oid("3"),
  packages: [{ id: "cargo:lenso-contracts", version: "0.3.5" }],
};

const receiptEvent = {
  schema: "lenso.release-event.v1",
  eventId: sha("7"),
  eventType: "lenso-publish-receipt",
  issuedAt: "2026-07-11T10:25:00Z",
  nonce: "nonce-0987654321",
  sourceRepository: receipt.repository,
  expectedAppId: 123456,
  planId: receipt.planId,
  planUrl: "https://raw.githubusercontent.com/LioRael/lenso/main/.lenso-release/plan.json",
  planSha256: sha("5"),
  releaseCommit: receipt.sourceCommit,
  correlationId: event.eventId,
  receipt,
};

const channel = {
  schema: "lenso.system-channel.v1",
  channel: "stable",
  systemVersion: release.systemVersion,
  manifestUrl: "https://github.com/LioRael/lenso-release/releases/download/v0.1.0/manifest.json",
  manifestSha256: contentSha256(release as JsonValue),
  updatedAt: "2026-07-11T10:30:00Z",
};

const lock = {
  schema: "lenso.framework-lock.v1",
  systemVersion: release.systemVersion,
  channel: "stable",
  manifestSha256: contentSha256(release as JsonValue),
  resolvedAt: "2026-07-11T10:30:00Z",
  manifest: release,
};

const floatingRequirementIdentity = {
  ...planIdentity,
  packages: [{
    ...planIdentity.packages[0],
    dependencies: [{
      id: "cargo:lenso-auth",
      requirement: "git:main",
      resolvedVersion: "0.4.0",
      source: "registry",
    }],
  }],
};
const floatingRequirementPlan = {
  ...floatingRequirementIdentity,
  planId: contentSha256(floatingRequirementIdentity as JsonValue),
};

const contracts = [
  ["lenso.release-plan.v1.schema.json", assertReleasePlan, plan],
  ["lenso.release-event.v1.schema.json", assertReleaseEvent, event],
  ["lenso.component-receipt.v1.schema.json", assertComponentReceipt, receipt],
  ["lenso.system-candidate.v1.schema.json", assertSystemCandidate, candidate],
  ["lenso.system-release.v1.schema.json", assertSystemRelease, release],
  ["lenso.system-channel.v1.schema.json", assertSystemChannel, channel],
  ["lenso.framework-lock.v1.schema.json", assertFrameworkLock, lock],
  ["lenso.reconciliation-report.v1.schema.json", assertReconciliationReport, {
    schema: "lenso.reconciliation-report.v1",
    status: "aligned",
    observedAt: "2026-07-11T00:00:00.000Z",
    components: [],
    issues: [],
  }],
] as const;

const schemaDocuments = contracts.map(([file]) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../schemas/${file}`, import.meta.url)), "utf8"),
  ),
);

const ajv = new Ajv({ allErrors: true, strict: true });
for (const schema of schemaDocuments) ajv.addSchema(schema);

function schemaNamed(file: string): AnySchema {
  const schema = schemaDocuments.find((document) => document.$id.endsWith(file));
  if (!schema) throw new Error(`missing schema fixture ${file}`);
  return schema as AnySchema;
}

describe("public release contracts", () => {
  it.each(contracts)("keeps %s aligned with its assertion validator", (file, assertContract, fixture) => {
    expect(() => assertContract(fixture)).not.toThrow();
    const schema = schemaNamed(file);
    expect(ajv.validate(schema, fixture), ajv.errorsText()).toBe(true);
  });

  it.each([
    ["lenso.release-plan.v1.schema.json", assertReleasePlan, { ...plan, packages: [plan.packages[0], plan.packages[0]] }],
    ["lenso.release-event.v1.schema.json", assertReleaseEvent, { ...event, releaseCommit: "main" }],
    ["lenso.component-receipt.v1.schema.json", assertComponentReceipt, { ...receipt, packedSha256: "sha256:bad" }],
    ["lenso.system-candidate.v1.schema.json", assertSystemCandidate, { ...candidate, proposedSystemVersion: "0.2.0+build" }],
    ["lenso.system-release.v1.schema.json", assertSystemRelease, { ...release, floatingRef: "main" }],
    ["lenso.system-channel.v1.schema.json", assertSystemChannel, { ...channel, channel: "latest" }],
    ["lenso.framework-lock.v1.schema.json", assertFrameworkLock, { ...lock, channel: "next" }],
    ["lenso.system-channel.v1.schema.json", assertSystemChannel, {
      ...channel,
      channel: "next",
      candidateId,
      systemVersion: `0.2.0-alpha-next.c${candidateId.slice("sha256:".length)}`,
    }],
    ["lenso.framework-lock.v1.schema.json", assertFrameworkLock, { ...lock, resolvedAt: "2026-02-30T10:00:00Z" }],
    ["lenso.release-event.v1.schema.json", assertReleaseEvent, { ...event, issuedAt: "2026-07-11T24:00:00Z" }],
    ["lenso.release-plan.v1.schema.json", assertReleasePlan, floatingRequirementPlan],
    ["lenso.component-receipt.v1.schema.json", assertComponentReceipt, { ...receipt, registryIntegrity: "latest" }],
    ["lenso.component-receipt.v1.schema.json", assertComponentReceipt, { ...receipt, registryIntegrity: npmIntegrity }],
    ["lenso.system-release.v1.schema.json", assertSystemRelease, {
      ...release,
      requirements: { ...release.requirements, minimumNode: "latest" },
    }],
    ["lenso.system-release.v1.schema.json", assertSystemRelease, {
      ...release,
      packages: [{ ...release.packages[0], registryIntegrity: npmIntegrity }],
    }],
  ] as const)("rejects the same structural invalid fixture through %s and runtime validation", (file, assertContract, fixture) => {
    expect(() => assertContract(fixture)).toThrow();
    expect(ajv.validate(schemaNamed(file), fixture)).toBe(false);
  });

  it("accepts an exact dependency snapshot", () => {
    expect(() => assertReleasePlan(plan)).not.toThrow();
  });

  it("rejects a well-formed plan ID when canonical plan bytes change", () => {
    expect(() => assertReleasePlan({ ...plan, repository: "LioRael/other" })).toThrow();
  });

  it("rejects a string-coupled candidate ID when canonical candidate bytes change", () => {
    expect(() => assertSystemCandidate({
      ...candidate,
      bumpReason: "changed without deriving a new candidate identity",
    })).toThrow();
  });

  it("rejects a framework lock whose manifest digest does not match its embedded manifest", () => {
    expect(() => assertFrameworkLock({
      ...lock,
      manifest: { ...release, createdAt: "2026-07-11T10:11:00Z" },
    })).toThrow();
  });

  it("rejects floating dependency sources", () => {
    const floating = {
      ...plan,
      packages: [{
        ...plan.packages[0],
        dependencies: [{
          id: "cargo:lenso-auth",
          requirement: "git:main",
          resolvedVersion: "main",
          source: "git",
        }],
      }],
    };
    expect(() => assertReleasePlan(floating)).toThrow();
  });

  it("rejects a floating requirement even with registry source and an exact resolved version", () => {
    expect(() => assertReleasePlan(floatingRequirementPlan)).toThrow();
  });

  it.each(["../local", "main", "release1", "https://example.com/pkg", "workspace:^1.0.0", "file:../pkg", "path:../pkg"])(
    "rejects non-registry dependency requirement %s",
    (requirement) => {
      const identity = {
        ...floatingRequirementIdentity,
        packages: [{
          ...floatingRequirementIdentity.packages[0],
          dependencies: [{ ...floatingRequirementIdentity.packages[0]!.dependencies[0], requirement }],
        }],
      };
      expect(() => assertReleasePlan({
        ...identity,
        planId: contentSha256(identity as JsonValue),
      })).toThrow();
    },
  );

  it.each(["1.2.3", "=1.2.3", "^1.2.3", "~1.2.3", ">=1.2.3", ">=1.2.3, <2.0.0", "^1.2.3 || ^2.0.0"])(
    "accepts supported registry SemVer requirement %s",
    (requirement) => {
      const identity = {
        ...floatingRequirementIdentity,
        packages: [{
          ...floatingRequirementIdentity.packages[0],
          dependencies: [{ ...floatingRequirementIdentity.packages[0]!.dependencies[0], requirement }],
        }],
      };
      expect(() => assertReleasePlan({
        ...identity,
        planId: contentSha256(identity as JsonValue),
      })).not.toThrow();
    },
  );

  it("requires resolved dependency versions to be exact stable SemVer", () => {
    const identity = {
      ...floatingRequirementIdentity,
      packages: [{
        ...floatingRequirementIdentity.packages[0],
        dependencies: [{
          ...floatingRequirementIdentity.packages[0]!.dependencies[0],
          requirement: "^1.2.3",
          resolvedVersion: "1.2.3-next.1",
        }],
      }],
    };
    expect(() => assertReleasePlan({
      ...identity,
      planId: contentSha256(identity as JsonValue),
    })).toThrow();
  });

  it("validates native registry integrity and binds provenance to the packed subject", () => {
    expect(() => assertComponentReceipt({ ...receipt, registryIntegrity: "latest" })).toThrow();
    expect(() => assertComponentReceipt({
      ...receipt,
      provenanceSubject: { ...receipt.provenanceSubject, digest: sha("f") },
    })).toThrow();
    expect(() => assertComponentReceipt({ ...receipt, registryIntegrity: npmIntegrity })).toThrow();
    expect(() => assertComponentReceipt(npmReceipt)).not.toThrow();
    expect(() => assertComponentReceipt({ ...npmReceipt, registryIntegrity: "e".repeat(64) })).toThrow();
    expect(() => assertSystemRelease({
      ...release,
      packages: [{ ...release.packages[0], registryIntegrity: npmIntegrity }],
    })).toThrow();
    expect(() => assertSystemRelease({
      ...release,
      packages: [{
        ...release.packages[0],
        id: "npm:@lenso/runtime-console-api",
        registryIntegrity: npmIntegrity,
      }],
    })).not.toThrow();
  });

  it("binds publish-receipt event routing fields to the nested receipt", () => {
    expect(() => assertReleaseEvent(receiptEvent)).not.toThrow();
    expect(() => assertReleaseEvent({ ...receiptEvent, planId: sha("8") })).toThrow();
    expect(() => assertReleaseEvent({ ...receiptEvent, sourceRepository: "LioRael/other" })).toThrow();
    expect(() => assertReleaseEvent({ ...receiptEvent, releaseCommit: oid("8") })).toThrow();
  });

  it("rejects floating system minimum requirements", () => {
    expect(() => assertSystemRelease({
      ...release,
      requirements: { ...release.requirements, minimumNode: "latest" },
    })).toThrow();
    expect(() => assertSystemRelease({
      ...release,
      requirements: { ...release.requirements, minimumRust: "stable" },
    })).toThrow();
  });

  it("rejects malformed hashes, OIDs, enums, duplicate IDs, and unknown fields", () => {
    const badHash = { ...receipt, packedSha256: "sha256:bad" };
    const badOid = { ...event, releaseCommit: "main" };
    const badEnum = { ...channel, channel: "latest" };
    const duplicate = { ...plan, packages: [plan.packages[0], plan.packages[0]] };
    const extra = { ...release, floatingRef: "main" };
    expect(() => assertComponentReceipt(badHash)).toThrow();
    expect(() => assertReleaseEvent(badOid)).toThrow();
    expect(() => assertSystemChannel(badEnum)).toThrow();
    expect(() => assertReleasePlan(duplicate)).toThrow();
    expect(() => assertSystemRelease(extra)).toThrow();
  });

  it("rejects structural mismatches and candidate identity mismatches", () => {
    expect(() => assertFrameworkLock({ ...lock, manifest: candidate })).toThrow();
    expect(() => assertSystemCandidate({ ...candidate, candidateId: sha("8") })).toThrow();
    expect(() => assertReleaseEvent({ ...event, packages: [] })).toThrow();
  });

  it("rejects accessor, symbol-keyed, and exotic array shapes", () => {
    const accessorPlan = { ...plan };
    Object.defineProperty(accessorPlan, "repository", {
      enumerable: true,
      get: () => "LioRael/lenso",
    });
    const symbolPlan = { ...plan, [Symbol("floating")]: "main" };
    const exoticPackages = new (class extends Array<unknown> {})(...plan.packages);
    const accessorEvent = { ...event };
    Object.defineProperty(accessorEvent, "eventType", {
      enumerable: true,
      get: () => "lenso-publish-requested",
    });
    expect(() => assertReleasePlan(accessorPlan)).toThrow();
    expect(() => assertReleasePlan(symbolPlan)).toThrow();
    expect(() => assertReleasePlan({ ...plan, packages: exoticPackages })).toThrow();
    expect(() => assertReleaseEvent(accessorEvent)).toThrow();
  });

  it("requires pinned publisher inputs and strict SemVer", () => {
    expect(() => assertReleasePlan({
      ...plan,
      publisher: { ...plan.publisher, runner: "ubuntu-latest" },
    })).toThrow();
    expect(() => assertReleasePlan({
      ...plan,
      publisher: { ...plan.publisher, node: "latest" },
    })).toThrow();
    expect(() => assertReleasePlan({
      ...plan,
      publisher: { ...plan.publisher, npm: "latest" },
    })).toThrow();
    expect(() => assertComponentReceipt({ ...receipt, version: "1.0.0-01" })).toThrow();
  });

  it("accepts RFC 3339 timestamps with an explicit offset", () => {
    expect(() => assertFrameworkLock({
      ...lock,
      resolvedAt: "2026-07-11T18:30:00+08:00",
    })).not.toThrow();
  });
});
