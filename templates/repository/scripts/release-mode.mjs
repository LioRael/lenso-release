#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../.lenso-release/shadow.json", import.meta.url), "utf8"));
assert.equal(config.schema, "lenso.release-mode.v1");
assert.equal(config.mode, "shadow");
assert.deepEqual(config.allowedModes, ["shadow"]);
const mode = process.env.REQUESTED_MODE || config.mode;
assert.match(mode, /^(?:shadow|production)$/u);
assert.ok(config.allowedModes.includes(mode), `release mode ${mode} is disabled by the reviewed repository config`);
console.log(`LENSO_RELEASE_MODE=${mode}`);
if (mode === "shadow") {
  const mappings = {
    LENSO_NPM_REGISTRY_URL: "LENSO_SHADOW_NPM_REGISTRY_URL",
    LENSO_CRATES_API_URL: "LENSO_SHADOW_CRATES_API_URL",
    LENSO_CRATES_UPLOAD_URL: "LENSO_SHADOW_CRATES_UPLOAD_URL",
    LENSO_GITHUB_API_URL: "LENSO_SHADOW_GITHUB_API_URL",
    LENSO_SHADOW_ATTESTATION_URL: "LENSO_SHADOW_ATTESTATION_URL",
  };
  for (const [target, source] of Object.entries(mappings)) {
    const value = process.env[source];
    assert.ok(value && value.startsWith("https://"), `${source} must be an HTTPS endpoint`);
    console.log(`${target}=${value}`);
  }
}
