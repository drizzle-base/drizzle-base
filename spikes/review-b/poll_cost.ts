// Review B probe: the cost of D12's polling transport.
// (1) an idle poll; (2) a poll while ONE write transaction stays open and other writes continue —
// the SQL-function interface re-creates the decoding context on EVERY call and re-reads WAL from the slot's
// restart_lsn, which an open transaction pins. Run from spikes/p2-capture (bun loads .env there).
import { SQL } from "bun";
const conn = (max: number) => new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max });
const db = conn(4);
const SLOT = "rb_poll_slot", PUB = "rb_poll_pub";
await db.unsafe(`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = '${SLOT}'`);
await db.unsafe(`drop publication if exists ${PUB}`);
await db.unsafe(`drop table if exists rb_poll, rb_noise`);
await db.unsafe(`create table rb_poll(id bigint primary key, v int)`);
await db.unsafe(`create table rb_noise(id bigserial primary key, v int, pad text)`);
await db.unsafe(`alter table rb_poll replica identity full`);
await db.unsafe(`create publication ${PUB} for table rb_poll`);
await db.unsafe(`select pg_create_logical_replication_slot('${SLOT}', 'pgoutput')`);
const POLL = `select count(*)::int as n from pg_logical_slot_get_binary_changes('${SLOT}', NULL, NULL, 'proto_version','1','publication_names','${PUB}')`;
const slotPos = async () => (await db.unsafe(`select restart_lsn::text r, confirmed_flush_lsn::text c, pg_current_wal_lsn()::text w, pg_size_pretty(pg_current_wal_lsn() - restart_lsn) behind from pg_replication_slots where slot_name='${SLOT}'`))[0];
async function timePolls(k: number) { const t = performance.now(); let n = 0; for (let i = 0; i < k; i++) n += (await db.unsafe(POLL))[0].n; return { ms_per_poll: +((performance.now() - t) / k).toFixed(3), msgs: n }; }
// (1) idle
await timePolls(20);
console.log("idle", JSON.stringify(await timePolls(500)));
// (1b) a SELECT 1 round trip for scale
{ const t = performance.now(); for (let i = 0; i < 500; i++) await db.unsafe("select 1"); console.log("select1_ms", ((performance.now() - t) / 500).toFixed(3)); }
// (2) open a write transaction that never commits during the test
const holder = await db.reserve();
await holder.unsafe("begin");
await holder.unsafe("insert into rb_poll values (-1, 0)");
const noise = async (rows: number) => { await db.unsafe(`insert into rb_noise(v, pad) select g, md5(g::text) from generate_series(1, ${rows}) g`); await db.unsafe(`insert into rb_poll values (${Math.floor(Math.random() * 1e9)}, 1) on conflict do nothing`); };
for (let step = 0; step < 6; step++) {
  await noise(200_000);
  const p = await timePolls(5);
  console.log("open-txn step", step, JSON.stringify({ ...p, ...(await slotPos()) }));
}
await holder.unsafe("commit"); holder.release();
await timePolls(2);
console.log("after commit", JSON.stringify({ ...(await timePolls(5)), ...(await slotPos()) }));
await db.unsafe(`select pg_drop_replication_slot('${SLOT}')`);
await db.unsafe(`drop publication ${PUB}`);
await db.unsafe(`drop table rb_poll, rb_noise`);
process.exit(0);
