import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProvenanceExpectation = {
  artifactBytes: Uint8Array;
  subjectName: string;
  digest: string;
  repository: string;
  workflow: string;
  ref: string;
  sha: string;
  runId: string;
  githubToken: string;
};
export type ProvenanceVerifier = {
  verify(expectation: ProvenanceExpectation): Promise<{ name: string; digest: string } | null>;
};
type ExecFile = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

const execute: ExecFile = (file, args, options) => new Promise((resolve, reject) => {
  nodeExecFile(file, [...args], { shell: false, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: options.env }, (error, stdout) => {
    if (error) reject(new Error("official GitHub attestation verification failed", { cause: error }));
    else resolve({ stdout });
  });
});

export class GhAttestationVerifier implements ProvenanceVerifier {
  constructor(private readonly execFile: ExecFile = execute) {}
  async verify(expected: ProvenanceExpectation): Promise<{ name: string; digest: string } | null> {
    const directory = await mkdtemp(join(tmpdir(), "lenso-attestation-"));
    const artifact = join(directory, "artifact");
    try {
      const handle = await open(
        artifact,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try { await handle.writeFile(expected.artifactBytes); }
      finally { await handle.close(); }
      const { stdout } = await this.execFile("gh", [
        "attestation", "verify", artifact,
        "--repo", expected.repository,
        "--signer-workflow", `${expected.repository}/${expected.workflow}`,
        "--source-ref", `refs/heads/${expected.ref}`,
        "--source-digest", expected.sha,
        "--predicate-type", "https://slsa.dev/provenance/v1",
        "--format", "json",
      ], { env: { ...process.env, GH_TOKEN: expected.githubToken } });
      const entries = JSON.parse(stdout) as unknown;
      if (!Array.isArray(entries)) return null;
      for (const entry of entries) {
        const result = (entry as Record<string, unknown>).verificationResult as Record<string, unknown> | undefined;
        const statement = result?.statement as Record<string, unknown> | undefined;
        const subjects = Array.isArray(statement?.subject) ? statement.subject as Record<string, unknown>[] : [];
        const subject = subjects.find((item) =>
          item.name === expected.subjectName &&
          `sha256:${String((item.digest as Record<string, unknown> | undefined)?.sha256)}` === expected.digest,
        );
        const signature = result?.signature as Record<string, unknown> | undefined;
        const certificate = signature?.certificate;
        const timestamps = result?.verifiedTimestamps;
        if (certificate === null || typeof certificate !== "object" || Array.isArray(certificate)) continue;
        const identity = certificate as Record<string, unknown>;
        const sourceRef = `refs/heads/${expected.ref}`;
        if (
          statement?.predicateType === "https://slsa.dev/provenance/v1" &&
          subject &&
          Array.isArray(timestamps) && timestamps.length > 0 &&
          identity.sourceRepositoryURI === `https://github.com/${expected.repository}` &&
          identity.sourceRepositoryDigest === expected.sha &&
          identity.sourceRepositoryRef === sourceRef &&
          identity.buildSignerURI === `https://github.com/${expected.repository}/${expected.workflow}@${sourceRef}` &&
          identity.runInvocationURI === `https://github.com/${expected.repository}/actions/runs/${expected.runId}`
        ) return { name: expected.subjectName, digest: expected.digest };
      }
      return null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
