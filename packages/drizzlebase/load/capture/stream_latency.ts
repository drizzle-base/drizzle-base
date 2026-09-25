// Commit → onEvent latency of PgoutputCapture: idle, then with one open transaction pinning the slot while
// 400k-row noise is written (the case that made polling O(WAL)). Run: bun --preload ./test/support/env.ts
// load/capture/stream_latency.ts (from the package dir, with the test database up). Prints JSON lines; copy them into docs/BENCH.md.
import { dropCapture, ensureCapture } from "../../src/capture";
import { PgoutputCapture } from "../../src/capture";
import { pgConfig, testSql, uniqueName } from "../../test/support/db";

const sql = testSql(4);
const n = { schema: uniqueName("bench"), publication: uniqueName("pub"), slot: uniqueName("slot") };
await sql.unsafe(`create schema "${n.schema}"; create table "${n.schema}".t(id bigint primary key, v int); create table "${n.schema}".noise(id bigserial primary key, v int, pad text)`);
await ensureCapture(sql, n);
const waiters = new Map<number, (t: number) => void>();
const cap = new PgoutputCapture({ connection: pgConfig, names: n });
await cap.start({
	onEvent: (e) => { if (e.kind === "txn") for (const c of e.txn.changes) { const id = Number(c.new?.id); waiters.get(id)?.(performance.now()); } },
	onError: (e) => { console.error(e); process.exit(1); },
});
async function lat(k: number, base: number) {
	const xs: number[] = [];
	for (let i = 0; i < k; i++) {
		const id = base + i;
		const seen = new Promise<number>((r) => waiters.set(id, r));
		const t0 = performance.now();
		await sql.unsafe(`insert into "${n.schema}".t values (${id}, 1)`);
		xs.push((await seen) - t0);
	}
	xs.sort((a, b) => a - b);
	return { p50: +xs[k >> 1]!.toFixed(2), p99: +xs[Math.floor(k * 0.99)]!.toFixed(2) };
}
console.log(JSON.stringify({ case: "idle", ...(await lat(500, 1)) }));
const holder = await sql.reserve();
await holder.unsafe("begin");
await holder.unsafe(`insert into "${n.schema}".t values (-1, 0)`);
for (let step = 0; step < 3; step++) {
	await sql.unsafe(`insert into "${n.schema}".noise(v, pad) select g, md5(g::text) from generate_series(1, 400000) g`);
	console.log(JSON.stringify({ case: `open-txn+noise step ${step}`, ...(await lat(200, 10_000 * (step + 1))) }));
}
await holder.unsafe("rollback");
holder.release();
await cap.stop();
await dropCapture(sql, n);
await sql.unsafe(`drop schema "${n.schema}" cascade`);
process.exit(0);
