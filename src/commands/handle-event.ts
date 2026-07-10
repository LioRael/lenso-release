import { readFile } from "node:fs/promises";

import type { StoredPlanState } from "../coordinator/state.js";
import {
  GithubAppTokenProvider,
  GithubSnapshotStore,
  GithubWorkflowDispatcher,
  parseCoordinatorEnvironment,
} from "../coordinator/github-adapters.js";

export const HANDLE_EVENT_EXIT = {
  ok: 0,
  validation: 2,
  conflict: 3,
  operational: 4,
} as const;
export type EventHandlers = {
  ready(value: unknown): Promise<StoredPlanState>;
  receipt(value: unknown): Promise<StoredPlanState>;
};
export type HandlerFactory = (env: NodeJS.ProcessEnv) => Promise<EventHandlers>;

export async function handleEvent(
  value: unknown,
  handlers: EventHandlers,
): Promise<StoredPlanState> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("event must be an object");
  const eventType = (value as Record<string, unknown>).eventType;
  if (eventType === "lenso-plan-ready") return handlers.ready(value);
  if (eventType === "lenso-publish-receipt") return handlers.receipt(value);
  throw new TypeError("unsupported event type");
}

export function classifyHandleEventError(error: unknown): number {
  if (error instanceof TypeError) return HANDLE_EVENT_EXIT.validation;
  if (
    error instanceof Error &&
    /(?:conflict|occupied|active immutable plan)/iu.test(error.message)
  )
    return HANDLE_EVENT_EXIT.conflict;
  return HANDLE_EVENT_EXIT.operational;
}

function args(argv: readonly string[]): {
  eventFile: string;
  eventKey: string;
} {
  if (
    argv.length !== 4 ||
    argv[0] !== "--event-file" ||
    argv[2] !== "--event-key"
  )
    throw new TypeError(
      "usage: handle-event --event-file PATH --event-key KEY",
    );
  const eventFile = argv[1]!;
  const eventKey = argv[3]!;
  if (!eventFile.startsWith("/") || eventFile.includes("\0"))
    throw new TypeError("event file must be an absolute path");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(eventKey))
    throw new TypeError("event key invalid");
  return { eventFile, eventKey };
}

export async function readEventArgument(
  argv: readonly string[],
): Promise<unknown> {
  const { eventFile, eventKey } = args(argv);
  const parsed: unknown = JSON.parse(await readFile(eventFile, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("GitHub event must be an object");
  const value = (parsed as Record<string, unknown>)[eventKey];
  if (value === undefined) throw new TypeError("event payload key missing");
  return value;
}

export async function composeGithubHandlers(
  env: NodeJS.ProcessEnv,
): Promise<EventHandlers> {
  const config = parseCoordinatorEnvironment(env);
  const moduleUrl = env.LENSO_COORDINATOR_FACTS_MODULE;
  if (!moduleUrl || !moduleUrl.startsWith("file:///"))
    throw new TypeError(
      "LENSO_COORDINATOR_FACTS_MODULE must be an absolute file URL",
    );
  const loaded: unknown = await import(moduleUrl);
  if (
    loaded === null ||
    typeof loaded !== "object" ||
    typeof (loaded as Record<string, unknown>).createCoordinatorHandlers !==
      "function"
  )
    throw new TypeError(
      "coordinator facts module must export createCoordinatorHandlers",
    );
  const create = (
    loaded as {
      createCoordinatorHandlers(input: unknown): Promise<EventHandlers>;
    }
  ).createCoordinatorHandlers;
  const store = new GithubSnapshotStore(config.repository, config.token);
  const tokens = new GithubAppTokenProvider(
    config.appId,
    config.privateKey,
    config.installationId,
  );
  const dispatcher = new GithubWorkflowDispatcher();
  return create({ config, env, store, tokens, dispatcher });
}

export async function runHandleEventCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  factory: HandlerFactory = composeGithubHandlers,
): Promise<number> {
  try {
    const value = await readEventArgument(argv);
    const handlers = await factory(env);
    await handleEvent(value, handlers);
    return HANDLE_EVENT_EXIT.ok;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "handle-event failed"}\n`,
    );
    return classifyHandleEventError(error);
  }
}

if (process.argv[1]?.endsWith("handle-event.js")) {
  runHandleEventCli(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
