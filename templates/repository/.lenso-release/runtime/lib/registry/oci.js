import { createHash } from "node:crypto";
import { isRfc3339, SHA256 } from "./validation.js";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
function trustedBase(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new TypeError("OCI registry endpoint must be an HTTPS URL without credentials");
    return url;
}
function digest(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export async function observeOciImage(name, version, options = {}) {
    if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(name) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version))
        throw new TypeError("invalid OCI image identity");
    const registry = trustedBase(options.registry ?? "https://ghcr.io");
    const registryPrefix = registry.pathname.replace(/\/+$/u, "");
    const repository = options.repository ?? `liorael/${name}`;
    if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(repository))
        throw new TypeError("invalid OCI repository");
    const registryName = repository.split("/").at(-1);
    const canonicalUrl = options.canonicalUrl ?? `https://github.com/LioRael/lenso-runtime-console/pkgs/container/${encodeURIComponent(registryName)}/${encodeURIComponent(version)}`;
    const endpoint = new URL(`${registryPrefix}/v2/${repository}/manifests/${encodeURIComponent(version)}`, registry.origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    const headers = {
        accept: "application/vnd.oci.image.manifest.v1+json",
    };
    if (options.token)
        headers.authorization = `Bearer ${options.token}`;
    const request = options.fetch ?? globalThis.fetch;
    try {
        let manifestResponse;
        try {
            manifestResponse = await request(endpoint, { signal: controller.signal, headers, redirect: "error" });
            if (manifestResponse.status === 401 && !options.token) {
                const challenge = manifestResponse.headers.get("www-authenticate") ?? "";
                const match = /^Bearer\s+realm="([^"]+)",service="([^"]+)",scope="([^"]+)"$/u.exec(challenge);
                if (!match)
                    return { failure: "http", detail: "OCI registry authentication challenge was invalid" };
                const realm = new URL(match[1]);
                if (realm.protocol !== "https:" || realm.origin !== registry.origin)
                    return { failure: "schema", detail: "OCI registry authentication realm was not trusted" };
                realm.searchParams.set("service", match[2]);
                realm.searchParams.set("scope", match[3]);
                const tokenResponse = await request(realm, { signal: controller.signal, redirect: "error", headers: { accept: "application/json" } });
                const tokenBody = tokenResponse.ok ? object(await tokenResponse.json()) : undefined;
                if (typeof tokenBody?.token !== "string")
                    return { failure: "http", detail: `OCI registry token service returned HTTP ${tokenResponse.status}` };
                headers.authorization = `Bearer ${tokenBody.token}`;
                manifestResponse = await request(endpoint, { signal: controller.signal, headers, redirect: "error" });
            }
        }
        catch {
            return controller.signal.aborted ? { failure: "timeout", detail: "OCI registry request timed out" } : { failure: "transport", detail: "OCI registry request failed" };
        }
        if (manifestResponse.status === 404)
            return { missing: true, canonicalUrl };
        if (!manifestResponse.ok)
            return { failure: "http", detail: `OCI registry returned HTTP ${manifestResponse.status}` };
        const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
        const manifestDigest = digest(manifestBytes);
        const advertisedDigest = manifestResponse.headers.get("docker-content-digest");
        if (advertisedDigest !== null && (advertisedDigest !== manifestDigest || !SHA256.test(advertisedDigest)))
            return { failure: "schema", detail: "OCI registry manifest digest contradicted its bytes" };
        let manifest;
        try {
            manifest = object(JSON.parse(Buffer.from(manifestBytes).toString("utf8")));
        }
        catch {
            return { failure: "schema", detail: "OCI registry returned an invalid manifest" };
        }
        const config = object(manifest?.config);
        if (manifest?.schemaVersion !== 2 || typeof config?.digest !== "string" || !SHA256.test(config.digest))
            return { failure: "schema", detail: "OCI registry manifest omitted a canonical config descriptor" };
        const configUrl = new URL(`${registryPrefix}/v2/${repository}/blobs/${config.digest}`, registry.origin);
        let configResponse;
        try {
            configResponse = await request(configUrl, { signal: controller.signal, headers: headers.authorization ? { authorization: headers.authorization } : {}, redirect: "error" });
        }
        catch {
            return controller.signal.aborted ? { failure: "timeout", detail: "OCI registry request timed out" } : { failure: "transport", detail: "OCI registry request failed" };
        }
        if (!configResponse.ok)
            return { failure: "http", detail: `OCI registry config returned HTTP ${configResponse.status}` };
        const configBytes = new Uint8Array(await configResponse.arrayBuffer());
        if (digest(configBytes) !== config.digest)
            return { failure: "schema", detail: "OCI registry config digest contradicted its bytes" };
        let imageConfig;
        try {
            imageConfig = object(JSON.parse(Buffer.from(configBytes).toString("utf8")));
        }
        catch {
            return { failure: "schema", detail: "OCI registry returned an invalid image config" };
        }
        const labels = object(object(imageConfig?.config)?.Labels);
        const created = imageConfig?.created;
        if (labels?.["org.opencontainers.image.version"] !== version || typeof created !== "string" || !isRfc3339(created))
            return { failure: "schema", detail: "OCI image config did not bind the requested version and creation time" };
        return { version, digest: manifestDigest, publishedAt: created, canonicalUrl };
    }
    finally {
        clearTimeout(timeout);
    }
}
