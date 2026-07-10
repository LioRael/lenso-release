import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  sha256,
  type JsonValue,
} from "../../src/core/canonical.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively and preserves array order", () => {
    const value = { z: [{ b: 2, a: 1 }], a: true };
    expect(canonicalBytes(value).toString("utf8")).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}'
    );
    expect(sha256(value)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects non-JSON numbers", () => {
    expect(() => canonicalBytes({ value: Number.NaN })).toThrow(
      "non-finite number"
    );
  });

  it("sorts integer-like object keys lexically", () => {
    expect(canonicalBytes({ "2": "two", "10": "ten" }).toString("utf8")).toBe(
      '{"10":"ten","2":"two"}'
    );
  });

  it.each([
    ["Date", new Date(0)],
    ["Map", new Map<string, string>()],
    ["class instance", new (class Example {})()],
    ["symbol-keyed object", { [Symbol("key")]: true }],
  ])("rejects non-JSON %s values", (_name, value) => {
    expect(() => canonicalBytes(value as JsonValue)).toThrow(
      "canonical JSON cannot encode"
    );
  });
});
