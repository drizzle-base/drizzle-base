// A running engine on the test application: capture → engine.onEvent, capture failure → engine.reset.
import type { SQL } from "bun";
import { type CaptureNames, PgoutputCapture } from "../../src/capture";
import { Runtime } from "../../src/runtime";
import { type EngineEvent, SubscriptionEngine } from "../../src/subscriptions";
import { schema, withApp } from "./app";
import { pgConfig } from "./db";

export interface EngineHarness {
  sql: SQL;
  names: CaptureNames;
  runtime: Runtime<typeof schema>;
  engine: SubscriptionEngine<typeof schema>;
  capture: PgoutputCapture;
}

export async function withEngine(
  fn: (h: EngineHarness) => Promise<void>,
  opts: { connections?: number; barrierTimeoutMs?: number; pruneEveryMs?: number } = {},
): Promise<void> {
  await withApp(async (sql, names) => {
    const runtime = new Runtime({ sql, schema, publication: names.publication });
    const engine = new SubscriptionEngine({ runtime, sql, ...opts });
    const capture = new PgoutputCapture({ connection: pgConfig, names });
    await capture.start({ onEvent: (e) => engine.onEvent(e), onError: (e) => engine.reset(String(e)) });
    try {
      await fn({ sql, names, runtime, engine, capture });
    } finally {
      engine.close();
      await capture.stop(); // idempotent: a test may have stopped it already
    }
  });
}

export function recorder<R>() {
  const events: EngineEvent<R>[] = [];
  const waiters: { pred: (e: EngineEvent<R>) => boolean; resolve: (e: EngineEvent<R>) => void }[] = [];
  return {
    events,
    listener: (e: EngineEvent<R>) => {
      events.push(e);
      for (const w of [...waiters])
        if (w.pred(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
    },
    wait(pred: (e: EngineEvent<R>) => boolean, ms = 5_000): Promise<EngineEvent<R>> {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return Promise.race([
        new Promise<EngineEvent<R>>((resolve) => waiters.push({ pred, resolve })),
        Bun.sleep(ms).then((): never => {
          throw new Error(`no matching event in ${ms} ms; got ${JSON.stringify(events)}`);
        }),
      ]);
    },
    last(): EngineEvent<R> | undefined {
      return events.at(-1);
    },
  };
}
