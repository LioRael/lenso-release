import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import {
  GithubAppTokenProvider,
  GithubSnapshotStore,
  GithubWorkflowDispatcher,
  parseCoordinatorEnvironment,
} from "../../src/coordinator/github-adapters.js";
import { checkedExternal } from "../../src/coordinator/production-facts.js";
import {
  StateConflictError,
  transact,
  type GitStateStore,
  type ReleaseStateSnapshot,
} from "../../src/coordinator/state.js";

describe("production coordinator adapters", () => {
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
    const request = vi.fn(async () => new Response(JSON.stringify({
      workflow_runs: [
        { display_title: `prefix-${eventId}`, html_url: "https://github.com/run/wrong" },
        { display_title: `lenso-publish-requested:${eventId}`, html_url: "https://github.com/run/42" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const run = await new GithubWorkflowDispatcher(request as typeof fetch)
      .findByEventId("LioRael/lenso", eventId, "token");
    expect(run).toEqual({ runUrl: "https://github.com/run/42" });
  });

  it("polls through API visibility delay without fabricating or redispatching a run", async () => {
    const eventId = `sha256:${"b".repeat(64)}`;
    let reads = 0;
    let posts = 0;
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(null, { status: 204 });
      }
      reads++;
      return new Response(JSON.stringify({ workflow_runs: reads < 3 ? [] : [{
        display_title: `lenso-publish-requested:${eventId}`,
        html_url: "https://github.com/LioRael/lenso/actions/runs/99",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const run = await new GithubWorkflowDispatcher(request as typeof fetch).dispatch({
      repository: "LioRael/lenso",
      workflow: ".github/workflows/publish.yml",
      ref: `release-execution/${"b".repeat(64)}`,
      inputs: { event: "{}", plan_id: eventId, plan_sha256: eventId, release_commit: "2".repeat(40), packages: "[]", source_repository: "LioRael/lenso-release" },
    }, eventId, "token");
    expect(run.runUrl).toBe("https://github.com/LioRael/lenso/actions/runs/99");
    expect(posts).toBe(1);
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
