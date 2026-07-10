import type { RegistryObservation, RegistryObserverOptions } from "./npm.js";
import { isCanonicalNpmIntegrity, isRfc3339 } from "./validation.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export type GithubObserverOptions = RegistryObserverOptions & { token?: string };

export async function observeGithubTag(repository: string, tag: string, packageId: string, version: string, options: GithubObserverOptions = {}): Promise<RegistryObservation> {
  const canonicalUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const request = async (url: string): Promise<Response | RegistryObservation> => {
    try { return await (options.fetch ?? globalThis.fetch)(url, { signal: controller.signal, headers }); }
    catch { return controller.signal.aborted ? { failure: "timeout", detail: "GitHub request timed out" } : { failure: "transport", detail: "GitHub request failed" }; }
  };
  try {
    const refResult = await request(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (!(refResult instanceof Response)) return refResult;
    if (refResult.status === 404) return { missing: true, canonicalUrl };
    if (!refResult.ok) return { failure: "http", detail: `GitHub returned HTTP ${refResult.status}` };
    let ref: Record<string, unknown> | undefined;
    try { ref = object(await refResult.json()); } catch { return { failure: "schema", detail: "GitHub returned invalid JSON" }; }
    const target = object(ref?.object);
    if ((target?.type !== "tag" && target?.type !== "commit") || typeof target.sha !== "string" || !/^[a-f0-9]{40}$/u.test(target.sha)) {
      return { failure: "schema", detail: "GitHub tag reference response was malformed" };
    }
    if (target.type === "commit") return { failure: "schema", detail: "package tag is lightweight; an annotated receipt tag is required" };
    const tagResult = await request(`https://api.github.com/repos/${repository}/git/tags/${target.sha}`);
    if (!(tagResult instanceof Response)) return tagResult;
    if (!tagResult.ok) return { failure: tagResult.status === 404 ? "schema" : "http", detail: tagResult.status === 404 ? "annotated GitHub tag target was missing" : `GitHub returned HTTP ${tagResult.status}` };
    let annotated: Record<string, unknown> | undefined;
    try { annotated = object(await tagResult.json()); } catch { return { failure: "schema", detail: "GitHub returned invalid JSON" }; }
    if (annotated?.tag !== tag || typeof annotated.message !== "string") return { failure: "schema", detail: "annotated GitHub tag response was malformed" };
    let receipt: Record<string, unknown> | undefined;
    try { receipt = object(JSON.parse(annotated.message)); } catch { return { failure: "schema", detail: "annotated GitHub tag did not contain a JSON receipt" }; }
    const integrityValid = packageId.startsWith("npm:")
      ? typeof receipt?.registryIntegrity === "string" && isCanonicalNpmIntegrity(receipt.registryIntegrity)
      : packageId.startsWith("cargo:")
        ? typeof receipt?.registryIntegrity === "string" && /^[a-f0-9]{64}$/u.test(receipt.registryIntegrity)
        : false;
    if (receipt?.schema !== "lenso.component-receipt.v1" || receipt.packageId !== packageId || receipt.version !== version ||
        typeof receipt.registryIntegrity !== "string" || typeof receipt.publishedAt !== "string" || !isRfc3339(receipt.publishedAt) ||
        !integrityValid) {
      return { failure: "schema", detail: "annotated GitHub tag receipt did not match the requested package" };
    }
    const digest = packageId.startsWith("cargo:") ? `sha256:${receipt.registryIntegrity}` : receipt.registryIntegrity;
    return { version, digest, publishedAt: receipt.publishedAt, canonicalUrl };
  } finally { clearTimeout(timeout); }
}
