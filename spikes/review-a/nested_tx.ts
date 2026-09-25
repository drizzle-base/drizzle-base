// REVIEW-A probe: what SQL does drizzle-orm/bun-sql's db.transaction() send on a reserved connection that is
// already inside BEGIN RR? (log_statement=all on this session only; read with docker logs)
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
if (!process.env.PGPASSWORD) throw new Error("run from spikes/p2-capture");
const db = new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max: 2 });
const r = await db.reserve();
await r`set log_statement = 'all'`;
await r`select 'REVIEWA-MARK-START'`;
await r`begin isolation level repeatable read`;
const [{ s: s0 }] = await r`select pg_current_snapshot()::text as s`;
await drizzle({ client: r }).transaction(async (tx) => { await tx.execute(sql`select 'REVIEWA-inside'`); });
const [{ s: s1 }] = await r`select pg_current_snapshot()::text as s`;
const [{ s: s2 }] = await r`select txid_current_if_assigned()::text as s`;
await db`select pg_sleep(0)`;
await db`create temp table if not exists x(i int)`; // noise
const other = await db`select pg_current_xact_id()::text as x`; // advances xids
const [{ s: s3 }] = await r`select pg_current_snapshot()::text as s`;
console.log({ s0, s1_same_stmt_later: s1, s3_after_other_txn: s3, snapshotChanged: s0 !== s3, other: other[0].x, s2 });
try { await r`commit`; } catch (e) { console.log("outer commit:", String(e)); }
await r`select 'REVIEWA-MARK-END'`;
r.release(); await db.close(); process.exit(0);
