// Intercepts statements on connections reserved from a pool — to hold or fail a cycle at an exact point (after its
// export, at its COMMIT) and make a race deterministic. The hook sees each statement with `run` (sends it) and a
// per-connection state object. Returning undefined lets the statement through untouched — Drizzle calls `.values()`
// on the returned query, so for its statements the query object itself must come back. Returning a promise
// replaces the result: `run().then(...)` delays after the statement ran, `gate.then(run)` delays before it. Only
// statements the caller awaits directly (the engine's own BEGIN / export / COMMIT) may be replaced.
import type { ReservedSQL, SQL } from "bun";

type Unsafe = ReservedSQL["unsafe"];
export type ConnState = { tag?: string };
export type Hook = (query: string, run: () => Promise<unknown>, conn: ConnState) => Promise<unknown> | undefined;

export function interceptReserved(pool: SQL, hook: Hook): () => void {
  const target = pool as unknown as { reserve: () => Promise<ReservedSQL> };
  const real = target.reserve.bind(pool);
  target.reserve = async () => {
    const conn = await real();
    const original = conn.unsafe.bind(conn) as Unsafe;
    const state: ConnState = {};
    (conn as unknown as { unsafe: Unsafe }).unsafe = ((query: string, params?: unknown[]) => {
      const replaced = hook(query, () => Promise.resolve(original(query, params)), state);
      return replaced ?? original(query, params);
    }) as Unsafe;
    return conn;
  };
  return () => {
    target.reserve = real;
  };
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export const isExport = (q: string) => q.includes("pg_export_snapshot()");
