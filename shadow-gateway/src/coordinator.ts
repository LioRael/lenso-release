import { sha256 } from "./protocol.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = Record<string, unknown>;
type CoordinatorEnv = { DB: { prepare(query: string): any }; PREFLIGHT_PRIVATE_KEY: string };

export function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

export async function canonicalSha256(value: Json): Promise<string> {
  return `sha256:${await sha256(new TextEncoder().encode(canonical(value)))}`;
}

function decodeBase64(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

export async function signAuthorization(value: Json, privateKeyBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", decodeBase64(privateKeyBase64), { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(canonical(value)));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  return value;
}

async function requireInstallation(request: Request, repository: string): Promise<string> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw new Error("GitHub installation token is required");
  const response = await fetch("https://api.github.com/installation/repositories?per_page=100", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "lenso-release-coordinator", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error("GitHub installation token is invalid");
  const body = await response.json() as { repositories?: Array<{ full_name?: string }> };
  if (!body.repositories?.some(({ full_name }) => full_name === repository) || !body.repositories.some(({ full_name }) => full_name === "LioRael/lenso-release"))
    throw new Error("GitHub App installation does not cover the release repositories");
  return token;
}

async function dispatch(request: Request, eventType: "lenso-plan-ready" | "lenso-publish-receipt"): Promise<Response> {
  const event = object(await request.json(), "release event");
  if (event.eventType !== eventType || event.schema !== "lenso.release-event.v1") throw new Error("release event type mismatch");
  const repository = string(event.sourceRepository, "sourceRepository");
  const token = await requireInstallation(request, repository);
  const response = await fetch("https://api.github.com/repos/LioRael/lenso-release/dispatches", {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "lenso-release-coordinator", "x-github-api-version": "2022-11-28" },
    body: JSON.stringify({ event_type: eventType, client_payload: event }),
  });
  if (!response.ok) throw new Error(`GitHub repository dispatch failed with ${response.status}`);
  return Response.json({ accepted: true, eventId: event.eventId }, { status: 202 });
}

async function issuePreflight(request: Request, env: CoordinatorEnv): Promise<Response> {
  const body = object(await request.json(), "preflight request");
  if (body.schema !== "lenso.publisher-preflight.v1") throw new Error("preflight schema mismatch");
  const binding = object(body.binding, "binding");
  const repository = string(binding.repository, "binding.repository");
  await requireInstallation(request, repository);
  const bindingDigest = string(body.bindingDigest, "bindingDigest");
  if (bindingDigest !== await canonicalSha256(binding as Json)) throw new Error("preflight binding digest mismatch");
  const eventId = string(binding.eventId, "binding.eventId");
  const now = new Date();
  const proofId = await canonicalSha256({ eventId, bindingDigest } as Json);
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 4 * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO preflight_proofs (proof_id, event_id, repository, binding_digest, token, issued_at, expires_at, consumed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL) ON CONFLICT(proof_id) DO NOTHING")
    .bind(proofId, eventId, repository, bindingDigest, token, issuedAt, expiresAt).run();
  const row = await env.DB.prepare("SELECT token, issued_at, expires_at FROM preflight_proofs WHERE proof_id=?1 AND event_id=?2 AND binding_digest=?3").bind(proofId, eventId, bindingDigest).first() as { token: string; issued_at: string; expires_at: string } | null;
  if (!row) throw new Error("preflight proof conflict");
  return Response.json({ schema: "lenso.publisher-preflight-proof.v1", proofId, bindingDigest, token: row.token, issuedAt: row.issued_at, expiresAt: row.expires_at });
}

async function consumePreflight(request: Request, env: CoordinatorEnv): Promise<Response> {
  const body = object(await request.json(), "preflight consumption");
  const proof = object(body.proof, "proof");
  const facts = object(body.facts, "facts");
  const artifacts = body.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("sealed artifacts are required");
  const eventId = string(facts.eventId, "facts.eventId");
  const proofId = string(proof.proofId, "proof.proofId");
  const row = await env.DB.prepare("SELECT repository, event_id, binding_digest, token, expires_at, consumed_at FROM preflight_proofs WHERE proof_id=?1").bind(proofId).first() as { repository: string; event_id: string; binding_digest: string; token: string; expires_at: string; consumed_at: string | null } | null;
  if (!row || row.event_id !== eventId || row.binding_digest !== proof.bindingDigest || row.token !== proof.token || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) throw new Error("preflight proof is invalid, expired, or consumed");
  await requireInstallation(request, row.repository);
  const consumedAt = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE preflight_proofs SET consumed_at=?2 WHERE proof_id=?1 AND consumed_at IS NULL").bind(proofId, consumedAt).run();
  if (result.meta.changes !== 1) throw new Error("preflight proof was already consumed");
  const authorization = {
    schema: "lenso.publisher-authorization.v1", bindingDigest: row.binding_digest,
    eventId, nonce: facts.nonce, planId: facts.planId, releaseCommit: facts.releaseCommit,
    ref: facts.ref, artifacts, issuedAt: consumedAt, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  } as Json;
  const signature = await signAuthorization(authorization, env.PREFLIGHT_PRIVATE_KEY);
  return Response.json({ accepted: true, eventId, proofId, authorization, signature });
}

export async function coordinatorRoute(request: Request, env: CoordinatorEnv, url: URL): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  if (url.pathname === "/coordinator/ready") return dispatch(request, "lenso-plan-ready");
  if (url.pathname === "/coordinator/receipt") return dispatch(request, "lenso-publish-receipt");
  if (url.pathname === "/coordinator/preflight") return issuePreflight(request, env);
  if (url.pathname === "/coordinator/preflight/consume") return consumePreflight(request, env);
  return Response.json({ error: "coordinator route not found" }, { status: 404 });
}
