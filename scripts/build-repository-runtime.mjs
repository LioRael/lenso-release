import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
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
const copied = new Set();
async function vendor(name, from = join(root, "package.json")) {
  if (copied.has(name)) return; copied.add(name);
  const require = createRequire(from); const entry = require.resolve(name); let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const packageFile = join(directory, "package.json"); const pkg = JSON.parse(await readFile(packageFile, "utf8"));
      if (pkg.name === name) {
        const destination = join(output, "node_modules", name); await mkdir(dirname(destination), { recursive: true });
        await cp(await realpath(directory), destination, { recursive: true, dereference: true, filter: (source) => !/^(?:CHANGELOG|README|LICENSE|SECURITY)(?:\.|$)/iu.test(source.split("/").at(-1) ?? "") });
        for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) await vendor(dependency, packageFile);
        return;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    directory = dirname(directory);
  }
  throw new Error(`cannot resolve runtime dependency ${name}`);
}
await vendor("tegami"); await vendor("yaml");
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name !== "manifest.json") {
      const rel = relative(join(root, "templates/repository"), path).replaceAll("\\", "/");
      let bytes = await readFile(path);
      if (/\.(?:c?m?js|json|md|ts|ya?ml|toml|txt)$/u.test(entry.name)) {
        const normalized = bytes.toString("utf8").replace(/[ \t]+$/gmu, "").replace(/\n*$/u, "\n");
        bytes = Buffer.from(normalized); await writeFile(path, bytes);
      }
      files.push({ path: rel, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
    }
  }
}
await walk(output);
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
await writeFile(join(output, "manifest.json"), `${JSON.stringify({ schema: "lenso.repository-runtime.v1", sourceRevision: revision, files }, null, 2)}\n`);
