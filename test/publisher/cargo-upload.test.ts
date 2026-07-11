import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { uploadCargoArtifact } from "../../src/repository/runtime.js";

const servers: ReturnType<typeof createServer>[] = []; afterEach(() => { servers.splice(0).forEach((server) => server.close()); delete process.env.LENSO_CRATES_UPLOAD_URL; delete process.env.CARGO_REGISTRY_TOKEN; });
describe("sealed Cargo upload", () => {
  it("uploads signed metadata framing plus exact crate bytes without workspace reads", async () => {
    let captured = Buffer.alloc(0); let authorization = ""; const server = createServer((request, response) => { authorization = String(request.headers.authorization); const chunks: Buffer[] = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { captured = Buffer.concat(chunks); response.setHeader("content-type", "application/json"); response.end("{}"); }); }); servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server"); process.env.LENSO_CRATES_UPLOAD_URL = `http://127.0.0.1:${address.port}/api/v1/crates/new`; process.env.CARGO_REGISTRY_TOKEN = "short-lived";
    const metadata = { name: "lenso-contracts", vers: "1.2.3", deps: [], features: {} }; const crate = Buffer.from("immutable crate bytes");
    await uploadCargoArtifact({ id: "cargo:lenso-contracts", version: "1.2.3" }, crate, metadata);
    const jsonLength = captured.readUInt32LE(0); const decoded = JSON.parse(captured.subarray(4, 4 + jsonLength).toString("utf8")); const crateLength = captured.readUInt32LE(4 + jsonLength); const uploaded = captured.subarray(8 + jsonLength);
    expect(decoded).toEqual(metadata); expect(crateLength).toBe(crate.length); expect(uploaded).toEqual(crate); expect(authorization).toBe("short-lived");
  });
});
