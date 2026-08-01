import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { inspectOciReleaseArtifact } from "../../src/repository/oci-release-artifact.js";
import { publishOciImage } from "../../src/repository/oci-registry-publisher.js";

const GHCR_STORAGE_HOST = "pkg-containers.githubusercontent.com";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function tar(files: Record<string, Buffer>): Buffer {
  const entries: Buffer[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    const header = Buffer.alloc(512); header.write(name, 0, 100, "utf8"); header.write("0000644\0", 100, "ascii"); header.write("0000000\0", 108, "ascii"); header.write("0000000\0", 116, "ascii"); header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); header[156] = 48; header.write("ustar\0", 257, "ascii");
    entries.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}
function fixture() {
  const version = "0.2.0"; const sourceCommit = "b".repeat(40); const repository = "liorael/lenso-console";
  const config = Buffer.from(JSON.stringify({ created: "2026-07-30T08:00:00Z", config: { Labels: { "org.opencontainers.image.version": version, "org.opencontainers.image.revision": sourceCommit } } }));
  const layer = Buffer.from("layer");
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digest(config), size: config.length }, layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: digest(layer), size: layer.length }] }));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest(manifest), size: manifest.length }] }));
  const archiveBytes = tar({ "oci-layout": Buffer.from('{"imageLayoutVersion":"1.0.0"}'), "index.json": index, [`blobs/sha256/${digest(config).slice(7)}`]: config, [`blobs/sha256/${digest(layer).slice(7)}`]: layer, [`blobs/sha256/${digest(manifest).slice(7)}`]: manifest });
  const installManifestBytes = Buffer.from(JSON.stringify({ schema: "lenso.console-service-release.v1", releaseId: `lenso-console@${version}`, version, sourceCommit, image: { reference: `ghcr.io/${repository}@${digest(manifest)}`, digest: digest(manifest) } }));
  const input = { archiveBytes, installManifestBytes, registryRepository: repository, sourceCommit, version };
  return { ...input, manifestDigest: digest(manifest), artifact: inspectOciReleaseArtifact(input) };
}

