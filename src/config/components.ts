import { readFile } from "node:fs/promises";

import { parse } from "yaml";

export const COMPONENT_REPOSITORIES = [
  "LioRael/lenso",
  "LioRael/lenso-audit-log-module",
  "LioRael/lenso-auth-module",
  "LioRael/lenso-cli",
  "LioRael/lenso-organization-module",
  "LioRael/lenso-release",
  "LioRael/lenso-runtime-console"
] as const;

export const COMPONENT_REGISTRIES = ["crates-io", "github-release", "npm"] as const;
export const RELEASE_GROUPS = [
  "foundation",
  "modules",
  "host",
  "console",
  "distribution",
  "catalog"
] as const;

export type ComponentRepository = (typeof COMPONENT_REPOSITORIES)[number];
export type ComponentRegistryKind = (typeof COMPONENT_REGISTRIES)[number];
export type ReleaseGroup = (typeof RELEASE_GROUPS)[number];
export type ComponentId =
  | `cargo:${string}`
  | `npm:@lenso/${string}`
  | `artifact:${string}`
  | `catalog:${string}`;

export type Component = {
  id: ComponentId;
  repository: ComponentRepository;
  registry: ComponentRegistryKind;
  releaseGroup: ReleaseGroup;
  userFacing: boolean;
  publishable: boolean;
  dependencies: ComponentId[];
};

export type ComponentRegistry = {
  schema: "lenso.component-registry.v1";
  internalPackages: ComponentId[];
  packages: Record<string, Component>;
};

const ROOT_KEYS = new Set(["schema", "internalPackages", "packages"]);
const PACKAGE_KEYS = new Set([
  "id",
  "repository",
  "registry",
  "releaseGroup",
  "userFacing",
  "publishable",
  "dependencies"
]);
const REPOSITORY_SET = new Set<string>(COMPONENT_REPOSITORIES);
const REGISTRY_SET = new Set<string>(COMPONENT_REGISTRIES);
const RELEASE_GROUP_SET = new Set<string>(RELEASE_GROUPS);
const COMPONENT_ID = /^(?:cargo:[a-z0-9]+(?:-[a-z0-9]+)*|npm:@lenso\/[a-z0-9]+(?:-[a-z0-9]+)*|artifact:[a-z0-9]+(?:-[a-z0-9]+)*|catalog:[a-z0-9]+(?:-[a-z0-9]+)*)$/u;

function fail(message: string): never {
  throw new TypeError(`invalid component registry: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${context} has unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) fail(`${context} is missing ${key}`);
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) return fail(`${context} must be a string`);
  return value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") return fail(`${context} must be a boolean`);
  return value;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) return fail(`${context} must be an array`);
  return value;
}

function componentId(value: unknown, context: string): ComponentId {
  const id = string(value, context);
  if (!COMPONENT_ID.test(id)) return fail(`${context} has unknown component ID ${id}`);
  return id as ComponentId;
}

function uniqueIds(values: unknown[], context: string): ComponentId[] {
  const ids = values.map((value, index) => componentId(value, `${context}[${index}]`));
  if (new Set(ids).size !== ids.length) fail(`${context} contains duplicate IDs`);
  return ids;
}

function parseComponent(value: unknown, index: number): Component {
  const raw = record(value, `packages[${index}]`);
  exactKeys(raw, PACKAGE_KEYS, `packages[${index}]`);
  const id = componentId(raw.id, `packages[${index}].id`);
  const repository = string(raw.repository, `${id}.repository`);
  const registry = string(raw.registry, `${id}.registry`);
  const releaseGroup = string(raw.releaseGroup, `${id}.releaseGroup`);
  if (!REPOSITORY_SET.has(repository)) fail(`${id} has unknown repository ${repository}`);
  if (!REGISTRY_SET.has(registry)) fail(`${id} has unknown registry ${registry}`);
  if (!RELEASE_GROUP_SET.has(releaseGroup)) fail(`${id} has unknown release group ${releaseGroup}`);

  const expectedRegistry = id.startsWith("cargo:")
    ? "crates-io"
    : id.startsWith("npm:")
      ? "npm"
      : "github-release";
  if (registry !== expectedRegistry) {
    fail(`${id} registry ${registry} is inconsistent with its ID`);
  }

  const publishable = boolean(raw.publishable, `${id}.publishable`);
  if ((id === "cargo:lenso-operator") === publishable) {
    fail(`${id} has an inconsistent publishable value`);
  }

  return {
    id,
    repository: repository as ComponentRepository,
    registry: registry as ComponentRegistryKind,
    releaseGroup: releaseGroup as ReleaseGroup,
    userFacing: boolean(raw.userFacing, `${id}.userFacing`),
    publishable,
    dependencies: uniqueIds(array(raw.dependencies, `${id}.dependencies`), `${id}.dependencies`)
  };
}

export async function loadComponents(path: string): Promise<ComponentRegistry> {
  let raw: unknown;
  try {
    raw = parse(await readFile(path, "utf8"), { uniqueKeys: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`invalid component registry YAML: ${detail}`, { cause: error });
  }

  const root = record(raw, "root");
  exactKeys(root, ROOT_KEYS, "root");
  if (root.schema !== "lenso.component-registry.v1") fail("unknown schema");

  const components = array(root.packages, "packages").map(parseComponent);
  const ids = components.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) fail("packages contains duplicate IDs");
  const packages = Object.fromEntries(components.map((component) => [component.id, component]));

  for (const component of components) {
    for (const dependency of component.dependencies) {
      if (!Object.hasOwn(packages, dependency)) fail(`${component.id} has unknown dependency ${dependency}`);
    }
  }

  const internalPackages = uniqueIds(array(root.internalPackages, "internalPackages"), "internalPackages");
  for (const id of internalPackages) {
    if (!Object.hasOwn(packages, id)) fail(`internalPackages contains unknown ID ${id}`);
  }
  const internalSet = new Set(internalPackages);
  for (const component of components) {
    if (!component.userFacing && !internalSet.has(component.id)) {
      fail(`${component.id} may be userFacing false only when reviewed in internalPackages`);
    }
  }

  return { schema: "lenso.component-registry.v1", internalPackages, packages };
}
