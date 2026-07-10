import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadComponents, type ComponentRegistry } from "../../src/config/components.js";
import { topologicalPhases } from "../../src/core/dag.js";

async function loadFixture(contents: string): Promise<ComponentRegistry> {
  const directory = await mkdtemp(join(tmpdir(), "lenso-components-"));
  const path = join(directory, "components.yaml");
  await writeFile(path, contents, "utf8");
  return loadComponents(path);
}

const validFixture = `
schema: lenso.component-registry.v1
internalPackages: []
packages:
  - id: cargo:foundation
    repository: LioRael/lenso
    registry: crates-io
    releaseGroup: foundation
    userFacing: true
    publishable: true
    dependencies: []
  - id: cargo:consumer
    repository: LioRael/lenso
    registry: crates-io
    releaseGroup: host
    userFacing: true
    publishable: true
    dependencies: [cargo:foundation]
`;

const expectedInventory = {
  "artifact:lenso-runtime-console": ["LioRael/lenso-runtime-console", "github-release", true, true],
  "cargo:lenso": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-api": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-bootstrap": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-cli": ["LioRael/lenso-cli", "crates-io", true, true],
  "cargo:lenso-contracts": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-migrate": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-module-audit-log": ["LioRael/lenso-audit-log-module", "crates-io", true, true],
  "cargo:lenso-module-auth": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-auth-anonymous": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-auth-device": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-auth-github": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-auth-google": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-auth-oauth": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-auth-oidc": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-auth-password": ["LioRael/lenso-auth-module", "crates-io", true, true],
  "cargo:lenso-module-organization": ["LioRael/lenso-organization-module", "crates-io", true, true],
  "cargo:lenso-module-story": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-operator": ["LioRael/lenso", "crates-io", false, true],
  "cargo:lenso-platform-admin": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-platform-admin-data": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-platform-core": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-platform-http": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-platform-module": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-platform-module-remote": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-platform-runtime": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-platform-testing": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-service": ["LioRael/lenso", "crates-io", true, true],
  "cargo:lenso-worker": ["LioRael/lenso", "crates-io", true, true],
  "catalog:lenso-official-module-catalog": ["LioRael/lenso-release", "github-release", true, true],
  "npm:@lenso/auth-console": ["LioRael/lenso-auth-module", "npm", true, true],
  "npm:@lenso/auth-device-console": ["LioRael/lenso-auth-module", "npm", true, true],
  "npm:@lenso/auth-provider-console": ["LioRael/lenso-auth-module", "npm", true, true],
  "npm:@lenso/cli": ["LioRael/lenso-cli", "npm", true, true],
  "npm:@lenso/organization-console": ["LioRael/lenso-organization-module", "npm", true, true],
  "npm:@lenso/remote-module-kit": ["LioRael/lenso-runtime-console", "npm", true, true],
  "npm:@lenso/runtime-console-api": ["LioRael/lenso-runtime-console", "npm", true, true],
  "npm:@lenso/service-kit": ["LioRael/lenso-runtime-console", "npm", true, true]
} as const;

