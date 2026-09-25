// Review B probe: does a STREAMING replication client (pg-logical-replication over `pg`) run under Bun, and
// what does it cost vs polling — commit→receive latency, and the open-transaction case that made polls O(WAL).
import { LogicalReplicationService, PgoutputPlugin } from "pg-logical-replication";
import { SQL } from "bun";
const cfg = { host: "127.0.0.1", port: 5477, database: "spike", user: "postgres", password: process.env.PGPASSWORD };
const db = new SQL({ hostname: cfg.host, port: cfg.port, database: cfg.database, username: cfg.user, password: cfg.password, max: 4 });
const SLOT = "rb_stream_slot", PUB = "rb_stream_pub";
await db.unsafe(`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = '${SLOT}'`);
await db.unsafe(`drop publication if exists ${PUB}`);
await db.unsafe(`drop table if exists rb_s, rb_snoise`);
await db.unsafe(`create table rb_s(id bigint primary key, v int, t bigint)`);
await db.unsafe(`create table rb_snoise(id bigserial primary key, v int, pad text)`);
await db.unsafe(`alter table rb_s replica identity full`);
await db.unsafe(`create publication ${PUB} for table rb_s`);
await db.unsafe(`select pg_create_logical_replication_slot('${SLOT}', 'pgoutput')`);
const svc = new LogicalReplicationService(cfg, { acknowledge: { auto: true, timeoutSeconds: 10 } });
const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [PUB] });
const waiters = new Map<number, (t: number) => void>();
svc.on("data", (_lsn: string, msg: any) => { if (msg.tag === "insert") { const id = Number(msg.new.id); waiters.get(id)?.(performance.now()); } });
svc.on("error", (e: any) => console.error("stream error", e.message));
svc.subscribe(plugin, SLOT);
await Bun.sleep(500);
async function lat(k: number, base: number) {
  const xs: number[] = [];
  for (let i = 0; i < k; i++) { const id = base + i; const p = new Promise<number>((r) => waiters.set(id, r)); const t0 = performance.now(); await db.unsafe(`insert into rb_s values (${id}, 1, 0)`); const t1 = await p; xs.push(t1 - t0); }
  xs.sort((a, b) => a - b); return { p50: +xs[k >> 1].toFixed(2), p99: +xs[Math.floor(k * 0.99)].toFixed(2) };
}
console.log("stream commit→receive (ms, incl. the insert round trip)", JSON.stringify(await lat(300, 1)));
const holder = await db.reserve(); await holder.unsafe("begin"); await holder.unsafe("insert into rb_s values (-1, 0, 0)");
for (let step = 0; step < 3; step++) { await db.unsafe(`insert into rb_snoise(v, pad) select g, md5(g::text) from generate_series(1, 400000) g`); console.log("open txn + noise step", step, JSON.stringify(await lat(100, 10000 * (step + 1)))); }
await holder.unsafe("rollback"); holder.release();
await svc.stop();
await db.unsafe(`select pg_drop_replication_slot('${SLOT}')`); await db.unsafe(`drop publication ${PUB}`); await db.unsafe(`drop table rb_s, rb_snoise`);
process.exit(0);
