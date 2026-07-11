import { createHmac, sign as asymmetricSign, timingSafeEqual, type KeyObject } from "node:crypto";
import { canonicalBytes, sha256, type JsonValue } from "../core/canonical.js";
import type { Sha256 } from "../contracts/types.js";

export type PreflightBinding = { eventId: string; nonce: string; planId: string; planSha256: string; repository: string; releaseCommit: string; ref: string; workflowSha256: string; runtimeManifestSha256: string; packages: JsonValue; generated: JsonValue };
export type AuthorizedArtifact = { id: string; name: string; version: string; kind: "npm" | "cargo" | "artifact"; path: string; sha256: Sha256; size: number; ino: number; mode: 256; cargoMetadata: JsonValue | null; cargoMetadataSha256: Sha256 | null };
export type PublishAuthorization = { schema: "lenso.publisher-authorization.v1"; proofId: Sha256; bindingDigest: Sha256; eventId: string; nonce: string; planId: string; releaseCommit: string; ref: string; expiresAt: string; artifacts: AuthorizedArtifact[] };
export type StoredProof = { proofId: Sha256; bindingDigest: Sha256; binding: PreflightBinding; issuedAt: string; expiresAt: string; token: string; status: "issued" | "consumed" };
export type AuthoritySnapshot = { revision: number; proofs: Record<string, StoredProof>; nonces: Record<string, string> };
export type AtomicPreflightStore = { read(): Promise<AuthoritySnapshot>; compareAndSwap(expectedRevision: number, next: AuthoritySnapshot): Promise<boolean> };
export class MemoryPreflightStore implements AtomicPreflightStore {
  private value: AuthoritySnapshot = { revision: 0, proofs: {}, nonces: {} };
  async read(): Promise<AuthoritySnapshot> { return structuredClone(this.value); }
  async compareAndSwap(expected: number, next: AuthoritySnapshot): Promise<boolean> { if (this.value.revision !== expected) return false; this.value = structuredClone(next); return true; }
}
export type GitPreflightBackend = { read(path: string): Promise<{ revision: number; bytes: Uint8Array } | null>; compareAndSwap(path: string, expectedRevision: number, bytes: Uint8Array): Promise<boolean> };
export class GitPreflightStore implements AtomicPreflightStore {
  constructor(private readonly backend: GitPreflightBackend, private readonly path = "preflight/authority-state.json") {}
  async read(): Promise<AuthoritySnapshot> { const value = await this.backend.read(this.path); if (!value) return { revision: 0, proofs: {}, nonces: {} }; const snapshot = JSON.parse(Buffer.from(value.bytes).toString("utf8")) as AuthoritySnapshot; if (snapshot.revision !== value.revision) throw new Error("Git preflight revision contradiction"); return snapshot; }
  async compareAndSwap(expectedRevision: number, next: AuthoritySnapshot): Promise<boolean> { return this.backend.compareAndSwap(this.path, expectedRevision, Buffer.concat([canonicalBytes(next as unknown as JsonValue), Buffer.from("\n")])); }
}
export class GithubPreflightBackend implements GitPreflightBackend {
  constructor(private readonly repository: string, private readonly branch: string, private readonly token: string, private readonly request: typeof fetch = fetch) { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !/^[A-Za-z0-9._/-]+$/u.test(branch) || !token) throw new Error("invalid GitHub preflight backend configuration"); }
  private url(path: string): string { return `https://api.github.com/repos/${this.repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(this.branch)}`; }
  private headers() { return { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}`, "content-type": "application/json" }; }
  async read(path: string): Promise<{ revision: number; bytes: Uint8Array } | null> {
    const response = await this.request(this.url(path), { headers: this.headers(), redirect: "error" }); if (response.status === 404) return null; if (!response.ok) throw new Error(`GitHub preflight state read ${response.status}`);
    const body = await response.json() as { content?: string; encoding?: string }; if (body.encoding !== "base64" || typeof body.content !== "string") throw new Error("GitHub preflight state response invalid"); const bytes = Buffer.from(body.content.replace(/\s/gu, ""), "base64"); const revision = (JSON.parse(bytes.toString("utf8")) as { revision?: number }).revision; if (!Number.isSafeInteger(revision)) throw new Error("GitHub preflight state revision invalid"); return { revision: revision!, bytes };
  }
  async compareAndSwap(path: string, expectedRevision: number, bytes: Uint8Array): Promise<boolean> {
    const current = await this.request(this.url(path), { headers: this.headers(), redirect: "error" }); let sha: string | undefined;
    if (current.ok) { const body = await current.json() as { sha?: string; content?: string }; sha = body.sha; const decoded = Buffer.from(String(body.content).replace(/\s/gu, ""), "base64"); if ((JSON.parse(decoded.toString("utf8")) as { revision?: number }).revision !== expectedRevision) return false; }
    else if (current.status !== 404 || expectedRevision !== 0) return false;
    const target = this.url(path).replace(/\?ref=.*$/u, ""); const response = await this.request(target, { method: "PUT", headers: this.headers(), redirect: "error", body: JSON.stringify({ message: "chore: atomically update preflight authority state", content: Buffer.from(bytes).toString("base64"), branch: this.branch, ...(sha ? { sha } : {}) }) });
    if (response.status === 409 || response.status === 422) return false; if (!response.ok) throw new Error(`GitHub preflight state CAS ${response.status}`); return true;
  }
}
async function transact<T>(store: AtomicPreflightStore, update: (snapshot: AuthoritySnapshot) => T): Promise<T> {
  for (let attempt = 0; attempt < 16; attempt += 1) { const current = await store.read(); const next = structuredClone(current); const result = update(next); next.revision = current.revision + 1; if (await store.compareAndSwap(current.revision, next)) return result; }
  throw new Error("preflight authority CAS contention");
}
function sign(secret: Uint8Array, value: JsonValue): string { return createHmac("sha256", secret).update(canonicalBytes(value)).digest("base64url"); }
export class PreflightAuthority {
  constructor(private readonly store: AtomicPreflightStore, private readonly secret: Uint8Array, private readonly authorizationKey: KeyObject, private readonly now = () => new Date()) { if (secret.length < 32 || authorizationKey.type !== "private") throw new Error("preflight signing key is invalid"); }
  async issue(binding: PreflightBinding, bindingDigest: string, authenticate: () => Promise<boolean>): Promise<Omit<StoredProof, "binding" | "status"> & { schema: "lenso.publisher-preflight-proof.v1" }> {
    if (!await authenticate()) throw new Error("preflight requester authentication failed");
    if (bindingDigest !== sha256(binding as unknown as JsonValue) || !/^sha256:[0-9a-f]{64}$/u.test(binding.eventId) || !/^sha256:[0-9a-f]{64}$/u.test(binding.planId) || !/^sha256:[0-9a-f]{64}$/u.test(binding.planSha256) || !/^[0-9a-f]{40}$/u.test(binding.releaseCommit) || binding.ref !== `release-execution/${binding.planId.slice(7)}`) throw new Error("invalid preflight binding");
    return transact(this.store, (snapshot) => {
      const duplicate = Object.values(snapshot.proofs).find(({ binding: saved }) => saved.eventId === binding.eventId);
      if (duplicate) { if (duplicate.bindingDigest !== bindingDigest || duplicate.binding.nonce !== binding.nonce) throw new Error("event preflight identity conflict"); return this.publicProof(duplicate); }
      if (snapshot.nonces[binding.nonce]) throw new Error("preflight nonce already used");
      const issuedAt = this.now().toISOString(); const expiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
      const identity = { bindingDigest: bindingDigest as Sha256, eventId: binding.eventId, nonce: binding.nonce, issuedAt, expiresAt };
      const proofId = sha256(identity as unknown as JsonValue) as Sha256; const token = sign(this.secret, identity as unknown as JsonValue);
      const stored: StoredProof = { proofId, bindingDigest: bindingDigest as Sha256, binding, issuedAt, expiresAt, token, status: "issued" };
      snapshot.proofs[proofId] = stored; snapshot.nonces[binding.nonce] = proofId; return this.publicProof(stored);
    });
  }
  async consume(proof: { proofId: string; bindingDigest: string; issuedAt: string; expiresAt: string; token: string }, facts: { eventId: string; nonce: string; planId: string; releaseCommit: string; ref: string }, artifacts: AuthorizedArtifact[], authenticate: () => Promise<boolean>): Promise<{ accepted: true; eventId: string; proofId: string; authorization: PublishAuthorization; signature: string }> {
    if (!await authenticate()) throw new Error("preflight consumer authentication failed");
    return transact(this.store, (snapshot) => {
      const stored = snapshot.proofs[proof.proofId]; if (!stored || stored.status !== "issued") throw new Error("preflight proof missing or already consumed");
      const identity = { bindingDigest: stored.bindingDigest, eventId: stored.binding.eventId, nonce: stored.binding.nonce, issuedAt: stored.issuedAt, expiresAt: stored.expiresAt };
      const expected = Buffer.from(sign(this.secret, identity as unknown as JsonValue)); const actual = Buffer.from(proof.token);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || proof.bindingDigest !== stored.bindingDigest || proof.issuedAt !== stored.issuedAt || proof.expiresAt !== stored.expiresAt || Date.parse(stored.expiresAt) <= this.now().getTime()) throw new Error("invalid or expired preflight signature");
      for (const key of ["eventId", "nonce", "planId", "releaseCommit", "ref"] as const) if (facts[key] !== stored.binding[key]) throw new Error("preflight consumption binding mismatch");
      if (artifacts.length === 0 || artifacts.length !== (stored.binding.packages as unknown[]).length) throw new Error("artifact authorization selection mismatch");
      for (const [index, artifact] of artifacts.entries()) {
        const selected = (stored.binding.packages as Array<{ id: string; version: string }>)[index]; const expectedName = artifact.id.startsWith("npm:@lenso/") ? artifact.id.slice("npm:@lenso/".length) : artifact.id.slice(artifact.id.indexOf(":") + 1);
        const expectedKind = artifact.id.startsWith("npm:") ? "npm" : artifact.id.startsWith("cargo:") ? "cargo" : "artifact";
        if (!selected || artifact.id !== selected.id || artifact.version !== selected.version || artifact.name !== expectedName || artifact.kind !== expectedKind || !artifact.path.startsWith(`.lenso-release/preflight-artifacts/${proof.proofId.slice(7)}/`) || !/^sha256:[0-9a-f]{64}$/u.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !Number.isSafeInteger(artifact.ino) || artifact.ino <= 0 || artifact.mode !== 0o400) throw new Error("invalid canonical artifact authorization");
        if (artifact.kind === "cargo" ? artifact.cargoMetadata === null || artifact.cargoMetadataSha256 !== sha256(artifact.cargoMetadata as JsonValue) : artifact.cargoMetadata !== null || artifact.cargoMetadataSha256 !== null) throw new Error("Cargo upload metadata binding mismatch");
      }
      const authorization: PublishAuthorization = { schema: "lenso.publisher-authorization.v1", proofId: stored.proofId, bindingDigest: stored.bindingDigest, eventId: stored.binding.eventId, nonce: stored.binding.nonce, planId: stored.binding.planId, releaseCommit: stored.binding.releaseCommit, ref: stored.binding.ref, expiresAt: stored.expiresAt, artifacts };
      const signature = asymmetricSign(null, canonicalBytes(authorization as unknown as JsonValue), this.authorizationKey).toString("base64url"); stored.status = "consumed"; return { accepted: true, eventId: stored.binding.eventId, proofId: stored.proofId, authorization, signature };
    });
  }
  private publicProof(proof: StoredProof) { return { schema: "lenso.publisher-preflight-proof.v1" as const, proofId: proof.proofId, bindingDigest: proof.bindingDigest, issuedAt: proof.issuedAt, expiresAt: proof.expiresAt, token: proof.token }; }
}
export function createPreflightHttpHandler(authority: PreflightAuthority, authenticate: (request: Request) => Promise<boolean>) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await request.json() as Record<string, unknown>; const auth = () => authenticate(request);
      const result = new URL(request.url).pathname.endsWith("/issue")
        ? await authority.issue(body.binding as PreflightBinding, String(body.bindingDigest), auth)
        : await authority.consume(body.proof as Parameters<PreflightAuthority["consume"]>[0], body.facts as Parameters<PreflightAuthority["consume"]>[1], body.artifacts as AuthorizedArtifact[], auth);
      return Response.json(result, { status: 200 });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "preflight failure" }, { status: 409 }); }
  };
}
