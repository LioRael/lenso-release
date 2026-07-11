/** Capture the resolved graph through Tegami's documented plugin context. */
export function capturePackages(target) {
    return {
        name: "lenso:capture-packages",
        enforce: "post",
        resolve() {
            for (const pkg of this.graph.getPackages())
                target.set(pkg.id, pkg);
        },
    };
}