describe("OCI release artifact", () => {
  it("binds one image graph and Console install manifest", () => {
    const value = fixture(); const inspected = inspectOciReleaseArtifact(value);
    expect(inspected.manifestDigest).toBe(value.manifestDigest);
    expect(inspected.blobs.size).toBe(3);
    expect(inspected.manifestBytes).toEqual(inspected.blobs.get(value.manifestDigest as `sha256:${string}`));
  });
  it("publishes every sealed blob and the exact manifest through Distribution V2", async () => {
    const value = fixture(); const blobs = new Map<string, Buffer>(); let manifest: Buffer | undefined;
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input)); const method = init?.method ?? "GET";
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer shadow-token");
      const blob = /\/blobs\/(sha256:[0-9a-f]{64})$/u.exec(url.pathname);
      if (method === "HEAD" && blob) return new Response(null, { status: blobs.has(blob[1]!) ? 200 : 404 });
      if (method === "POST" && url.pathname.endsWith("/blobs/uploads/")) return new Response(null, { status: 202, headers: { location: `${url.origin}${url.pathname}upload-id` } });
      if (method === "PUT" && url.pathname.endsWith("/blobs/uploads/upload-id")) { const bytes = Buffer.from(await new Response(init?.body).arrayBuffer()); blobs.set(url.searchParams.get("digest")!, bytes); return new Response(null, { status: 201, headers: { "docker-content-digest": url.searchParams.get("digest")! } }); }
      if (method === "PUT" && url.pathname.endsWith("/manifests/0.2.0")) { manifest = Buffer.from(await new Response(init?.body).arrayBuffer()); return new Response(null, { status: 201, headers: { "docker-content-digest": value.manifestDigest } }); }
      if (method === "GET" && url.pathname.endsWith("/manifests/0.2.0")) return new Response(manifest as unknown as BodyInit, { headers: { "docker-content-digest": value.manifestDigest } });
      return new Response(null, { status: 500 });
    };
    await expect(publishOciImage({ artifact: value.artifact, credential: { bearer: "shadow-token" }, registry: "https://shadow.example/oci", version: value.version, fetch: request as typeof fetch }))
      .resolves.toMatchObject({ digest: value.manifestDigest, publishedAt: "2026-07-30T08:00:00Z" });
    expect(blobs.size).toBe(2); expect(manifest).toEqual(value.artifact.manifestBytes);
  });
  it("uses GHCR signed blob upload locations without forwarding registry credentials", async () => {
    const value = fixture(); const blobs = new Map<string, Buffer>(); let manifest: Buffer | undefined;
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input)); const method = init?.method ?? "GET"; const authorization = new Headers(init?.headers).get("authorization");
      if (url.hostname === GHCR_STORAGE_HOST) {
        expect(authorization).toBeNull();
        expect(init?.redirect).toBe("error");
        const bytes = Buffer.from(await new Response(init?.body).arrayBuffer()); blobs.set(url.searchParams.get("digest")!, bytes);
        return new Response(null, { status: 201, headers: { "docker-content-digest": url.searchParams.get("digest")! } });
      }
      expect(authorization).toBe("Bearer production-token");
      const blob = /\/blobs\/(sha256:[0-9a-f]{64})$/u.exec(url.pathname);
      if (method === "HEAD" && blob) return new Response(null, { status: 404 });
      if (method === "POST" && url.pathname.endsWith("/blobs/uploads/")) return new Response(null, { status: 202, headers: { location: `https://${GHCR_STORAGE_HOST}/signed/upload?token=opaque` } });
      if (method === "PUT" && url.pathname.endsWith("/manifests/0.2.0")) { manifest = Buffer.from(await new Response(init?.body).arrayBuffer()); return new Response(null, { status: 201, headers: { "docker-content-digest": value.manifestDigest } }); }
      if (method === "GET" && url.pathname.endsWith("/manifests/0.2.0")) return new Response(manifest as unknown as BodyInit, { headers: { "docker-content-digest": value.manifestDigest } });
      return new Response(null, { status: 500 });
    };
    await expect(publishOciImage({ artifact: value.artifact, credential: { bearer: "production-token" }, registry: "https://ghcr.io", version: value.version, fetch: request as typeof fetch }))
      .resolves.toMatchObject({ digest: value.manifestDigest });
    expect(blobs.size).toBe(2); expect(manifest).toEqual(value.artifact.manifestBytes);
  });
  it("accepts GHCR singular same-repository blob upload locations", async () => {
    const value = fixture(); const blobs = new Map<string, Buffer>(); let manifest: Buffer | undefined;
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input)); const method = init?.method ?? "GET";
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer production-token");
      const blob = /\/blobs\/(sha256:[0-9a-f]{64})$/u.exec(url.pathname);
      if (method === "HEAD" && blob) return new Response(null, { status: 404 });
      if (method === "POST" && url.pathname.endsWith("/blobs/uploads/")) return new Response(null, { status: 202, headers: { location: `/v2/liorael/lenso-console/blobs/upload/upload-${blobs.size}` } });
      if (method === "PUT" && url.pathname.includes("/blobs/upload/upload-")) { const bytes = Buffer.from(await new Response(init?.body).arrayBuffer()); blobs.set(url.searchParams.get("digest")!, bytes); return new Response(null, { status: 201, headers: { "docker-content-digest": url.searchParams.get("digest")! } }); }
      if (method === "PUT" && url.pathname.endsWith("/manifests/0.2.0")) { manifest = Buffer.from(await new Response(init?.body).arrayBuffer()); return new Response(null, { status: 201, headers: { "docker-content-digest": value.manifestDigest } }); }
      if (method === "GET" && url.pathname.endsWith("/manifests/0.2.0")) return new Response(manifest as unknown as BodyInit, { headers: { "docker-content-digest": value.manifestDigest } });
      return new Response(null, { status: 500 });
    };
    await expect(publishOciImage({ artifact: value.artifact, credential: { bearer: "production-token" }, registry: "https://ghcr.io", version: value.version, fetch: request as typeof fetch }))
      .resolves.toMatchObject({ digest: value.manifestDigest });
    expect(blobs.size).toBe(2); expect(manifest).toEqual(value.artifact.manifestBytes);
  });
  it("rejects untrusted cross-origin blob upload locations", async () => {
    const value = fixture();
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input)); const method = init?.method ?? "GET";
      if (method === "HEAD") return new Response(null, { status: 404 });
      if (method === "POST" && url.pathname.endsWith("/blobs/uploads/")) return new Response(null, { status: 202, headers: { location: "https://storage.example/upload" } });
      return new Response(null, { status: 500 });
    };
    await expect(publishOciImage({ artifact: value.artifact, credential: { bearer: "production-token" }, registry: "https://ghcr.io", version: value.version, fetch: request as typeof fetch }))
      .rejects.toThrow("blob upload location escaped the registry repository");
  });
  it("rejects manifest, image identity, and graph contradictions", () => {
    const value = fixture();
    expect(() => inspectOciReleaseArtifact({ ...value, version: "0.2.1" })).toThrow("release identity");
    const corrupted = Buffer.from(value.archiveBytes); const marker = corrupted.indexOf(Buffer.from("layer")); expect(marker).toBeGreaterThanOrEqual(0); corrupted[marker] = corrupted[marker]! ^ 1;
    expect(() => inspectOciReleaseArtifact({ ...value, archiveBytes: corrupted })).toThrow("blob digest mismatch");
    expect(() => inspectOciReleaseArtifact({ ...value, installManifestBytes: Buffer.from("{}") })).toThrow("install manifest");
  });
});
