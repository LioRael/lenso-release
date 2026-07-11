#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createPlan, createPreflightProof, publishSelected, type RuntimeEnvironment } from "./runtime.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function parsePackages(value: string): { id: string; version: string }[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("packages must be an array");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid package entry");
    const { id, version } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof version !== "string") throw new Error("invalid package entry");
    return { id, version };
  });
}

function environment(): RuntimeEnvironment { return {
  cwd: process.cwd(), repository: required("GITHUB_REPOSITORY"), releaseCommit: required("INPUT_RELEASE_COMMIT"),
  githubSha: required("GITHUB_SHA"), refName: required("GITHUB_REF_NAME"), workflowPath: ".github/workflows/publish.yml",
  runId: required("GITHUB_RUN_ID"), runUrl: `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}`,
  githubToken: required("LENSO_APP_TOKEN"), eventId: required("INPUT_EVENT_ID"), nonce: required("INPUT_NONCE"), planId: required("INPUT_PLAN_ID"),
  planSha256: required("INPUT_PLAN_SHA256"), packages: parsePackages(required("INPUT_PACKAGES_JSON")),
}; }
const command = process.argv[2];
if (command === "plan") {
  const plan = await createPlan(process.cwd(), required("GITHUB_REPOSITORY"), required("GITHUB_SHA"));
  process.stdout.write(`${plan.planId}\n`);
} else if (command === "preflight") {
  const proof = await createPreflightProof(environment()); process.stdout.write(`${proof.proofId}\n`);
} else if (command === "publish") {
  const receipts = await publishSelected(environment());
  process.stdout.write(`${JSON.stringify(receipts)}\n`);
} else {
  throw new Error("usage: runtime plan|preflight|publish");
}
