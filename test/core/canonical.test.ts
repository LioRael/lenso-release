import { describe, expect, it } from "vitest";
import { canonicalBytes, sha256 } from "../../src/core/canonical.js";

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
});
