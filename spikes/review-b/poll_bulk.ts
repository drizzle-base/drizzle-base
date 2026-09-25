// Review B probe: one bulk UPDATE on the wide table (REPLICA IDENTITY FULL) → what ONE poll returns to Bun.
// upto_nchanges is only checked at transaction boundaries, so a single large transaction arrives whole.
import { SQL } from "bun";
const db = new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max: 2 });
const SLOT = "rb_bulk_slot", PUB = "rb_bulk_pub";
await db.unsafe(`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = '${SLOT}'`);
await db.unsafe(`drop publication if exists ${PUB}`);
await db.unsafe(`alter table rb_wide replica identity full`);
await db.unsafe(`create publication ${PUB} for table rb_wide`);
await db.unsafe(`select pg_create_logical_replication_slot('${SLOT}', 'pgoutput')`);
await db.unsafe(`update rb_wide set views = views + 1`); // 20 000 rows, one statement, one transaction
const rss0 = process.memoryUsage().rss;
const t = performance.now();
const rows = await db.unsafe(`select data from pg_logical_slot_get_binary_changes('${SLOT}', NULL, 100, 'proto_version','1','publication_names','${PUB}')`);
const ms = performance.now() - t;
let bytes = 0; for (const r of rows) bytes += (r.data as Uint8Array).byteLength;
console.log(JSON.stringify({ upto_nchanges: 100, messages_returned: rows.length, payload_mb: +(bytes / 1e6).toFixed(1), poll_ms: +ms.toFixed(0), rss_delta_mb: +((process.memoryUsage().rss - rss0) / 1e6).toFixed(0) }));
await db.unsafe(`select pg_drop_replication_slot('${SLOT}')`);
await db.unsafe(`drop publication ${PUB}`);
await db.unsafe(`alter table rb_wide replica identity default`);
process.exit(0);
