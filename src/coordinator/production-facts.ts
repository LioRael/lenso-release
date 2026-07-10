import type {
  ComponentReceiptV1,
  ReleaseEventV1,
  ReleasePlanV1,
} from "../contracts/types.js";
import { loadComponents } from "../config/components.js";
import { sha256 } from "../core/canonical.js";
import { canonicalBytes } from "../core/canonical.js";
import { acceptReadyEvent } from "./ready.js";
import { acceptReceiptEvent, recoverLostReceipt, type ReceiptDependencies, type ReceiptObservation, type ReceiptObservationContext } from "./receipt.js";
import {
  runDispatchOutbox,
  type AppTokenProvider,
  type WorkflowDispatcher,
} from "./dispatch.js";
import type { GitStateStore, StoredPlanState } from "./state.js";

type Input = {
  config: { appId: number; actor: string };
  env: NodeJS.ProcessEnv;
  store: GitStateStore;
  tokens: AppTokenProvider;
  dispatcher: WorkflowDispatcher;
  request?: typeof fetch;
};
const headers = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
});
const EXTERNAL_HOSTS = new Set(["crates.io", "static.crates.io", "registry.npmjs.org"]);
function assertGithubApi(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== "https://api.github.com")
    throw new TypeError("authenticated GitHub request must target api.github.com");
}
export async function checkedExternal(request: typeof fetch, url: string): Promise<Response> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (current.protocol !== "https:" || !EXTERNAL_HOSTS.has(current.hostname))
      throw new TypeError(`external observation host is not allowed: ${current.hostname}`);
    const response = await request(current, { redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("external redirect missing location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`external observation ${response.status} for ${current.origin}`);
    if (response.url) {
      const final = new URL(response.url);
      if (final.protocol !== "https:" || !EXTERNAL_HOSTS.has(final.hostname))
        throw new TypeError("external response escaped host allowlist");
    }
    return response;
  }
  throw new Error("external observation redirect limit exceeded");
}
function nonce() {
  return crypto.randomUUID();
}

export function tagRefIsImmutable(value: unknown, tagRef: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((raw) => {
    const ruleset = raw as Record<string, unknown>;
    if (ruleset.enforcement !== "active" || ruleset.target !== "tag") return false;
    const conditions = ruleset.conditions as Record<string, unknown> | undefined;
    const names = conditions?.ref_name as Record<string, unknown> | undefined;
    const includes = Array.isArray(names?.include) ? names.include.map(String) : [];
    const matches = includes.some((pattern) =>
      pattern === "~ALL" || pattern === "refs/tags/*" || pattern === tagRef,
    );
    const types = new Set((Array.isArray(ruleset.rules) ? ruleset.rules : []).map((rule) => String((rule as Record<string, unknown>).type)));
    return matches && types.has("deletion") && types.has("non_fast_forward");
  });
}

export function selectVerifiedProvenance(
  value: unknown,
  packedDigest: string,
  context: ReceiptObservationContext,
  runId: string,
): { name: string; digest: string } | null {
  const attestations = (value as Record<string, unknown>)?.attestations;
  if (!Array.isArray(attestations)) return null;
  for (const raw of attestations) {
    const attestation = raw as Record<string, unknown>;
    const verification = attestation.verificationResult as Record<string, unknown> | undefined;
    if (
      verification?.verified !== true ||
      verification.repository !== context.repository ||
      verification.workflow !== context.workflow ||
      verification.ref !== context.executionRef ||
      verification.sha !== context.releaseCommit ||
      String(verification.runId) !== runId
    ) continue;
    const bundle = attestation.bundle as Record<string, unknown> | undefined;
    const envelope = bundle?.dsseEnvelope as Record<string, unknown> | undefined;
    if (typeof envelope?.payload !== "string") continue;
    let statement: Record<string, unknown>;
    try { statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as Record<string, unknown>; } catch { continue; }
    if (!new Set(["https://slsa.dev/provenance/v1", "https://slsa.dev/provenance/v0.2", "https://github.com/Attestations/GitHubHostedActions@v1"]).has(String(statement.predicateType))) continue;
    const subjects = Array.isArray(statement.subject) ? statement.subject as Record<string, unknown>[] : [];
    const match = subjects.find((subject) => `sha256:${String((subject.digest as Record<string, unknown> | undefined)?.sha256)}` === packedDigest);
    if (match) return { name: String(match.name), digest: packedDigest };
  }
  return null;
}

export async function createCoordinatorHandlers(
  input: Input,
): Promise<{
  ready(value: unknown): Promise<StoredPlanState>;
  receipt(value: unknown): Promise<StoredPlanState>;
  recoverActive(): Promise<StoredPlanState[]>;
}> {
  const registry = await loadComponents(
    new URL("../../config/components.yaml", import.meta.url).pathname,
  );
  const planPath =
    input.env.LENSO_RELEASE_PLAN_PATH ?? ".lenso/release-plan.json";
  const bundlePath =
    input.env.LENSO_SHARED_BUNDLE_PATH ?? "publisher/bundle.json";
  const observedActor = input.env.LENSO_EVENT_ACTOR;
  if (!observedActor) throw new TypeError("LENSO_EVENT_ACTOR is required");
  const now = () => new Date();
  const request = input.request ?? fetch;
  const githubJson = async (url: string, token: string): Promise<Record<string, unknown>> => {
    assertGithubApi(url);
    const response = await request(url, { redirect: "error", headers: headers(token) });
    if (!response.ok) throw new Error(`GitHub observation ${response.status}`);
    if (response.url && new URL(response.url).origin !== "https://api.github.com")
      throw new TypeError("GitHub API response origin mismatch");
    return await response.json() as Record<string, unknown>;
  };
  const githubBytes = async (repository: string, path: string, ref: string, token: string): Promise<Uint8Array> => {
    const body = await githubJson(`https://api.github.com/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, token);
    if (body.encoding !== "base64" || typeof body.content !== "string") throw new TypeError("GitHub content encoding invalid");
    return Buffer.from(body.content.replace(/\n/gu, ""), "base64");
  };
  const handlers: {
    ready(value: unknown): Promise<StoredPlanState>;
    receipt(value: unknown): Promise<StoredPlanState>;
    recoverActive(): Promise<StoredPlanState[]>;
  } = {
    async ready(value) {
      const event = value as Extract<
        ReleaseEventV1,
        { eventType: "lenso-plan-ready" }
      >;
      const sourceToken = await input.tokens.tokenFor(event.sourceRepository, { contents: "write", administration: "write", metadata: "read" });
      const api = `https://api.github.com/repos/${event.sourceRepository}`;
      const github = {
        async readAtReleaseCommit() {
          const planBytes = await githubBytes(event.sourceRepository, planPath, event.releaseCommit, sourceToken);
          const plan = JSON.parse(
            Buffer.from(planBytes).toString("utf8"),
          ) as ReleasePlanV1;
          const source = await githubJson(
            `${api}/commits/${plan.sourceCommit}`,
            sourceToken,
          );
          const release = await githubJson(
            `${api}/commits/${event.releaseCommit}`,
            sourceToken,
          );
          const compare = await githubJson(
            `${api}/compare/${plan.sourceCommit}...${event.releaseCommit}`,
            sourceToken,
          );
          const workflowBytes = await githubBytes(event.sourceRepository, plan.publisher.workflow, event.releaseCommit, sourceToken);
          const coordinatorToken = await input.tokens.tokenFor("LioRael/lenso-release", { contents: "read", metadata: "read" });
          const bundleBytes = await githubBytes("LioRael/lenso-release", bundlePath, plan.publisher.sharedRevision, coordinatorToken);
          let generatedFilesValid = true;
          for (const file of plan.generatedFiles) {
            const bytes = await githubBytes(event.sourceRepository, file.path, event.releaseCommit, sourceToken);
            if (sha256(bytes) !== file.sha256) generatedFilesValid = false;
          }
          let externalDependenciesVisible = true;
          const selectedIds = new Set(plan.packages.map(({ id }) => id));
          for (const pkg of plan.packages)
            for (const dep of pkg.dependencies)
              if (!selectedIds.has(dep.id)) {
                const url = dep.id.startsWith("cargo:")
                  ? `https://crates.io/api/v1/crates/${dep.id.slice(6)}/${dep.resolvedVersion}`
                  : `https://registry.npmjs.org/${encodeURIComponent(dep.id.slice(4))}/${dep.resolvedVersion}`;
                try { await checkedExternal(request, url); } catch { externalDependenciesVisible = false; }
              }
          const branch = await githubJson(
            `${api}/branches/${encodeURIComponent(input.env.LENSO_SOURCE_BRANCH ?? "main")}/protection`,
            sourceToken,
          );
          return {
            actor: observedActor,
            appId: input.config.appId,
            planBytes,
            plan,
            planSha256: sha256(planBytes),
            sourceCommitRepository: event.sourceRepository,
            releaseCommitRepository: event.sourceRepository,
            releaseCommitContainsSourceCommit: compare.status === "ahead",
            workflowSha256: sha256(workflowBytes),
            sharedRevision: plan.publisher.sharedRevision,
            sharedBundleSha256: sha256(bundleBytes),
            runner: plan.publisher.runner,
            node: plan.publisher.node,
            npm: plan.publisher.npm,
            rust: plan.publisher.rust,
            branchProtected: Object.keys(branch).length > 0,
            generatedFilesValid,
            externalDependenciesVisible,
            source,
            release,
          };
        },
        async ensureExecutionRef(
          repository: string,
          ref: string,
          commit: string,
        ) {
          const encoded = encodeURIComponent(`heads/${ref}`);
          const refResponse = await request(`${api}/git/ref/${encoded}`, {
            redirect: "error",
            headers: headers(sourceToken),
          });
          if (refResponse.status !== 200 && refResponse.status !== 404)
            throw new Error(`execution ref observation ${refResponse.status}`);
          if (refResponse.status === 404) {
            const created = await request(`${api}/git/refs`, {
              method: "POST",
              redirect: "error",
              headers: headers(sourceToken),
              body: JSON.stringify({ ref: `refs/heads/${ref}`, sha: commit }),
            });
            if (!created.ok && created.status !== 422)
              throw new Error(`execution ref creation ${created.status}`);
          }
          const observed = await githubJson(
            `${api}/git/ref/${encoded}`,
            sourceToken,
          );
          const tip = String((observed.object as Record<string, unknown>).sha);
          const protectedResponse = await request(`${api}/branches/${encodeURIComponent(ref)}/protection`, {
            method: "PUT",
            redirect: "error",
            headers: headers(sourceToken),
            body: JSON.stringify({
              required_status_checks: null,
              enforce_admins: true,
              required_pull_request_reviews: null,
              restrictions: { users: [], teams: [], apps: [] },
              allow_force_pushes: false,
              allow_deletions: false,
            }),
          });
          if (!protectedResponse.ok)
            throw new Error(`execution ref protection ${protectedResponse.status}`);
          return { tip, protected: true };
        },
      };
      const result = await acceptReadyEvent(value, {
        store: input.store,
        github,
        registry,
        now,
        nonce,
        appId: input.config.appId,
        expectedActor: input.config.actor,
      });
      return runDispatchOutbox(
        input.store,
        result.state.repository,
        result.state.planId,
        input.dispatcher,
        input.tokens,
        now,
      );
    },
    async receipt(value) {
      const event = value as Extract<
        ReleaseEventV1,
        { eventType: "lenso-publish-receipt" }
      >;
      const expected = event.receipt;
      let tagWrite: { githubApi: string; token: string; tagName: string; immutable: boolean } | null = null;
      const observer = {
        async observe(context: ReceiptObservationContext, packageId: string, packageVersion: string): Promise<ReceiptObservation | null> {
          if (!context.packages.some(({ id, version }) => id === packageId && version === packageVersion)) throw new Error("package is not selected by stored outbox");
          const repository = context.repository;
          const token = await input.tokens.tokenFor(repository, { contents: "write", actions: "read", attestations: "read", metadata: "read" });
          const githubApi = `https://api.github.com/repos/${repository}`;
          const packageName = packageId.startsWith("cargo:") ? packageId.slice(6) : packageId.slice("npm:@lenso/".length);
          const tagName = `${packageName}@${packageVersion}`;
          const expectedTagUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tagName)}`;
          let packedBytes: Uint8Array;
          let nativeIntegrity: string;
          let registryUrl: string;
          let publishedAt: string;
          if (packageId.startsWith("cargo:")) {
            const metadataUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}`;
            const metadata = await (await checkedExternal(request, metadataUrl)).json() as Record<string, unknown>;
            const version = metadata.version as Record<string, unknown>;
            const artifact = await checkedExternal(request, `https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}/download`);
            packedBytes = new Uint8Array(await artifact.arrayBuffer());
            nativeIntegrity = String(version.checksum);
            publishedAt = String(version.created_at);
            registryUrl = artifact.url || `https://static.crates.io/crates/${packageName}/${packageName}-${packageVersion}.crate`;
          } else {
            const name = `@lenso/${packageName}`;
            const packumentUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
            const packument = await (await checkedExternal(request, packumentUrl)).json() as Record<string, unknown>;
            const versions = packument.versions as Record<string, Record<string, unknown>>;
            const metadata = versions[packageVersion];
            if (!metadata) return null;
            const dist = metadata.dist as Record<string, unknown>;
            const tarball = String(dist.tarball);
            const artifact = await checkedExternal(request, tarball);
            packedBytes = new Uint8Array(await artifact.arrayBuffer());
            nativeIntegrity = String(dist.integrity);
            publishedAt = String((packument.time as Record<string, unknown>)[packageVersion]);
            registryUrl = tarball;
          }
          const packedDigest = sha256(packedBytes);
          const provenanceApi = `${githubApi}/attestations/${encodeURIComponent(packedDigest)}`;
          const provenance = await githubJson(provenanceApi, token);
          const workflowRuns = await githubJson(`${githubApi}/actions/workflows/${encodeURIComponent(context.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(context.executionRef)}&per_page=100`, token);
          const runs = Array.isArray(workflowRuns.workflow_runs) ? workflowRuns.workflow_runs as Record<string, unknown>[] : [];
          const workflow = runs.find((run) => run.display_title === `lenso-publish-requested:${context.eventId}` && run.head_branch === context.executionRef && run.head_sha === context.releaseCommit);
          if (!workflow || workflow.status !== "completed" || workflow.conclusion !== "success") return null;
          const runId = String(workflow.id);
          const runUrl = String(workflow.html_url);
          if (runUrl !== `https://github.com/${repository}/actions/runs/${runId}`) return null;
          const subject = selectVerifiedProvenance(provenance, packedDigest, context, runId);
          if (!subject) return null;
          const rulesets = await githubJson(`${githubApi}/rulesets?includes_parents=true`, token);
          const immutable = tagRefIsImmutable(rulesets, `refs/tags/${tagName}`);
          tagWrite = { githubApi, token, tagName, immutable };
          const refResponse = await request(`${githubApi}/git/ref/tags/${encodeURIComponent(tagName)}`, { redirect: "error", headers: headers(token) });
          let tagReceipt: unknown | null = null;
          let annotated = false;
          let targetSha: string | null = null;
          if (refResponse.ok) {
            const ref = await refResponse.json() as Record<string, unknown>;
            const object = ref.object as Record<string, unknown>;
            if (object.type !== "tag") throw new Error("component tag is not annotated");
            const tag = await githubJson(`${githubApi}/git/tags/${String(object.sha)}`, token);
            annotated = true;
            targetSha = String((tag.object as Record<string, unknown>).sha);
            tagReceipt = JSON.parse(String(tag.message));
          } else if (refResponse.status !== 404) {
            throw new Error(`tag observation ${refResponse.status}`);
          }
          return {
            registry: {
              packedBytes,
              nativeIntegrity,
              url: registryUrl,
              publishedAt,
            },
            provenance: {
              url: `https://github.com/${repository}/attestations/${packedDigest.slice("sha256:".length)}`,
              subject,
            },
            workflow: {
              url: runUrl,
              repository: String((workflow.repository as Record<string, unknown>).full_name),
              ref: String(workflow.head_branch),
              sha: String(workflow.head_sha),
              runName: String(workflow.display_title),
              workflowPath: context.workflow,
            },
            tag: {
              url: expectedTagUrl,
              annotated,
              immutable,
              targetSha,
              receipt: tagReceipt,
            },
          };
        },
        async createAnnotatedTag(_repository: string, receipt: ComponentReceiptV1) {
          if (!tagWrite || !tagWrite.immutable) throw new Error("package tag protection is not active");
          const { githubApi, token, tagName } = tagWrite;
          const tagResponse = await request(`${githubApi}/git/tags`, {
            method: "POST",
            redirect: "error",
            headers: headers(token),
            body: JSON.stringify({
              tag: tagName,
              message: canonicalBytes(receipt as never).toString("utf8"),
              object: receipt.sourceCommit,
              type: "commit",
              tagger: {
                name: "Lenso Release App",
                email: "release@lenso.dev",
                date: receipt.publishedAt,
              },
            }),
          });
          if (!tagResponse.ok) throw new Error(`annotated tag creation ${tagResponse.status}`);
          const tag = await tagResponse.json() as Record<string, unknown>;
          const refResponse = await request(`${githubApi}/git/refs`, {
            method: "POST",
            redirect: "error",
            headers: headers(token),
            body: JSON.stringify({ ref: `refs/tags/${tagName}`, sha: tag.sha }),
          });
          if (!refResponse.ok && refResponse.status !== 422)
            throw new Error(`annotated tag ref creation ${refResponse.status}`);
        },
      };
      const receiptDependencies: ReceiptDependencies = {
        store: input.store,
        observer,
        authenticate: async () => ({
          actor: observedActor,
          appId: input.config.appId,
        }),
        expectedActor: input.config.actor,
        readPlan: async (repository, commit) => {
          const planBytes = await githubBytes(repository, planPath, commit, await input.tokens.tokenFor(repository, { contents: "read", metadata: "read" }));
          return {
            plan: JSON.parse(Buffer.from(planBytes).toString("utf8")),
            planBytes,
          };
        },
        dependenciesVisible: async (plan, packageIds) => {
          const selected = new Set(plan.packages.map(({ id }) => id));
          for (const packageId of packageIds) {
            const pkg = plan.packages.find(({ id }) => id === packageId);
            if (!pkg) return false;
            for (const dep of pkg.dependencies) {
              const version = dep.resolvedVersion;
              const url = dep.id.startsWith("cargo:")
                ? `https://crates.io/api/v1/crates/${encodeURIComponent(dep.id.slice(6))}/${encodeURIComponent(version)}`
                : `https://registry.npmjs.org/${encodeURIComponent(dep.id.slice(4))}/${encodeURIComponent(version)}`;
              if (!selected.has(dep.id) || dep.source === "plan") {
                try { await checkedExternal(request, url); } catch { return false; }
              }
            }
          }
          return true;
        },
        now,
        nonce,
        appId: input.config.appId,
      };
      const recoveryOnly = event.eventId === `sha256:${"0".repeat(64)}`;
      let result: StoredPlanState | null = null;
      if (!recoveryOnly) {
        try {
          result = await acceptReceiptEvent(value, receiptDependencies);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "receipt tag evidence incomplete") throw error;
        }
      }
      result ??= await recoverLostReceipt(
        expected.repository,
        expected.planId,
        expected.packageId,
        expected.version,
        receiptDependencies,
      );
      if (!result) throw new Error("authoritative receipt evidence incomplete");
      return runDispatchOutbox(
        input.store,
        result.state.repository,
        result.state.planId,
        input.dispatcher,
        input.tokens,
        now,
      );
    },
    async recoverActive() {
      const snapshot = await input.store.readSnapshot();
      const recovered: StoredPlanState[] = [];
      for (const state of Object.values(snapshot.plans)) {
        if (state.status !== "publishing" && !(state.status === "blocked" && state.reason === "dispatch outcome unknown")) continue;
        for (const pkg of state.packages) {
          if (pkg.status !== "dispatched") continue;
          const zero = `sha256:${"0".repeat(64)}` as const;
          const result = await handlers.receipt({
            schema: "lenso.release-event.v1",
            eventType: "lenso-publish-receipt",
            eventId: zero,
            issuedAt: now().toISOString(),
            nonce: nonce(),
            sourceRepository: state.repository,
            expectedAppId: input.config.appId,
            planId: state.planId,
            planUrl: `https://github.com/${state.repository}`,
            planSha256: state.planSha256,
            releaseCommit: state.releaseCommit,
            correlationId: pkg.requestEventId,
            receipt: {
              schema: "lenso.component-receipt.v1",
              receiptId: zero,
              planId: state.planId,
              packageId: pkg.id,
              version: pkg.version,
              repository: state.repository,
              sourceCommit: state.releaseCommit,
              packedSha256: zero,
              registryIntegrity: pkg.id.startsWith("cargo:") ? "0".repeat(64) : `sha512-${Buffer.alloc(64).toString("base64")}`,
              registryUrl: "https://registry.invalid/recovery",
              provenanceUrl: "https://github.com/recovery",
              provenanceSubject: { name: "recovery", digest: zero },
              workflowUrl: `https://github.com/${state.repository}/actions/runs/1`,
              tagUrl: `https://github.com/${state.repository}/releases/tag/recovery`,
              publishedAt: now().toISOString(),
            },
          });
          recovered.push(result);
        }
      }
      return recovered;
    },
  };
  return handlers;
}
