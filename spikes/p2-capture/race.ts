// THROWAWAY SPIKE (P4) — the subscribe race: which stream changes are "already in" a query's result?
//
// A subscription = run the query at snapshot S1, then react to every streamed change NOT reflected in S1.
// Rules compared:
//   A   LSN read AFTER the query (same REPEATABLE READ txn): react to commits with commit-LSN > lsn.
//   A'  LSN read BEFORE the query (autocommit, then the RR txn): same comparison.
//   B   xid visibility: react to a transaction iff its xid is NOT visible in S1 (pg_current_snapshot()).
// Judge: later, snapshot S2 re-runs the query. If R1 ≠ R2, some change that is visible in S2 and that the
// rule reacted to must touch k = X (old or new image). Otherwise the subscriber missed it forever.
//
//   bun race.ts [--trials=300] [--sabotage=xip]
import { SQL } from "bun";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const TRIALS = Number(arg("trials", "300"));
const SABOTAGE = arg("sabotage", "");
const GAP = Number(arg("gap", "8")); // ms between a writer's transactions: larger = fewer masking changes
if (!process.env.PGPASSWORD) throw new Error("PGPASSWORD missing: run from spikes/p2-capture (bun loads .env)");
const conn = (max: number) => new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max });

const admin = conn(1);
await admin.unsafe(`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name in ('p4', 'bench', 'spike')`);
await admin.unsafe(`drop table if exists t; create table t(id int primary key, k int not null, v int not null);
  insert into t select g, g % 4, 0 from generate_series(1, 20) g; alter table t replica identity full`);
await admin.unsafe(`select pg_create_logical_replication_slot('p4', 'test_decoding')`);

// ── the stream: committed transactions with their commit LSN and the k values their images touched ──────
const lsnNum = (s: string) => { const [h, l] = s.split("/"); return BigInt(`0x${h}`) * 2n ** 32n + BigInt(`0x${l}`); };
interface Txn { xid: bigint; commitLsn: bigint; ks: Set<number> }
const log: Txn[] = [];
let streamedUpTo = 0n;
const open = new Map<string, Set<number>>();
const streamer = conn(1);
let stop = false;
async function pump(): Promise<void> {
	for (const r of await streamer`select lsn::text as lsn, xid::text as xid, data from pg_logical_slot_get_changes('p4', null, null)`) {
		const d = r.data as string;
		if (d.startsWith("BEGIN")) open.set(r.xid, new Set());
		else if (d.startsWith("COMMIT")) { log.push({ xid: BigInt(r.xid), commitLsn: lsnNum(r.lsn), ks: open.get(r.xid) ?? new Set() }); open.delete(r.xid); }
		else for (const m of d.matchAll(/ k\[integer\]:(\d+)/g)) open.get(r.xid)?.add(Number(m[1]));
		streamedUpTo = lsnNum(r.lsn);
	}
}
const streamLoop = (async () => { while (!stop) { await pump(); await Bun.sleep(1); } })();

// ── writers: short transactions, a small sleep INSIDE so snapshots often see them in progress (xip) ─────────
const writers = conn(6);
const writerLoops = Array.from({ length: 6 }, async () => {
	while (!stop) {
		await writers.begin(async (tx) => {
			await tx`update t set v = v + 1, k = ${Math.floor(Math.random() * 4)} where id = ${1 + Math.floor(Math.random() * 20)}`;
			await tx`select pg_sleep(${Math.random() * 0.004})`;
		});
		await Bun.sleep(Math.random() * GAP);
	}
});

// ── subscriptions ────────────────────────────────────────────────────────────
type Snap = { xmin: bigint; xmax: bigint; xip: Set<bigint> };
const parseSnap = (s: string): Snap => { const [a, b, c] = s.split(":"); return { xmin: BigInt(a), xmax: BigInt(b), xip: new Set(c ? c.split(",").map(BigInt) : []) }; };
const visible = (xid: bigint, s: Snap) => xid < s.xmin || (xid < s.xmax && (SABOTAGE === "xip" || !s.xip.has(xid)));

const subs = conn(1);
async function snapQuery(x: number, lsnWhen: "before" | "after" | "none") {
	const c = await subs.reserve();
	try {
		let lsn = 0n;
		if (lsnWhen === "before") lsn = lsnNum((await c`select pg_current_wal_lsn()::text as l`)[0].l);
		await c`begin isolation level repeatable read`;
		const [{ s }] = await c`select pg_current_snapshot()::text as s`; // the RR snapshot is taken here
		const rows = await c`select id, v from t where k = ${x} order by id`;
		if (lsnWhen === "after") { await Bun.sleep(Math.random() * 3); lsn = lsnNum((await c`select pg_current_wal_lsn()::text as l`)[0].l); }
		await c`commit`;
		return { snap: parseSnap(s), result: JSON.stringify(rows), lsn };
	} finally { c.release(); }
}

const RULES = ["A", "A'", "B"] as const;
const stats = Object.fromEntries(RULES.map((r) => [r, { trials: 0, changed: 0, viol: 0 }]));
for (let i = 0; i < TRIALS; i++) {
	const rule = RULES[i % 3];
	const x = Math.floor(Math.random() * 4);
	const s1 = await snapQuery(x, rule === "A" ? "after" : rule === "A'" ? "before" : "none");
	await Bun.sleep(5 + Math.random() * 10);
	const s2 = await snapQuery(x, "none");
	// wait until the stream has passed everything S2 could see
	const target = lsnNum((await admin`select pg_current_wal_lsn()::text as l`)[0].l);
	while (streamedUpTo < target) { await admin`select pg_logical_emit_message(false, 'tick', '')`; await Bun.sleep(2); }
	const reacted = log.filter((t) => visible(t.xid, s2.snap) && t.ks.has(x) && (rule === "B" ? !visible(t.xid, s1.snap) : t.commitLsn > s1.lsn));
	const st = stats[rule];
	st.trials++;
	if (s1.result !== s2.result) { st.changed++; if (!reacted.length) st.viol++; }
}
stop = true;
await Promise.all([streamLoop, ...writerLoops]);
console.log(`trials=${TRIALS}${SABOTAGE ? ` SABOTAGE=${SABOTAGE}` : ""} streamed txns=${log.length}`);
for (const r of RULES) console.log(`rule ${r.padEnd(3)} trials=${stats[r].trials} resultChanged=${stats[r].changed} MISSED=${stats[r].viol}`);
await admin.unsafe(`select pg_drop_replication_slot('p4')`);
await Promise.all([admin.close(), streamer.close(), writers.close(), subs.close()]);
process.exit(0);
