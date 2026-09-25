// The owner's question: what does Drizzle cost over raw Bun.sql, and what does drizzlebase's runtime add
// (a reserved connection, BEGIN/snapshot/COMMIT, the parse gate, the read-set)? Sequential, one connection's
// worth of work at a time, so the number is latency, not throughput. Run from the package dir:
//   bun --preload ./test/support/env.ts load/runtime/drizzle_overhead.ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { functions, Runtime } from "../../src/runtime";
import { loadParser } from "../../src/sql";
import { schema, users, withApp } from "../../test/support/app";

const N = Number(process.env["N"] ?? 3000);
await loadParser();
await withApp(async (sql, names) => {
  await sql.unsafe(`insert into dzb_app.users(name, age) select 'u' || g, g % 90 from generate_series(1, 1000) g`);
  await sql.unsafe(
    `insert into dzb_app.posts(author_id, title) select id, 'p' from dzb_app.users, generate_series(1, 3)`,
  );
  const [{ id }] = await sql.unsafe(`select id from dzb_app.users limit 1`);
  const db = drizzle({ client: sql, schema });
  const prepared = db
    .select()
    .from(users)
    .where(eq(users.id, id as string))
    .prepare("by_id");
  const rt = new Runtime({ sql, schema, publication: names.publication });
  const { query } = functions<typeof schema>();
  const byId = query(async (ctx, a: { id: string }) => ctx.db.select().from(users).where(eq(users.id, a.id)));
  const withPosts = query(async (ctx, a: { id: string }) =>
    ctx.db.query.users.findFirst({ where: eq(users.id, a.id), with: { posts: true } }),
  );

  const variants: [string, () => Promise<unknown>][] = [
    ["Bun.sql tagged template", () => sql`select * from dzb_app.users where id = ${id}`],
    [
      "Drizzle builder",
      () =>
        db
          .select()
          .from(users)
          .where(eq(users.id, id as string)),
    ],
    ["Drizzle .prepare()", () => prepared.execute()],
    [
      "Drizzle relational (with posts)",
      () => db.query.users.findFirst({ where: eq(users.id, id as string), with: { posts: true } }),
    ],
    ["runtime.runQuery(builder)", () => rt.runQuery(byId, { id: id as string })],
    ["runtime.runQuery(relational)", () => rt.runQuery(withPosts, { id: id as string })],
  ];
  for (let round = 1; round <= 2; round++) {
    for (const [name, run] of variants) {
      for (let i = 0; i < 200; i++) await run(); // warm-up: prepared statements, parse cache, catalog cache
      const xs: number[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        await run();
        xs.push(performance.now() - t0);
      }
      xs.sort((a, b) => a - b);
      const p = (q: number) => xs[Math.floor(q * (xs.length - 1))]!.toFixed(3);
      console.log(
        JSON.stringify({
          round,
          variant: name,
          p50_ms: p(0.5),
          p99_ms: p(0.99),
          ops_s: Math.round(1000 / (xs.reduce((a, b) => a + b, 0) / xs.length)),
        }),
      );
    }
  }
});
process.exit(0);
