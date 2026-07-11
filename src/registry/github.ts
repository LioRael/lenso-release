import { createHash } from "node:crypto";

import type { RegistryObservation, RegistryObserverOptions } from "./npm.js";
import { isCanonicalNpmIntegrity, isRfc3339 } from "./validation.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export type GithubObserverOptions = RegistryObserverOptions & { token?: string };

export async function observeGithubArtifact(repository: string, name: string, version: string, options: GithubObserverOptions = {}): Promise<RegistryObservation> {
  const canonicalUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(`v${version}`)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const request = async (url: string, accept = "application/vnd.github+json"): Promise<Response | RegistryObservation> => {
    try { return await (options.fetch ?? globalThis.fetch)(url, { signal: controller.signal, headers: { ...headers, accept }, redirect: "manual" }); }
    catch { return controller.signal.aborted ? { failure: "timeout", detail: "GitHub request timed out" } : { failure: "transport", detail: "GitHub request failed" }; }
  };
  try {
    const releaseResult = await request(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(`v${version}`)}`);
    if (!(releaseResult instanceof Response)) return releaseResult;
    if (releaseResult.status === 404) return { missing: true, canonicalUrl };
    if (!releaseResult.ok) return { failure: "http", detail: `GitHub returned HTTP ${releaseResult.status}` };
    let release: Record<string, unknown> | undefined;
    try { release = object(await releaseResult.json()); } catch { return { failure: "schema", detail: "GitHub returned invalid JSON" }; }
    if (release?.draft !== true || typeof release.created_at !== "string" || !isRfc3339(release.created_at) || !Array.isArray(release.assets)) {
      return { failure: "schema", detail: "GitHub hosted artifact release was malformed" };
    }
    const assetName = `${name}.tar.gz`;
    const assets = release.assets.map(object);
    const asset = assets.find((candidate) => candidate?.name === assetName);
    const checksumAsset = assets.find((candidate) => candidate?.name === `${assetName}.sha256`);
    if (!asset || !checksumAsset) return { missing: true, canonicalUrl };
    if (!Number.isSafeInteger(asset.id) || Number(asset.id) <= 0 || !Number.isSafeInteger(checksumAsset.id) || Number(checksumAsset.id) <= 0) {
      return { failure: "schema", detail: "GitHub hosted artifact assets were malformed" };
    }
    const downloadAsset = async (id: number): Promise<Response | RegistryObservation> => {
      const initial = await request(`https://api.github.com/repos/${repository}/releases/assets/${id}`, "application/octet-stream");
      if (!(initial instanceof Response) || ![301, 302, 303, 307, 308].includes(initial.status)) return initial;
      const location = initial.headers.get("location");
      if (!location) return { failure: "schema", detail: "GitHub hosted artifact redirect was malformed" };
      const target = new URL(location);
      if (target.protocol !== "https:" || !["objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(target.hostname)) {
        return { failure: "schema", detail: "GitHub hosted artifact redirect target was not trusted" };
      }
      try {
        return await (options.fetch ?? globalThis.fetch)(target, { signal: controller.signal, headers: { accept: "application/octet-stream" }, redirect: "error" });
      } catch {
        return controller.signal.aborted ? { failure: "timeout", detail: "GitHub request timed out" } : { failure: "transport", detail: "GitHub request failed" };
      }
    };
    const archiveResult = await downloadAsset(Number(asset.id));
    if (!(archiveResult instanceof Response)) return archiveResult;
    if (!archiveResult.ok) return { failure: "http", detail: `GitHub returned HTTP ${archiveResult.status}` };
    const bytes = new Uint8Array(await archiveResult.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksumResult = await downloadAsset(Number(checksumAsset.id));
    if (!(checksumResult instanceof Response)) return checksumResult;
    if (!checksumResult.ok) return { failure: "http", detail: `GitHub returned HTTP ${checksumResult.status}` };
    const checksum = Buffer.from(await checksumResult.arrayBuffer()).toString("utf8");
    if (checksum !== `${digest}  ${assetName}\n`) return { failure: "schema", detail: "GitHub hosted artifact checksum contradicted the archive" };
    return { version, digest: `sha256:${digest}`, publishedAt: release.created_at, canonicalUrl };
  } finally { clearTimeout(timeout); }
}

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
        : packageId.startsWith("artifact:")
          ? typeof receipt?.registryIntegrity === "string" && /^sha256:[a-f0-9]{64}$/u.test(receipt.registryIntegrity)
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
