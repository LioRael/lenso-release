import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/**
 * Tegami 1.2.5 writes bumped virtual-workspace dependencies under a forbidden
 * root `[dependencies]` table. Move those exact versions back into the existing
 * `[workspace.dependencies]` entries before Cargo.lock is refreshed.
 */
export async function repairVirtualWorkspaceManifest(cwd) {
    const path = join(cwd, "Cargo.toml");
    let original;
    try {
        original = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    if (!/^\[workspace\]$/mu.test(original) || /^\[package\]$/mu.test(original))
        return;
    const lines = original.split("\n");
    const start = lines.findIndex((line) => line === "[dependencies]");
    if (start === -1)
        return;
    let end = start + 1;
    while (end < lines.length && (!lines[end].startsWith("[") || lines[end].startsWith("[dependencies.")))
        end += 1;
    const generated = lines.slice(start, end).join("\n");
    const versions = [...generated.matchAll(/^\[dependencies\.([^\]]+)\]\nversion = "([^"]+)"$/gmu)];
    if (versions.length === 0)
        throw new Error("virtual workspace dependency repair found no exact versions");
    let repaired = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
    for (const match of versions) {
        const key = match[1];
        const version = match[2];
        const dependency = new RegExp(`^(${escapeRegex(key)}\\s*=\\s*\\{[^\\n]*\\bversion\\s*=\\s*")[^"]+("[^\\n]*\\})$`, "mu");
        if (!dependency.test(repaired))
            throw new Error(`virtual workspace dependency ${key} has no versioned workspace entry`);
        repaired = repaired.replace(dependency, `$1${version}$2`);
    }
    await writeFile(path, repaired);
}
export function repairCargoWorkspace() {
    return {
        name: "lenso:repair-cargo-workspace",
        enforce: "post",
        async applyDraft() {
            await repairVirtualWorkspaceManifest(this.cwd);
        },
    };
}
