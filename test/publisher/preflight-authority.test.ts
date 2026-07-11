import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { sha256, type JsonValue } from "../../src/core/canonical.js";
import { MemoryPreflightStore, PreflightAuthority, type PreflightBinding } from "../../src/publisher/preflight-authority.js";

const servers: ReturnType<typeof createServer>[] = []; afterEach(() => servers.splice(0).forEach((server) => server.close()));
function binding(): PreflightBinding { const planId = `sha256:${"a".repeat(64)}`; return { eventId: `sha256:${"b".repeat(64)}`, nonce: "12345678-1234-4234-8234-123456789abc", planId, planSha256: `sha256:${"c".repeat(64)}`, repository: "LioRael/lenso", releaseCommit: "d".repeat(40), ref: `release-execution/${planId.slice(7)}`, workflowSha256: `sha256:${"e".repeat(64)}`, runtimeManifestSha256: `sha256:${"f".repeat(64)}`, packages: [{ id: "cargo:lenso-contracts", version: "1.0.0" }], generated: [] }; }
describe("authoritative preflight service", () => {
  it("authenticates issue and permits exactly one concurrent consume", async () => {
    const authority = new PreflightAuthority(new MemoryPreflightStore(), Buffer.alloc(32, 7), () => new Date("2026-07-11T00:00:00.000Z"));
    const server = createServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", async () => { try { const value = JSON.parse(body); const auth = async () => request.headers.authorization === "Bearer app-token"; const result = request.url === "/issue" ? await authority.issue(value.binding, value.bindingDigest, auth) : await authority.consume(value.proof, value.facts, auth); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result)); } catch (error) { response.statusCode = 409; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failure" })); } }); }); servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address"); const base = `http://127.0.0.1:${address.port}`;
    const value = binding(); const issue = await fetch(`${base}/issue`, { method: "POST", headers: { authorization: "Bearer app-token" }, body: JSON.stringify({ binding: value, bindingDigest: sha256(value as unknown as JsonValue) }) }); expect(issue.status).toBe(200); const proof = await issue.json();
    const facts = { eventId: value.eventId, nonce: value.nonce, planId: value.planId, releaseCommit: value.releaseCommit, ref: value.ref };
    const consume = () => fetch(`${base}/consume`, { method: "POST", headers: { authorization: "Bearer app-token" }, body: JSON.stringify({ proof, facts }) }); const outcomes = await Promise.all([consume(), consume()]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 409]);
    const replay = await consume(); expect(replay.status).toBe(409);
  });
});
