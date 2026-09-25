// Per-checkout test databases (test/support/testdb.ts) isolate suites only if a slot never decodes another
// database's messages: barriers are pg_logical_emit_message, written to the cluster's one WAL. This pins the
// Postgres behaviour the isolation rests on.
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { emitBarrier, ensureCapture, PgoutputCapture, type StreamEvent } from "../../../src/capture";
import { pgConfig, withCaptureSchema } from "../../support/db";

const connect = (database: string) =>
  new SQL({
    hostname: pgConfig.host,
    port: pgConfig.port,
    database,
    username: pgConfig.user,
    password: pgConfig.password,
    max: 1,
    prepare: false,
  });

test("a slot never sees a barrier emitted in another database of the cluster", async () => {
  const sibling = `dzb_test_iso_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = connect("postgres");
  await admin.unsafe(`create database "${sibling}"`);
  try {
    await withCaptureSchema(async (sql, n) => {
      await ensureCapture(sql, n);
      const events: StreamEvent[] = [];
      const seen = new Map<string, () => void>();
      const cap = new PgoutputCapture({ connection: pgConfig, names: n });
      await cap.start({
        onEvent: (e) => {
          events.push(e);
          if (e.kind === "barrier") seen.get(e.id)?.();
        },
        onError: () => {},
      });
      const other = connect(sibling);
      try {
        const waitFor = (id: string) =>
          Promise.race([
            new Promise<void>((r) => seen.set(id, r)),
            Bun.sleep(5_000).then(() => {
              throw new Error(`barrier ${id} not seen`);
            }),
          ]);
        expect(await emitBarrier(other, "foreign")).toMatch(/\//); // the premise: it was written to the WAL
        const twin = waitFor("twin");
        await emitBarrier(sql, "twin"); // the loud twin: the same message in this database arrives
        await twin;
        const last = waitFor("last");
        await emitBarrier(sql, "last"); // written after "foreign": had it been decoded, it would be in by now
        await last;
        expect(events.some((e) => e.kind === "barrier" && e.id === "foreign")).toBe(false);
      } finally {
        await other.close();
        await cap.stop();
      }
    });
  } finally {
    await admin.unsafe(`drop database if exists "${sibling}" with (force)`);
    await admin.close();
  }
});
