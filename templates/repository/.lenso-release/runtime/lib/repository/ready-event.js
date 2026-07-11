#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assertReleasePlan } from "../contracts/validate.js";
import { sha256 } from "../core/canonical.js";
function required(name) { const value = process.env[name]; if (!value)
    throw new Error(`missing ${name}`); return value; }
const bytes = await readFile(".lenso-release/plan.json");
const plan = JSON.parse(bytes.toString("utf8"));
assertReleasePlan(plan);
const releaseCommit = required("GITHUB_SHA");
if (releaseCommit === plan.sourceCommit)
    throw new Error("ready event requires the reviewed merge commit");
const identity = {
    schema: "lenso.release-event.v1",
    eventType: "lenso-plan-ready",
    issuedAt: new Date().toISOString(), nonce: crypto.randomUUID(), sourceRepository: required("GITHUB_REPOSITORY"),
    expectedAppId: Number(required("APP_ID")), planId: plan.planId,
    planUrl: `https://raw.githubusercontent.com/${plan.repository}/${releaseCommit}/.lenso-release/plan.json`,
    planSha256: sha256(bytes), releaseCommit,
};
process.stdout.write(`${JSON.stringify({ ...identity, eventId: sha256(identity) })}\n`);
