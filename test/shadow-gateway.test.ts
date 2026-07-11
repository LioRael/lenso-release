import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { npmPublication, parseCargoUpload } from "../shadow-gateway/src/protocol.js";
import { canonical, canonicalSha256, signAuthorization } from "../shadow-gateway/src/coordinator.js";

describe("shadow gateway protocols", () => {
  it("parses the Cargo publish wire format without changing artifact bytes", () => {
    const metadata = Buffer.from(JSON.stringify({ name: "lenso-test", vers: "1.2.3" }));
    const crate = Buffer.from("exact crate bytes");
    const header = Buffer.alloc(8);
    header.writeUInt32LE(metadata.length, 0);
    header.writeUInt32LE(crate.length, 4);
    const upload = Buffer.concat([header.subarray(0, 4), metadata, header.subarray(4), crate]);
    const parsed = parseCargoUpload(upload);
    expect(parsed.metadata).toEqual({ name: "lenso-test", vers: "1.2.3" });
    expect(Buffer.from(parsed.crate)).toEqual(crate);
  });

  it("extracts one exact npm attachment", () => {
    const bytes = Buffer.from("exact npm bytes");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const shasum = createHash("sha1").update(bytes).digest("hex");
    const publication = npmPublication({
      name: "@lenso/test",
      versions: { "1.2.3": { name: "@lenso/test", version: "1.2.3", dist: { integrity, shasum } } },
      _attachments: { "test-1.2.3.tgz": { data: bytes.toString("base64"), integrity, shasum } },
    });
    expect(publication.name).toBe("@lenso/test");
    expect(publication.version).toBe("1.2.3");
    expect(Buffer.from(publication.bytes)).toEqual(bytes);
  });

  it("rejects Cargo bodies with trailing bytes", () => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(2, 0);
    header.writeUInt32LE(0, 4);
    expect(() => parseCargoUpload(Buffer.concat([header.subarray(0, 4), Buffer.from("{}"), header.subarray(4), Buffer.from("x")]))).toThrow("length mismatch");
  });

  it("canonicalizes and digests coordinator bindings deterministically", async () => {
    const left = { z: [2, { b: true, a: null }], a: "value" };
    const right = { a: "value", z: [2, { a: null, b: true }] };
    expect(canonical(left)).toBe(canonical(right));
    expect(await canonicalSha256(left)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await canonicalSha256(left)).toBe(await canonicalSha256(right));
  });

  it("signs a publisher authorization with an Ed25519 PKCS8 key", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const authorization = { schema: "lenso.publisher-authorization.v1", eventId: "sha256:test" };
    const signature = Buffer.from((await signAuthorization(authorization, privateKey)).replaceAll("-", "+").replaceAll("_", "/"), "base64");
    expect(await crypto.subtle.verify("Ed25519", pair.publicKey, signature, Buffer.from(canonical(authorization)))).toBe(true);
  });
});
