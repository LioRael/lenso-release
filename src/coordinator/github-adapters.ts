import { createSign } from "node:crypto";

import type { PlanStateV1 } from "../contracts/types.js";
import { canonicalBytes } from "../core/canonical.js";
import type {
  AppTokenProvider,
  DispatchCommand,
  WorkflowDispatcher,
} from "./dispatch.js";
import {
  assertReleaseStateSnapshot,
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
  async tokenFor(repository: string): Promise<string> {
    const response = await this.request(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.jwt()}`,
        },
        body: JSON.stringify({
          repositories: [repository.split("/")[1]],
          permissions: {
            actions: "write",
            administration: "write",
            contents: "write",
            metadata: "read",
          },
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
    private readonly token: string,
    private readonly request: Fetch = fetch,
  ) {}
  private headers() {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
    };
  }
  async readSnapshot(): Promise<ReleaseStateSnapshot> {
    const ref = await json(
      await this.request(
        `https://api.github.com/repos/${this.coordinatorRepository}/git/ref/heads/release-state`,
        { headers: this.headers() },
      ),
    );
    const object = ref.object as Record<string, unknown>;
    const headSha = String(object.sha);
    const content = await json(
      await this.request(
        `https://api.github.com/repos/${this.coordinatorRepository}/contents/release-state.json?ref=${headSha}`,
        { headers: this.headers() },
      ),
    );
    const parsed = JSON.parse(
      Buffer.from(
        String(content.content).replace(/\n/gu, ""),
        "base64",
      ).toString("utf8"),
    ) as Omit<ReleaseStateSnapshot, "headSha">;
    const snapshot = { headSha, ...parsed };
    assertReleaseStateSnapshot(snapshot);
    return snapshot;
  }
  async compareAndSwap(
    expectedHeadSha: string,
    next: ReleaseStateSnapshot,
  ): Promise<ReleaseStateSnapshot> {
    assertReleaseStateSnapshot({ ...next, headSha: expectedHeadSha });
    const blob = await json(
      await this.request(
        `https://api.github.com/repos/${this.coordinatorRepository}/git/blobs`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            content: canonicalBytes({
              plans: next.plans,
              activeRepositories: next.activeRepositories,
              occupiedPackages: next.occupiedPackages,
            } as never).toString("utf8"),
            encoding: "utf-8",
          }),
        },
      ),
    );
    const base = await json(
      await this.request(
        `https://api.github.com/repos/${this.coordinatorRepository}/git/commits/${expectedHeadSha}`,
        { headers: this.headers() },
      ),
    );
    const tree = await json(
      await this.request(
        `https://api.github.com/repos/${this.coordinatorRepository}/git/trees`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            base_tree: (base.tree as Record<string, unknown>).sha,
            tree: [
              {
                path: "release-state.json",
                mode: "100644",
                type: "blob",
                sha: blob.sha,
              },
            ],
          }),
        },
      ),
    );
    const commit = await json(
      await this.request(
        `https://api.github.com/repos/${this.coordinatorRepository}/git/commits`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            message: "chore: update atomic release state",
            tree: tree.sha,
            parents: [expectedHeadSha],
          }),
        },
      ),
    );
    const update = await this.request(
      `https://api.github.com/repos/${this.coordinatorRepository}/git/refs/heads/release-state`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ sha: commit.sha, force: false }),
      },
    );
    if (update.status === 409 || update.status === 422)
      throw new Error("release-state head conflict");
    if (!update.ok) throw new Error(`GitHub ref update ${update.status}`);
    return { ...structuredClone(next), headSha: String(commit.sha) };
  }
}

export class GithubWorkflowDispatcher implements WorkflowDispatcher {
  constructor(private readonly request: Fetch = fetch) {}
  async findByEventId(
    repository: string,
    eventId: string,
    appToken: string,
  ): Promise<{ runUrl: string } | null> {
    const body = await json(
      await this.request(
        `https://api.github.com/repos/${repository}/actions/runs?event=workflow_dispatch&per_page=100`,
        {
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
    const run = runs.find((item) =>
      String(item.display_title).includes(eventId),
    );
    return run ? { runUrl: String(run.html_url) } : null;
  }
  async dispatch(
    command: DispatchCommand,
    eventId: string,
    appToken: string,
  ): Promise<{ runUrl: string }> {
    const response = await this.request(
      `https://api.github.com/repos/${command.repository}/actions/workflows/${encodeURIComponent(command.workflow)}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appToken}`,
        },
        body: JSON.stringify({ ref: command.ref, inputs: command.inputs }),
      },
    );
    if (!response.ok) throw new Error(`workflow dispatch ${response.status}`);
    return {
      runUrl: `https://github.com/${command.repository}/actions?query=${encodeURIComponent(eventId)}`,
    };
  }
}

export function parseCoordinatorEnvironment(env: NodeJS.ProcessEnv): {
  repository: string;
  appId: number;
  installationId: number;
  privateKey: string;
  actor: string;
  token: string;
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
    token: required("LENSO_COORDINATOR_TOKEN"),
  };
}
