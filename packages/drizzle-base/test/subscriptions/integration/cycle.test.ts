// Races inside a cycle, each made deterministic by holding or failing the cycle at an exact statement.
import { expect, test } from "bun:test";
import { count, eq, sql } from "drizzle-orm";
import { Catalog } from "../../../src/readset";
import { functions } from "../../../src/runtime";
import { comments, posts, type schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";
import { deferred, interceptReserved, isExport } from "../../support/hooks";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";

test("the prune timer never drops a commit that a cycle still re-running needs to replay", async () => {
  await withEngine(
    async ({ sql: pool, engine }) => {
      let hold = false;
      const entered = deferred();
      const gate = deferred();
      const titles = query(async (ctx) => {
        const rows = (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title);
        if (hold) {
          entered.resolve();
          await gate.promise;
        }
        return rows;
      });
      const r = recorder<string[]>();
      await engine.subscribe("t", titles, {}, r.listener);
      hold = true;
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'a')`);
      await entered.promise; // a cycle is re-running at S, which does not see 'b' below
      hold = false;
      const bxid = await pool.begin(async (tx) => {
        await tx.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'b')`);
        const [{ x }] = await tx.unsafe("select pg_current_xact_id()::text as x");
        return BigInt(x as string);
      });
      await Bun.sleep(300); // six prune periods
      // The premise: the database's xmin has passed 'b', so a prune that ignored the running cycle would drop it.
      const [{ xmin }] = await pool.unsafe("select pg_snapshot_xmin(pg_current_snapshot())::text as xmin");
      expect(BigInt(xmin as string)).toBeGreaterThan(bxid);
      gate.resolve();
      await r.wait((e) => e.kind === "value" && e.value.includes("a") && e.value.includes("b"));
    },
    { pruneEveryMs: 50 },
  );
}, 20_000);

test("a forced cycle that fails still completes the mutation's named cycle later", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await engine.subscribe(
      "n",
      query(async (ctx) => (await ctx.db.select().from(posts)).length),
      {},
      () => {},
    );
    let completed = 0;
    engine.onCycleComplete((id) => {
      completed = Math.max(completed, id);
    });
    let fail = true;
    const restore = interceptReserved(pool, (q) => {
      if (!isExport(q) || !fail) return undefined;
      fail = false;
      return Promise.reject(new Error("simulated: the cycle lost its connection"));
    });
    try {
      // Changes nothing any subscription reads: the only reason for the named cycle to run is the mutation.
      const { cycle } = await engine.mutate(
        mutation(async (ctx) => ctx.db.execute(sql`select 1`)),
        {},
      );
      for (let i = 0; i < 150 && completed < cycle; i++) await Bun.sleep(20);
      expect(fail).toBe(false); // the premise: the named cycle did fail once
      expect(engine.stats.failedCycles).toBeGreaterThan(0);
      expect(completed).toBeGreaterThanOrEqual(cycle);
    } finally {
      restore();
    }
  });
});

