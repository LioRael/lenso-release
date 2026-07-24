import type {
  ComponentReceiptV1,
  PlanStatePackage,
  PlanStateV1,
  ReleaseEventV1,
  ReleasePlanV1,
} from "../contracts/types.js";
import { loadComponents } from "../config/components.js";
import { sha256 } from "../core/canonical.js";
import { canonicalBytes } from "../core/canonical.js";
import { acceptReadyEvent } from "./ready.js";
import { acceptReceiptEvent, IncompleteEvidenceError, recoverLostReceipt, type ReceiptDependencies, type ReceiptObservation, type ReceiptObservationContext } from "./receipt.js";
import {
  runDispatchOutbox,
  type AppTokenProvider,
  type WorkflowDispatcher,
} from "./dispatch.js";
import { planStatePath, retireFailedShadowPlan, retryFailedShadowPlan, type GitStateStore, type StoredPlanState } from "./state.js";
import { GhAttestationVerifier, type ProvenanceVerifier } from "./provenance-verifier.js";
import { observeGithubArtifact } from "../registry/github.js";

type Input = {
  config: { appId: number; actor: string };
  env: NodeJS.ProcessEnv;
  store: GitStateStore;
  tokens: AppTokenProvider;
  dispatcher: WorkflowDispatcher;
  request?: typeof fetch;
  provenanceVerifier?: ProvenanceVerifier;
};
const headers = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
});
const EXTERNAL_HOSTS = new Set(["crates.io", "static.crates.io", "registry.npmjs.org"]);
export function coordinatorEnvironment(value: string | undefined): "shadow" | "production" {
  if (value === "shadow" || value === "production") return value;
  throw new TypeError("LENSO_COORDINATOR_MODE must be shadow or production");
}
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
    const response = await request(current, {
      redirect: "manual",
      headers: { "user-agent": "lenso-release-coordinator/1.0" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("external redirect missing location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      if (response.status === 404) throw new IncompleteEvidenceError(`external observation not yet visible for ${current.origin}`);
      throw new Error(`external observation ${response.status} for ${current.origin}`);
    }
    if (response.url) {
      const final = new URL(response.url);
      if (final.protocol !== "https:" || !EXTERNAL_HOSTS.has(final.hostname))
        throw new TypeError("external response escaped host allowlist");
    }
    return response;
  }
  throw new Error("external observation redirect limit exceeded");
}
export async function checkedGithubAsset(request: typeof fetch, url: string, token: string): Promise<Response> {
  assertGithubApi(url);
  const parsed = new URL(url);
  if (!/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/u.test(parsed.pathname))
    throw new TypeError("GitHub asset URL is invalid");
  const initial = await request(parsed, { redirect: "manual", headers: { ...headers(token), accept: "application/octet-stream" } });
  if (![301, 302, 303, 307, 308].includes(initial.status)) return initial;
  const location = initial.headers.get("location");
  if (!location) throw new TypeError("GitHub asset redirect missing location");
  const target = new URL(location);
  if (target.protocol !== "https:" || !["objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(target.hostname))
    throw new TypeError("GitHub asset redirect target is not trusted");
  return request(target, { redirect: "error", headers: { accept: "application/octet-stream" } });
}
function nonce() {
  return crypto.randomUUID();
}

export function npmPackumentContainsVersion(value: unknown, version: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("shadow npm packument invalid");
  const versions = (value as Record<string, unknown>).versions;
  if (versions === null || typeof versions !== "object" || Array.isArray(versions))
    throw new TypeError("shadow npm packument versions invalid");
  return Object.hasOwn(versions, version);
}

export function productionDependencyUrl(id: string, version: string): string {
  if (id.startsWith("cargo:")) {
    const name = encodeURIComponent(id.slice(6));
    return `https://crates.io/api/v1/crates/${name}/${encodeURIComponent(version)}/download`;
  }
  if (id.startsWith("npm:"))
    return `https://registry.npmjs.org/${encodeURIComponent(id.slice(4))}`;
  throw new TypeError(`unsupported registry dependency ${id}`);
}

export function executionRefProtectionIsImmutable(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const protection = value as Record<string, unknown>;
  const enabled = (key: string, expected: boolean) => {
    const setting = protection[key];
    return typeof setting === "object" && setting !== null && !Array.isArray(setting) &&
      (setting as Record<string, unknown>).enabled === expected;
  };
  return enabled("enforce_admins", true) &&
    enabled("allow_force_pushes", false) &&
    enabled("allow_deletions", false);
}

export async function scanActiveRecovery(
  plans: Record<string, PlanStateV1>,
  recover: (state: PlanStateV1, pkg: PlanStatePackage) => Promise<void>,
): Promise<{ recovered: string[]; incomplete: string[] }> {
  const recovered: string[] = [];
  const incomplete: string[] = [];
  for (const state of Object.values(plans).sort((a, b) => `${a.repository}:${a.planId}`.localeCompare(`${b.repository}:${b.planId}`))) {
    if (state.status !== "publishing" && !(state.status === "blocked" && state.reason === "dispatch outcome unknown")) continue;
    for (const pkg of [...state.packages].sort((a, b) => `${a.id}:${a.version}`.localeCompare(`${b.id}:${b.version}`))) {
      if (pkg.status !== "dispatched") continue;
      const key = `${state.repository}:${state.planId}:${pkg.id}:${pkg.version}`;
      try { await recover(state, pkg); recovered.push(key); }
      catch (error) {
        if (error instanceof IncompleteEvidenceError) incomplete.push(key);
        else throw error;
      }
    }
  }
  return { recovered, incomplete };
}

export async function scanActiveOutboxRecovery(
  plans: Record<string, PlanStateV1>,
  recover: (state: PlanStateV1) => Promise<void>,
): Promise<string[]> {
  const recovered: string[] = [];
  for (const state of Object.values(plans).sort((a, b) => `${a.repository}:${a.planId}`.localeCompare(`${b.repository}:${b.planId}`))) {
    if (state.status !== "publishing" && !(state.status === "blocked" && state.reason === "dispatch outcome unknown")) continue;
    if (!state.outbox.some(({ status }) => status === "pending" || status === "in-flight")) continue;
    await recover(state);
    recovered.push(`${state.repository}:${state.planId}`);
  }
  return recovered;
}

export function tagRefIsImmutable(value: unknown, tagRef: string): boolean {
  if (!Array.isArray(value)) return false;
  const match = (pattern: string): boolean | null => {
    if (pattern === "~ALL") return true;
    if (!/^refs\/tags\/[A-Za-z0-9@._/*-]+$/u.test(pattern) || pattern.includes("***")) return null;
    let expression = "^";
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index]!;
      if (character === "*" && pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else if (character === "*") expression += "[^/]*";
      else expression += character.replace(/[.\\+?^${}()|[\]]/gu, "\\$&");
    }
    return new RegExp(`${expression}$`, "u").test(tagRef);
  };
  return value.some((raw) => {
    const ruleset = raw as Record<string, unknown>;
    if (ruleset.enforcement !== "active" || ruleset.target !== "tag") return false;
    const conditions = ruleset.conditions as Record<string, unknown> | undefined;
    const names = conditions?.ref_name as Record<string, unknown> | undefined;
    const includes = Array.isArray(names?.include) ? names.include.map(String) : [];
    const excludes = Array.isArray(names?.exclude) ? names.exclude.map(String) : [];
    if (excludes.some((pattern) => match(pattern) !== false)) return false;
    const matches = includes.some((pattern) => match(pattern) === true);
    const types = new Set((Array.isArray(ruleset.rules) ? ruleset.rules : []).map((rule) => String((rule as Record<string, unknown>).type)));
    return matches && types.has("deletion") && types.has("non_fast_forward");
  });
}

export async function activeRulesetDetails(
  list: unknown,
  getDetail: (id: number) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  if (!Array.isArray(list)) throw new TypeError("GitHub ruleset list invalid");
  const ids = list
    .filter((item) => (item as Record<string, unknown>).enforcement === "active")
    .map((item) => Number((item as Record<string, unknown>).id));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new TypeError("GitHub active ruleset ID invalid");
  return Promise.all(ids.map(getDetail));
}

export async function createCoordinatorHandlers(
  input: Input,
): Promise<{
  ready(value: unknown): Promise<StoredPlanState>;
  receipt(value: unknown): Promise<StoredPlanState>;
  recoverActive(): Promise<{ recovered: string[]; incomplete: string[] }>;
  retireFailedShadowPlan(repository: string, planId: string, eventId: `sha256:${string}`): Promise<StoredPlanState>;
  retryFailedShadowPlan(repository: string, planId: string): Promise<StoredPlanState>;
}> {
  const registryPath = import.meta.url.includes("/dist/src/")
    ? new URL("../../../config/components.yaml", import.meta.url).pathname
    : new URL("../../config/components.yaml", import.meta.url).pathname;
  const registry = await loadComponents(
    registryPath,
  );
  const planPath =
    input.env.LENSO_RELEASE_PLAN_PATH ?? ".lenso-release/plan.json";
  const bundlePath =
    input.env.LENSO_SHARED_BUNDLE_PATH ?? ".lenso-release/runtime/manifest.json";
  const observedActor = input.env.LENSO_EVENT_ACTOR;
  if (!observedActor) throw new TypeError("LENSO_EVENT_ACTOR is required");
  const now = () => new Date();
  const request = input.request ?? fetch;
  const provenanceVerifier = input.provenanceVerifier ?? new GhAttestationVerifier();
  const environment = coordinatorEnvironment(input.env.LENSO_COORDINATOR_MODE);
  const shadow = environment === "shadow";
  const dependencyVisible = async (id: string, version: string): Promise<boolean> => {
    if (id.startsWith("artifact:")) {
      const component = registry.packages[id];
      if (!component || component.registry !== "github-release") return false;
      const token = await input.tokens.tokenFor(component.repository, { contents: "read", metadata: "read" });
      const observation = await observeGithubArtifact(component.repository, id.slice("artifact:".length), version, { fetch: request, token });
      return "version" in observation && observation.version === version;
    }
    const productionUrl = productionDependencyUrl(id, version);
    const url = id.startsWith("cargo:")
      ? `${input.env.LENSO_SHADOW_CRATES_API_URL}/api/v1/crates/${encodeURIComponent(id.slice(6))}/${encodeURIComponent(version)}`
      : `${input.env.LENSO_SHADOW_NPM_REGISTRY_URL}/${encodeURIComponent(id.slice(4))}`;
    try {
      if (!shadow) return (await checkedExternal(request, productionUrl)).ok;
      if ((await request(url, { redirect: "error" })).ok) return true;
      return (await checkedExternal(request, productionUrl)).ok;
    } catch { return false; }
  };
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
    recoverActive(): Promise<{ recovered: string[]; incomplete: string[] }>;
    retireFailedShadowPlan(repository: string, planId: string, eventId: `sha256:${string}`): Promise<StoredPlanState>;
    retryFailedShadowPlan(repository: string, planId: string): Promise<StoredPlanState>;
  } = {
    async ready(value) {
      const event = value as Extract<
        ReleaseEventV1,
        { eventType: "lenso-plan-ready" }
      >;
      const sourceToken = await input.tokens.tokenFor(event.sourceRepository, {
        contents: "write",
        metadata: "read",
      });
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
          const bundleBytes = await githubBytes(event.sourceRepository, bundlePath, event.releaseCommit, sourceToken);
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
                if (!await dependencyVisible(dep.id, dep.resolvedVersion)) externalDependenciesVisible = false;
              }
          const branch = shadow ? { protected: true } : await githubJson(
            `${api}/branches/${encodeURIComponent(input.env.LENSO_SOURCE_BRANCH ?? "main")}`, sourceToken,
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
            branchProtected: branch.protected === true,
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
          if (shadow) return { tip, protected: true };
          const branch = await githubJson(
            `${api}/branches/${encodeURIComponent(ref)}`,
            sourceToken,
          );
          if (branch.protected === true) return { tip, protected: true };
          const protectionUrl = `${api}/branches/${encodeURIComponent(ref)}/protection`;
          const existingProtection = await request(protectionUrl, {
            redirect: "error",
            headers: headers(sourceToken),
          });
          if (existingProtection.ok && executionRefProtectionIsImmutable(await existingProtection.json()))
            return { tip, protected: true };
          if (existingProtection.status !== 404 && !existingProtection.ok)
            throw new Error(`execution ref protection observation ${existingProtection.status}`);
          const protectedResponse = await request(protectionUrl, {
            method: "PUT",
            redirect: "error",
            headers: headers(sourceToken),
            body: JSON.stringify({
              required_status_checks: null,
              enforce_admins: true,
              required_pull_request_reviews: null,
              restrictions: null,
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
        environment,
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
      const recoveryOnly = event.eventId === `sha256:${"0".repeat(64)}`;
      let expected = event.receipt;
      if (recoveryOnly && shadow) {
        const repository = expected.repository;
        const packageName = expected.packageId.startsWith("cargo:")
          ? expected.packageId.slice(6)
          : expected.packageId.startsWith("npm:@lenso/")
            ? expected.packageId.slice("npm:@lenso/".length)
            : expected.packageId.slice("artifact:".length);
        const tagName = `${packageName}@${expected.version}`;
        const token = await input.tokens.tokenFor(repository, { contents: "write", actions: "read", metadata: "read" });
        const tagApi = `${input.env.LENSO_SHADOW_GITHUB_API_URL}/repos/${repository}`;
        const ref = await request(`${tagApi}/git/ref/tags/${encodeURIComponent(tagName)}`, { redirect: "error", headers: headers(token) });
        if (!ref.ok) throw new IncompleteEvidenceError("recovery tag evidence incomplete");
        const refBody = await ref.json() as Record<string, unknown>;
        const object = refBody.object as Record<string, unknown>;
        const tag = await request(`${tagApi}/git/tags/${String(object.sha)}`, { redirect: "error", headers: headers(token) });
        if (!tag.ok) throw new IncompleteEvidenceError("recovery tag evidence incomplete");
        const tagBody = await tag.json() as Record<string, unknown>;
        expected = JSON.parse(String(tagBody.message)) as ComponentReceiptV1;
      }
      let tagWrite: { githubApi: string; token: string; tagName: string; immutable: boolean } | null = null;
      const observer = {
        async observe(context: ReceiptObservationContext, packageId: string, packageVersion: string): Promise<ReceiptObservation | null> {
          if (!context.packages.some(({ id, version }) => id === packageId && version === packageVersion)) throw new Error("package is not selected by stored outbox");
          const repository = context.repository;
          const token = await input.tokens.tokenFor(repository, shadow
            ? { contents: "write", actions: "read", metadata: "read" }
            : { contents: "write", actions: "read", attestations: "read", metadata: "read" });
          const githubApi = `https://api.github.com/repos/${repository}`;
          const tagApi = shadow ? `${input.env.LENSO_SHADOW_GITHUB_API_URL}/repos/${repository}` : githubApi;
          const packageName = packageId.startsWith("cargo:")
            ? packageId.slice(6)
            : packageId.startsWith("npm:@lenso/") ? packageId.slice("npm:@lenso/".length) : packageId.slice("artifact:".length);
          const tagName = `${packageName}@${packageVersion}`;
          const expectedTagUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tagName)}`;
          let packedBytes: Uint8Array;
          let nativeIntegrity: string;
          let registryUrl: string;
          let publishedAt: string;
          if (packageId.startsWith("cargo:")) {
            const base = shadow ? input.env.LENSO_SHADOW_CRATES_API_URL : "https://crates.io";
            const metadataUrl = `${base}/api/v1/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}`;
            const metadataResponse = shadow ? await request(metadataUrl, { redirect: "error" }) : await checkedExternal(request, metadataUrl);
            if (!metadataResponse.ok) return null;
            const metadata = await metadataResponse.json() as Record<string, unknown>;
            const version = metadata.version as Record<string, unknown>;
            const artifactUrl = `${base}/api/v1/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}/download`;
            const artifact = shadow ? await request(artifactUrl, { redirect: "error" }) : await checkedExternal(request, artifactUrl);
            if (!artifact.ok) return null;
            packedBytes = new Uint8Array(await artifact.arrayBuffer());
            nativeIntegrity = String(version.checksum);
            publishedAt = String(version.created_at);
            registryUrl = artifact.url || `https://static.crates.io/crates/${packageName}/${packageName}-${packageVersion}.crate`;
          } else if (packageId.startsWith("npm:")) {
            const name = `@lenso/${packageName}`;
            const packumentUrl = `${shadow ? input.env.LENSO_SHADOW_NPM_REGISTRY_URL : "https://registry.npmjs.org"}/${encodeURIComponent(name)}`;
            const packumentResponse = shadow ? await request(packumentUrl, { redirect: "error" }) : await checkedExternal(request, packumentUrl);
            if (!packumentResponse.ok) return null;
            const packument = await packumentResponse.json() as Record<string, unknown>;
            const versions = packument.versions as Record<string, Record<string, unknown>>;
            const metadata = versions[packageVersion];
            if (!metadata) return null;
            const dist = metadata.dist as Record<string, unknown>;
            const tarball = String(dist.tarball);
            const artifact = shadow ? await request(tarball, { redirect: "error" }) : await checkedExternal(request, tarball);
            if (!artifact.ok) return null;
            packedBytes = new Uint8Array(await artifact.arrayBuffer());
            nativeIntegrity = String(dist.integrity);
            publishedAt = String((packument.time as Record<string, unknown>)[packageVersion]);
            registryUrl = tarball;
          } else {
            const release = await githubJson(`${githubApi}/releases/tags/${encodeURIComponent(`v${packageVersion}`)}`, token);
            if (release.draft !== true || typeof release.created_at !== "string") return null;
            const assets = Array.isArray(release.assets) ? release.assets as Record<string, unknown>[] : [];
            const asset = assets.find(({ name }) => name === `${packageName}.tar.gz`);
            const checksumAsset = assets.find(({ name }) => name === `${packageName}.tar.gz.sha256`);
            if (!asset?.url || !asset.browser_download_url || !checksumAsset?.url) return null;
            const artifact = await checkedGithubAsset(request, String(asset.url), token);
            if (!artifact.ok) return null;
            packedBytes = new Uint8Array(await artifact.arrayBuffer());
            nativeIntegrity = sha256(packedBytes);
            const checksum = await checkedGithubAsset(request, String(checksumAsset.url), token);
            const expectedChecksum = `${nativeIntegrity.slice("sha256:".length)}  ${packageName}.tar.gz\n`;
            if (!checksum.ok || Buffer.from(await checksum.arrayBuffer()).toString("utf8") !== expectedChecksum) return null;
            publishedAt = String(release.created_at);
            registryUrl = String(asset.browser_download_url);
          }
          const packedDigest = sha256(packedBytes);
          const workflowRuns = await githubJson(`${githubApi}/actions/workflows/${encodeURIComponent(context.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(context.executionRef)}&per_page=100`, token);
          const runs = Array.isArray(workflowRuns.workflow_runs) ? workflowRuns.workflow_runs as Record<string, unknown>[] : [];
          const workflow = runs.find((run) => run.display_title === `lenso-publish-requested:${context.eventId}` && run.event === "workflow_dispatch" && run.head_branch === context.executionRef && run.head_sha === context.releaseCommit && (run.repository as Record<string, unknown> | undefined)?.full_name === repository);
          if (!workflow) return null;
          const runId = String(workflow.id);
          const runUrl = String(workflow.html_url);
          if (runUrl !== expected.workflowUrl || runUrl !== `https://github.com/${repository}/actions/runs/${runId}`) return null;
          if (workflow.status !== "completed" || workflow.conclusion !== "success") return null;
          const subjectName = packageId.startsWith("cargo:")
            ? `${packageName}-${packageVersion}.crate`
            : packageId.startsWith("npm:") ? `${packageName}-${packageVersion}.tgz` : `${packageName}.tar.gz`;
          const subject = shadow
            ? await (async () => {
                const response = await request(expected.provenanceUrl, { redirect: "error" });
                if (!response.ok) return null;
                const value = await response.json() as Record<string, unknown>;
                return value.artifact_sha256 === packedDigest ? expected.provenanceSubject : null;
              })()
            : await provenanceVerifier.verify({ artifactBytes: packedBytes, subjectName, digest: packedDigest, repository, workflow: context.workflow, ref: context.executionRef, sha: context.releaseCommit, runId, githubToken: token });
          if (!subject) return null;
          const rulesetDetails = shadow ? [] : await activeRulesetDetails(await githubJson(`${githubApi}/rulesets?includes_parents=true`, token) as unknown, (id) => githubJson(`${githubApi}/rulesets/${id}`, token));
          const immutable = shadow || tagRefIsImmutable(rulesetDetails, `refs/tags/${tagName}`);
          tagWrite = { githubApi: tagApi, token, tagName, immutable };
          const refResponse = await request(`${tagApi}/git/ref/tags/${encodeURIComponent(tagName)}`, { redirect: "error", headers: headers(token) });
          let tagReceipt: unknown | null = null;
          let annotated = false;
          let targetSha: string | null = null;
          if (refResponse.ok) {
            const ref = await refResponse.json() as Record<string, unknown>;
            const object = ref.object as Record<string, unknown>;
            if (object.type !== "tag") throw new Error("component tag is not annotated");
            const tagResponse = await request(`${tagApi}/git/tags/${String(object.sha)}`, { redirect: "error", headers: headers(token) });
            if (!tagResponse.ok) throw new Error(`tag object observation ${tagResponse.status}`);
            const tag = await tagResponse.json() as Record<string, unknown>;
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
              url: shadow
                ? expected.provenanceUrl
                : `https://github.com/${repository}/attestations/${packedDigest.slice("sha256:".length)}`,
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
        environment: shadow ? "shadow" : "production",
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
              if (!selected.has(dep.id) || dep.source === "plan") {
                if (!await dependencyVisible(dep.id, version)) return false;
              }
            }
          }
          return true;
        },
        now,
        nonce,
        appId: input.config.appId,
      };
      let result: StoredPlanState | null = null;
      if (!recoveryOnly) {
        try {
          result = await acceptReceiptEvent(value, receiptDependencies);
        } catch (error) {
          if (!(error instanceof IncompleteEvidenceError) || error.message !== "receipt tag evidence incomplete") throw error;
        }
      }
      result ??= await recoverLostReceipt(
        expected.repository,
        expected.planId,
        expected.packageId,
        expected.version,
        receiptDependencies,
      );
      if (!result) throw new IncompleteEvidenceError("authoritative receipt evidence incomplete");
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
      await scanActiveOutboxRecovery(snapshot.plans, async (state) => {
        await runDispatchOutbox(
          input.store,
          state.repository,
          state.planId,
          input.dispatcher,
          input.tokens,
          now,
        );
      });
      const refreshed = await input.store.readSnapshot();
      return scanActiveRecovery(refreshed.plans, async (state, pkg) => {
          const zero = `sha256:${"0".repeat(64)}` as const;
          await handlers.receipt({
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
              environment: shadow ? "shadow" : "production",
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
      });
    },
    async retireFailedShadowPlan(repository, planId, eventId) {
      const snapshot = await input.store.readSnapshot();
      const state = snapshot.plans[planStatePath(repository, planId)];
      if (!state) throw new Error("plan state not found");
      const token = await input.tokens.tokenFor(repository, { actions: "read", metadata: "read" });
      return retireFailedShadowPlan(
        input.store,
        repository,
        planId,
        eventId,
        input.env.LENSO_COORDINATOR_MODE,
        {
          async observeRun(entry) {
            return input.dispatcher.findByEventId(
              { repository, workflow: entry.workflow, ref: entry.ref, sha: state.releaseCommit },
              entry.eventId,
              token,
            );
          },
          async packageVersionExists(id, version) {
            let response: Response;
            if (id.startsWith("cargo:")) {
              response = await request(`${input.env.LENSO_SHADOW_CRATES_API_URL}/api/v1/crates/${encodeURIComponent(id.slice(6))}/${encodeURIComponent(version)}`, { redirect: "error" });
              if (response.status === 404) return false;
              if (!response.ok) throw new Error(`shadow registry observation ${response.status}`);
              return true;
            }
            if (id.startsWith("npm:")) {
              response = await request(`${input.env.LENSO_SHADOW_NPM_REGISTRY_URL}/${encodeURIComponent(id.slice(4))}`, { redirect: "error" });
              if (response.status === 404) return false;
              if (!response.ok) throw new Error(`shadow registry observation ${response.status}`);
              return npmPackumentContainsVersion(await response.json(), version);
            }
            const component = registry.packages[id];
            if (!component) throw new TypeError(`unknown package ${id}`);
            response = await request(`${input.env.LENSO_SHADOW_GITHUB_API_URL}/repos/${component.repository}/releases/tags/${encodeURIComponent(`v${version}`)}`, { redirect: "error", headers: headers(token) });
            if (response.status === 404) return false;
            if (!response.ok) throw new Error(`shadow release observation ${response.status}`);
            return true;
          },
        },
        now(),
      );
    },
    async retryFailedShadowPlan(repository, planId) {
      const snapshot = await input.store.readSnapshot();
      const state = snapshot.plans[planStatePath(repository, planId)];
      if (!state) throw new Error("plan state not found");
      const token = await input.tokens.tokenFor(repository, { actions: "read", metadata: "read" });
      await retryFailedShadowPlan(
        input.store,
        repository,
        planId,
        input.env.LENSO_COORDINATOR_MODE,
        {
          async observeRun(entry) {
            return input.dispatcher.findByEventId(
              { repository, workflow: entry.workflow, ref: entry.ref, sha: state.releaseCommit },
              entry.eventId,
              token,
            );
          },
        },
        now(),
        nonce(),
        input.config.appId,
      );
      return runDispatchOutbox(input.store, repository, planId, input.dispatcher, input.tokens, now);
    },
  };
  return handlers;
}
