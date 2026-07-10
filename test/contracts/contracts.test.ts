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
} from "../../src/contracts/validate.js";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const oid = (character: string) => character.repeat(40);

const plan = {
  schema: "lenso.release-plan.v1",
  planId: sha("a"),
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
    rust: "1.94.0",
  },
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

const receipt = {
  schema: "lenso.component-receipt.v1",
  receiptId: sha("d"),
  planId: sha("a"),
  packageId: "cargo:lenso-contracts",
  version: "0.3.5",
  repository: "LioRael/lenso",
  sourceCommit: oid("3"),
  packedSha256: sha("e"),
  registryIntegrity: "sha256-native-registry-value",
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
  requirements: { node: "24.0.0", rust: "1.94.0" },
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

const candidateId = sha("9");
const candidate = {
  ...release,
  schema: "lenso.system-candidate.v1",
  candidateId,
  systemVersion: `0.2.0-next.c${"9".repeat(64)}`,
  proposedSystemVersion: "0.2.0",
  bumpReason: "highest user-facing component bump is minor",
  validation: {
    status: "passed",
    systemSmokeRunUrls: ["https://github.com/LioRael/lenso-release/actions/runs/3"],
  },
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

const channel = {
  schema: "lenso.system-channel.v1",
  channel: "stable",
  systemVersion: release.systemVersion,
  manifestUrl: "https://github.com/LioRael/lenso-release/releases/download/v0.1.0/manifest.json",
  manifestSha256: sha("6"),
  updatedAt: "2026-07-11T10:30:00Z",
};

const lock = {
  schema: "lenso.framework-lock.v1",
  systemVersion: release.systemVersion,
  channel: "stable",
  manifestSha256: sha("6"),
  resolvedAt: "2026-07-11T10:30:00Z",
  manifest: release,
};

const contracts = [
  ["lenso.release-plan.v1.schema.json", assertReleasePlan, plan],
  ["lenso.release-event.v1.schema.json", assertReleaseEvent, event],
  ["lenso.component-receipt.v1.schema.json", assertComponentReceipt, receipt],
  ["lenso.system-candidate.v1.schema.json", assertSystemCandidate, candidate],
  ["lenso.system-release.v1.schema.json", assertSystemRelease, release],
  ["lenso.system-channel.v1.schema.json", assertSystemChannel, channel],
  ["lenso.framework-lock.v1.schema.json", assertFrameworkLock, lock],
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
  ] as const)("rejects the same structural invalid fixture through %s and runtime validation", (file, assertContract, fixture) => {
    expect(() => assertContract(fixture)).toThrow();
    expect(ajv.validate(schemaNamed(file), fixture)).toBe(false);
  });

  it("accepts an exact dependency snapshot", () => {
    expect(() => assertReleasePlan(plan)).not.toThrow();
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
    expect(() => assertComponentReceipt({ ...receipt, version: "1.0.0-01" })).toThrow();
  });

  it("accepts RFC 3339 timestamps with an explicit offset", () => {
    expect(() => assertFrameworkLock({
      ...lock,
      resolvedAt: "2026-07-11T18:30:00+08:00",
    })).not.toThrow();
  });
});
