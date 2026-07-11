import { npmPublication, parseCargoUpload, sha256 } from "./protocol.ts";
import { coordinatorRoute } from "./coordinator.ts";

type JsonObject = Record<string, unknown>;
type ReleaseRow = { id: number; repository: string; tag_name: string; target_commitish: string; name: string; draft: number; prerelease: number; created_at: string };
type AssetRow = { id: number; release_id: number; name: string; content_type: string; object_key: string; size: number; created_at: string };

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const error = (status: number, message: string): Response => json({ error: message }, status);

function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : value;
}

async function sameSecret(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  if (left.byteLength !== right.byteLength) return false;
  const key = await crypto.subtle.importKey("raw", right, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [leftMac, rightMac] = await Promise.all([crypto.subtle.sign("HMAC", key, left), crypto.subtle.sign("HMAC", key, right)]);
  const leftBytes = new Uint8Array(leftMac);
  const rightBytes = new Uint8Array(rightMac);
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) difference |= leftBytes[index]! ^ rightBytes[index]!;
  return difference === 0;
}

async function requireShadowToken(request: Request, env: Env): Promise<Response | null> {
  return await sameSecret(bearer(request), env.SHADOW_TOKEN) ? null : error(401, "invalid shadow token");
}

async function requireGitHubInstallation(request: Request, repository: string): Promise<Response | null> {
  const token = bearer(request);
  if (!token) return error(401, "missing GitHub installation token");
  const response = await fetch("https://api.github.com/installation/repositories?per_page=100", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "lenso-release-shadow-gateway", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) return error(401, "invalid GitHub installation token");
  const body = await response.json<{ repositories?: Array<{ full_name?: string }> }>();
  return body.repositories?.some(({ full_name }) => full_name === repository) ? null : error(403, "repository is outside the App installation");
}

async function npmRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const suffix = url.pathname.slice("/npm/".length);
  if (request.method === "PUT") {
    const denied = await requireShadowToken(request, env);
    if (denied) return denied;
    const publication = npmPublication(await request.json());
    const key = `npm/${encodeURIComponent(publication.name)}/${publication.version}.tgz`;
    await env.ARTIFACTS.put(key, publication.bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    await env.DB.prepare("INSERT INTO npm_packages (name, version, integrity, shasum, object_key, published_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(name, version) DO UPDATE SET integrity=excluded.integrity, shasum=excluded.shasum, object_key=excluded.object_key")
      .bind(publication.name, publication.version, publication.integrity, publication.shasum, key, new Date().toISOString()).run();
    return json({ ok: true, id: publication.name, rev: publication.version }, 201);
  }
  const tarball = suffix.match(/^tarballs\/(.+)\/(\d+\.\d+\.\d+)\.tgz$/u);
  if (request.method === "GET" && tarball) {
    const object = await env.ARTIFACTS.get(`npm/${tarball[1]}/${tarball[2]}.tgz`);
    return object ? new Response(object.body, { headers: { "content-type": "application/octet-stream", etag: object.httpEtag } }) : error(404, "npm artifact not found");
  }
  if (request.method === "GET") {
    const name = decodeURIComponent(suffix);
    const rows = await env.DB.prepare("SELECT name, version, integrity, shasum, published_at FROM npm_packages WHERE name = ?1 ORDER BY published_at").bind(name).all<{ name: string; version: string; integrity: string; shasum: string; published_at: string }>();
    if (!rows.results.length) return error(404, "npm package not found");
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = {};
    for (const row of rows.results) {
      versions[row.version] = { name: row.name, version: row.version, dist: { integrity: row.integrity, shasum: row.shasum, tarball: `${url.origin}/npm/tarballs/${encodeURIComponent(row.name)}/${row.version}.tgz` } };
      time[row.version] = row.published_at;
    }
    return json({ name, versions, time });
  }
  return error(405, "unsupported npm operation");
}

async function cargoRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "PUT" && url.pathname === "/cargo/api/v1/crates/new") {
    const denied = await requireShadowToken(request, env);
    if (denied) return denied;
    const parsed = parseCargoUpload(new Uint8Array(await request.arrayBuffer()));
    const name = String(parsed.metadata.name ?? "");
    const version = String(parsed.metadata.vers ?? "");
    if (!name || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) return error(400, "invalid Cargo identity");
    const checksum = await sha256(parsed.crate);
    const key = `cargo/${encodeURIComponent(name)}/${version}.crate`;
    const publishedAt = new Date().toISOString();
    await env.ARTIFACTS.put(key, parsed.crate, { httpMetadata: { contentType: "application/gzip" } });
    await env.DB.prepare("INSERT INTO cargo_packages (name, version, checksum, object_key, published_at, metadata_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(name, version) DO UPDATE SET checksum=excluded.checksum, object_key=excluded.object_key, metadata_json=excluded.metadata_json")
      .bind(name, version, checksum, key, publishedAt, JSON.stringify(parsed.metadata)).run();
    return json({ ok: true }, 200);
  }
  const match = url.pathname.match(/^\/cargo\/api\/v1\/crates\/([^/]+)\/([^/]+)(\/download)?$/u);
  if (request.method === "GET" && match) {
    const name = decodeURIComponent(match[1]!);
    const version = decodeURIComponent(match[2]!);
    const row = await env.DB.prepare("SELECT checksum, object_key, published_at FROM cargo_packages WHERE name=?1 AND version=?2").bind(name, version).first<{ checksum: string; object_key: string; published_at: string }>();
    if (!row) return error(404, "Cargo package not found");
    if (match[3]) {
      const object = await env.ARTIFACTS.get(row.object_key);
      return object ? new Response(object.body, { headers: { "content-type": "application/gzip", etag: object.httpEtag } }) : error(404, "Cargo artifact not found");
    }
    return json({ version: { checksum: row.checksum, created_at: row.published_at } });
  }
  return error(405, "unsupported Cargo operation");
}

