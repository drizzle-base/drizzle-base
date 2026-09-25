// Review B probe: what one RE-RUN costs under the protocol D5+D7+D8 prescribe, vs the bare query.
// Query = P1's E03 (nested `with`: user → posts → comments) keyed by user id; D5 adds one key query per edge.
import { SQL } from "bun";
const CONC = Number(process.env.CONC ?? 8), N = Number(process.env.N ?? 4000);
const db = new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max: CONC + 2, connection: { search_path: "rb" } });
const E03 = `select "users"."id", "users"."name", "users"."email", "users"."age", "users"."manager_id", "users"."deleted", "users"."created_at", "users_posts"."data" as "posts" from "users" "users" left join lateral (select coalesce(json_agg(json_build_array("users_posts"."id", "users_posts"."author_id", "users_posts"."title", "users_posts"."published", "users_posts"."views", "users_posts"."created_at", "users_posts_comments"."data")), '[]'::json) as "data" from "posts" "users_posts" left join lateral (select coalesce(json_agg(json_build_array("users_posts_comments"."id", "users_posts_comments"."post_id", "users_posts_comments"."author_id", "users_posts_comments"."body")), '[]'::json) as "data" from "comments" "users_posts_comments" where "users_posts_comments"."post_id" = "users_posts"."id") "users_posts_comments" on true where "users_posts"."author_id" = "users"."id") "users_posts" on true where "users"."id" = $1`;
const KEY_POSTS = `select id from posts where author_id = $1`;
const KEY_COMMENTS = `select c.id, c.post_id from comments c where c.post_id in (select id from posts where author_id = $1)`;
const uid = (i: number) => `00000000-0000-7000-8000-${String(1 + (i * 7919) % 5000).padStart(12, "0")}`;
async function run(name: string, one: (c: any, i: number, snap?: string) => Promise<void>, perCycleSnapshot = false) {
  const conns = await Promise.all(Array.from({ length: CONC }, () => db.reserve()));
  let exporter: any, snap: string | undefined;
  if (perCycleSnapshot) { exporter = await db.reserve(); await exporter.unsafe("begin isolation level repeatable read read only"); snap = (await exporter.unsafe("select pg_export_snapshot() s"))[0].s; }
  let next = 0; const t = performance.now();
  await Promise.all(conns.map(async (c) => { for (;;) { const i = next++; if (i >= N) break; await one(c, i, snap); } }));
  const ms = performance.now() - t;
  if (exporter) { await exporter.unsafe("commit"); exporter.release(); }
  conns.forEach((c) => c.release());
  console.log(JSON.stringify({ variant: name, conc: CONC, reruns: N, reruns_per_s: Math.round(N / (ms / 1000)), ms_per_rerun_wall: +(ms / N * CONC).toFixed(3) }));
}
const bare = async (c: any, i: number) => { await c.unsafe(E03, [uid(i)]); };
const d7 = async (c: any, i: number) => { await c.unsafe("begin isolation level repeatable read read only"); await c.unsafe("select pg_current_snapshot()"); await c.unsafe(E03, [uid(i)]); await c.unsafe(KEY_POSTS, [uid(i)]); await c.unsafe(KEY_COMMENTS, [uid(i)]); await c.unsafe("commit"); };
const d8 = async (c: any, i: number, snap?: string) => { await c.unsafe("begin isolation level repeatable read read only"); await c.unsafe(`set transaction snapshot '${snap}'`); await c.unsafe(E03, [uid(i)]); await c.unsafe(KEY_POSTS, [uid(i)]); await c.unsafe(KEY_COMMENTS, [uid(i)]); await c.unsafe("commit"); };
// the cheaper alternative: ONE transaction per connection per cycle, importing the snapshot once, running its share
async function batched() {
  const conns = await Promise.all(Array.from({ length: CONC }, () => db.reserve()));
  const exporter = await db.reserve(); await exporter.unsafe("begin isolation level repeatable read read only"); const snap = (await exporter.unsafe("select pg_export_snapshot() s"))[0].s;
  let next = 0; const t = performance.now();
  await Promise.all(conns.map(async (c) => { await c.unsafe("begin isolation level repeatable read read only"); await c.unsafe(`set transaction snapshot '${snap}'`); for (;;) { const i = next++; if (i >= N) break; await c.unsafe(E03, [uid(i)]); await c.unsafe(KEY_POSTS, [uid(i)]); await c.unsafe(KEY_COMMENTS, [uid(i)]); } await c.unsafe("commit"); }));
  const ms = performance.now() - t; await exporter.unsafe("commit"); exporter.release(); conns.forEach((c) => c.release());
  console.log(JSON.stringify({ variant: "batched-per-conn+keys", conc: CONC, reruns: N, reruns_per_s: Math.round(N / (ms / 1000)), ms_per_rerun_wall: +(ms / N * CONC).toFixed(3) }));
}
await run("warmup", bare);
for (let r = 0; r < 2; r++) {
  await run("bare-query", bare);
  await run("D7-txn+snapshot+2keys", d7);
  await run("D8-imported-snapshot+2keys", d8, true);
  await batched();
}
const sizes = await db.unsafe(`select avg(length(t::text))::int b from (${E03.replace("$1", `'${uid(1)}'`)}) t`);
console.log("result_bytes", sizes[0].b);
process.exit(0);
