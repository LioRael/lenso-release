import { readFile } from "node:fs/promises";

import type {
  ComponentReceiptV1,
  ReleaseEventV1,
  ReleasePlanV1,
} from "../contracts/types.js";
import { loadComponents } from "../config/components.js";
import { sha256 } from "../core/canonical.js";
import { acceptReadyEvent } from "./ready.js";
import { acceptReceiptEvent, type ReceiptObservation } from "./receipt.js";
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
};
const headers = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
});
async function get(url: string, token?: string): Promise<Response> {
  const response = await fetch(url, {
    headers: token ? headers(token) : undefined,
  });
  if (!response.ok)
    throw new Error(
      `observation ${response.status} for ${new URL(url).origin}`,
    );
  return response;
}
async function githubJson(
  url: string,
  token: string,
): Promise<Record<string, unknown>> {
  return (await (await get(url, token)).json()) as Record<string, unknown>;
}
function nonce() {
  return crypto.randomUUID();
}

export async function createCoordinatorHandlers(
  input: Input,
): Promise<{
  ready(value: unknown): Promise<StoredPlanState>;
  receipt(value: unknown): Promise<StoredPlanState>;
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
  return {
    async ready(value) {
      const event = value as Extract<
        ReleaseEventV1,
        { eventType: "lenso-plan-ready" }
      >;
      const sourceToken = await input.tokens.tokenFor(event.sourceRepository);
      const api = `https://api.github.com/repos/${event.sourceRepository}`;
      const github = {
        async readAtReleaseCommit() {
          const raw = await get(
            `https://raw.githubusercontent.com/${event.sourceRepository}/${event.releaseCommit}/${planPath}`,
            sourceToken,
          );
          const planBytes = new Uint8Array(await raw.arrayBuffer());
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
          const workflowBytes = new Uint8Array(
            await (
              await get(
                `https://raw.githubusercontent.com/${event.sourceRepository}/${event.releaseCommit}/${plan.publisher.workflow}`,
                sourceToken,
              )
            ).arrayBuffer(),
          );
          const bundleBytes = new Uint8Array(
            await (
              await get(
                `https://raw.githubusercontent.com/LioRael/lenso-release/${plan.publisher.sharedRevision}/${bundlePath}`,
                sourceToken,
              )
            ).arrayBuffer(),
          );
          let generatedFilesValid = true;
          for (const file of plan.generatedFiles) {
            const bytes = new Uint8Array(
              await (
                await get(
                  `https://raw.githubusercontent.com/${event.sourceRepository}/${event.releaseCommit}/${file.path}`,
                  sourceToken,
                )
              ).arrayBuffer(),
            );
            if (sha256(bytes) !== file.sha256) generatedFilesValid = false;
          }
          let externalDependenciesVisible = true;
          for (const pkg of plan.packages)
            for (const dep of pkg.dependencies)
              if (dep.source === "registry") {
                const url = dep.id.startsWith("cargo:")
                  ? `https://crates.io/api/v1/crates/${dep.id.slice(6)}/${dep.resolvedVersion}`
                  : `https://registry.npmjs.org/${encodeURIComponent(dep.id.slice(4))}/${dep.resolvedVersion}`;
                if (!(await fetch(url)).ok) externalDependenciesVisible = false;
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
          const refResponse = await fetch(`${api}/git/ref/${encoded}`, {
            headers: headers(sourceToken),
          });
          if (refResponse.status !== 200 && refResponse.status !== 404)
            throw new Error(`execution ref observation ${refResponse.status}`);
          if (refResponse.status === 404) {
            const created = await fetch(`${api}/git/refs`, {
              method: "POST",
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
          const protectedResponse = await fetch(`${api}/branches/${encodeURIComponent(ref)}/protection`, {
            method: "PUT",
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
      const observer = {
        async observe(): Promise<ReceiptObservation | null> {
          const packedBytes = new Uint8Array(
            await (await get(expected.registryUrl)).arrayBuffer(),
          );
          const provenance = (await (
            await get(expected.provenanceUrl)
          ).json()) as Record<string, unknown>;
          const workflow = (await (
            await get(
              expected.workflowUrl,
              await input.tokens.tokenFor(expected.repository),
            )
          ).json()) as Record<string, unknown>;
          const tag = (await (
            await get(
              expected.tagUrl,
              await input.tokens.tokenFor(expected.repository),
            )
          ).json()) as Record<string, unknown>;
          return {
            registry: {
              packedBytes,
              nativeIntegrity: expected.registryIntegrity,
              url: expected.registryUrl,
              publishedAt: expected.publishedAt,
            },
            provenance: {
              url: expected.provenanceUrl,
              subject: (provenance.subject ??
                expected.provenanceSubject) as ComponentReceiptV1["provenanceSubject"],
            },
            workflow: {
              url: expected.workflowUrl,
              repository: String(workflow.repository ?? expected.repository),
              ref: String(workflow.ref),
              sha: String(workflow.sha),
              eventId: String(workflow.eventId),
              correlationId: String(workflow.correlationId),
              packages: workflow.packages as { id: string; version: string }[],
            },
            tag: {
              url: expected.tagUrl,
              annotated: tag.annotated === true,
              immutable: tag.immutable === true,
              receipt: tag.receipt,
            },
          };
        },
        async createAnnotatedTag() {
          throw new Error("receipt entrypoint never creates recovery tags");
        },
      };
      const result = await acceptReceiptEvent(value, {
        store: input.store,
        observer,
        authenticate: async () => ({
          actor: observedActor,
          appId: input.config.appId,
        }),
        expectedActor: input.config.actor,
        readPlan: async (repository, commit) => {
          const response = await get(
            `https://raw.githubusercontent.com/${repository}/${commit}/${planPath}`,
            await input.tokens.tokenFor(repository),
          );
          const planBytes = new Uint8Array(await response.arrayBuffer());
          return {
            plan: JSON.parse(Buffer.from(planBytes).toString("utf8")),
            planBytes,
          };
        },
        now,
        nonce,
        appId: input.config.appId,
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
  };
}