test("a transient re-run never lets its peers push alone: a transition stays consistent", async () => {
  await withEngine(
    async ({ sql: pool, runtime, engine }) => {
      await pool.unsafe(`insert into dzb_app.comments(post_id, body) values (uuidv7(), 'c')`);
      const nPosts = query(async (ctx) => (await ctx.db.select({ n: count() }).from(posts))[0]?.n ?? -1);
      const nComments = query(async (ctx) => (await ctx.db.select({ n: count() }).from(comments))[0]?.n ?? -1);
      const latest = { p: 0, c: 1 };
      const sums: number[] = [];
      const errors: unknown[] = [];
      const note = (k: "p" | "c") => (e: { kind: string; value?: unknown; error?: unknown }) => {
        if (e.kind === "error") errors.push(e.error);
        if (e.kind !== "value") return;
        latest[k] = e.value as number;
      };
      await engine.subscribe("p", nPosts, {}, note("p"));
      await engine.subscribe("c", nComments, {}, note("c"));
      engine.onCycleComplete(() => sums.push(latest.p + latest.c));
      const real = runtime.runInSnapshot.bind(runtime);
      let transient = true;
      runtime.runInSnapshot = async (id: string, calls: Parameters<typeof real>[1]) => {
        const out = await real(id, calls);
        if (!transient || out.length < 2) return out;
        transient = false;
        const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
          name: "PostgresError",
          errno: "57014",
        });
        return out.map((x, i) => (i === 0 ? { ok: false as const, error: timeout, readSet: x.readSet } : x));
      };
      await pool.begin(async (tx) => {
        await tx.unsafe(`delete from dzb_app.comments`);
        await tx.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'moved')`);
      });
      for (let i = 0; i < 250 && !(latest.p === 1 && latest.c === 0); i++) await Bun.sleep(20);
      expect(transient).toBe(false); // the premise: one re-run did come back transient
      expect(latest).toEqual({ p: 1, c: 0 });
      expect(sums.every((s) => s === 1)).toBe(true);
      expect(errors).toEqual([]);
    },
    { connections: 1 },
  );
});

test("a cycle never re-runs an entry whose value is newer than its snapshot (never back in time)", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await engine.subscribe(
      "wake",
      query(async (ctx) => (await ctx.db.select().from(users)).length),
      {},
      () => {},
    );
    const exported = deferred();
    const gate = deferred();
    let hold = true;
    const restore = interceptReserved(pool, (q, run) => {
      if (!isExport(q) || !hold) return undefined;
      hold = false;
      return run().then(async (rows) => {
        exported.resolve();
        await gate.promise; // S is taken; the cycle waits before its barrier and before choosing what to re-run
        return rows;
      });
    });
    try {
      await pool.unsafe(`insert into dzb_app.users(name) values ('starts a cycle')`);
      await exported.promise;
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'seen by the fresh value')`);
      const titles = query(async (ctx) =>
        (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title).sort(),
      );
      const r = recorder<string[]>();
      await engine.subscribe("titles", titles, {}, r.listener); // its snapshot is newer than S
      expect(r.last()).toMatchObject({ value: ["seen by the fresh value"] });
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'later')`);
      await Bun.sleep(200); // 'later' streamed and applied: the entry is dirty while the cycle still holds S
      gate.resolve();
      await r.wait((e) => e.kind === "value" && e.value.includes("later"));
      for (const e of r.events) if (e.kind === "value") expect(e.value).toContain("seen by the fresh value"); // no push at S went back
    } finally {
      restore();
    }
  });
});

test("an entry that turns volatile on a re-run is never joined by a later subscriber", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    let runs = 0;
    const q = query(async (ctx) => {
      runs++;
      const n = (await ctx.db.select().from(users)).length;
      if (n > 0) await ctx.db.execute(sql`select now()`); // volatile from the first user on
      return n;
    });
    const a = recorder<number>();
    await engine.subscribe("q", q, {}, a.listener);
    expect(runs).toBe(1);
    await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
    await a.wait((e) => e.kind === "value" && e.value === 1);
    expect(runs).toBe(2); // the premise: it re-ran, and read now() this time
    const b = recorder<number>();
    await engine.subscribe("q", q, {}, b.listener);
    expect(runs).toBe(3); // a fresh run of its own, not the shared entry's value
  });
});

// The re-run returns the value the subscriber already has: nothing is pushed, so only the check after COMMIT stands
// between the reset and the rest of the cycle's completion.
test("a reset during a cycle's COMMIT pushes nothing after the subscribers were told", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await pool.unsafe(`insert into dzb_app.users(name) values ('already there')`);
    const r = recorder<number>();
    await engine.subscribe(
      "n",
      query(async (ctx) => Math.min(1, (await ctx.db.select().from(users)).length)),
      {},
      r.listener,
    );
    let armed = true;
    const completedAfterReset: number[] = [];
    engine.onCycleComplete((id) => {
      if (!armed) completedAfterReset.push(id);
    });
    const restore = interceptReserved(pool, (q, run, conn) => {
      if (isExport(q)) conn.tag = "cycle";
      if (q !== "commit" || conn.tag !== "cycle" || !armed) return undefined;
      armed = false;
      engine.reset("the capture failed during COMMIT");
      return run();
    });
    try {
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await r.wait((e) => e.kind === "reset");
      await Bun.sleep(200);
      expect(armed).toBe(false); // the premise: the reset happened at the cycle's COMMIT
      expect(r.events.at(-1)?.kind).toBe("reset");
      // Nor does the cycle complete: a client resolving a mutation on it would trust a transition it never got.
      expect(completedAfterReset).toEqual([]);
    } finally {
      restore();
    }
  });
});

test("a cycle's lanes share one Catalog: one catalog statement for the whole cycle", async () => {
  const proto = Catalog.prototype as unknown as { issue: (...a: unknown[]) => Promise<unknown> };
  const real = proto.issue;
  let issued = 0;
  proto.issue = function (this: unknown, ...a: unknown[]) {
    issued++;
    return real.apply(this, a);
  };
  try {
    await withEngine(
      async ({ sql: pool, engine }) => {
        const byAuthor = query(async (ctx, a: { id: string }) =>
          (await ctx.db.select().from(posts).where(eq(posts.authorId, a.id))).map((p) => p.title),
        );
        for (let i = 1; i <= 4; i++)
          await engine.subscribe("byAuthor", byAuthor, { id: `0190a000-0000-7000-8000-00000000000${i}` }, () => {});
        issued = 0;
        const before = engine.stats.reruns;
        await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'wakes all four')`);
        await engine.flush();
        expect(engine.stats.reruns - before).toBe(4); // the premise: four re-runs, spread over four lanes
        expect(issued).toBe(1);
      },
      { connections: 4 },
    );
  } finally {
    proto.issue = real;
  }
});
