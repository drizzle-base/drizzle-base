// Commit → push latency and the useless re-run ratio of table-level invalidation (DZB-01a-3). N subscriptions,
// each on the posts of its own author; 200 raw-SQL inserts, each for ONE author: at table level every subscription
// re-runs on every insert, N−1 of them uselessly — the number 01b must beat.
//   bun --preload ./test/support/env.ts load/subscriptions/reactive_latency.ts
import { eq } from "drizzle-orm";
import { functions } from "../../src/runtime";
import { posts, type schema } from "../../test/support/app";
import { withEngine } from "../../test/support/engine";

const { query } = functions<typeof schema>();
const byAuthor = query(
  async (ctx, a: { id: string }) => (await ctx.db.select().from(posts).where(eq(posts.authorId, a.id))).length,
);
const author = (i: number) => `0190a000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;

for (const n of [1, 100, 1000]) {
  await withEngine(
    async ({ sql, engine }) => {
      const seen = new Map<number, (t: number) => void>();
      for (let i = 0; i < n; i++)
        await engine.subscribe("byAuthor", byAuthor, { id: author(i) }, (e) => {
          if (i === 0 && e.kind === "value") seen.get(e.value as number)?.(performance.now());
        });
      const base = { ...engine.stats };
      const xs: number[] = [];
      for (let k = 1; k <= 200; k++) {
        const pushed = new Promise<number>((r) => seen.set(k, r));
        const t0 = performance.now();
        await sql.unsafe(`insert into dzb_app.posts(author_id, title) values ('${author(0)}', 't')`);
        xs.push((await pushed) - t0);
      }
      xs.sort((a, b) => a - b);
      const reruns = engine.stats.reruns - base.reruns;
      const useless = engine.stats.uselessReruns - base.uselessReruns;
      console.log(
        JSON.stringify({
          subscriptions: n,
          p50_ms: +xs[100]!.toFixed(2),
          p99_ms: +xs[197]!.toFixed(2),
          reruns,
          useless,
          useless_ratio: +(useless / reruns).toFixed(3),
        }),
      );
    },
    { connections: 4 },
  );
}
process.exit(0);
