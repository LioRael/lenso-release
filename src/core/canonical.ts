import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError("canonical JSON cannot encode a non-finite number");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])])
    );
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(normalize(value)), "utf8");
}

export function sha256(value: unknown | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : canonicalBytes(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
