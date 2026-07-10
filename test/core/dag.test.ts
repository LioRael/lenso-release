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

  it("schedules the complete first-slice registry without a cycle", async () => {
    const registry = await loadComponents("config/components.yaml");
    const selected = Object.keys(registry.packages);
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
