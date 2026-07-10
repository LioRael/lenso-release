import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertReleasePlan } from "../../src/contracts/validate.js";
import { sha256 } from "../../src/core/canonical.js";
import { exportReleasePlan, type ReleaseComponentMetadata } from "../../src/tegami/export-plan.js";

const publisher = {
  workflow: ".github/workflows/publish.yml",
  workflowSha256: `sha256:${"2".repeat(64)}` as const,
  sharedRevision: "3".repeat(40),
  sharedBundleSha256: `sha256:${"4".repeat(64)}` as const,
  runner: "ubuntu-24.04",
  node: "24.0.0",
  rust: "1.94.0",
};

async function fixture(name: string): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), `lenso-tegami-${name}-`));
  await cp(new URL(`../fixtures/tegami/${name}/`, import.meta.url), target, { recursive: true });
  return target;
}

function metadata(...entries: Array<[string, string, boolean]>): Record<string, ReleaseComponentMetadata> {
  return Object.fromEntries(entries.map(([id, releaseGroup, userFacing]) => [id, { releaseGroup, userFacing }]));
}

describe("Tegami release plan export", () => {
  it("exports a stable mixed Cargo/npm plan and applies Tegami without publishing", async () => {
    const cwd = await fixture("mixed");
    const plan = await exportReleasePlan({
      cwd,
      repository: "LioRael/fixture",
      sourceCommit: "1".repeat(40),
      publisher,
      components: metadata(
        ["cargo:fixture-core", "foundation", true],
        ["npm:@fixture/console", "console", true],
      ),
    });

    expect(plan.packages.map(({ id }) => id)).toEqual(["cargo:fixture-core", "npm:@fixture/console"]);
    expect(plan.packages.map(({ previousVersion, nextVersion, bump }) => ({ previousVersion, nextVersion, bump }))).toEqual([
      { previousVersion: "0.1.0", nextVersion: "0.2.0", bump: "minor" },
      { previousVersion: "1.0.0", nextVersion: "1.0.1", bump: "patch" },
    ]);
    expect(plan.tegamiVersion).toBe("1.2.5");
    const { planId, ...identity } = plan;
    expect(planId).toBe(sha256(identity));
    expect(() => assertReleasePlan(plan)).not.toThrow();
    await expect(readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8")).resolves.toContain("fixture-core");
    await expect(readFile(join(cwd, ".lenso-release/plan.json"), "utf8")).resolves.toBe(`${JSON.stringify(plan, null, 2)}\n`);
    await expect(readFile(join(cwd, "crates/core/Cargo.toml"), "utf8")).resolves.toContain('version = "0.2.0"');
    await expect(readFile(join(cwd, "packages/console/package.json"), "utf8")).resolves.toContain('"version": "1.0.1"');
    await expect(readFile(join(cwd, "crates/core/CHANGELOG.md"), "utf8")).resolves.toContain("0.2.0");
    await expect(readFile(join(cwd, "packages/console/CHANGELOG.md"), "utf8")).resolves.toContain("1.0.1");
  });

  it.each([
    ["cargo-only", metadata(["cargo:fixture-core", "foundation", true])],
    ["npm-only", metadata(
      ["npm:@fixture/console", "console", false],
      ["npm:@fixture/runtime", "console", false],
    )],
  ])("applies and repeats the %s fixture deterministically", async (name, components) => {
    const cwd = await fixture(name);
    const options = { cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher, components };
    const first = await exportReleasePlan(options);
    if (name === "npm-only") {
      expect(first.packages[0]?.dependencies).toEqual([{
        id: "npm:@fixture/runtime",
        requirement: "^2.3.4",
        resolvedVersion: "2.3.4",
        source: "registry",
      }]);
    }
    const persisted = await readFile(join(cwd, ".lenso-release/plan.json"), "utf8");
    const second = await exportReleasePlan(options);
    expect(second).toEqual(first);
    expect(await readFile(join(cwd, ".lenso-release/plan.json"), "utf8")).toBe(persisted);
  });

  it("fails closed when discovered package metadata is absent", async () => {
    await expect(exportReleasePlan({
      cwd: await fixture("npm-only"), repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher, components: {},
    })).rejects.toThrow("missing component registry metadata");
  });

  it("rejects an unknown dependency before mutating manifests or intents", async () => {
    const cwd = await fixture("npm-only");
    const manifest = await readFile(join(cwd, "package.json"), "utf8");
    const intent = await readFile(join(cwd, ".tegami/release.md"), "utf8");
    await expect(exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["npm:@fixture/console", "console", false]),
    })).rejects.toThrow("dependency npm:@fixture/runtime has no component registry metadata");
    expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(manifest);
    expect(await readFile(join(cwd, ".tegami/release.md"), "utf8")).toBe(intent);
  });

  it("rejects ambiguous pnpm resolution before applying the draft", async () => {
    const cwd = await fixture("npm-only");
    await writeFile(join(cwd, "pnpm-lock.yaml"), (await readFile(join(cwd, "pnpm-lock.yaml"), "utf8")).replace(
      "version: 2.3.4", "version: 2.3.4\n        alternate: 2.3.5",
    ));
    await expect(exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["npm:@fixture/console", "console", false], ["npm:@fixture/runtime", "console", false]),
    })).rejects.toThrow("ambiguous pnpm lock resolution");
    await expect(readFile(join(cwd, "package.json"), "utf8")).resolves.toContain('"version": "1.0.0"');
  });

  it("rejects stale plan reuse after metadata drift", async () => {
    const cwd = await fixture("cargo-only");
    const base = { cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher };
    await exportReleasePlan({ ...base, components: metadata(["cargo:fixture-core", "foundation", true]) });
    await expect(exportReleasePlan({
      ...base, components: metadata(["cargo:fixture-core", "host", true]),
    })).rejects.toThrow("persisted plan does not match current workspace");
  });

  it("rejects stale plan reuse after manifest version drift", async () => {
    const cwd = await fixture("cargo-only");
    const options = {
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["cargo:fixture-core", "foundation", true]),
    };
    await exportReleasePlan(options);
    await writeFile(join(cwd, "Cargo.toml"), (await readFile(join(cwd, "Cargo.toml"), "utf8")).replace("0.1.1", "9.9.9"));
    await expect(exportReleasePlan(options)).rejects.toThrow("persisted plan does not match current workspace");
  });

  it("rejects stale plan reuse after dependency drift", async () => {
    const cwd = await fixture("npm-only");
    const options = {
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["npm:@fixture/console", "console", false], ["npm:@fixture/runtime", "console", false]),
    };
    await exportReleasePlan(options);
    await writeFile(join(cwd, "package.json"), (await readFile(join(cwd, "package.json"), "utf8")).replace("^2.3.4", "~2.3.4"));
    await writeFile(join(cwd, "pnpm-lock.yaml"), (await readFile(join(cwd, "pnpm-lock.yaml"), "utf8")).replace("specifier: ^2.3.4", "specifier: ~2.3.4"));
    await expect(exportReleasePlan(options)).rejects.toThrow("persisted plan does not match current workspace");
  });

  it("rejects a symlinked persistence directory without partial output", async () => {
    const cwd = await fixture("cargo-only");
    const outside = await mkdtemp(join(tmpdir(), "lenso-plan-outside-"));
    await symlink(outside, join(cwd, ".lenso-release"));
    await expect(exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["cargo:fixture-core", "foundation", true]),
    })).rejects.toThrow("unsafe plan persistence path");
    await expect(readFile(join(outside, "plan.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(cwd, "Cargo.toml"), "utf8")).resolves.toContain('version = "0.1.0"');
    await rm(outside, { recursive: true, force: true });
  });
});
