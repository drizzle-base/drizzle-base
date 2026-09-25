// One call to run drizzle-base: the pool, the capture checks (boot fails closed if anything capture depends on is
// missing, spec D13), the runtime, the engine, the capture and the WebSocket server. After a capture failure it
// resets every subscription at once (D14: subscribers are told, never served stale), recreates the SLOT only
// (the publication stays as validated), checks the capture again, restarts it and resumes the engine — so no
// snapshot predates the new slot (P-M6). It retries with backoff until it succeeds or stop() is called.
import { SQL } from "bun";
import { assertCapture, type CaptureNames, log, type PgConnection, PgoutputCapture, recreateSlot } from "../capture";
import { Runtime } from "../runtime";
import { SubscriptionEngine } from "../subscriptions";
import type { ApiTree } from "./api";
import { type Conn, createHandler, type HandlerOptions } from "./handler";
import { CaptureSupervisor } from "./supervisor";

export interface StartOptions<S extends Record<string, unknown>> {
  connection: PgConnection;
  schema: S;
  api: ApiTree;
  names: CaptureNames;
  port?: number; // default 3210; 0 picks a free one
  hostname?: string; // default 127.0.0.1: binding a public interface is the caller's explicit choice
  connections?: number; // engine lanes (default 4)
  maxConcurrentCalls?: number; // default 8
  advanceEveryMs?: number; // a barrier so a quiet app does not retain WAL (default 10 s)
  handler?: Omit<HandlerOptions<S>, "engine" | "api" | "maxConcurrentCalls">;
}

export interface DrizzleBase<S extends Record<string, unknown>> {
  url: string;
  engine: SubscriptionEngine<S>;
  runtime: Runtime<S>;
  stop(): Promise<void>;
}

export async function startDrizzleBase<S extends Record<string, unknown>>(
  opts: StartOptions<S>,
): Promise<DrizzleBase<S>> {
  const lanes = opts.connections ?? 4;
  const callSlots = opts.maxConcurrentCalls ?? 8;
  const c = opts.connection;
  // Room for the engine's lanes, its cycle transaction and a barrier, the prune and advance queries, and every
  // concurrent call; beyond that, statements queue for a connection (never a deadlock: none waits on another).
  const sql = new SQL({
    hostname: c.host,
    port: c.port,
    database: c.database,
    username: c.user,
    password: c.password,
    max: lanes + 4 + callSlots,
    prepare: false,
  });
  try {
    await assertCapture(sql, opts.names);
  } catch (e) {
    await sql.close();
    throw e;
  }
  const runtime = new Runtime({ sql, schema: opts.schema, publication: opts.names.publication });
  const engine = new SubscriptionEngine({ runtime, sql, connections: lanes });

  // A failed capture delivers nothing more (its failure latch), so events need no generation check here; the
  // supervisor ignores errors from older captures.
  const supervisor = new CaptureSupervisor({
    start: async (onError) => {
      const cap = new PgoutputCapture({
        connection: c,
        names: opts.names,
        advance: { sql, everyMs: opts.advanceEveryMs ?? 10_000 },
      });
      await cap.start({ onEvent: (e) => engine.onEvent(e), onError });
      return cap;
    },
    prepare: async () => {
      await recreateSlot(sql, opts.names.slot);
      await assertCapture(sql, opts.names);
    },
    reset: () => engine.reset("the change stream failed"),
    resume: () => {
      engine.resume();
      log.info("capture restarted", { slot: opts.names.slot });
    },
    onRestartError: (e, attempt) =>
      log.error("capture restart failed", {
        slot: opts.names.slot,
        attempt,
        error: e instanceof Error ? e.name : typeof e,
      }),
  });

  const handler = createHandler({ ...opts.handler, engine, api: opts.api, maxConcurrentCalls: callSlots });
  let server: ReturnType<typeof Bun.serve<Conn>> | undefined;
  try {
    await supervisor.start();
    server = Bun.serve<Conn>({
      hostname: opts.hostname ?? "127.0.0.1",
      port: opts.port ?? 3210,
      fetch: (req, s) => handler.upgrade(req, s),
      websocket: handler.websocket,
    });
  } catch (e) {
    await supervisor.stop();
    engine.close();
    await sql.close();
    throw e;
  }
  const bound = server;

  return {
    url: `ws://${bound.hostname}:${bound.port}`,
    engine,
    runtime,
    async stop() {
      handler.close();
      await bound.stop(true);
      await supervisor.stop(); // waits for a restart in progress; no capture is left running
      engine.close();
      await sql.close();
    },
  };
}
