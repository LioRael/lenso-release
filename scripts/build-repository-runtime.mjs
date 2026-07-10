import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url).pathname;
const output = join(root, "templates/repository/.lenso-release/runtime");
const revision = process.env.LENSO_RUNTIME_SOURCE_REVISION || (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("runtime source revision must be a full Git OID");
await exec("pnpm", ["build"], { cwd: root });
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "lib"), { recursive: true });
const modules = [
  "config/components.js", "contracts/types.js", "contracts/events.js", "contracts/validate.js", "core/canonical.js", "core/dag.js",
  "publisher/contract.js", "registry/validation.js", "repository/runtime.js", "repository/cli.js", "repository/ready-event.js",
  "tegami/capture-plugin.js", "tegami/cargo-lock-plugin.js", "tegami/export-plan.js",
];
for (const path of modules) {
  await mkdir(join(output, "lib", path, ".."), { recursive: true });
  await cp(join(root, "dist/src", path), join(output, "lib", path));
}
await cp(join(root, "config/components.yaml"), join(output, "components.yaml"));
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name !== "manifest.json") {
      const rel = relative(join(root, "templates/repository"), path).replaceAll("\\", "/");
      const bytes = await readFile(path);
      files.push({ path: rel, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
    }
  }
}
await walk(output);
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(output, "manifest.json"), `${JSON.stringify({ schema: "lenso.repository-runtime.v1", sourceRevision: revision, files }, null, 2)}\n`);
