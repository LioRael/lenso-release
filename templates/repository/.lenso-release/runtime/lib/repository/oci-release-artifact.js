import { createHash } from "node:crypto";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
function fail(message) { throw new Error(`OCI release artifact: ${message}`); }
function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(`${label} must be an object`);
    return value;
}
function json(bytes, label) {
    try {
        return object(JSON.parse(Buffer.from(bytes).toString("utf8")), label);
    }
    catch (error) {
        throw new Error(`OCI release artifact: invalid ${label} JSON`, { cause: error });
    }
}
function canonicalPath(name) {
    const value = name.replace(/^\.\//u, "").replace(/\/$/u, "");
    if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === ".."))
        fail("archive contains an unsafe path");
    return value;
}
function octal(bytes) {
    const value = bytes.toString("ascii").replaceAll("\0", "").trim();
    if (!/^[0-7]+$/u.test(value))
        fail("archive contains an invalid size");
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        fail("archive entry size is invalid");
    return parsed;
}
function tarFiles(archive) {
    const files = new Map();
    let offset = 0;
    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0))
            break;
        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
        const path = canonicalPath(prefix ? `${prefix}/${name}` : name);
        const size = octal(header.subarray(124, 136));
        const type = header[156] ?? 0;
        const start = offset + 512;
        const end = start + size;
        if (end > archive.length)
            fail("archive entry is truncated");
        if (type === 0 || type === 48) {
            if (files.has(path))
                fail(`archive contains duplicate path ${path}`);
            files.set(path, Buffer.from(archive.subarray(start, end)));
        }
        else if (type !== 53)
            fail(`archive entry type is forbidden: ${path}`);
        offset = start + Math.ceil(size / 512) * 512;
    }
    if (files.size === 0)
        fail("archive contains no files");
    return files;
}
function descriptor(value, label) {
    const raw = object(value, label);
    if (typeof raw.mediaType !== "string" || typeof raw.digest !== "string" || !DIGEST.test(raw.digest) || !Number.isSafeInteger(raw.size) || Number(raw.size) <= 0)
        fail(`${label} is invalid`);
    return { mediaType: raw.mediaType, digest: raw.digest, size: Number(raw.size) };
}
export function inspectOciInstallManifest(input) {
    if (!REPOSITORY.test(input.registryRepository) || input.registryRepository.includes(".."))
        fail("registry repository is invalid");
    if (!/^[0-9a-f]{40}$/u.test(input.sourceCommit) || !/^\d+\.\d+\.\d+$/u.test(input.version))
        fail("release identity is invalid");
    const install = json(input.installManifestBytes, "Console install manifest");
    const image = object(install.image, "Console install manifest image");
    const manifestDigest = image.digest;
    if (install.schema !== "lenso.console-service-release.v1" ||
        install.releaseId !== `lenso-console@${input.version}` ||
        install.version !== input.version ||
        install.sourceCommit !== input.sourceCommit ||
        typeof manifestDigest !== "string" ||
        !DIGEST.test(manifestDigest) ||
        image.reference !== `ghcr.io/${input.registryRepository}@${manifestDigest}`)
        fail("Console install manifest does not bind the OCI image");
    return { manifestDigest: manifestDigest, registryRepository: input.registryRepository };
}
export function inspectOciReleaseArtifact(input) {
    if (!REPOSITORY.test(input.registryRepository) || input.registryRepository.includes(".."))
        fail("registry repository is invalid");
    if (!/^[0-9a-f]{40}$/u.test(input.sourceCommit) || !/^\d+\.\d+\.\d+$/u.test(input.version))
        fail("release identity is invalid");
    const files = tarFiles(input.archiveBytes);
    const layout = json(files.get("oci-layout") ?? fail("oci-layout is missing"), "oci-layout");
    if (layout.imageLayoutVersion !== "1.0.0")
        fail("unsupported OCI layout version");
    const index = json(files.get("index.json") ?? fail("index.json is missing"), "index");
    if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1)
        fail("OCI index must select exactly one image manifest");
    const root = descriptor(index.manifests[0], "OCI index manifest descriptor");
    if (root.mediaType !== "application/vnd.oci.image.manifest.v1+json")
        fail("OCI index must directly select an image manifest");
    const blobs = new Map();
    for (const [path, bytes] of files) {
        const match = /^blobs\/sha256\/([0-9a-f]{64})$/u.exec(path);
        if (!match)
            continue;
        const expected = `sha256:${match[1]}`;
        if (digest(bytes) !== expected)
            fail(`blob digest mismatch: ${expected}`);
        blobs.set(expected, bytes);
    }
    const manifestBytes = blobs.get(root.digest) ?? fail("selected image manifest blob is missing");
    if (manifestBytes.length !== root.size)
        fail("selected image manifest size mismatch");
    const manifest = json(manifestBytes, "image manifest");
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers))
        fail("image manifest shape is invalid");
    const dependencies = [descriptor(manifest.config, "image config descriptor"), ...manifest.layers.map((value, index) => descriptor(value, `image layer descriptor ${index}`))];
    for (const dependency of dependencies) {
        const bytes = blobs.get(dependency.digest) ?? fail(`referenced image blob is missing: ${dependency.digest}`);
        if (bytes.length !== dependency.size)
            fail(`referenced image blob size mismatch: ${dependency.digest}`);
    }
    const config = json(blobs.get(dependencies[0].digest), "image config");
    const labels = object(object(config.config, "image config.config").Labels, "image config labels");
    if (labels["org.opencontainers.image.version"] !== input.version || labels["org.opencontainers.image.revision"] !== input.sourceCommit)
        fail("image config does not bind the release identity");
    if (typeof config.created !== "string" || !Number.isFinite(Date.parse(config.created)))
        fail("image config creation time is invalid");
    const install = inspectOciInstallManifest(input);
    if (install.manifestDigest !== root.digest)
        fail("Console install manifest does not bind the OCI image");
    return { archiveBytes: input.archiveBytes, installManifestBytes: input.installManifestBytes, manifestBytes, manifestDigest: root.digest, publishedAt: config.created, registryRepository: input.registryRepository, blobs };
}
