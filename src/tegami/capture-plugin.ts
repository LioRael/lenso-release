import type { TegamiPlugin, WorkspacePackage } from "tegami";

/** Capture the resolved graph through Tegami's documented plugin context. */
export function capturePackages(target: Map<string, WorkspacePackage>): TegamiPlugin {
  return {
    name: "lenso:capture-packages",
    enforce: "post",
    resolve() {
      for (const pkg of this.graph.getPackages()) target.set(pkg.id, pkg);
    },
  };
}
