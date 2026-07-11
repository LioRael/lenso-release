#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const config = JSON.parse(
  await readFile(new URL("../.lenso-release/config.json", import.meta.url), "utf-8")
);
const existingPlan = args.includes("--verify")
  ? JSON.parse(await readFile(new URL("../.lenso-release/plan.json", import.meta.url), "utf-8"))
  : undefined;
process.env.GITHUB_REPOSITORY = option("--repository") ?? process.env.GITHUB_REPOSITORY ?? config.repository;
process.env.GITHUB_SHA = existingPlan?.sourceCommit ?? option("--source-commit") ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
process.argv = [process.argv[0], process.argv[1], "plan"];
try {
  await import("../.lenso-release/runtime/lib/repository/cli.js");
} catch (error) {
  if (args.includes("--check-intent") && String(error).includes("draft contains no release changes")) {
    process.exit(0);
  }
  throw error;
}