const expectedDependencies: Record<string, readonly string[]> = {
  "cargo:lenso-module-auth": [
    "cargo:lenso-contracts",
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-http",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso-module-auth-anonymous": [
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-http",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso-module-auth-device": ["cargo:lenso-platform-core", "cargo:lenso-platform-module"],
  "cargo:lenso-module-auth-oauth": ["cargo:lenso-platform-core", "cargo:lenso-platform-module"],
  "cargo:lenso-module-auth-github": [
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-http",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso-module-auth-google": [
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-http",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso-module-auth-oidc": [
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-http",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso-module-auth-password": [
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-http",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso-module-audit-log": [
    "cargo:lenso-contracts",
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso-bootstrap": [
    "cargo:lenso-module-auth",
    "cargo:lenso-module-auth-anonymous",
    "cargo:lenso-module-auth-github",
    "cargo:lenso-module-auth-google",
    "cargo:lenso-module-auth-oauth",
    "cargo:lenso-module-auth-oidc",
    "cargo:lenso-module-auth-password"
  ],
  "cargo:lenso-module-organization": [
    "cargo:lenso-module-audit-log",
    "cargo:lenso-module-auth",
    "cargo:lenso-platform-core",
    "cargo:lenso-platform-http",
    "cargo:lenso-platform-module"
  ],
  "cargo:lenso": ["cargo:lenso-module-organization"],
  "cargo:lenso-cli": ["artifact:lenso-runtime-console", "cargo:lenso"],
  "npm:@lenso/cli": ["artifact:lenso-runtime-console", "cargo:lenso", "cargo:lenso-cli"],
  "npm:@lenso/auth-console": ["npm:@lenso/runtime-console-api"],
  "npm:@lenso/auth-device-console": ["npm:@lenso/runtime-console-api"],
  "npm:@lenso/auth-provider-console": ["npm:@lenso/runtime-console-api"],
  "npm:@lenso/organization-console": ["npm:@lenso/runtime-console-api"],
  "npm:@lenso/service-kit": ["npm:@lenso/remote-module-kit"],
  "catalog:lenso-official-module-catalog": [
    "artifact:lenso-runtime-console",
    "cargo:lenso-module-audit-log",
    "cargo:lenso-module-auth",
    "cargo:lenso-module-auth-anonymous",
    "cargo:lenso-module-auth-device",
    "cargo:lenso-module-auth-github",
    "cargo:lenso-module-auth-google",
    "cargo:lenso-module-auth-oauth",
    "cargo:lenso-module-auth-oidc",
    "cargo:lenso-module-auth-password",
    "cargo:lenso-module-organization",
    "npm:@lenso/auth-console",
    "npm:@lenso/auth-device-console",
    "npm:@lenso/auth-provider-console",
    "npm:@lenso/organization-console"
  ]
} as const;

describe("component release graph", () => {
  it("orders foundation, modules, host and CLI", async () => {
    const registry = await loadComponents("config/components.yaml");
    const phases = topologicalPhases(registry, [
      "cargo:lenso-contracts",
      "cargo:lenso-module-auth",
      "cargo:lenso-module-organization",
      "cargo:lenso",
      "cargo:lenso-cli",
      "npm:@lenso/cli"
    ]);

    expect(phases).toEqual([
      ["cargo:lenso-contracts"],
      ["cargo:lenso-module-auth"],
      ["cargo:lenso-module-organization"],
      ["cargo:lenso"],
      ["cargo:lenso-cli"],
      ["npm:@lenso/cli"]
    ]);
  });

  it("sorts each phase lexically and ignores dependencies outside the selection", async () => {
    const registry = await loadComponents("config/components.yaml");

    expect(
      topologicalPhases(registry, [
        "npm:@lenso/service-kit",
        "npm:@lenso/runtime-console-api",
        "npm:@lenso/remote-module-kit"
      ])
    ).toEqual([
      ["npm:@lenso/remote-module-kit", "npm:@lenso/runtime-console-api"],
      ["npm:@lenso/service-kit"]
    ]);
    expect(topologicalPhases(registry, ["npm:@lenso/service-kit"])).toEqual([
      ["npm:@lenso/service-kit"]
    ]);
  });

  it("matches the reviewed first-slice inventory and classifications", async () => {
    const registry = await loadComponents("config/components.yaml");
    const actual = Object.fromEntries(
      Object.entries(registry.packages).map(([id, component]) => [
        id,
        [component.repository, component.registry, component.publishable, component.userFacing]
      ])
    );

    expect(actual).toEqual(expectedInventory);
  });

  it("matches every reviewed cross-repository and release-phase edge", async () => {
    const registry = await loadComponents("config/components.yaml");

    for (const id of Object.keys(expectedInventory)) {
      expect(registry.packages[id]!.dependencies).toEqual(expectedDependencies[id] ?? []);
    }
  });

  it("does not copy ordinary same-workspace manifest edges into the control plane", async () => {
    const registry = await loadComponents("config/components.yaml");
    const sameRepositoryEdges = Object.values(registry.packages)
      .flatMap((component) =>
        component.dependencies
          .filter((dependency) => registry.packages[dependency]!.repository === component.repository)
          .map((dependency) => `${dependency} -> ${component.id}`)
      )
      .sort();

    expect(sameRepositoryEdges).toEqual([
      "cargo:lenso-cli -> npm:@lenso/cli",
      "npm:@lenso/remote-module-kit -> npm:@lenso/service-kit"
    ]);
  });

  it("schedules the explicit reviewed inventory without a cycle", async () => {
    const registry = await loadComponents("config/components.yaml");
    const selected = Object.keys(expectedInventory);
    const phases = topologicalPhases(registry, selected);

    expect(phases.flat()).toHaveLength(selected.length);
    for (const phase of phases) expect(phase).toEqual([...phase].sort());
  });

  it("rejects unknown, duplicate and cyclic selections", async () => {
    const registry = await loadFixture(validFixture);

    expect(() => topologicalPhases(registry, ["cargo:missing"])).toThrow(
      "unknown selected component ID cargo:missing"
    );
    expect(() => topologicalPhases(registry, ["toString"])).toThrow(
      "unknown selected component ID toString"
    );
    expect(() => topologicalPhases(registry, ["cargo:foundation", "cargo:foundation"])).toThrow(
      "selected component IDs contain duplicates"
    );

    registry.packages["cargo:foundation"]!.dependencies = ["cargo:consumer"];
    expect(() => topologicalPhases(registry, ["cargo:foundation", "cargo:consumer"])).toThrow(
      "component dependency cycle"
    );
  });
});

describe("component registry validation", () => {
  it("fails closed on malformed YAML and unknown fields", async () => {
    await expect(loadFixture("schema: [unterminated")).rejects.toThrow(
      "invalid component registry YAML"
    );
    await expect(loadFixture(`${validFixture}\nunexpected: true\n`)).rejects.toThrow(
      "root has unknown field unexpected"
    );
  });

  it("rejects duplicate or unknown component IDs and dependencies", async () => {
    await expect(
      loadFixture(`${validFixture}\n  - id: cargo:foundation
    repository: LioRael/lenso
    registry: crates-io
    releaseGroup: foundation
    userFacing: true
    publishable: true
    dependencies: []\n`)
    ).rejects.toThrow("packages contains duplicate IDs");
    await expect(loadFixture(validFixture.replace("cargo:consumer", "python:consumer"))).rejects.toThrow(
      "unknown component ID python:consumer"
    );
    await expect(loadFixture(validFixture.replace("cargo:foundation]", "cargo:missing]"))).rejects.toThrow(
      "cargo:consumer has unknown dependency cargo:missing"
    );
  });

  it("rejects invalid repository, registry and release-group values", async () => {
    await expect(loadFixture(validFixture.replace("LioRael/lenso", "LioRael/unknown"))).rejects.toThrow(
      "unknown repository LioRael/unknown"
    );
    await expect(loadFixture(validFixture.replace("registry: crates-io", "registry: npm"))).rejects.toThrow(
      "registry npm is inconsistent with its ID"
    );
    await expect(loadFixture(validFixture.replace("releaseGroup: foundation", "releaseGroup: other"))).rejects.toThrow(
      "unknown release group other"
    );
  });

  it("rejects inconsistent publishable and unreviewed user-facing classifications", async () => {
    await expect(loadFixture(validFixture.replace("publishable: true", "publishable: false"))).rejects.toThrow(
      "cargo:foundation has an inconsistent publishable value"
    );
    await expect(loadFixture(validFixture.replace("userFacing: true", "userFacing: false"))).rejects.toThrow(
      "may be userFacing false only when reviewed in internalPackages"
    );
  });
});
