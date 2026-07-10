import { isCanonicalNpmIntegrity, isRfc3339 } from "./validation.js";

export type RegistryFailureKind = "transport" | "http" | "schema" | "timeout";
export type RegistryObservation =
  | { version: string; digest: string; publishedAt: string; canonicalUrl: string }
  | { missing: true; canonicalUrl: string }
  | { failure: RegistryFailureKind; detail: string };

export type RegistryObserverOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function observeNpmVersion(
  name: string,
  version: string,
  options: RegistryObserverOptions = {},
): Promise<RegistryObservation> {
  const canonicalUrl = `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(version)}`;
  const endpoint = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch (error) {
      return controller.signal.aborted
        ? { failure: "timeout", detail: "registry request timed out" }
        : { failure: "transport", detail: "registry request failed" };
    }
    if (response.status === 404) return { missing: true, canonicalUrl };
    if (!response.ok) return { failure: "http", detail: `registry returned HTTP ${response.status}` };
    let root: Record<string, unknown> | undefined;
    try { root = object(await response.json()); } catch { return { failure: "schema", detail: "registry returned invalid JSON" }; }
    const dist = object(root?.dist);
    if (root?.name !== name || root?.version !== version || typeof dist?.integrity !== "string" || !isCanonicalNpmIntegrity(dist.integrity) ||
        typeof dist.tarball !== "string") {
      return { failure: "schema", detail: "registry response did not match the requested npm version" };
    }
    let publishedAt = typeof root.time === "string" ? root.time : undefined;
    if (!publishedAt) {
      let packageResponse: Response;
      try {
        packageResponse = await (options.fetch ?? globalThis.fetch)(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
      } catch {
        return controller.signal.aborted
          ? { failure: "timeout", detail: "registry request timed out" }
          : { failure: "transport", detail: "registry request failed" };
      }
      if (!packageResponse.ok) return { failure: "http", detail: `registry returned HTTP ${packageResponse.status}` };
      let packageRoot: Record<string, unknown> | undefined;
      try { packageRoot = object(await packageResponse.json()); } catch { return { failure: "schema", detail: "registry returned invalid JSON" }; }
      const times = object(packageRoot?.time);
      if (typeof times?.[version] !== "string") return { failure: "schema", detail: "registry response omitted publication time" };
      publishedAt = times[version];
    }
    if (!isRfc3339(publishedAt)) return { failure: "schema", detail: "registry response contained an invalid publication time" };
    return { version, digest: dist.integrity, publishedAt, canonicalUrl };
  } finally {
    clearTimeout(timeout);
  }
}
