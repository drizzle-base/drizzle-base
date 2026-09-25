// What a client learns about a failure. Only a DrizzleBaseError — thrown on purpose by application code — carries
// its message and data to the client (Convex's ConvexError model). Anything else is `internal` with no detail: a
// driver error's message holds SQL and parameters, which are user data (appsec: no dumps, no leaks). The server
// log gets the error class and SQLSTATE only, never a message or values.
import { log } from "../capture";
import { encodeValue, type WireError } from "../protocol";
import { CommitOutcomeUnknownError } from "../runtime";
import { EngineDownError } from "../subscriptions";

export class DrizzleBaseError extends Error {
  override name = "DrizzleBaseError";
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const root = (e: unknown): unknown => {
  let cur = e;
  for (let i = 0; i < 5 && (cur as { cause?: unknown })?.cause; i++) cur = (cur as { cause: unknown }).cause;
  return cur;
};

export function toWireError(e: unknown): WireError {
  if (e instanceof DrizzleBaseError) {
    try {
      return e.data === undefined
        ? { code: "app", message: e.message }
        : { code: "app", message: e.message, data: encodeValue(e.data) };
    } catch {
      // Unencodable data, or data whose getters throw: never an exception out of here (it would escape a frame
      // handler as an unhandled rejection, which ends the process).
      return { code: "internal" };
    }
  }
  if (e instanceof EngineDownError) return { code: "unavailable" };
  if (e instanceof CommitOutcomeUnknownError) return { code: "commit_unknown" };
  return { code: "internal" };
}

// The redacted log line for a failure the client saw as `internal`: which function, which frame, which class of
// error, which SQLSTATE — never its message, arguments or values.
export function logInternal(e: unknown, where: { fn?: string; frame?: string }): void {
  const r = root(e) as { name?: unknown; errno?: unknown } | undefined;
  log.error("function failed", {
    ...where,
    error: typeof (e as { name?: unknown })?.name === "string" ? (e as { name: string }).name : typeof e,
    cause: typeof r?.name === "string" ? r.name : undefined,
    sqlstate: r?.errno === undefined ? undefined : String(r.errno),
  });
}