async function releaseJson(env: Env, origin: string, row: ReleaseRow): Promise<JsonObject> {
  const assets = await env.DB.prepare("SELECT * FROM github_assets WHERE release_id=?1 ORDER BY id").bind(row.id).all<AssetRow>();
  return {
    id: row.id, tag_name: row.tag_name, target_commitish: row.target_commitish, name: row.name, draft: row.draft === 1, prerelease: row.prerelease === 1, created_at: row.created_at,
    upload_url: `${origin}/github/uploads/repos/${row.repository}/releases/${row.id}/assets{?name,label}`,
    assets: assets.results.map((asset) => ({ id: asset.id, name: asset.name, size: asset.size, url: `${origin}/github/assets/${asset.id}`, browser_download_url: `${origin}/github/assets/${asset.id}` })),
  };
}

async function githubRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const releaseTag = url.pathname.match(/^\/github\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/u);
  const releases = url.pathname.match(/^\/github\/repos\/([^/]+\/[^/]+)\/releases$/u);
  const upload = url.pathname.match(/^\/github\/uploads\/repos\/([^/]+\/[^/]+)\/releases\/(\d+)\/assets$/u);
  const asset = url.pathname.match(/^\/github\/assets\/(\d+)$/u);
  const tagRef = url.pathname.match(/^\/github\/repos\/([^/]+\/[^/]+)\/git\/ref\/tags\/(.+)$/u);
  const tagObject = url.pathname.match(/^\/github\/repos\/([^/]+\/[^/]+)\/git\/tags\/([^/]+)$/u);
  const tagObjects = url.pathname.match(/^\/github\/repos\/([^/]+\/[^/]+)\/git\/tags$/u);
  const tagRefs = url.pathname.match(/^\/github\/repos\/([^/]+\/[^/]+)\/git\/refs$/u);
  const repository = releaseTag?.[1] ?? releases?.[1] ?? upload?.[1] ?? tagRef?.[1] ?? tagObject?.[1] ?? tagObjects?.[1] ?? tagRefs?.[1];
  if (repository) {
    const denied = await requireGitHubInstallation(request, repository);
    if (denied) return denied;
  }
  if (request.method === "GET" && releaseTag) {
    const row = await env.DB.prepare("SELECT * FROM github_releases WHERE repository=?1 AND tag_name=?2").bind(releaseTag[1], decodeURIComponent(releaseTag[2]!)).first<ReleaseRow>();
    return row ? json(await releaseJson(env, url.origin, row)) : error(404, "release not found");
  }
  if (request.method === "POST" && releases) {
    const body = await request.json<{ tag_name?: string; target_commitish?: string; name?: string; draft?: boolean; prerelease?: boolean }>();
    if (!body.tag_name || !body.target_commitish || !body.name) return error(400, "incomplete release");
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO github_releases (repository, tag_name, target_commitish, name, draft, prerelease, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(repository, tag_name) DO NOTHING")
      .bind(releases[1], body.tag_name, body.target_commitish, body.name, body.draft ? 1 : 0, body.prerelease ? 1 : 0, now).run();
    const row = await env.DB.prepare("SELECT * FROM github_releases WHERE repository=?1 AND tag_name=?2").bind(releases[1], body.tag_name).first<ReleaseRow>();
    return row ? json(await releaseJson(env, url.origin, row), 201) : error(500, "release persistence failed");
  }
  if (request.method === "POST" && upload) {
    const releaseId = Number(upload[2]);
    const name = url.searchParams.get("name") ?? "";
    if (!name) return error(400, "asset name is required");
    const bytes = new Uint8Array(await request.arrayBuffer());
    const key = `github/${releaseId}/${encodeURIComponent(name)}`;
    const now = new Date().toISOString();
    await env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" } });
    await env.DB.prepare("INSERT INTO github_assets (release_id, name, content_type, object_key, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(release_id, name) DO NOTHING")
      .bind(releaseId, name, request.headers.get("content-type") ?? "application/octet-stream", key, bytes.byteLength, now).run();
    const row = await env.DB.prepare("SELECT * FROM github_assets WHERE release_id=?1 AND name=?2").bind(releaseId, name).first<AssetRow>();
    return row ? json({ id: row.id, name: row.name, size: row.size, url: `${url.origin}/github/assets/${row.id}`, browser_download_url: `${url.origin}/github/assets/${row.id}` }, 201) : error(500, "asset persistence failed");
  }
  if (request.method === "GET" && asset) {
    const row = await env.DB.prepare("SELECT * FROM github_assets WHERE id=?1").bind(Number(asset[1])).first<AssetRow>();
    if (!row) return error(404, "asset not found");
    const object = await env.ARTIFACTS.get(row.object_key);
    return object ? new Response(object.body, { headers: { "content-type": row.content_type, etag: object.httpEtag } }) : error(404, "asset bytes not found");
  }
  if (request.method === "POST" && tagObjects) {
    const body = await request.json<{ tag?: string; message?: string; object?: string }>();
    if (!body.tag || !body.message || !body.object) return error(400, "incomplete tag object");
    const objectSha = await sha256(new TextEncoder().encode(`${tagObjects[1]}\0${body.tag}\0${body.message}\0${body.object}`));
    await env.DB.prepare("INSERT INTO github_tags (repository, tag, tag_object_sha, target_sha, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(repository, tag) DO NOTHING")
      .bind(tagObjects[1], body.tag, objectSha, body.object, body.message, new Date().toISOString()).run();
    return json({ sha: objectSha, tag: body.tag, message: body.message, object: { sha: body.object, type: "commit" } }, 201);
  }
  if (request.method === "POST" && tagRefs) return json({ ref: (await request.json<{ ref?: string }>()).ref }, 201);
  if (request.method === "GET" && tagRef) {
    const row = await env.DB.prepare("SELECT tag_object_sha FROM github_tags WHERE repository=?1 AND tag=?2").bind(tagRef[1], decodeURIComponent(tagRef[2]!)).first<{ tag_object_sha: string }>();
    return row ? json({ ref: `refs/tags/${decodeURIComponent(tagRef[2]!)}`, object: { type: "tag", sha: row.tag_object_sha } }) : error(404, "tag ref not found");
  }
  if (request.method === "GET" && tagObject) {
    const row = await env.DB.prepare("SELECT tag, target_sha, message FROM github_tags WHERE repository=?1 AND tag_object_sha=?2").bind(tagObject[1], tagObject[2]).first<{ tag: string; target_sha: string; message: string }>();
    return row ? json({ tag: row.tag, message: row.message, object: { type: "commit", sha: row.target_sha } }) : error(404, "tag object not found");
  }
  return error(405, "unsupported GitHub shadow operation");
}

