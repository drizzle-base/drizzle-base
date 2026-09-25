import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { emitBarrier } from "../src/capture/barrier";
import { PgoutputCapture } from "../src/capture/pgoutput";
import { type CaptureNames, ensureCapture } from "../src/capture/setup";
import type { CapturedTxn, StreamEvent } from "../src/capture/types";
import { pgConfig, withCaptureSchema } from "./db";

function collector() {
	const events: StreamEvent[] = [];
	const waiters = new Map<string, () => void>();
	const errors: Error[] = [];
	return {
		events,
		errors,
		txns: () => events.filter((e): e is { kind: "txn"; txn: CapturedTxn } => e.kind === "txn").map((e) => e.txn),
		handlers: {
			onEvent: (e: StreamEvent) => {
				events.push(e);
				if (e.kind === "barrier") waiters.get(e.id)?.();
			},
			onError: (e: Error) => errors.push(e),
		},
		async sync(sql: SQL, id: string) {
			const seen = new Promise<void>((r) => waiters.set(id, r));
			await emitBarrier(sql, id);
			await Promise.race([seen, Bun.sleep(10_000).then(() => { throw new Error(`barrier ${id} not seen in 10 s`); })]);
		},
	};
}

async function started(sql: SQL, n: CaptureNames, c: ReturnType<typeof collector>, rowCap?: number) {
	await ensureCapture(sql, n);
	const cap = new PgoutputCapture({ connection: pgConfig, names: n, rowCap });
	await cap.start(c.handlers);
	return cap;
}

