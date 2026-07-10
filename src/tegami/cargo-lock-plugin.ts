import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TegamiPlugin } from "tegami";

const execFileAsync = promisify(execFile);

/** Refresh Cargo.lock after Cargo's public applyDraft hook updates manifests. */
export function refreshCargoLock(): TegamiPlugin {
  let hasCargo = false;
  return {
    name: "lenso:refresh-cargo-lock",
    enforce: "post",
    resolve() {
      hasCargo = this.graph.getPackages().some((pkg) => pkg.manager === "cargo");
    },
    async applyDraft() {
      if (!hasCargo) return;
      const { stderr } = await execFileAsync("cargo", ["update", "--workspace", "--offline"], { cwd: this.cwd });
      if (stderr.includes("error:")) throw new Error(`Cargo lock refresh failed: ${stderr.trim()}`);
    },
  };
}
