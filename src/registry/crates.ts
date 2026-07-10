import type { RegistryObservation, RegistryObserverOptions } from "./npm.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function observeCrateVersion(
  name: string,
  version: string,
  options: RegistryObserverOptions = {},
): Promise<RegistryObservation> {
  const canonicalUrl = `https://crates.io/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const endpoint = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "lenso-release-reconciler/1" },
      });
    } catch {
      return controller.signal.aborted
        ? { failure: "timeout", detail: "registry request timed out" }
        : { failure: "transport", detail: "registry request failed" };
    }
    if (response.status === 404) return { missing: true, canonicalUrl };
    if (!response.ok) return { failure: "http", detail: `registry returned HTTP ${response.status}` };
    let root: Record<string, unknown> | undefined;
    try { root = object(await response.json()); } catch { return { failure: "schema", detail: "registry returned invalid JSON" }; }
    const entry = object(root?.version);
    if (entry?.crate !== name || entry?.num !== version || typeof entry.checksum !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.checksum) || typeof entry.created_at !== "string") {
      return { failure: "schema", detail: "registry response did not match the requested crate version" };
    }
    return {
      version,
      digest: `sha256:${entry.checksum}`,
      publishedAt: entry.created_at,
      canonicalUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}
