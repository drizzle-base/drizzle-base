// THROWAWAY SPIKE (P2c) — can the outbox consumer MISS a row?
//
// bigserial ids are handed out at INSERT time, commits land in another order. A consumer that polls
// `id > last` advances past an id whose transaction has not committed yet, and never sees it. The xid cursor
// only reads rows of transactions older than the snapshot's xmin (all finished), so none can appear later.
//
//   bun consumer.ts [--seconds=8] [--writers=8]
import { SQL } from "bun";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const SECONDS = Number(arg("seconds", "8"));
const WRITERS = Number(arg("writers", "8"));
if (!process.env.PGPASSWORD) throw new Error("PGPASSWORD missing: run from spikes/p2-capture (bun loads .env)");
const conn = (max: number) => new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max });

const admin = conn(1);
await admin.unsafe(`drop table if exists _outbox2; create table _outbox2(id bigserial primary key, xid xid8 not null default pg_current_xact_id(), note text)`);

const writers = conn(WRITERS);
let stop = false;
const writer = async () => {
	while (!stop) await writers.begin(async (tx) => { await tx`insert into _outbox2(note) values ('w')`; await tx`select pg_sleep(${Math.random() * 0.02})`; });
};

const naive = conn(1), xidc = conn(1);
const seenNaive = new Set<string>(), seenXid = new Set<string>();
let dupXid = 0, last = "0", lo: string | null = null;
const lagXid: number[] = [];
const pollNaive = async () => {
	while (!stop) {
		for (const r of await naive`select id::text as id from _outbox2 where id > ${last}::bigint order by id`) { seenNaive.add(r.id); last = r.id; }
		await Bun.sleep(2);
	}
};
const pollXid = async () => {
	while (!stop) {
		const [{ xmin }] = await xidc`select pg_snapshot_xmin(pg_current_snapshot())::text as xmin`;
		const rows = lo === null
			? await xidc`select id::text as id from _outbox2 where xid < ${xmin}::xid8`
			: await xidc`select id::text as id from _outbox2 where xid >= ${lo}::xid8 and xid < ${xmin}::xid8`;
		for (const r of rows) { if (seenXid.has(r.id)) dupXid++; seenXid.add(r.id); }
		lo = xmin;
		await Bun.sleep(2);
	}
};

const t0 = Date.now();
const all = [...Array.from({ length: WRITERS }, writer), pollNaive(), pollXid()];
await Bun.sleep(SECONDS * 1000);
stop = true;
await Promise.all(all);
// one final pass each, after every writer is done
for (const r of await naive`select id::text as id from _outbox2 where id > ${last}::bigint`) seenNaive.add(r.id);
const [{ xmin }] = await xidc`select pg_snapshot_xmin(pg_current_snapshot())::text as xmin`;
for (const r of await xidc`select id::text as id from _outbox2 where xid >= ${lo ?? "0"}::xid8 and xid < ${xmin}::xid8`) { if (seenXid.has(r.id)) dupXid++; seenXid.add(r.id); }

const total = (await admin`select id::text as id from _outbox2`).map((r: { id: string }) => r.id);
const missNaive = total.filter((id: string) => !seenNaive.has(id)).length;
const missXid = total.filter((id: string) => !seenXid.has(id)).length;
console.log(`rows=${total.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s writers=${WRITERS}`);
console.log(`naive  id > last : missed ${missNaive}`);
console.log(`xid8 + snapshot  : missed ${missXid}, duplicates ${dupXid}`);
void lagXid;
await Promise.all([admin.close(), writers.close(), naive.close(), xidc.close()]);
process.exit(0);
