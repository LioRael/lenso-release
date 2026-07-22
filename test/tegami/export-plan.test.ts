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
  npm: "11.7.0",
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
    expect(plan.generatedFiles.map(({ path }) => path)).toEqual([
      ".tegami/publish-lock.yaml",
      "Cargo.lock",
      "crates/core/CHANGELOG.md",
      "crates/core/Cargo.toml",
      "packages/console/CHANGELOG.md",
      "packages/console/package.json",
      "pnpm-lock.yaml",
    ]);
    const { planId, ...identity } = plan;
    expect(planId).toBe(sha256(identity));
    expect(() => assertReleasePlan(plan)).not.toThrow();
    await expect(readFile(join(cwd, ".tegami/publish-lock.yaml"), "utf8")).resolves.toContain("fixture-core");
    await expect(readFile(join(cwd, ".lenso-release/plan.json"), "utf8")).resolves.toBe(`${JSON.stringify(plan, null, 2)}\n`);
    await expect(readFile(join(cwd, "crates/core/Cargo.toml"), "utf8")).resolves.toContain('version = "0.2.0"');
    await expect(readFile(join(cwd, "Cargo.lock"), "utf8")).resolves.toContain('version = "0.2.0"');
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

  it("repeats a Cargo plan after applying workspace dependency versions", async () => {
    const cwd = await fixture("cargo-workspace-dependency");
    const options = {
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(
        ["cargo:fixture-core", "foundation", true],
        ["cargo:fixture-consumer", "host", true],
      ),
    };

    const first = await exportReleasePlan(options);
    expect(first.packages.find(({ id }) => id === "cargo:fixture-consumer")?.dependencies).toContainEqual({
      id: "cargo:fixture-core",
      requirement: "^0.1.1",
      resolvedVersion: "0.1.1",
      source: "plan",
    });
    await expect(exportReleasePlan(options)).resolves.toEqual(first);
  });

  it("atomically replaces a retained plan when fresh intent exists", async () => {
    const cwd = await fixture("cargo-only");
    const components = metadata(["cargo:fixture-core", "foundation", true]);
    const first = await exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher, components,
    });
    await writeFile(join(cwd, ".tegami/release.md"), `---
packages:
  fixture-core: patch
---

### Features

Exercise the next reviewed release.
`);

    const second = await exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "2".repeat(40), publisher, components,
    });

    expect(second.sourceCommit).toBe("2".repeat(40));
    expect(second.packages).toEqual([expect.objectContaining({
      id: "cargo:fixture-core", previousVersion: "0.1.1", nextVersion: "0.1.2",
    })]);
    expect(second.planId).not.toBe(first.planId);
    await expect(readFile(join(cwd, ".lenso-release/plan.json"), "utf8"))
      .resolves.toBe(`${JSON.stringify(second, null, 2)}\n`);
  });

  it("verifies a partial release beside historical package changelogs", async () => {
    const cwd = await fixture("mixed");
    const components = metadata(
      ["cargo:fixture-core", "foundation", true],
      ["npm:@fixture/console", "console", true],
    );
    await exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher, components,
    });
    await writeFile(join(cwd, ".tegami/release.md"), `---
packages:
  fixture-core: patch
---

### Fixes

Exercise a partial follow-up release.
`);

    const partial = await exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "2".repeat(40), publisher, components,
    });

    expect(partial.packages.map(({ id }) => id)).toEqual(["cargo:fixture-core"]);
    expect(partial.generatedFiles.map(({ path }) => path)).not.toContain("packages/console/CHANGELOG.md");
    await expect(exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "2".repeat(40), publisher, components,
    })).resolves.toEqual(partial);
  });

  it("resolves auto-installed peer dependencies from the pnpm importer", async () => {
    const cwd = await fixture("npm-only");
    const path = join(cwd, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.peerDependencies = manifest.dependencies;
    delete manifest.dependencies;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const plan = await exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["npm:@fixture/console", "console", false], ["npm:@fixture/runtime", "console", false]),
    });
    expect(plan.packages[0]?.dependencies).toEqual([expect.objectContaining({ id: "npm:@fixture/runtime", resolvedVersion: "2.3.4" })]);
  });

  it("fails closed when discovered package metadata is absent", async () => {
    await expect(exportReleasePlan({
      cwd: await fixture("npm-only"), repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher, components: {},
    })).rejects.toThrow("missing component registry metadata");
  });

  it("maps a Tegami workspace version to a reviewed hosted artifact", async () => {
    const cwd = await fixture("npm-only");
    const plan = await exportReleasePlan({
      cwd,
      repository: "LioRael/fixture",
      sourceCommit: "1".repeat(40),
      publisher,
      aliases: { "artifact:lenso-runtime-console": "npm:@fixture/console" },
      components: metadata(["artifact:lenso-runtime-console", "console", true]),
    });

    expect(plan.packages).toEqual([
      expect.objectContaining({
        id: "artifact:lenso-runtime-console",
        previousVersion: "1.0.0",
        nextVersion: "1.0.1",
        dependencies: [],
      }),
    ]);
    expect(plan.generatedFiles.map(({ path }) => path)).toContain("package.json");
    expect(await readFile(join(cwd, "package.json"), "utf8")).toContain('"version": "1.0.1"');
    await expect(exportReleasePlan({
      cwd,
      repository: "LioRael/fixture",
      sourceCommit: "1".repeat(40),
      publisher,
      aliases: { "artifact:lenso-runtime-console": "npm:@fixture/console" },
      components: metadata(["artifact:lenso-runtime-console", "console", true]),
    })).resolves.toEqual(plan);
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

  it.each(["crates/core/CHANGELOG.md", ".tegami/publish-lock.yaml"])("rejects generated output tamper at %s", async (path) => {
    const cwd = await fixture("mixed");
    const options = {
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["cargo:fixture-core", "foundation", true], ["npm:@fixture/console", "console", true]),
    };
    await exportReleasePlan(options);
    await writeFile(join(cwd, path), "tampered\n");
    await expect(exportReleasePlan(options)).rejects.toThrow("generated file digest mismatch");
  });

  it("rejects Cargo git sources before mutation", async () => {
    const cwd = await fixture("cargo-only");
    const manifestPath = join(cwd, "Cargo.toml");
    const original = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, `${original}\n[dependencies]\nfixture-git = { git = "https://example.invalid/repo.git", version = "1.0.0" }\n`);
    const modified = await readFile(manifestPath, "utf8");
    await expect(exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["cargo:fixture-core", "foundation", true], ["cargo:fixture-git", "foundation", false]),
    })).rejects.toThrow("unsupported Cargo dependency source");
    expect(await readFile(manifestPath, "utf8")).toBe(modified);
    await expect(readFile(join(cwd, ".tegami/release.md"), "utf8")).resolves.toContain("fixture-core");
  });

  it("rejects a symlinked rollback target without mutating outside the workspace", async () => {
    const cwd = await fixture("cargo-only");
    const outside = join(await mkdtemp(join(tmpdir(), "lenso-rollback-outside-")), "CHANGELOG.md");
    const outsideBytes = "outside changelog\n";
    await writeFile(outside, outsideBytes);
    await symlink(outside, join(cwd, "CHANGELOG.md"));
    await expect(exportReleasePlan({
      cwd, repository: "LioRael/fixture", sourceCommit: "1".repeat(40), publisher,
      components: metadata(["cargo:fixture-core", "foundation", true]),
    })).rejects.toThrow("unsafe workspace symlink");
    expect(await readFile(outside, "utf8")).toBe(outsideBytes);
    await expect(readFile(join(cwd, ".tegami/release.md"), "utf8")).resolves.toContain("fixture-core");
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