async function attestationRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return error(405, "unsupported attestation operation");
  const body = await request.json<{ repository?: string; releaseCommit?: string; artifactSha256?: string; artifactName?: string }>();
  if (!body.repository || !body.releaseCommit || !/^sha256:[0-9a-f]{64}$/u.test(body.artifactSha256 ?? "") || !body.artifactName) return error(400, "invalid attestation");
  const denied = await requireGitHubInstallation(request, body.repository);
  if (denied) return denied;
  const id = await sha256(new TextEncoder().encode(`${body.repository}\0${body.releaseCommit}\0${body.artifactSha256}\0${body.artifactName}`));
  await env.DB.prepare("INSERT INTO attestations (id, repository, release_commit, artifact_sha256, artifact_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING")
    .bind(id, body.repository, body.releaseCommit, body.artifactSha256, body.artifactName, new Date().toISOString()).run();
  return json({ url: `${url.origin}/attestations/${id}` }, 201);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", service: "lenso-release-shadow-gateway" });
      if (url.pathname.startsWith("/npm/")) return await npmRoute(request, env, url);
      if (url.pathname.startsWith("/cargo/")) return await cargoRoute(request, env, url);
      if (url.pathname.startsWith("/github/")) return await githubRoute(request, env, url);
      if (url.pathname.startsWith("/coordinator/")) return await coordinatorRoute(request, env, url);
      if (url.pathname === "/attestations") return await attestationRoute(request, env, url);
      if (request.method === "GET" && /^\/attestations\/[0-9a-f]{64}$/u.test(url.pathname)) {
        const row = await env.DB.prepare("SELECT * FROM attestations WHERE id=?1").bind(url.pathname.slice("/attestations/".length)).first();
        return row ? json(row) : error(404, "attestation not found");
      }
      return error(404, "route not found");
    } catch (caught) {
      console.error(JSON.stringify({ level: "error", message: caught instanceof Error ? caught.message : "unknown error" }));
      return error(400, caught instanceof Error ? caught.message : "invalid request");
    }
  },
} satisfies ExportedHandler<Env>;
