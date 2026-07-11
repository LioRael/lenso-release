import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalBytes, sha256, type JsonValue } from "../core/canonical.js";
import type { Sha256 } from "../contracts/types.js";

export type PreflightBinding = { eventId: string; nonce: string; planId: string; planSha256: string; repository: string; releaseCommit: string; ref: string; workflowSha256: string; runtimeManifestSha256: string; packages: JsonValue; generated: JsonValue };
export type StoredProof = { proofId: Sha256; bindingDigest: Sha256; binding: PreflightBinding; issuedAt: string; expiresAt: string; token: string; status: "issued" | "consumed" };
export type AuthoritySnapshot = { revision: number; proofs: Record<string, StoredProof>; nonces: Record<string, string> };
export type AtomicPreflightStore = { read(): Promise<AuthoritySnapshot>; compareAndSwap(expectedRevision: number, next: AuthoritySnapshot): Promise<boolean> };
export class MemoryPreflightStore implements AtomicPreflightStore {
  private value: AuthoritySnapshot = { revision: 0, proofs: {}, nonces: {} };
  async read(): Promise<AuthoritySnapshot> { return structuredClone(this.value); }
  async compareAndSwap(expected: number, next: AuthoritySnapshot): Promise<boolean> { if (this.value.revision !== expected) return false; this.value = structuredClone(next); return true; }
}
async function transact<T>(store: AtomicPreflightStore, update: (snapshot: AuthoritySnapshot) => T): Promise<T> {
  for (let attempt = 0; attempt < 16; attempt += 1) { const current = await store.read(); const next = structuredClone(current); const result = update(next); next.revision = current.revision + 1; if (await store.compareAndSwap(current.revision, next)) return result; }
  throw new Error("preflight authority CAS contention");
}
function sign(secret: Uint8Array, value: JsonValue): string { return createHmac("sha256", secret).update(canonicalBytes(value)).digest("base64url"); }
export class PreflightAuthority {
  constructor(private readonly store: AtomicPreflightStore, private readonly secret: Uint8Array, private readonly now = () => new Date()) { if (secret.length < 32) throw new Error("preflight signing key is too short"); }
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
  async consume(proof: { proofId: string; bindingDigest: string; issuedAt: string; expiresAt: string; token: string }, facts: { eventId: string; nonce: string; planId: string; releaseCommit: string; ref: string }, authenticate: () => Promise<boolean>): Promise<{ accepted: true; eventId: string; proofId: string }> {
    if (!await authenticate()) throw new Error("preflight consumer authentication failed");
    return transact(this.store, (snapshot) => {
      const stored = snapshot.proofs[proof.proofId]; if (!stored || stored.status !== "issued") throw new Error("preflight proof missing or already consumed");
      const identity = { bindingDigest: stored.bindingDigest, eventId: stored.binding.eventId, nonce: stored.binding.nonce, issuedAt: stored.issuedAt, expiresAt: stored.expiresAt };
      const expected = Buffer.from(sign(this.secret, identity as unknown as JsonValue)); const actual = Buffer.from(proof.token);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || proof.bindingDigest !== stored.bindingDigest || proof.issuedAt !== stored.issuedAt || proof.expiresAt !== stored.expiresAt || Date.parse(stored.expiresAt) <= this.now().getTime()) throw new Error("invalid or expired preflight signature");
      for (const key of ["eventId", "nonce", "planId", "releaseCommit", "ref"] as const) if (facts[key] !== stored.binding[key]) throw new Error("preflight consumption binding mismatch");
      stored.status = "consumed"; return { accepted: true, eventId: stored.binding.eventId, proofId: stored.proofId };
    });
  }
  private publicProof(proof: StoredProof) { return { schema: "lenso.publisher-preflight-proof.v1" as const, proofId: proof.proofId, bindingDigest: proof.bindingDigest, issuedAt: proof.issuedAt, expiresAt: proof.expiresAt, token: proof.token }; }
}
