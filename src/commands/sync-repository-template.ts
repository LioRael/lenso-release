import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { canonicalBytes, sha256, type JsonValue } from "../core/canonical.js";

export type TemplateManifest = { schema: "lenso.repository-template.v1"; sourceRevision: string; files: { path: string; sha256: string }[] };
export type SyncOptions = { source: string; target: string; trustedPreviousManifests?: readonly TemplateManifest[]; failAfterWrites?: number };

function fail(message: string): never { throw new Error(`template sync: ${message}`); }
function pathIsSafe(path: string): boolean { return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }
async function assertSafeParents(root: string, relativePath: string, allowMissing: boolean): Promise<void> {
  if (!pathIsSafe(relativePath)) fail(`unsafe path ${relativePath}`);
  let current = resolve(root);
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail(`symlink is forbidden: ${relativePath}`);
      if (index < segments.length - 1 && !info.isDirectory()) fail(`non-directory parent: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}
async function readNoFollow(root: string, path: string): Promise<Buffer> {
  await assertSafeParents(root, path, false);
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}
async function sourceFiles(root: string): Promise<{ path: string; bytes: Buffer; sha256: string }[]> {
  const files: { path: string; bytes: Buffer; sha256: string }[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail("template source contains a symlink");
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (path === ".lenso-release/template-manifest.json") continue;
        const bytes = await readNoFollow(root, path);
        files.push({ path, bytes, sha256: sha256(bytes) });
      } else fail("template source contains a special file");
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function validateManifest(value: unknown): TemplateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid installed manifest");
  const manifest = value as TemplateManifest;
  if (manifest.schema !== "lenso.repository-template.v1" || !/^[0-9a-f]{40}$/u.test(manifest.sourceRevision) || !Array.isArray(manifest.files)) fail("invalid installed manifest");
  let previous = "";
  for (const file of manifest.files) {
    if (!pathIsSafe(file.path) || file.path <= previous || !/^sha256:[0-9a-f]{64}$/u.test(file.sha256)) fail("invalid installed manifest file");
    previous = file.path;
  }
  return manifest;
}
async function installedManifest(target: string): Promise<TemplateManifest | undefined> {
  try { return validateManifest(JSON.parse((await readNoFollow(target, ".lenso-release/template-manifest.json")).toString("utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function manifestEqual(left: TemplateManifest, right: TemplateManifest): boolean {
  return canonicalBytes(left as unknown as JsonValue).equals(canonicalBytes(right as unknown as JsonValue));
}

export async function syncRepositoryTemplate(options: SyncOptions): Promise<TemplateManifest> {
  const source = resolve(options.source); const target = resolve(options.target);
  if (source === target || source.startsWith(`${target}/`) || target.startsWith(`${source}/`)) fail("source and target must be separate trees");
  const runtime = JSON.parse((await readNoFollow(source, ".lenso-release/runtime/manifest.json")).toString("utf8")) as { sourceRevision?: string };
  if (!runtime.sourceRevision || !/^[0-9a-f]{40}$/u.test(runtime.sourceRevision)) fail("template runtime has no trusted revision");
  const incomingFiles = await sourceFiles(source);
  const incoming: TemplateManifest = { schema: "lenso.repository-template.v1", sourceRevision: runtime.sourceRevision, files: incomingFiles.map(({ path, sha256: digest }) => ({ path, sha256: digest })) };
  const current = await installedManifest(target);
  if (current) {
    const trusted = options.trustedPreviousManifests ?? [];
    if (!trusted.some((entry) => manifestEqual(entry, current))) fail("installed manifest is not in the trusted upgrade catalog");
    for (const file of current.files) if (sha256(await readNoFollow(target, file.path)) !== file.sha256) fail(`managed file drift: ${file.path}`);
  } else {
    for (const file of incoming.files) {
      try { await lstat(join(target, file.path)); fail(`refusing to take over existing path: ${file.path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await assertSafeParents(target, file.path, true);
    }
  }
  for (const file of incoming.files) await assertSafeParents(target, file.path, true); // all validation precedes mutation
  const transaction = await mkdtemp(join(tmpdir(), "lenso-template-sync-"));
  const backups = new Map<string, string | null>();
  const nextFiles = [...incomingFiles, { path: ".lenso-release/template-manifest.json", bytes: Buffer.from(`${JSON.stringify(incoming, null, 2)}\n`), sha256: "" }];
  try {
    for (const file of nextFiles) {
      const staged = join(transaction, "next", file.path); await mkdir(dirname(staged), { recursive: true });
      const handle = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
      try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
    }
    let writes = 0;
    for (const file of nextFiles) {
      const destination = join(target, file.path); await mkdir(dirname(destination), { recursive: true }); await assertSafeParents(target, file.path, true);
      try {
        await lstat(destination);
        const backup = join(transaction, "backup", file.path); await mkdir(dirname(backup), { recursive: true }); await rename(destination, backup); backups.set(destination, backup);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") backups.set(destination, null); else throw error; }
      await rename(join(transaction, "next", file.path), destination); writes += 1;
      if (options.failAfterWrites === writes) throw new Error("injected sync failure");
    }
    if (current) {
      const incomingPaths = new Set(incoming.files.map(({ path }) => path));
      for (const old of current.files) if (!incomingPaths.has(old.path)) fail(`template deletion requires an explicit migration: ${old.path}`);
    }
    return incoming;
  } catch (error) {
    for (const [destination, backup] of [...backups].reverse()) {
      await rm(destination, { force: true, recursive: true });
      if (backup) { await mkdir(dirname(destination), { recursive: true }); await rename(backup, destination); }
    }
    throw error;
  } finally { await rm(transaction, { recursive: true, force: true }); }
}
