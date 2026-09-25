import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { CATALOG_STATEMENT } from "../../../src/readset";
import { functions, isTransient, Runtime } from "../../../src/runtime";
import { posts, schema, users, withApp } from "../../support/app";
import { pgConfig, testSql } from "../../support/db";

const pgConfigForSql = () => ({
  hostname: pgConfig.host,
  port: pgConfig.port,
  database: pgConfig.database,
  username: pgConfig.user,
  password: pgConfig.password,
  max: 1,
});

async function exported<T>(pool: SQL, fn: (id: string) => Promise<T>): Promise<T> {
  const ex = await pool.reserve();
  try {
    await ex.unsafe("begin isolation level repeatable read read only");
    const [{ id }] = await ex.unsafe("select pg_export_snapshot() as id");
    return await fn(id as string);
  } finally {
    await ex.unsafe("commit");
    ex.release();
  }
}

test("calls see the exported snapshot, not a commit made after it", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await exported(pool, async (id) => {
      await pool.unsafe(`insert into dzb_app.users(name) values ('after export')`);
      const [a, b] = await rt.runInSnapshot(id, [
        async (ctx) => (await ctx.db.select().from(users)).length,
        async (ctx) => (await ctx.db.select().from(posts)).length,
      ]);
      expect(a).toMatchObject({ ok: true, value: 0 });
      expect(b).toMatchObject({ ok: true, value: 0 });
      if (a?.ok) expect([...a.readSet.tables]).toEqual(["dzb_app.users"]);
    });
  });
});

test("a failing call does not break the others, and reports what it read", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await exported(pool, async (id) => {
      const [bad, good] = await rt.runInSnapshot(id, [
        async (ctx) => {
          await ctx.db.select().from(users);
          await ctx.db.execute(sql`select 1/0`);
        },
        async (ctx) => (await ctx.db.select().from(posts)).length,
      ]);
      expect(bad?.ok).toBe(false);
      expect([...(bad?.readSet.tables ?? [])]).toEqual(["dzb_app.users"]);
      expect(good).toMatchObject({ ok: true, value: 0 });
    });
  });
});

test("a snapshot id that is not one is refused before reaching Postgres", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await expect(rt.runInSnapshot("x'; drop table dzb_app.users; --", [])).rejects.toThrow(/snapshot id/);
  });
});

test("after a schema change a warm pool returns the new shape, not 0A000 (prepare: false)", async () => {
  await withApp(async (pool, n) => {
    // One connection: a plan cached by a warm run is only hit again on the same connection.
    const one = testSql(1);
    const rt = new Runtime({ sql: one, schema, publication: n.publication });
    const pid = "0190a000-0000-7000-8000-0000000000aa";
    await pool.unsafe(`insert into dzb_app.comments(post_id, body) values ('${pid}', 'b')`);
    // Parameterised on purpose: an unparameterised statement does not hit the cached-plan error (probed).
    const row = functions<typeof schema>().query(
      async (ctx, a: { id: string }) =>
        (await ctx.db.execute(sql`select * from dzb_app.comments where post_id = ${a.id}`))[0],
    );
    for (let i = 0; i < 3; i++) await rt.runQuery(row, { id: pid });
    await pool.unsafe(`alter table dzb_app.comments add column extra int default 7`);
    try {
      expect((await rt.runQuery(row, { id: pid })).value).toMatchObject({ body: "b", extra: 7 });
    } finally {
      await one.close();
    }
  });
});

test("the Runtime refuses a pool that prepares statements", () => {
  const preparing = new SQL({ ...pgConfigForSql(), prepare: true });
  expect(() => new Runtime({ sql: preparing, schema, publication: "p" })).toThrow(/prepare: false/);
});

test("isTransient: connection, conflict, resource and operator classes — never a plain error", () => {
  const e = (errno?: string) => Object.assign(new Error("x"), { name: "PostgresError", errno });
  for (const c of ["08006", "40001", "40P01", "53300", "57014", "57P01"]) expect(isTransient(e(c))).toBe(true);
  expect(isTransient(Object.assign(new Error("closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" }))).toBe(true);
  expect(isTransient(new Error("no users allowed"))).toBe(false); // a handler's own throw is deterministic
  for (const c of ["22012", "42703", "23505"]) expect(isTransient(e(c))).toBe(false);
  expect(isTransient({ cause: e("40001") })).toBe(true);
});

// The catalog batch is PREPAREd once per connection. A second PREPARE on the same connection would fail (42P05),
// so two runs on a one-connection pool both succeeding proves the runtime knew the connection was ready.
test("the runtime prepares the catalog statement once per connection and reuses it", async () => {
  await withApp(async (pool, n) => {
    const one = testSql(1);
    try {
      const rt = new Runtime({ sql: one, schema, publication: n.publication });
      const count = functions<typeof schema>().query(async (ctx) => (await ctx.db.select().from(users)).length);
      expect((await rt.runQuery(count, {})).readSet.tables).toEqual(new Set(["dzb_app.users"]));
      expect((await rt.runQuery(count, {})).readSet.tables).toEqual(new Set(["dzb_app.users"]));
      const [prepared] = await one.unsafe("select count(*)::int as n from pg_prepared_statements where name = $1", [
        CATALOG_STATEMENT,
      ]);
      expect(prepared?.n).toBe(1);
      // A cycle's lane on that same connection takes the prepared path too (it would PREPARE again and fail).
      const lane = await exported(pool, async (sid) => {
        const [r] = await rt.runInSnapshot(sid, [async (ctx) => (await ctx.db.select().from(posts)).length]);
        return r;
      });
      expect(lane?.readSet).toEqual({ tables: new Set(["dzb_app.posts"]), opaque: [], volatile: [] });
    } finally {
      await one.close();
    }
  });
});
