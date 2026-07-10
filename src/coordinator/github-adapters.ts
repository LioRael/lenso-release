import { createSign } from "node:crypto";

import { canonicalBytes } from "../core/canonical.js";
import type {
  AppTokenProvider,
  DispatchCommand,
  DispatchRunContext,
  ObservedWorkflowRun,
  WorkflowDispatcher,
} from "./dispatch.js";
import {
  assertReleaseStateSnapshot,
  normalizeRepository,
  StateConflictError,
  type GitStateStore,
  type ReleaseStateSnapshot,
} from "./state.js";

type Fetch = typeof fetch;
function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

export class GithubAppTokenProvider implements AppTokenProvider {
  constructor(
    private readonly appId: number,
    private readonly privateKey: string,
    private readonly installationId: number,
    private readonly request: Fetch = fetch,
  ) {}
  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 540, iss: String(this.appId) })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    return `${unsigned}.${signer.sign(this.privateKey, "base64url")}`;
  }
  async tokenFor(
    repository: string,
    permissions: Record<string, "read" | "write"> = { metadata: "read" },
  ): Promise<string> {
    normalizeRepository(repository);
    const response = await this.request(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.jwt()}`,
        },
        body: JSON.stringify({
          repositories: [repository.split("/")[1]],
          permissions,
        }),
      },
    );
    const body = await json(response);
    if (typeof body.token !== "string")
      throw new Error("GitHub App token response missing token");
    return body.token;
  }
}

export class GithubSnapshotStore implements GitStateStore {
  constructor(
    private readonly coordinatorRepository: string,
    private readonly tokens: AppTokenProvider,
    private readonly request: Fetch = fetch,
  ) {}
  private async headers() {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await this.tokens.tokenFor(this.coordinatorRepository, { contents: "write", metadata: "read" })}`,
    };
  }
  private api(path: string): string {
    return `https://api.github.com/repos/${this.coordinatorRepository}${path}`;
  }
  private async readBlob(sha: string, headers: Record<string, string>): Promise<unknown> {
    const blob = await json(await this.request(this.api(`/git/blobs/${sha}`), { headers, redirect: "error" }));
    if (blob.encoding !== "base64" || typeof blob.content !== "string")
      throw new TypeError("GitHub state blob encoding invalid");
    return JSON.parse(Buffer.from(blob.content.replace(/\n/gu, ""), "base64").toString("utf8"));
  }
  private async treeAt(headSha: string, headers: Record<string, string>): Promise<Record<string, string>> {
    const commit = await json(await this.request(this.api(`/git/commits/${headSha}`), { headers, redirect: "error" }));
    const treeSha = String((commit.tree as Record<string, unknown>).sha);
    const tree = await json(await this.request(this.api(`/git/trees/${treeSha}?recursive=1`), { headers, redirect: "error" }));
    const entries = Array.isArray(tree.tree) ? tree.tree as Record<string, unknown>[] : [];
    return Object.fromEntries(entries.filter((entry) => entry.type === "blob").map((entry) => [String(entry.path), String(entry.sha)]));
  }
  async readSnapshot(): Promise<ReleaseStateSnapshot> {
    const headers = await this.headers();
    const ref = await json(
      await this.request(
        this.api("/git/ref/heads/release-state"),
        { headers, redirect: "error" },
      ),
    );
    const object = ref.object as Record<string, unknown>;
    const headSha = String(object.sha);
    const tree = await this.treeAt(headSha, headers);
    const activeSha = tree["indexes/active-repositories.json"];
    const occupiedSha = tree["indexes/occupied-packages.json"];
    if (!activeSha || !occupiedSha) throw new TypeError("release-state indexes missing");
    const planEntries = Object.entries(tree).filter(([path]) => path.startsWith("plans/") && path.endsWith(".json"));
    const plans = Object.fromEntries(await Promise.all(planEntries.map(async ([path, sha]) => [path, await this.readBlob(sha, headers)])));
    const snapshot = {
      headSha,
      plans,
      activeRepositories: await this.readBlob(activeSha, headers) as Record<string, string>,
      occupiedPackages: await this.readBlob(occupiedSha, headers) as Record<string, string>,
    };
    assertReleaseStateSnapshot(snapshot);
    return snapshot;
  }
  async compareAndSwap(
    expectedHeadSha: string,
    next: ReleaseStateSnapshot,
  ): Promise<ReleaseStateSnapshot> {
    const headers = await this.headers();
    const observedRef = await json(await this.request(this.api("/git/ref/heads/release-state"), { headers, redirect: "error" }));
    if (String((observedRef.object as Record<string, unknown>).sha) !== expectedHeadSha)
      throw new StateConflictError("release-state head conflict");
    const oldTree = await this.treeAt(expectedHeadSha, headers);
    const materialized = structuredClone(next);
    for (const [path, state] of Object.entries(materialized.plans))
      state.previousBlobSha = oldTree[path] ?? null;
    assertReleaseStateSnapshot({ ...materialized, headSha: expectedHeadSha });
    const createBlob = async (value: unknown) => json(await this.request(this.api("/git/blobs"), {
      method: "POST", headers, redirect: "error",
      body: JSON.stringify({ content: canonicalBytes(value as never).toString("utf8"), encoding: "utf-8" }),
    }));
    const treeEntries: Record<string, unknown>[] = [];
    for (const [path, state] of Object.entries(materialized.plans)) {
      const blob = await createBlob(state);
      treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const [path] of Object.entries(oldTree))
      if (path.startsWith("plans/") && path.endsWith(".json") && !materialized.plans[path])
        treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    for (const [path, value] of [
      ["indexes/active-repositories.json", materialized.activeRepositories],
      ["indexes/occupied-packages.json", materialized.occupiedPackages],
    ] as const) {
      const blob = await createBlob(value);
      treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const base = await json(
      await this.request(
        this.api(`/git/commits/${expectedHeadSha}`),
        { headers, redirect: "error" },
      ),
    );
    const tree = await json(
      await this.request(
        this.api("/git/trees"),
        {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify({
            base_tree: (base.tree as Record<string, unknown>).sha,
            tree: treeEntries,
          }),
        },
      ),
    );
    const commit = await json(
      await this.request(
        this.api("/git/commits"),
        {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify({
            message: "chore: update atomic release state",
            tree: tree.sha,
            parents: [expectedHeadSha],
          }),
        },
      ),
    );
    const update = await this.request(
      this.api("/git/refs/heads/release-state"),
      {
        method: "PATCH",
        redirect: "error",
        headers,
        body: JSON.stringify({ sha: commit.sha, force: false }),
      },
    );
    if (update.status === 409 || update.status === 422)
      throw new StateConflictError("release-state head conflict");
    if (!update.ok) throw new Error(`GitHub ref update ${update.status}`);
    return { ...materialized, headSha: String(commit.sha) };
  }
}

