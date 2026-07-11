export interface CargoUpload {
  metadata: Record<string, unknown>;
  crate: Uint8Array;
}

function uint32le(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) throw new Error("truncated cargo upload");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

export function parseCargoUpload(bytes: Uint8Array): CargoUpload {
  const jsonLength = uint32le(bytes, 0);
  const jsonStart = 4;
  const jsonEnd = jsonStart + jsonLength;
  const crateLength = uint32le(bytes, jsonEnd);
  const crateStart = jsonEnd + 4;
  const crateEnd = crateStart + crateLength;
  if (crateEnd !== bytes.byteLength) throw new Error("cargo upload length mismatch");
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonEnd)));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid cargo metadata");
  return { metadata: decoded as Record<string, unknown>, crate: bytes.subarray(crateStart, crateEnd) };
}

export function npmPublication(document: unknown): {
  name: string;
  version: string;
  integrity: string;
  shasum: string;
  bytes: Uint8Array;
} {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("invalid npm publication");
  const value = document as Record<string, unknown>;
  const name = String(value.name ?? "");
  const versions = value.versions;
  const attachments = value._attachments;
  if (!name || !versions || typeof versions !== "object" || Array.isArray(versions) || !attachments || typeof attachments !== "object" || Array.isArray(attachments)) throw new Error("incomplete npm publication");
  const entries = Object.entries(versions as Record<string, unknown>);
  const attachmentEntries = Object.values(attachments as Record<string, unknown>);
  if (entries.length !== 1 || attachmentEntries.length !== 1) throw new Error("npm publication must contain one version and one attachment");
  const [version, manifestValue] = entries[0]!;
  const manifest = manifestValue as Record<string, unknown>;
  const attachment = attachmentEntries[0] as Record<string, unknown>;
  const dist = manifest.dist as Record<string, unknown> | undefined;
  const data = String(attachment.data ?? "");
  const integrity = String(dist?.integrity ?? attachment.integrity ?? "");
  const shasum = String(dist?.shasum ?? attachment.shasum ?? "");
  if (manifest.name !== name || manifest.version !== version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity) || !/^[0-9a-f]{40}$/u.test(shasum) || !data) throw new Error("invalid npm artifact identity");
  return { name, version, integrity, shasum, bytes: Uint8Array.from(atob(data), (character) => character.charCodeAt(0)) };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer))].map((value) => value.toString(16).padStart(2, "0")).join("");
}
