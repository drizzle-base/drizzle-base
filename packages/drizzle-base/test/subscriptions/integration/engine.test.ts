import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { posts, type schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";
const userPosts = query(async (ctx, a: { id: string }) =>
  (await ctx.db.select().from(posts).where(eq(posts.authorId, a.id))).map((p) => p.title).sort(),
);

describe("SubscriptionEngine", () => {
  test("the first value, then a new one after a write through a mutation", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      expect(r.last()).toMatchObject({ kind: "value", value: [] });
      await engine.mutate(
        mutation(async (ctx) => ctx.db.insert(posts).values({ authorId: U, title: "hello" })),
        {},
      );
      await r.wait((e) => e.kind === "value" && (e.value as string[]).includes("hello"));
    });
  });

  test("a raw SQL write (Drizzle Studio, psql) re-pushes", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'from psql')`);
      await r.wait((e) => e.kind === "value" && (e.value as string[]).includes("from psql"));
    });
  });

  test("a write to a table the query does not read re-runs nothing", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      const before = { ...engine.stats };
      await pool.unsafe(`insert into dzb_app.comments(post_id, body) values (uuidv7(), 'unrelated')`);
      await engine.flush(); // a full cycle ran: the comment's commit has been applied
      expect(engine.stats.cycles).toBeGreaterThan(before.cycles); // the premise: a cycle did run
      expect(engine.stats.reruns).toBe(before.reruns);
      expect(r.events.length).toBe(1);
    });
  });

  test("subscribers to the same query share one entry: one re-run per cycle", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      let runs = 0;
      const counted = query(async (ctx) => {
        runs++;
        return (await ctx.db.select().from(users)).length;
      });
      const a = recorder<number>(),
        b = recorder<number>();
      await engine.subscribe("users:count", counted, {}, a.listener);
      await engine.subscribe("users:count", counted, {}, b.listener);
      expect(runs).toBe(1);
      expect(b.last()).toMatchObject({ kind: "value", value: 0 });
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await Promise.all([
        a.wait((e) => e.kind === "value" && e.value === 1),
        b.wait((e) => e.kind === "value" && e.value === 1),
      ]);
      expect(runs).toBe(2);
    });
  });

  test("a query reading now() is not shared", async () => {
    await withEngine(async ({ engine }) => {
      let runs = 0;
      const clock = query(async (ctx) => {
        runs++;
        return (await ctx.db.execute(sql`select now()::text as t`))[0];
      });
      await engine.subscribe("clock", clock, {}, recorder().listener);
      await engine.subscribe("clock", clock, {}, recorder().listener);
      expect(runs).toBe(2);
    });
  });

  test("DDL re-runs every subscription", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      const before = engine.stats.reruns;
      await pool.unsafe(`alter table dzb_app.users add column nickname text`);
      await engine.flush();
      expect(engine.stats.reruns).toBeGreaterThan(before);
    });
  });

  test("a query that throws is reported and stays registered", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const boom = query(async (ctx) => {
        const rows = await ctx.db.select().from(users);
        if (rows.length > 0) throw new Error("no users allowed");
        return rows.length;
      });
      const r = recorder<number>();
      await engine.subscribe("boom", boom, {}, r.listener);
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await r.wait((e) => e.kind === "error");
      await pool.unsafe(`delete from dzb_app.users`);
      await r.wait((e) => e.kind === "value" && e.value === 0 && r.events.some((x) => x.kind === "error"));
    });
  });

  test("a re-run that returns the same value pushes nothing (and is counted as useless)", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      const other = "0190a000-0000-7000-8000-000000000009";
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${other}', 'someone else')`);
      await engine.flush();
      expect(engine.stats.reruns).toBeGreaterThan(0); // the premise: table level re-ran it
      expect(engine.stats.uselessReruns).toBe(engine.stats.reruns);
      expect(r.events.length).toBe(1);
    });
  });

  test("unsubscribing the last listener forgets the entry", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      const off = await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      off();
      const before = engine.stats.reruns;
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'nobody listens')`);
      await engine.flush();
      expect(engine.stats.reruns).toBe(before);
    });
  });

  test("two subscribes of one key at once share one entry; one unsubscribing leaves the other live", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      let runs = 0;
      const q = query(async (ctx) => {
        runs++;
        return (await ctx.db.select().from(users)).length;
      });
      const a = recorder<number>(),
        b = recorder<number>();
      const [offA] = await Promise.all([
        engine.subscribe("k", q, {}, a.listener),
        engine.subscribe("k", q, {}, b.listener),
      ]);
      expect(runs).toBe(1);
      offA();
      offA(); // idempotent
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await b.wait((e) => e.kind === "value" && e.value === 1);
    });
  });

  test("a listener that throws does not keep the value from the others", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const q = query(async (ctx) => (await ctx.db.select().from(users)).length);
      await engine.subscribe("k", q, {}, (e) => {
        if (e.kind === "value" && e.value === 1) throw new Error("closed socket");
      });
      const b = recorder<number>();
      await engine.subscribe("k", q, {}, b.listener);
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await b.wait((e) => e.kind === "value" && e.value === 1);
    });
  });

  test("a fresh value carries no cycle id", async () => {
    await withEngine(async ({ engine }) => {
      const r = recorder<number>();
      await engine.subscribe(
        "k",
        query(async (ctx) => (await ctx.db.select().from(users)).length),
        {},
        r.listener,
      );
      expect(r.last()).toMatchObject({ kind: "value", cycle: null });
    });
  });
});
