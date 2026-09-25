// Review B probe: Hasura-style multiplexing — K subscriptions of ONE query shape with different args re-run as
// ONE statement (`unnest($ids) … cross join lateral (<query with $1 := arg>)`) vs K statements (D10 dedupes only equal args).
import { SQL } from "bun";
const db = new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max: 8, connection: { search_path: "rb" } });
const E03 = (arg: string) => `select "users"."id", "users"."name", "users"."email", "users"."age", "users"."manager_id", "users"."deleted", "users"."created_at", "users_posts"."data" as "posts" from "users" "users" left join lateral (select coalesce(json_agg(json_build_array("users_posts"."id", "users_posts"."author_id", "users_posts"."title", "users_posts"."published", "users_posts"."views", "users_posts"."created_at", "users_posts_comments"."data")), '[]'::json) as "data" from "posts" "users_posts" left join lateral (select coalesce(json_agg(json_build_array("users_posts_comments"."id", "users_posts_comments"."post_id", "users_posts_comments"."author_id", "users_posts_comments"."body")), '[]'::json) as "data" from "comments" "users_posts_comments" where "users_posts_comments"."post_id" = "users_posts"."id") "users_posts_comments" on true where "users_posts"."author_id" = "users"."id") "users_posts" on true where "users"."id" = ${arg}`;
const uid = (i: number) => `00000000-0000-7000-8000-${String(1 + (i * 7919) % 5000).padStart(12, "0")}`;
for (const K of [100, 1000]) {
  const ids = Array.from({ length: K }, (_, i) => uid(i));
  for (let r = 0; r < 3; r++) {
    let t = performance.now();
    let next = 0; await Promise.all(Array.from({ length: 8 }, async () => { for (;;) { const i = next++; if (i >= K) break; await db.unsafe(E03("$1"), [ids[i]]); } }));
    const sep = performance.now() - t;
    t = performance.now();
    const rows = await db.unsafe(`select a.ord, q.* from unnest($1::uuid[]) with ordinality a(arg, ord) cross join lateral (${E03("a.arg")}) q`, [`{${ids.join(",")}}`]);
    const mux = performance.now() - t;
    console.log(JSON.stringify({ K, round: r, separate_8conns_ms: +sep.toFixed(0), multiplexed_1stmt_ms: +mux.toFixed(0), rows: rows.length }));
  }
}
process.exit(0);
