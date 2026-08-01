const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const GHCR_BLOB_UPLOAD_HOST = "pkg-containers.githubusercontent.com";
function fail(message) { throw new Error(`OCI registry publisher: ${message}`); }
function registryBase(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        fail("registry endpoint is invalid");
    return url;
}
function challenge(value) {
    if (!value.startsWith("Bearer "))
        fail("registry authentication challenge is invalid");
    const fields = Object.fromEntries([...value.slice(7).matchAll(/([a-z]+)="([^"]+)"/gu)].map((match) => [match[1], match[2]]));
    if (!fields.realm || !fields.service || !fields.scope)
        fail("registry authentication challenge is incomplete");
    return fields;
}
export async function publishOciImage(input) {
    const base = registryBase(input.registry);
    const prefix = base.pathname.replace(/\/+$/u, "");
    const request = input.fetch ?? globalThis.fetch;
    let authorization = "bearer" in input.credential ? `Bearer ${input.credential.bearer}` : `Basic ${Buffer.from(`${input.credential.username}:${input.credential.password}`).toString("base64")}`;
    const endpoint = (path) => new URL(`${prefix}/v2/${input.artifact.registryRepository}/${path}`, base.origin);
    const perform = async (url, init = {}) => {
        let response = await request(url, { ...init, redirect: "error", headers: { ...Object.fromEntries(new Headers(init.headers)), authorization } });
        if (response.status !== 401)
            return response;
        const parsed = challenge(response.headers.get("www-authenticate") ?? "");
        const realm = new URL(parsed.realm);
        if (realm.protocol !== "https:" || realm.origin !== base.origin)
            fail("registry token realm is not trusted");
        realm.searchParams.set("service", parsed.service);
        realm.searchParams.set("scope", parsed.scope);
        const tokenResponse = await request(realm, { redirect: "error", headers: { accept: "application/json", ...(authorization.startsWith("Basic ") ? { authorization } : {}) } });
        let body = {};
        try {
            body = await tokenResponse.json();
        }
        catch { /* handled below */ }
        const token = body.token ?? body.access_token;
        if (!tokenResponse.ok || typeof token !== "string")
            fail(`registry token exchange failed with ${tokenResponse.status}`);
        authorization = `Bearer ${token}`;
        response = await request(url, { ...init, redirect: "error", headers: { ...Object.fromEntries(new Headers(init.headers)), authorization } });
        return response;
    };
    for (const [digest, bytes] of input.artifact.blobs) {
        if (digest === input.artifact.manifestDigest)
            continue;
        const existing = await perform(endpoint(`blobs/${digest}`), { method: "HEAD" });
        if (existing.ok)
            continue;
        if (existing.status !== 404)
            fail(`blob observation failed with ${existing.status}`);
        const started = await perform(endpoint("blobs/uploads/"), { method: "POST" });
        if (started.status !== 202)
            fail(`blob upload start failed with ${started.status}`);
        const location = started.headers.get("location");
        if (!location)
            fail("blob upload location is missing");
        const upload = new URL(location, base);
        const standardUploadPath = `${prefix}/v2/${input.artifact.registryRepository}/blobs/uploads/`;
        const ghcrUploadPath = `${prefix}/v2/${input.artifact.registryRepository}/blobs/upload/`;
        const sameRepository = upload.origin === base.origin && (upload.pathname.startsWith(standardUploadPath) || (base.hostname === "ghcr.io" && upload.pathname.startsWith(ghcrUploadPath)));
        const trustedGhcrStorage = base.hostname === "ghcr.io" && upload.protocol === "https:" && upload.hostname === GHCR_BLOB_UPLOAD_HOST && !upload.username && !upload.password && !upload.hash;
        if (!sameRepository && !trustedGhcrStorage)
            fail("blob upload location escaped the registry repository");
        upload.searchParams.set("digest", digest);
        const uploadRequest = { method: "PUT", redirect: "error", headers: { "content-type": "application/octet-stream" }, body: bytes };
        const stored = sameRepository ? await perform(upload, uploadRequest) : await request(upload, uploadRequest);
        if (stored.status !== 201 || stored.headers.get("docker-content-digest") !== digest)
            fail(`blob upload failed with ${stored.status}`);
    }
    const manifestUrl = endpoint(`manifests/${encodeURIComponent(input.version)}`);
    const stored = await perform(manifestUrl, { method: "PUT", headers: { "content-type": MANIFEST_TYPE }, body: input.artifact.manifestBytes });
    if (stored.status !== 201 || stored.headers.get("docker-content-digest") !== input.artifact.manifestDigest)
        fail(`manifest upload failed with ${stored.status}`);
    const observed = await perform(manifestUrl, { headers: { accept: MANIFEST_TYPE } });
    if (!observed.ok || observed.headers.get("docker-content-digest") !== input.artifact.manifestDigest)
        fail(`manifest observation failed with ${observed.status}`);
    const manifestBytes = Buffer.from(await observed.arrayBuffer());
    if (!manifestBytes.equals(input.artifact.manifestBytes))
        fail("remote manifest bytes contradict the sealed image");
    return { digest: input.artifact.manifestDigest, manifestBytes, registryUrl: manifestUrl.toString(), publishedAt: input.artifact.publishedAt };
}
