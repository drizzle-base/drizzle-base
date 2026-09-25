// REVIEW-A probe: (1) D8 exported snapshot as seen by pg_current_snapshot() in importers;
// (2) D13 — a Drizzle `db.transaction()` inside a handler whose reserved connection already runs BEGIN RR.
// Run from spikes/p2-capture: bun ../review-a/snap_and_driver.ts
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
if (!process.env.PGPASSWORD) throw new Error("run from spikes/p2-capture");
const db = new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max: 6 });
await db.unsafe(`drop table if exists ra_s; create table ra_s(id int primary key, v int); insert into ra_s values (1, 0)`);

// (1) exported snapshot
const ex = await db.reserve();
await ex`begin isolation level repeatable read`;
const [{ id: snapId }] = await ex`select pg_export_snapshot() as id`;
const [{ s: exS }] = await ex`select pg_current_snapshot()::text as s`;
await db`update ra_s set v = v + 1 where id = 1`; // commits AFTER the export
const imps = [];
for (let i = 0; i < 3; i++) {
	const c = await db.reserve();
	await c`begin isolation level repeatable read read only`;
	await c.unsafe(`set transaction snapshot '${snapId}'`);
	const [{ s }] = await c`select pg_current_snapshot()::text as s`;
	const [{ v }] = await c`select v from ra_s where id = 1`;
	imps.push({ s, v });
	await c`commit`; c.release();
}
console.log("(1) exporter snapshot", exS, "importers:", JSON.stringify(imps));
await ex`commit`; ex.release();

// (2) drizzle transaction on a reserved connection that is already inside BEGIN RR
const r = await db.reserve();
await r`begin isolation level repeatable read`;
const [{ s: s0 }] = await r`select pg_current_snapshot()::text as s`;
const d = drizzle({ client: r });
let err = "";
try {
	await d.transaction(async (tx) => { await tx.execute(sql`select 1`); });
} catch (e) { err = String(e).slice(0, 160); }
const [{ st }] = await r`select (case when pg_current_xact_id_if_assigned() is null and now() = statement_timestamp() then 'NOT in a transaction (autocommit)' else 'still in a transaction' end) as st`;
await db`update ra_s set v = v + 100 where id = 1`;
const [{ v: after }] = await r`select v from ra_s where id = 1`;
console.log("(2) outer snapshot", s0, "| drizzle tx error:", err || "none", "| afterwards:", st, "| sees concurrent commit:", after >= 100);
try { await r`commit`; } catch {}
r.release();
await db.unsafe(`drop table ra_s`);
await db.close();
process.exit(0);
