import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import {
  GithubAppTokenProvider,
  GithubSnapshotStore,
  GithubWorkflowDispatcher,
  parseCoordinatorEnvironment,
} from "../../src/coordinator/github-adapters.js";
import { activeRulesetDetails, checkedExternal, checkedGithubAsset, checkedGithubJson, checkedShadowGithubAsset, checkedShadowGithubJson, coordinatorEnvironment, executionRefProtectionIsImmutable, npmPackumentContainsVersion, productionDependencyUrl, tagRefIsImmutable, trustedFailedRecoveryRun, trustedProductionBreakGlassRun, trustedProductionOciAbsenceRun, trustedProductionPrepublishFailureRun, trustedProductionZeroWriteFailureRun, trustedRecoveryProvenanceRun, trustedRecoveryRun, trustedShadowReceiptRecoveryRun, verifiedProvenanceUrl } from "../../src/coordinator/production-facts.js";
import { GhAttestationVerifier } from "../../src/coordinator/provenance-verifier.js";
import {
  StateConflictError,
  transact,
  type GitStateStore,
  type ReleaseStateSnapshot,
} from "../../src/coordinator/state.js";

describe("production coordinator adapters", () => {
  it("accepts only explicit coordinator environments", () => {
    expect(coordinatorEnvironment("shadow")).toBe("shadow");
    expect(coordinatorEnvironment("production")).toBe("production");
    expect(() => coordinatorEnvironment(undefined)).toThrow("must be shadow or production");
    expect(() => coordinatorEnvironment("staging")).toThrow("must be shadow or production");
  });

  it("identifies a failed GitHub observation without exposing its query", async () => {
    const request = vi.fn(async () => new Response("missing", { status: 404 }));
    await expect(checkedGithubJson(
      request as typeof fetch,
      "https://api.github.com/repos/LioRael/lenso-console/branches/main?token=secret",
      "app-token",
    )).rejects.toThrow(
      "GitHub observation 404 for /repos/LioRael/lenso-console/branches/main",
    );
  });

  it("observes Cargo dependencies through the official crates.io download API", () => {
    expect(productionDependencyUrl("cargo:lenso-module-auth", "0.1.8")).toBe(
      "https://crates.io/api/v1/crates/lenso-module-auth/0.1.8/download",
    );
  });

  it("preserves a verified immutable tag attestation record URL", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const subject = { name: "lenso-1.0.0.crate", digest };
    const recordUrl = "https://github.com/LioRael/lenso/attestations/38141732";
    expect(verifiedProvenanceUrl("LioRael/lenso", digest, subject, {
      repository: "LioRael/lenso",
      packedSha256: digest,
      provenanceSubject: subject,
      provenanceUrl: recordUrl,
    })).toBe(recordUrl);
    expect(verifiedProvenanceUrl("LioRael/lenso", digest, subject, {
      repository: "LioRael/lenso",
      packedSha256: digest,
      provenanceSubject: subject,
      provenanceUrl: "https://example.com/untrusted",
    })).toBe(`https://github.com/LioRael/lenso/attestations/${digest.slice(7)}`);
    expect(verifiedProvenanceUrl("LioRael/lenso", digest, subject, {
      schema: "lenso.fixed-group-receipt.v1",
      receipts: [
        { repository: "LioRael/lenso", packedSha256: `sha256:${"b".repeat(64)}`, provenanceSubject: { name: "other.tgz", digest: `sha256:${"b".repeat(64)}` }, provenanceUrl: "https://github.com/LioRael/lenso/attestations/1" },
        { repository: "LioRael/lenso", packedSha256: digest, provenanceSubject: subject, provenanceUrl: recordUrl },
      ],
    })).toBe(recordUrl);
  });

  it("identifies allowlisted external observations across crates.io redirects", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("user-agent")).toBe("lenso-release-coordinator/1.0");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      if (new URL(String(input)).hostname === "crates.io") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://static.crates.io/crates/lenso/lenso-0.1.0.crate" },
        });
      }
      return new Response("crate");
    });
    await expect(checkedExternal(
      request as typeof fetch,
      "https://crates.io/api/v1/crates/lenso/0.1.0/download",
    )).resolves.toHaveProperty("status", 200);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when npm absence cannot be proven from a valid packument", () => {
    expect(npmPackumentContainsVersion({ versions: { "1.0.0": {} } }, "1.0.0")).toBe(true);
    expect(npmPackumentContainsVersion({ versions: {} }, "1.0.0")).toBe(false);
    for (const malformed of [{}, { versions: null }, { versions: [] }, null])
      expect(() => npmPackumentContainsVersion(malformed, "1.0.0")).toThrow("packument");
  });
  it("accepts only immutable execution-ref branch protection", () => {
    const exact = {
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    };
    expect(executionRefProtectionIsImmutable(exact)).toBe(true);
    expect(executionRefProtectionIsImmutable({ ...exact, allow_deletions: { enabled: true } })).toBe(false);
    expect(executionRefProtectionIsImmutable({ ...exact, enforce_admins: null })).toBe(false);
  });
  it("accepts only successful reviewed recovery jobs from protected main history", () => {
    const sha = "2".repeat(40);
    const eventId = `sha256:${"a".repeat(64)}`;
    const run = {
      id: 42,
      event: "workflow_dispatch",
      display_title: `lenso-publish-requested:${eventId}`,
      head_branch: "main",
      head_sha: sha,
      repository: { full_name: "LioRael/lenso" },
      status: "completed",
      conclusion: "success",
    };
    const jobs = [
      { name: "recover", status: "completed", conclusion: "success" },
      { name: "publish", status: "completed", conclusion: "skipped" },
    ];
    const comparison = {
      status: "ahead",
      base_commit: { sha },
      merge_base_commit: { sha },
    };
    expect(trustedRecoveryRun(run, jobs, comparison, "LioRael/lenso", "main", eventId)).toBe(true);
    expect(trustedRecoveryRun(run, [
      { name: "recover", status: "completed", conclusion: "skipped" },
      { name: "recover-partial", status: "completed", conclusion: "success" },
      jobs[1]!,
    ], comparison, "LioRael/lenso", "main", eventId)).toBe(true);
    expect(trustedRecoveryRun(run, [
      jobs[0]!,
      { name: "recover-partial", status: "completed", conclusion: "success" },
      jobs[1]!,
    ], comparison, "LioRael/lenso", "main", eventId)).toBe(false);
    expect(trustedRecoveryProvenanceRun(run, jobs, comparison, "LioRael/lenso", "main")).toBe(true);
    expect(trustedRecoveryProvenanceRun({ ...run, display_title: "unbound-recovery" }, jobs, comparison, "LioRael/lenso", "main")).toBe(false);
    expect(trustedRecoveryRun(run, [{ ...jobs[0], conclusion: "failure" }, jobs[1]!], comparison, "LioRael/lenso", "main", eventId)).toBe(false);
    expect(trustedRecoveryRun(run, jobs, { ...comparison, status: "diverged" }, "LioRael/lenso", "main", eventId)).toBe(false);
    expect(trustedRecoveryRun({ ...run, head_branch: "unreviewed" }, jobs, comparison, "LioRael/lenso", "main", eventId)).toBe(false);
  });
  it("accepts only the exact failed shadow run when a receipt tag drives recovery", () => {
    const eventId = `sha256:${"a".repeat(64)}`;
    const releaseCommit = "2".repeat(40);
    const runUrl = "https://github.com/LioRael/lenso/actions/runs/42";
    const run = {
      event: "workflow_dispatch",
      path: ".github/workflows/publish.yml",
      display_title: `lenso-publish-requested:${eventId}`,
      head_branch: `release-execution/${"b".repeat(64)}`,
      head_sha: releaseCommit,
      repository: { full_name: "LioRael/lenso" },
      status: "completed",
      conclusion: "failure",
      html_url: runUrl,
    };
    const args = [
      "LioRael/lenso",
      ".github/workflows/publish.yml",
      run.head_branch,
      releaseCommit,
      eventId,
      runUrl,
    ] as const;
    expect(trustedShadowReceiptRecoveryRun(run, ...args)).toBe(true);
    expect(trustedShadowReceiptRecoveryRun({ ...run, conclusion: "success" }, ...args)).toBe(false);
    expect(trustedShadowReceiptRecoveryRun({ ...run, html_url: `${runUrl}0` }, ...args)).toBe(false);
    expect(trustedShadowReceiptRecoveryRun({ ...run, head_sha: "3".repeat(40) }, ...args)).toBe(false);
  });
  it("trusts only an exact successful production OCI absence proof", () => {
    const planId = `sha256:${"a".repeat(64)}`;
    const head = "2".repeat(40);
    const run = {
      event: "workflow_dispatch", head_branch: "main", head_sha: head,
      display_title: `verify-production-oci-absence:${planId}:oci:lenso-console-service@0.1.4`,
      status: "completed", conclusion: "success", repository: { full_name: "LioRael/lenso-console" },
    };
    const workflow = { path: ".github/workflows/verify-production-oci-absence.yml" };
    const jobs = [{ name: "verify", conclusion: "success", steps: [{ name: "Prove the production manifest is absent", conclusion: "success" }] }];
    expect(trustedProductionOciAbsenceRun(run, workflow, jobs, "LioRael/lenso-console", "main", head, planId, "oci:lenso-console-service", "0.1.4")).toBe(true);
    expect(trustedProductionOciAbsenceRun({ ...run, head_sha: "3".repeat(40) }, workflow, jobs, "LioRael/lenso-console", "main", head, planId, "oci:lenso-console-service", "0.1.4")).toBe(false);
    expect(trustedProductionOciAbsenceRun(run, workflow, [{ ...jobs[0], steps: [] }], "LioRael/lenso-console", "main", head, planId, "oci:lenso-console-service", "0.1.4")).toBe(false);
  });
  it("trusts only an exact successful production prepublish failure proof", () => {
    const planId = `sha256:${"a".repeat(64)}`;
    const head = "2".repeat(40);
    const failedRunId = "30693169936";
    const run = {
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: head,
      display_title:
        `verify-production-prepublish-failure:${planId}:${failedRunId}`,
      status: "completed",
      conclusion: "success",
      repository: { full_name: "LioRael/lenso-console" },
    };
    const workflow = {
      path: ".github/workflows/verify-production-prepublish-failure.yml",
    };
    const steps = [
      "Verify failed publisher stopped before preflight and registry access",
      "Prove the production npm version is absent",
      "Prove the production OCI manifest is absent",
    ].map((name) => ({ name, conclusion: "success" }));
    const jobs = [{ name: "verify", conclusion: "success", steps }];
    expect(
      trustedProductionPrepublishFailureRun(
        run,
        workflow,
        jobs,
        "LioRael/lenso-console",
        "main",
        head,
        planId,
        failedRunId,
      ),
    ).toBe(true);
    expect(
      trustedProductionPrepublishFailureRun(
        run,
        workflow,
        [{ ...jobs[0], steps: steps.slice(1) }],
        "LioRael/lenso-console",
        "main",
        head,
        planId,
        failedRunId,
      ),
    ).toBe(false);
  });
  it("trusts only an exact successful production zero-write failure proof", () => {
    const planId = `sha256:${"a".repeat(64)}`;
    const head = "2".repeat(40);
    const failedRunId = "30696779531";
    const run = {
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: head,
      display_title:
        `verify-production-zero-write-failure:${planId}:${failedRunId}`,
      status: "completed",
      conclusion: "success",
      repository: { full_name: "LioRael/lenso-console" },
    };
    const workflow = {
      path: ".github/workflows/verify-production-zero-write-failure.yml",
    };
    const steps = [
      "Verify proof consumption and npm authentication failure",
      "Prove the production npm version is absent",
      "Prove the production OCI manifest is absent",
    ].map((name) => ({ name, conclusion: "success" }));
    const jobs = [{ name: "verify", conclusion: "success", steps }];
    expect(
      trustedProductionZeroWriteFailureRun(
        run,
        workflow,
        jobs,
        "LioRael/lenso-console",
        "main",
        head,
        planId,
        failedRunId,
      ),
    ).toBe(true);
    expect(
      trustedProductionZeroWriteFailureRun(
        run,
        workflow,
        [{ ...jobs[0], steps: steps.slice(1) }],
        "LioRael/lenso-console",
        "main",
        head,
        planId,
        failedRunId,
      ),
    ).toBe(false);
  });
  it("retries only an exact conclusively failed recovery run", () => {
    const sha = "2".repeat(40);
    const eventId = `sha256:${"a".repeat(64)}`;
    const run = {
      event: "workflow_dispatch",
      path: ".github/workflows/publish.yml",
      display_title: `lenso-publish-requested:${eventId}`,
      head_branch: "main",
      head_sha: sha,
      repository: { full_name: "LioRael/lenso" },
      status: "completed",
      conclusion: "failure",
    };
    const jobs = [
      { name: "recover", status: "completed", conclusion: "failure" },
      { name: "publish", status: "completed", conclusion: "skipped" },
    ];
    expect(trustedFailedRecoveryRun(
      run,
      jobs,
      "LioRael/lenso",
      ".github/workflows/publish.yml",
      "main",
      sha,
      eventId,
    )).toBe(true);
    expect(trustedFailedRecoveryRun(
      run,
      [
        { name: "recover", status: "completed", conclusion: "skipped" },
        { name: "recover-partial", status: "completed", conclusion: "failure" },
        jobs[1]!,
      ],
      "LioRael/lenso",
      ".github/workflows/publish.yml",
      "main",
      sha,
      eventId,
    )).toBe(true);
    expect(trustedFailedRecoveryRun(
      { ...run, conclusion: "cancelled" },
      jobs,
      "LioRael/lenso",
      ".github/workflows/publish.yml",
      "main",
      sha,
      eventId,
    )).toBe(false);
  });
  it("binds production break-glass evidence to the exact legacy release run", () => {
    const releaseCommit = "2".repeat(40);
    const executionRef = `release-execution/${"a".repeat(64)}`;
    const steps = [
      "Run release gate",
      "Run package publish preflight",
      "Build release package",
      "Publish Lenso crates to crates.io",
      "Publish GitHub Release",
    ].map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    }));
    const run = {
      event: "workflow_dispatch",
      name: "release",
      display_title: "release",
      path: ".github/workflows/release.yml",
      repository: { full_name: "LioRael/lenso" },
      head_branch: executionRef,
      head_sha: releaseCommit,
      status: "completed",
      conclusion: "success",
    };
    const jobs = [{
      name: "package",
      status: "completed",
      conclusion: "success",
      steps,
    }];
    expect(
      trustedProductionBreakGlassRun(
        run,
        jobs,
        "LioRael/lenso",
        executionRef,
        releaseCommit,
      ),
    ).toBe(true);
    expect(
      trustedProductionBreakGlassRun(
        run,
        [{ ...jobs[0], steps: steps.slice(1) }],
        "LioRael/lenso",
        executionRef,
        releaseCommit,
      ),
    ).toBe(false);
    expect(
      trustedProductionBreakGlassRun(
        { ...run, head_sha: "3".repeat(40) },
        jobs,
        "LioRael/lenso",
        executionRef,
        releaseCommit,
      ),
    ).toBe(false);
  });

  it("follows only trusted GitHub asset redirects without forwarding authorization", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/archive" } });
      }
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response("archive");
    });
    await expect(checkedGithubAsset(request as typeof fetch, "https://api.github.com/repos/LioRael/lenso-console/releases/assets/42", "secret")).resolves.toHaveProperty("status", 200);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(checkedGithubAsset(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/archive" } }), "https://api.github.com/repos/LioRael/lenso-console/releases/assets/42", "secret")).rejects.toThrow("not trusted");
  });

  it("observes shadow GitHub releases and assets only through the configured gateway", async () => {
    const gateway = "https://shadow.example/github";
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(input)).origin).toBe("https://shadow.example");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      return String(input).endsWith("/assets/42")
        ? new Response("archive")
        : Response.json({ draft: true });
    });
    await expect(checkedShadowGithubJson(
      request as typeof fetch,
      `${gateway}/repos/LioRael/lenso-console/releases/tags/v0.1.2`,
      gateway,
      "secret",
    )).resolves.toEqual({ draft: true });
    await expect(checkedShadowGithubAsset(
      request as typeof fetch,
      `${gateway}/assets/42`,
      gateway,
      "secret",
    )).resolves.toHaveProperty("status", 200);
    await expect(checkedShadowGithubAsset(
      request as typeof fetch,
      "https://api.github.com/repos/LioRael/lenso-console/releases/assets/42",
      gateway,
      "secret",
    )).rejects.toThrow("shadow GitHub request");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("requires active update-and-delete protection for the exact tag ref", () => {
    const protectedRules = [{
      target: "tag", enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    }];
    expect(tagRefIsImmutable(protectedRules, "refs/tags/core@1.0.0")).toBe(true);
    expect(tagRefIsImmutable([{ ...protectedRules[0], conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/core@1.0.0"] } } }], "refs/tags/core@1.0.0")).toBe(false);
    expect(tagRefIsImmutable([{ ...protectedRules[0], conditions: { ref_name: { include: ["refs/tags/core@1.0.0"], exclude: [] } } }], "refs/tags/core@1.0.0")).toBe(true);
    expect(tagRefIsImmutable([{ ...protectedRules[0], conditions: { ref_name: { include: ["refs/tags/other*"], exclude: [] } } }], "refs/tags/core@1.0.0")).toBe(false);
    expect(tagRefIsImmutable([{ ...protectedRules[0], conditions: { ref_name: { include: ["refs/tags/**/ambiguous"], exclude: [] } } }], "refs/tags/core@1.0.0")).toBe(false);
    expect(tagRefIsImmutable(protectedRules, "refs/tags/@lenso/pkg@1.0.0")).toBe(false);
    expect(tagRefIsImmutable([{ ...protectedRules[0], conditions: { ref_name: { include: ["refs/tags/**"], exclude: [] } } }], "refs/tags/@lenso/pkg@1.0.0")).toBe(true);
    expect(tagRefIsImmutable([{ ...protectedRules[0], conditions: { ref_name: { include: ["refs/tags/@lenso/*"], exclude: [] } } }], "refs/tags/@lenso/pkg@1.0.0")).toBe(true);
    expect(tagRefIsImmutable([{ ...protectedRules[0], conditions: { ref_name: { include: ["refs/tags/**"], exclude: ["refs/tags/@lenso/*"] } } }], "refs/tags/@lenso/pkg@1.0.0")).toBe(false);
    expect(tagRefIsImmutable([{ ...protectedRules[0], enforcement: "disabled" }], "refs/tags/core@1.0.0")).toBe(false);
    expect(tagRefIsImmutable([{ ...protectedRules[0], rules: [{ type: "deletion" }] }], "refs/tags/core@1.0.0")).toBe(false);
  });

  it("loads every active ruleset detail and fails closed on list/detail errors", async () => {
    const detail = vi.fn(async (id: number) => ({ id, target: "tag", enforcement: "active" }));
    await expect(activeRulesetDetails([{ id: 2, enforcement: "active" }, { id: 3, enforcement: "disabled" }, { id: 1, enforcement: "active" }], detail)).resolves.toEqual([
      { id: 2, target: "tag", enforcement: "active" },
      { id: 1, target: "tag", enforcement: "active" },
    ]);
    expect(detail).toHaveBeenCalledTimes(2);
    await expect(activeRulesetDetails({}, detail)).rejects.toThrow("list invalid");
    await expect(activeRulesetDetails([{ id: 4, enforcement: "active" }], async () => { throw new Error("ruleset detail 403"); })).rejects.toThrow("403");
  });

  it("invokes official attestation verification without a shell and requires exact identity", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const expected = { artifactBytes: Buffer.from("artifact"), subjectName: "core-1.0.0.crate", digest, repository: "LioRael/lenso", workflow: ".github/workflows/publish.yml", ref: `release-execution/${"b".repeat(64)}`, sha: "2".repeat(40), runId: "42", githubToken: "top-secret" };
    let invocation: { file: string; args: readonly string[] } | undefined;
    const sourceRef = `refs/heads/${expected.ref}`;
    const exactCertificate = { sourceRepositoryURI: `https://github.com/${expected.repository}`, sourceRepositoryDigest: expected.sha, sourceRepositoryRef: sourceRef, buildSignerURI: `https://github.com/${expected.repository}/${expected.workflow}@${sourceRef}`, runInvocationURI: `https://github.com/${expected.repository}/actions/runs/${expected.runId}` };
    const exact = { statement: { predicateType: "https://slsa.dev/provenance/v1", subject: [{ name: expected.subjectName, digest: { sha256: digest.slice(7) } }] }, signature: { certificate: exactCertificate }, verifiedTimestamps: [{ type: "tlog" }] };
    const verifier = new GhAttestationVerifier(async (file, args, options) => {
      invocation = { file, args };
      expect(options.env.GH_TOKEN).toBe("top-secret");
      return { stdout: JSON.stringify([{ verificationResult: exact }]) };
    });
    await expect(verifier.verify(expected)).resolves.toEqual({ name: expected.subjectName, digest });
    expect(invocation?.file).toBe("gh");
    expect(invocation?.args.slice(0, 2)).toEqual(["attestation", "verify"]);
    expect(invocation?.args).toContain("--signer-workflow");
    expect(invocation?.args).toContain("--source-ref");
    expect(invocation?.args).toContain("--source-digest");
    expect(JSON.stringify(invocation)).not.toMatch(/token|secret|shell/iu);
    const attempted = new GhAttestationVerifier(async () => ({ stdout: JSON.stringify([{
      verificationResult: {
        ...exact,
        signature: {
          certificate: {
            ...exactCertificate,
            runInvocationURI: `${exactCertificate.runInvocationURI}/attempts/1`,
          },
        },
      },
    }]) }));
    await expect(attempted.verify(expected)).resolves.toEqual({ name: expected.subjectName, digest });
    const historical = new GhAttestationVerifier(async (_file, args) => {
      expect(args).not.toContain("--source-ref");
      expect(args).not.toContain("--source-digest");
      return { stdout: JSON.stringify([{ verificationResult: exact }]) };
    });
    await expect(historical.verify({ ...expected, allowAnySource: true })).resolves.toEqual({
      name: expected.subjectName,
      digest,
      source: { ref: expected.ref, sha: expected.sha, runId: expected.runId },
    });
    const wrong = new GhAttestationVerifier(async () => ({ stdout: JSON.stringify([{ verificationResult: { ...exact, signature: { certificate: { ...exactCertificate, sourceRepositoryURI: `https://github.com/${expected.repository}-suffix`, runInvocationURI: `https://github.com/${expected.repository}/actions/runs/420` } } } }]) }));
    await expect(wrong.verify(expected)).resolves.toBeNull();
    for (const certificate of [
      { ...exactCertificate, buildSignerURI: `${exactCertificate.buildSignerURI}-suffix` },
      { ...exactCertificate, sourceRepositoryDigest: `${expected.sha}0` },
      { ...exactCertificate, sourceRepositoryRef: `${sourceRef}/extra` },
      { ...exactCertificate, runInvocationURI: `${exactCertificate.runInvocationURI}/attempts/0` },
      { ...exactCertificate, runInvocationURI: `${exactCertificate.runInvocationURI}/attempts/1/extra` },
      [exactCertificate],
      null,
    ]) {
      const verifier = new GhAttestationVerifier(async () => ({ stdout: JSON.stringify([{ verificationResult: { ...exact, signature: { certificate } } }]) }));
      await expect(verifier.verify(expected)).resolves.toBeNull();
    }
    const failed = new GhAttestationVerifier(async () => { throw new Error("verifier unavailable"); });
    await expect(failed.verify(expected)).rejects.toThrow("verifier unavailable");
  });
  it("rejects unapproved observation hosts and redirect escapes", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/steal" },
    }));
    await expect(checkedExternal(request as typeof fetch, "https://registry.npmjs.org/@lenso%2Fcore"))
      .rejects.toThrow("not allowed");
    expect(request).toHaveBeenCalledOnce();
    await expect(checkedExternal(request as typeof fetch, "https://attacker.example/steal"))
      .rejects.toThrow("not allowed");
  });

  it("matches only the exact stable workflow run-name and returns its real URL", async () => {
    const eventId = `sha256:${"a".repeat(64)}`;
    const context = { repository: "LioRael/lenso", workflow: ".github/workflows/publish.yml", ref: `release-execution/${"a".repeat(64)}`, sha: "2".repeat(40) };
    const request = vi.fn(async () => new Response(JSON.stringify({
      workflow_runs: [
        { id: 41, event: "workflow_dispatch", display_title: `lenso-publish-requested:${eventId}`, head_branch: "wrong", head_sha: context.sha, repository: { full_name: context.repository }, html_url: "https://github.com/LioRael/lenso/actions/runs/41" },
        { id: 40, event: "push", display_title: `lenso-publish-requested:${eventId}`, head_branch: context.ref, head_sha: context.sha, repository: { full_name: context.repository }, html_url: "https://github.com/LioRael/lenso/actions/runs/40" },
        { id: 39, event: "workflow_dispatch", display_title: `lenso-publish-requested:${eventId}`, head_branch: context.ref, head_sha: "3".repeat(40), repository: { full_name: "attacker/repo" }, html_url: "https://github.com/attacker/repo/actions/runs/39" },
        { id: 42, event: "workflow_dispatch", display_title: `lenso-publish-requested:${eventId}`, head_branch: context.ref, head_sha: context.sha, repository: { full_name: context.repository }, html_url: "https://github.com/LioRael/lenso/actions/runs/42", status: "completed", conclusion: "failure" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const run = await new GithubWorkflowDispatcher(request as typeof fetch)
      .findByEventId(context, eventId, "token");
    expect(run).toMatchObject({ ...context, runUrl: "https://github.com/LioRael/lenso/actions/runs/42", status: "completed", conclusion: "failure" });
    const [requestedUrl] = request.mock.calls[0] as unknown as [string];
    expect(String(requestedUrl)).toContain("actions/workflows/.github%2Fworkflows%2Fpublish.yml/runs");
  });

  it("polls through API visibility delay without fabricating or redispatching a run", async () => {
    const eventId = `sha256:${"b".repeat(64)}`;
    let reads = 0;
    let posts = 0;
    const waits: number[] = [];
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(null, { status: 204 });
      }
      reads++;
      return new Response(JSON.stringify({ workflow_runs: reads < 3 ? [] : [{
        id: 99,
        event: "workflow_dispatch",
        display_title: `lenso-publish-requested:${eventId}`,
        head_branch: `release-execution/${"b".repeat(64)}`,
        head_sha: "2".repeat(40),
        repository: { full_name: "LioRael/lenso" },
        html_url: "https://github.com/LioRael/lenso/actions/runs/99",
        status: "queued",
        conclusion: null,
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const run = await new GithubWorkflowDispatcher(
      request as typeof fetch,
      async (milliseconds) => { waits.push(milliseconds); },
    ).dispatch({
      repository: "LioRael/lenso",
      workflow: ".github/workflows/publish.yml",
      ref: `release-execution/${"b".repeat(64)}`,
      inputs: { event_id: eventId, plan_id: eventId, plan_sha256: eventId, release_commit: "2".repeat(40), packages_json: "[]", nonce: "nonce" },
    }, eventId, "token");
    expect(run.runUrl).toBe("https://github.com/LioRael/lenso/actions/runs/99");
    expect(posts).toBe(1);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("mints a token for only the requested repository and permissions", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ token: "short-lived" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = new GithubAppTokenProvider(1, key, 2, request as typeof fetch);
    await expect(provider.tokenFor("LioRael/lenso", { actions: "write" })).resolves.toBe("short-lived");
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/2/access_tokens");
    expect(JSON.parse(String(init.body))).toEqual({
      repositories: ["lenso"], permissions: { actions: "write" },
    });
  });

  it("reuses unexpired tokens for the same repository and permissions", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      token: "cached",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = new GithubAppTokenProvider(1, key, 2, request as typeof fetch);
    await expect(Promise.all([
      provider.tokenFor("LioRael/lenso", { metadata: "read", actions: "read" }),
      provider.tokenFor("LioRael/lenso", { actions: "read", metadata: "read" }),
    ])).resolves.toEqual(["cached", "cached"]);
    await expect(
      provider.tokenFor("LioRael/lenso", { actions: "write", metadata: "read" }),
    ).resolves.toBe("cached");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries rate-limited app token requests using the advised delay", async () => {
    const waits: number[] = [];
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 403,
        headers: { "content-type": "application/json", "retry-after": "3" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "recovered" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = new GithubAppTokenProvider(
      1,
      key,
      2,
      request as typeof fetch,
      async (milliseconds) => { waits.push(milliseconds); },
    );
    await expect(provider.tokenFor("LioRael/lenso", { actions: "read" })).resolves.toBe("recovered");
    expect(request).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([3_000]);
  });

  it("does not retry app token permission failures", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      message: "The permissions requested are not granted to this installation",
    }), { status: 403, headers: { "content-type": "application/json" } }));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = new GithubAppTokenProvider(1, key, 2, request as typeof fetch);
    await expect(provider.tokenFor("LioRael/lenso", { actions: "read" }))
      .rejects.toThrow("GitHub App token 403: The permissions requested are not granted to this installation");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not require or return a static coordinator token", () => {
    const parsed = parseCoordinatorEnvironment({
      GITHUB_REPOSITORY: "LioRael/lenso-release",
      LENSO_GITHUB_APP_ID: "1",
      LENSO_GITHUB_APP_INSTALLATION_ID: "2",
      LENSO_GITHUB_APP_PRIVATE_KEY: "private\\nkey",
      LENSO_GITHUB_APP_ACTOR: "lenso-release[bot]",
    });
    expect(parsed).not.toHaveProperty("token");
    expect(JSON.stringify(parsed)).not.toContain("LENSO_COORDINATOR_TOKEN");
  });

  it("retries only explicit CAS conflicts", async () => {
    const empty: ReleaseStateSnapshot = {
      headSha: "1".repeat(40), plans: {}, activeRepositories: {}, occupiedPackages: {},
    };
    let writes = 0;
    const operational = new Error("GitHub API 403 rate limited");
    const store: GitStateStore = {
      async readSnapshot() { return structuredClone(empty); },
      async compareAndSwap() { writes++; throw operational; },
    };
    await expect(transact(store, (snapshot) => snapshot)).rejects.toBe(operational);
    expect(writes).toBe(1);

    const conflicting: GitStateStore = {
      async readSnapshot() { return structuredClone(empty); },
      async compareAndSwap(_head, next) {
        writes++;
        if (writes < 4) throw new StateConflictError("conflict");
        return next;
      },
    };
    writes = 1;
    await transact(conflicting, (snapshot) => snapshot, 3);
    expect(writes).toBe(4);
  });

  it("materializes state indexes as Git tree files in one parented CAS commit", async () => {
    let treeBody: Record<string, unknown> | undefined;
    const response = (value: unknown, status = 200) => new Response(
      value === null ? null : JSON.stringify(value),
      { status, headers: { "content-type": "application/json" } },
    );
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/git/ref/heads/release-state")) return response({ object: { sha: "1".repeat(40) } });
      if (url.endsWith(`/git/commits/${"1".repeat(40)}`)) return response({ tree: { sha: "a".repeat(40) } });
      if (url.includes(`/git/trees/${"a".repeat(40)}?recursive=1`)) return response({ tree: [
        { path: "indexes/active-repositories.json", type: "blob", sha: "b".repeat(40) },
        { path: "indexes/occupied-packages.json", type: "blob", sha: "c".repeat(40) },
      ] });
      if (init?.method === "POST" && url.endsWith("/git/blobs")) return response({ sha: "d".repeat(40) }, 201);
      if (init?.method === "POST" && url.endsWith("/git/trees")) {
        treeBody = JSON.parse(String(init.body));
        return response({ sha: "e".repeat(40) }, 201);
      }
      if (init?.method === "POST" && url.endsWith("/git/commits")) return response({ sha: "2".repeat(40) }, 201);
      if (init?.method === "PATCH" && url.endsWith("/git/refs/heads/release-state")) return response({}, 200);
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    const store = new GithubSnapshotStore(
      "LioRael/lenso-release",
      { async tokenFor() { return "scoped"; } },
      request as typeof fetch,
    );
    const next = { headSha: "1".repeat(40), plans: {}, activeRepositories: {}, occupiedPackages: {} };
    const committed = await store.compareAndSwap(next.headSha, next);
    expect(committed.headSha).toBe("2".repeat(40));
    expect(treeBody).toMatchObject({ base_tree: "a".repeat(40) });
    expect((treeBody!.tree as { path: string }[]).map(({ path }) => path).sort()).toEqual([
      "indexes/active-repositories.json",
      "indexes/occupied-packages.json",
    ]);
    expect(JSON.stringify(treeBody)).not.toContain("release-state.json");
  });
});
