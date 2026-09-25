import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { CommittedUnconfirmedError } from "../../../src/subscriptions";
import { posts, type schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";
const add = mutation(async (ctx, a: { t: string }) => ctx.db.insert(posts).values({ authorId: U, title: a.t }));

// The client's contract (01a-4): a mutation is visible once a cycle at or after the one it names has COMPLETED — by
// then every push that cycle made has been delivered. The named cycle itself may push nothing: when the stream
// delivered the commit before the barrier returned, an earlier cycle already pushed it.
test("once the returned cycle completes, the subscriber holds the write, and no later push lacks it — 20 in a row", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
    const titles = query(async (ctx) =>
      (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title),
    );
    const r = recorder<string[]>();
    // What the subscriber holds at the instant each cycle completes: the view a client resolves its mutation on.
    const heldAt = new Map<number, string[]>();
    let completed = 0;
    engine.onCycleComplete((id) => {
      completed = Math.max(completed, id);
      const last = r.last();
      heldAt.set(id, last?.kind === "value" ? last.value : []);
    });
    await engine.subscribe("titles", titles, {}, r.listener);
    for (let i = 0; i < 20; i++) {
      const { cycle } = await engine.mutate(add, { t: `p${i}` });
      for (let w = 0; w < 250 && completed < cycle; w++) await Bun.sleep(20);
      expect(completed).toBeGreaterThanOrEqual(cycle); // the premise: the named cycle completed
      const first = Math.min(...[...heldAt.keys()].filter((id) => id >= cycle));
      expect(heldAt.get(first)).toContain(`p${i}`);
      for (const e of r.events)
        if (e.kind === "value" && e.cycle !== null && e.cycle >= cycle) expect(e.value).toContain(`p${i}`);
    }
  });
});

test("a mutation that changes nothing a client watches still completes its cycle (onCycleComplete)", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
    const titles = query(async (ctx) =>
      (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title),
    );
    await engine.subscribe("titles", titles, {}, () => {});
    const completed: number[] = [];
    engine.onCycleComplete((id) => completed.push(id));
    const touch = mutation(async (ctx) => ctx.db.execute(sql`update dzb_app.users set name = name where id = ${U}`));
    const { cycle } = await engine.mutate(touch, {});
    for (let i = 0; i < 100 && !completed.some((c) => c >= cycle); i++) await Bun.sleep(20);
    expect(completed.some((c) => c >= cycle)).toBe(true);
  });
});

test("a committed mutation whose effect cannot be confirmed is CommittedUnconfirmedError, not a failure", async () => {
  await withEngine(
    async ({ sql: pool, capture, engine }) => {
      await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
      await capture.stop();
      const err = await engine.mutate(add, { t: "landed" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CommittedUnconfirmedError);
      expect((err as CommittedUnconfirmedError).commitLsn).toMatch(/\//);
      const [{ n }] = await pool.unsafe("select count(*)::int as n from dzb_app.posts where title = 'landed'");
      expect(n).toBe(1); // it DID commit
    },
    { barrierTimeoutMs: 500 },
  );
});

// The cycle in flight when the barrier returns exported its snapshot BEFORE the commit: naming it would resolve the
// client on a transition that lacks the write. The gate holds that cycle open, deterministically, across the mutation.
test("the named cycle is never one already running when the mutation committed", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
    let hold = false;
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slowUsers = query(async (ctx) => {
      const n = (await ctx.db.select().from(users)).length;
      if (hold) {
        entered();
        await gate;
      }
      return n;
    });
    const titles = query(async (ctx) =>
      (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title),
    );
    const r = recorder<string[]>();
    // What the subscriber holds at the instant each cycle completes: the view a client resolves its mutation on.
    const heldAt = new Map<number, string[]>();
    let completed = 0;
    engine.onCycleComplete((id) => {
      completed = Math.max(completed, id);
      const last = r.last();
      heldAt.set(id, last?.kind === "value" ? last.value : []);
    });
    await engine.subscribe("slow", slowUsers, {}, () => {});
    await engine.subscribe("titles", titles, {}, r.listener);
    hold = true;
    await pool.unsafe(`insert into dzb_app.users(name) values ('wakes the slow query')`);
    await inside; // a cycle is now running, its snapshot taken before the mutation below
    const { cycle } = await engine.mutate(add, { t: "late" });
    hold = false;
    open();
    for (let w = 0; w < 250 && completed < cycle; w++) await Bun.sleep(20);
    expect(completed).toBeGreaterThanOrEqual(cycle);
    const first = Math.min(...[...heldAt.keys()].filter((id) => id >= cycle));
    expect(heldAt.get(first)).toContain("late");
  });
});
