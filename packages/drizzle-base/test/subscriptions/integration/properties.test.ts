import { expect, test } from "bun:test";
import type { ReservedSQL, SQL } from "bun";
import { count, eq } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { comments, posts, type schema } from "../../support/app";
import { testSql } from "../../support/db";
import { recorder, withEngine } from "../../support/engine";

const { query } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";
const titles = query(async (ctx) =>
  (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title).sort(),
);

// Postgres computes a snapshot's xmax as latestCompletedXid + 1: an open transaction holding the newest xid sits AT
// or above xmax, invisible by that rule alone, and never appears in xip. To exercise the xip rule, a later
// transaction must complete first. The premise is asserted: the held xid is in a snapshot's xip.
async function pushPastXmax(pool: SQL, held: ReservedSQL): Promise<bigint> {
  const [{ x }] = await held.unsafe("select pg_current_xact_id()::text as x");
  await pool.unsafe(`insert into dzb_app.comments(post_id, body) values (uuidv7(), 'moves xmax past the held xid')`);
  const [{ s }] = await pool.unsafe("select pg_current_snapshot()::text as s");
  expect(String(s).split(":")[2]?.split(",")).toContain(String(x));
  return BigInt(x as string);
}

test("a commit its snapshot saw as running reaches the subscription through apply()", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    const held = await pool.reserve();
    await held.unsafe("begin");
    await held.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'held')`);
    await pushPastXmax(pool, held);
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    await held.unsafe("commit");
    held.release();
    await r.wait((e) => e.kind === "value" && e.value.includes("held"));
  });
});

test("a commit streamed during the handler is caught by the replay (and not pruned under it)", async () => {
  await withEngine(
    async ({ sql: pool, engine }) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gated = query(async (ctx) => {
        const rows = (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title);
        await gate;
        return rows;
      });
      const held = await pool.reserve();
      await held.unsafe("begin");
      await held.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'during')`);
      const heldXid = await pushPastXmax(pool, held);
      const r = recorder<string[]>();
      const subscribed = engine.subscribe("gated", gated, {}, r.listener);
      await Bun.sleep(100); // the handler's snapshot exists, with the held xid running
      await held.unsafe("commit");
      held.release();
      await engine.flush(); // streamed and applied — to nothing registered yet
      await Bun.sleep(300); // longer than pruneEveryMs: a prune that ignored the in-flight query would drop it now
      // The premise: the database's xmin has passed the held commit, so a prune that ignored the in-flight query
      // would drop it (another open transaction on the database would pin xmin and make this test vacuous).
      const [{ xmin }] = await pool.unsafe("select pg_snapshot_xmin(pg_current_snapshot())::text as xmin");
      expect(BigInt(xmin as string)).toBeGreaterThan(heldXid);
      release();
      await subscribed;
      expect(r.events[0]).toMatchObject({ kind: "value", value: [] }); // the premise: the fresh value missed it
      await r.wait((e) => e.kind === "value" && e.value.includes("during"));
    },
    { pruneEveryMs: 50 },
  );
});

test("two tables moved by one transaction never disagree in a cycle", async () => {
  await withEngine(
    async ({ sql: pool, engine }) => {
      await pool.unsafe(
        `insert into dzb_app.comments(post_id, body) select uuidv7(), 'c' from generate_series(1, 2000)`,
      );
      const nPosts = query(async (ctx) => (await ctx.db.select({ n: count() }).from(posts))[0]!.n);
      const nComments = query(async (ctx) => (await ctx.db.select({ n: count() }).from(comments))[0]!.n);
      const latest = { p: 0, c: 2000 };
      const perCycle = new Map<number, { p?: number; c?: number }>();
      const note = (k: "p" | "c") => (e: { kind: string; cycle?: number | null; value?: unknown }) => {
        if (e.kind === "value" && typeof e.cycle === "number")
          perCycle.set(e.cycle, { ...perCycle.get(e.cycle), [k]: e.value as number });
      };
      await engine.subscribe("p", nPosts, {}, note("p"));
      await engine.subscribe("c", nComments, {}, note("c"));
      // Four writers on their own pool, a lagging stream, and mostly touch-only updates: most cycles re-run only the
      // comment count (dirty from an update), so a move committed before the export but not yet delivered would reach
      // that count alone — the window the barrier closes. Frequent moves would dirty both counts every cycle and hide it.
      const writers = testSql(4);
      let stop = false;
      const writer = async () => {
        while (!stop) {
          if (Math.random() < 0.95)
            await writers.unsafe(
              `update dzb_app.comments set body = body || '.' where id = (select id from dzb_app.comments limit 1 for update skip locked)`,
            );
          else
            await writers.begin(async (tx) => {
              // Two statements, one transaction; the post is inserted only if a comment was deleted, so the database
              // itself always holds p + c = 2000 (the property is about the pushes, not the workload).
              const gone = await tx.unsafe(
                `delete from dzb_app.comments where id = (select id from dzb_app.comments limit 1 for update skip locked) returning id`,
              );
              if (gone.length) await tx.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'moved')`);
            });
        }
      };
      const running = Promise.all([writer(), writer(), writer(), writer()]);
      await Bun.sleep(2_000);
      stop = true;
      await running;
      await writers.close();
      await engine.flush();
      let checked = 0;
      for (const id of [...perCycle.keys()].sort((a, b) => a - b)) {
        Object.assign(latest, perCycle.get(id));
        checked++;
        expect(latest.p + latest.c).toBe(2000);
      }
      expect(checked).toBeGreaterThan(10);
    },
    { streamLagMs: 20 },
  );
}, 30_000);

test("a rename plus a view under the old name: the subscription follows the view", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    const all = query(async (ctx) => (await ctx.db.select().from(posts)).length);
    const r = recorder<number>();
    await engine.subscribe("all", all, {}, r.listener);
    await pool.unsafe(
      `alter table dzb_app.posts rename to articles; create view dzb_app.posts as select * from dzb_app.articles`,
    );
    await engine.flush();
    await pool.unsafe(`insert into dzb_app.articles(author_id, title) values ('${U}', 'via the view')`);
    await r.wait((e) => e.kind === "value" && e.value === 1);
  });
});

test("a failed cycle does not leave dirty entries stuck", async () => {
  await withEngine(async ({ sql: pool, runtime, engine }) => {
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    const real = runtime.runInSnapshot.bind(runtime);
    let failOnce = true;
    runtime.runInSnapshot = async (...a: Parameters<typeof real>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("lane lost");
      }
      return real(...a);
    };
    await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'first')`);
    await r.wait((e) => e.kind === "value" && e.value.includes("first"));
    expect(engine.stats.failedCycles).toBeGreaterThan(0);
  });
});

test("a transient error is retried, never pushed as the result", async () => {
  await withEngine(async ({ sql: pool, runtime, engine }) => {
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    const real = runtime.runInSnapshot.bind(runtime);
    let once = true;
    runtime.runInSnapshot = async (id: string, calls: Parameters<typeof real>[1]) => {
      const out = await real(id, calls);
      if (!once) return out;
      once = false;
      return out.map((x) => ({
        ok: false as const,
        error: Object.assign(new Error("timeout"), { name: "PostgresError", errno: "57014" }),
        readSet: x.readSet,
      }));
    };
    await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'eventually')`);
    await r.wait((e) => e.kind === "value" && e.value.includes("eventually"));
    expect(r.events.some((e) => e.kind === "error")).toBe(false);
    expect(engine.stats.transientReruns).toBeGreaterThan(0);
  });
});
