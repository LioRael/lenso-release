import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repairVirtualWorkspaceManifest } from "../../src/tegami/cargo-workspace-plugin.js";

describe("Cargo virtual workspace repair", () => {
  it("moves Tegami's generated dependency version into workspace dependencies", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lenso-cargo-workspace-"));
    const manifest = `[workspace]\nmembers = ["crates/core"]\n\n[workspace.dependencies]\ncore = { package = "fixture-core", path = "crates/core", version = "0.1.0" }\n\n[dependencies]\n\n[dependencies.core]\nversion = "0.1.1"\n\n[workspace.lints.rust]\nunsafe_code = "forbid"\n`;
    await writeFile(join(cwd, "Cargo.toml"), manifest);
    await repairVirtualWorkspaceManifest(cwd);
    const repaired = await readFile(join(cwd, "Cargo.toml"), "utf8");
    expect(repaired).toContain('core = { package = "fixture-core", path = "crates/core", version = "0.1.1" }');
    expect(repaired).not.toContain("[dependencies]");
  });
});
