import type { ComponentRegistry } from "../config/components.js";

export function topologicalPhases(registry: ComponentRegistry, selectedIds: string[]): string[][] {
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) {
    throw new TypeError("selected component IDs contain duplicates");
  }
  for (const id of selectedIds) {
    if (!Object.hasOwn(registry.packages, id)) throw new TypeError(`unknown selected component ID ${id}`);
  }

  const incoming = new Map(
    selectedIds.map((id) => [
      id,
      new Set<string>(registry.packages[id]!.dependencies.filter((dependency) => selected.has(dependency)))
    ])
  );
  const phases: string[][] = [];

  while (incoming.size > 0) {
    const ready = [...incoming]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) throw new Error("component dependency cycle");
    phases.push(ready);
    for (const id of ready) incoming.delete(id);
    for (const dependencies of incoming.values()) {
      for (const id of ready) dependencies.delete(id);
    }
  }

  return phases;
}
