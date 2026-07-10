import { readFile } from "node:fs/promises";

import type { StoredPlanState } from "../coordinator/state.js";

export const HANDLE_EVENT_EXIT = { ok: 0, validation: 2, conflict: 3, operational: 4 } as const;
export type EventHandlers = { ready(value: unknown): Promise<StoredPlanState>; receipt(value: unknown): Promise<StoredPlanState> };

export async function handleEvent(value: unknown, handlers: EventHandlers): Promise<StoredPlanState> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("event must be an object");
  const eventType = (value as Record<string, unknown>).eventType;
  if (eventType === "lenso-plan-ready") return handlers.ready(value);
  if (eventType === "lenso-publish-receipt") return handlers.receipt(value);
  throw new TypeError("unsupported event type");
}

export function classifyHandleEventError(error: unknown): number {
  if (error instanceof TypeError) return HANDLE_EVENT_EXIT.validation;
  if (error instanceof Error && /(?:conflict|occupied|active immutable plan)/iu.test(error.message)) return HANDLE_EVENT_EXIT.conflict;
  return HANDLE_EVENT_EXIT.operational;
}

function args(argv: readonly string[]): { eventFile: string; eventKey: string } {
  if (argv.length !== 4 || argv[0] !== "--event-file" || argv[2] !== "--event-key") throw new TypeError("usage: handle-event --event-file PATH --event-key KEY");
  const eventFile = argv[1]!; const eventKey = argv[3]!;
  if (!eventFile.startsWith("/") || eventFile.includes("\0")) throw new TypeError("event file must be an absolute path");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(eventKey)) throw new TypeError("event key invalid");
  return { eventFile, eventKey };
}

export async function readEventArgument(argv: readonly string[]): Promise<unknown> {
  const { eventFile, eventKey } = args(argv);
  const parsed: unknown = JSON.parse(await readFile(eventFile, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("GitHub event must be an object");
  const value = (parsed as Record<string, unknown>)[eventKey];
  if (value === undefined) throw new TypeError("event payload key missing");
  return value;
}

if (process.argv[1]?.endsWith("handle-event.js")) {
  readEventArgument(process.argv.slice(2)).then(() => {
    // Network/state adapters are installed by the deployment composition root.
    process.stderr.write("handle-event adapters are not configured\n"); process.exitCode = HANDLE_EVENT_EXIT.operational;
  }).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "invalid event"}\n`); process.exitCode = classifyHandleEventError(error); });
}