export class GithubWorkflowDispatcher implements WorkflowDispatcher {
  constructor(private readonly request: Fetch = fetch) {}
  async findByEventId(
    context: DispatchRunContext,
    eventId: string,
    appToken: string,
  ): Promise<ObservedWorkflowRun | null> {
    normalizeRepository(context.repository);
    const body = await json(
      await this.request(
        `https://api.github.com/repos/${context.repository}/actions/workflows/${encodeURIComponent(context.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(context.ref)}&per_page=100`,
        {
          redirect: "error",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${appToken}`,
          },
        },
      ),
    );
    const runs = Array.isArray(body.workflow_runs)
      ? (body.workflow_runs as Record<string, unknown>[])
      : [];
    const runName = `lenso-publish-requested:${eventId}`;
    const run = runs.find((item) =>
      String(item.display_title) === runName &&
      item.event === "workflow_dispatch" &&
      item.head_branch === context.ref &&
      item.head_sha === context.sha &&
      (item.repository as Record<string, unknown> | undefined)?.full_name === context.repository &&
      String(item.html_url) === `https://github.com/${context.repository}/actions/runs/${String(item.id)}`,
    );
    return run ? { ...context, event: "workflow_dispatch", runName, runUrl: String(run.html_url) } : null;
  }
  async dispatch(
    command: DispatchCommand,
    eventId: string,
    appToken: string,
  ): Promise<ObservedWorkflowRun> {
    const response = await this.request(
      `https://api.github.com/repos/${command.repository}/actions/workflows/${encodeURIComponent(command.workflow)}/dispatches`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appToken}`,
        },
        body: JSON.stringify({ ref: command.ref, inputs: command.inputs }),
      },
    );
    if (!response.ok) throw new Error(`workflow dispatch ${response.status}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const observed = await this.findByEventId({ repository: command.repository, workflow: command.workflow, ref: command.ref, sha: command.inputs.release_commit }, eventId, appToken);
      if (observed) return observed;
    }
    throw new Error(`workflow run ${eventId} is not yet visible`);
  }
}

export function parseCoordinatorEnvironment(env: NodeJS.ProcessEnv): {
  repository: string;
  appId: number;
  installationId: number;
  privateKey: string;
  actor: string;
} {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new TypeError(`${name} is required`);
    return value;
  };
  const integer = (name: string) => {
    const value = Number(required(name));
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`${name} must be a positive integer`);
    return value;
  };
  return {
    repository: required("GITHUB_REPOSITORY"),
    appId: integer("LENSO_GITHUB_APP_ID"),
    installationId: integer("LENSO_GITHUB_APP_INSTALLATION_ID"),
    privateKey: required("LENSO_GITHUB_APP_PRIVATE_KEY").replace(/\\n/gu, "\n"),
    actor: required("LENSO_GITHUB_APP_ACTOR"),
  };
}
