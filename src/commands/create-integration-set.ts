import { writeFile } from "node:fs/promises";

import { canonicalBytes, sha256, type JsonValue } from "../core/canonical.js";

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OID = /^[0-9a-f]{40}$/u;

export type IntegrationSetV1 = {
  schema: "lenso.integration-set.v1";
  integrationSetId: `sha256:${string}`;
  baseSystemVersion: string;
  repositories: Record<string, string>;
};

export async function createIntegrationSet(
  baseSystemVersion: string,
  repositories: Record<string, string>,
  options: { fetch?: typeof fetch; token?: string } = {},
): Promise<IntegrationSetV1> {
  if (!VERSION.test(baseSystemVersion)) throw new TypeError("base system version must be exact SemVer");
  const entries = Object.entries(repositories).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new TypeError("integration set must contain repositories");
  const request = options.fetch ?? fetch;
  for (const [repository, commit] of entries) {
    if (!REPOSITORY.test(repository) || !OID.test(commit)) throw new TypeError("integration set repository or commit is invalid");
    const response = await request(`https://api.github.com/repos/${repository}/commits/${commit}`, {
      headers: { accept: "application/vnd.github+json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`integration commit is not visible in ${repository}: ${response.status}`);
    const observed = await response.json() as { sha?: string };
    if (observed.sha !== commit) throw new Error(`integration commit identity mismatch in ${repository}`);
  }
  const identity = { schema: "lenso.integration-set.v1" as const, baseSystemVersion, repositories: Object.fromEntries(entries) };
  return { ...identity, integrationSetId: sha256(identity as unknown as JsonValue) as `sha256:${string}` };
}

async function main(args: string[]): Promise<void> {
  const value = (name: string): string | undefined => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  const base = value("--base-system-version");
  const output = value("--output");
  const repositories: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--repository") continue;
    const entry = args[index + 1] ?? ""; const separator = entry.indexOf("=");
    if (separator === -1) throw new TypeError("--repository must be owner/name=commit");
    repositories[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  if (!base || !output) throw new TypeError("usage: create-integration-set --base-system-version <version> --repository <owner/name=commit> --output <path>");
  const integrationSet = await createIntegrationSet(base, repositories, { token: process.env.GITHUB_TOKEN });
  await writeFile(output, Buffer.concat([canonicalBytes(integrationSet as unknown as JsonValue), Buffer.from("\n")]), { flag: "wx", mode: 0o600 });
}

if (process.argv[1]?.endsWith("create-integration-set.js")) await main(process.argv.slice(2));