describe("PgoutputCapture", () => {
	test("delivers committed transactions in commit order, then the barrier", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".t(id int primary key, v int)`);
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				await sql.unsafe(`insert into "${n.schema}".t values (1, 1)`);
				await sql.unsafe(`update "${n.schema}".t set v = 2 where id = 1`);
				await c.sync(sql, "b1");
				const kinds = c.events.map((e) => (e.kind === "txn" ? e.txn.changes.map((x) => x.op).join() : `barrier:${e.id}`));
				expect(kinds.slice(-3)).toEqual(["insert", "update", "barrier:b1"]);
				const upd = c.txns().at(-1)!.changes[0]!;
				expect(upd.old).toEqual({ id: 1, v: 1 });
				expect(upd.new).toEqual({ id: 1, v: 2 });
			} finally {
				await cap.stop();
			}
		});
	});

	test("a barrier on an otherwise idle database arrives", async () => {
		await withCaptureSchema(async (sql, n) => {
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				await c.sync(sql, "idle-barrier"); // nothing else commits: the barrier must flush itself
			} finally {
				await cap.stop();
			}
		});
	});

	test("after an acknowledged transaction and a restart, the next barrier is delivered", async () => {
		// The acknowledged position must not pass the end of the WAL: a record written exactly there (the next
		// barrier) would be skipped as already confirmed, and a cycle waiting on it would hang.
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".t(id int primary key)`);
			const a = collector();
			const first = await started(sql, n, a);
			const [{ c: before }] = await sql`select confirmed_flush_lsn::text as c from pg_replication_slots where slot_name = ${n.slot}`;
			await sql.unsafe(`insert into "${n.schema}".t values (1)`);
			// Wait for the acknowledgement to reach the slot — and write NOTHING else, so the next record lands
			// exactly at the end of the acknowledged commit.
			for (let i = 0; i < 100; i++) {
				const [{ c }] = await sql`select confirmed_flush_lsn::text as c from pg_replication_slots where slot_name = ${n.slot}`;
				if (c !== before && a.txns().length) break;
				await Bun.sleep(50);
			}
			await first.stop();
			const b = collector();
			const second = new PgoutputCapture({ connection: pgConfig, names: n });
			await second.start(b.handlers);
			try {
				await b.sync(sql, "after-restart");
				expect(b.txns().flatMap((t) => t.changes)).toEqual([]); // the acknowledged insert is not redelivered
			} finally {
				await second.stop();
			}
		});
	}, 30_000);

	test("a barrier arrives promptly on a quiet database (median of 20 under 50 ms)", async () => {
		// Read-your-writes and every flush cycle wait on a barrier; a barrier left for the WAL writer to flush
		// costs up to wal_writer_delay (200 ms) per wait.
		await withCaptureSchema(async (sql, n) => {
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				const ms: number[] = [];
				for (let i = 0; i < 20; i++) {
					const t0 = performance.now();
					await c.sync(sql, `lat-${i}`);
					ms.push(performance.now() - t0);
					await Bun.sleep(20);
				}
				ms.sort((a, b) => a - b);
				expect(ms[10]!).toBeLessThan(50);
			} finally {
				await cap.stop();
			}
		});
	}, 30_000);

	test("a rolled-back transaction is never delivered", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".t(id int primary key)`);
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				await sql.begin(async (tx) => { await tx.unsafe(`insert into "${n.schema}".t values (1)`); throw new Error("abort"); }).catch(() => {});
				await c.sync(sql, "b2");
				expect(c.txns().flatMap((t) => t.changes)).toEqual([]);
			} finally {
				await cap.stop();
			}
		});
	});

	test("DDL arrives flagged, in commit order", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".t(id int primary key, v int)`);
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				await sql.unsafe(`alter table "${n.schema}".t alter column v type bigint using (v * 10)`);
				await c.sync(sql, "b3");
				expect(c.txns().some((t) => t.ddl)).toBe(true);
			} finally {
				await cap.stop();
			}
		});
	});

	test("an unacknowledged transaction is redelivered", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".t(id int primary key)`);
			await ensureCapture(sql, n);
			// First consumer never finishes its handler: nothing is acknowledged.
			const first = new PgoutputCapture({ connection: pgConfig, names: n });
			let got = false;
			await first.start({ onEvent: (e) => { if (e.kind === "txn" && e.txn.changes.length) { got = true; return new Promise<void>(() => {}); } }, onError: () => {} });
			await sql.unsafe(`insert into "${n.schema}".t values (42)`);
			for (let i = 0; i < 100 && !got; i++) await Bun.sleep(50);
			expect(got).toBe(true);
			await first.stop();
			// A new consumer on the same slot must see it again.
			const c = collector();
			const second = new PgoutputCapture({ connection: pgConfig, names: n });
			await second.start(c.handlers);
			try {
				await c.sync(sql, "b4");
				expect(c.txns().flatMap((t) => t.changes).some((ch) => ch.new?.id === 42)).toBe(true);
			} finally {
				await second.stop();
			}
		});
	});

	test("after a handler throws, nothing later is acknowledged: the failed transaction is redelivered", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".t(id int primary key)`);
			await ensureCapture(sql, n);
			const errors: Error[] = [];
			const first = new PgoutputCapture({ connection: pgConfig, names: n });
			await first.start({
				onEvent: (e) => { if (e.kind === "txn" && e.txn.changes.some((c) => c.new?.id === 1)) throw new Error("apply failed"); },
				onError: (e) => errors.push(e),
			});
			await sql.unsafe(`insert into "${n.schema}".t values (1)`);
			await sql.unsafe(`insert into "${n.schema}".t values (2)`); // a later transaction the failed one must not be skipped behind
			for (let i = 0; i < 100 && !errors.length; i++) await Bun.sleep(50);
			expect(errors.map((e) => e.message)).toContain("apply failed");
			await Bun.sleep(300); // give a wrong implementation time to acknowledge id=2
			await first.stop();
			const c = collector();
			const second = new PgoutputCapture({ connection: pgConfig, names: n });
			await second.start(c.handlers);
			try {
				await c.sync(sql, "b-fail");
				expect(c.txns().flatMap((t) => t.changes).map((ch) => ch.new?.id)).toContain(1);
			} finally {
				await second.stop();
			}
		});
	});

	test("a terminated walsender surfaces onError", async () => {
		await withCaptureSchema(async (sql, n) => {
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				await sql`select pg_terminate_backend(active_pid) from pg_replication_slots where slot_name = ${n.slot} and active_pid is not null`;
				for (let i = 0; i < 100 && !c.errors.length; i++) await Bun.sleep(50);
				expect(c.errors.length).toBeGreaterThan(0);
			} finally {
				await cap.stop();
			}
		});
	});

	test("odd values decode", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".o(id int primary key, j jsonb, x numeric, t text, b bytea, ts timestamptz, z int)`);
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				await sql.unsafe(`insert into "${n.schema}".o values (1, '{"a":[1,"😀"]}', 1.50, E'a\\nb 😀 İ', '\\xdeadbeef', '2026-03-29 01:30:00+00', null)`);
				await c.sync(sql, "b5");
				const row = c.txns().flatMap((t) => t.changes).find((ch) => ch.table === `${n.schema}.o`)?.new;
				expect(row).toBeDefined();
				expect(row?.z).toBeNull();
				expect(String(row?.t)).toContain("😀");
			} finally {
				await cap.stop();
			}
		});
	});

	test("survives idle past wal_sender_timeout", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".t(id int primary key)`);
			await sql.unsafe(`alter system set wal_sender_timeout = '2s'`);
			await sql`select pg_reload_conf()`;
			const c = collector();
			const cap = await started(sql, n, c);
			try {
				await Bun.sleep(5_000);
				await sql.unsafe(`insert into "${n.schema}".t values (1)`);
				await c.sync(sql, "b6");
				expect(c.errors).toEqual([]);
				expect(c.txns().flatMap((t) => t.changes)).toHaveLength(1);
			} finally {
				await cap.stop();
				await sql.unsafe(`alter system reset wal_sender_timeout`);
				await sql`select pg_reload_conf()`;
			}
		});
	}, 30_000);
});
