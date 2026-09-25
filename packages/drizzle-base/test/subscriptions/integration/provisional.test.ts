// A subscriber's first value may be older than commits the engine has already applied: a fresh open whose snapshot
// predates a commit its replay found, or a joiner on an entry that is dirty. Such a first value is marked
// provisional, and the engine guarantees that subscriber one more event after the entry's next re-run — even when
// the value did not change — so a client can tell "loading" from "current" (01a-4a plan review, I1).
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { type schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";
import { deferred } from "../../support/hooks";

const { query } = functions<typeof schema>();

test("a fresh value its own replay found stale is provisional, and the re-run follows", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    const entered = deferred();
    const gate = deferred();
    let hold = true;
    const names = query(async (ctx) => {
      const rows = (await ctx.db.select().from(users)).map((u) => u.name).sort();
      if (hold) {
        hold = false;
        entered.resolve();
        await gate.promise;
      }
      return rows;
    });
    const r = recorder<string[]>();
    const subscribed = engine.subscribe("names", names, {}, r.listener);
    try {
      await entered.promise; // the open's snapshot is taken and sees no users
      await pool.unsafe(`insert into dzb_app.users(name) values ('committed during the open')`);
      await engine.flush(); // the commit is streamed and applied before the open registers
    } finally {
      gate.resolve(); // a failed step must not leave a transaction held open (it blocks the fixture's teardown)
    }
    await subscribed;
    expect(r.events[0]).toMatchObject({ kind: "value", value: [], provisional: true });
    const next = await r.wait((e) => e.kind === "value" && e.cycle !== null);
    expect(next).toMatchObject({ value: ["committed during the open"] });
    expect((next as { provisional?: boolean }).provisional).toBeUndefined();
  });
});

test("a joiner on a dirty entry is settled after the re-run even when the value did not change", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    let hold = false;
    const entered = deferred();
    const gate = deferred();
    const xs = query(async (ctx) => {
      const n = (await ctx.db.select().from(users).where(eq(users.name, "x"))).length;
      if (hold) {
        hold = false;
        entered.resolve();
        await gate.promise;
      }
      return n;
    });
    const first = recorder<number>();
    await engine.subscribe("xs", xs, {}, first.listener);
    hold = true;
    await pool.unsafe(`insert into dzb_app.users(name) values ('not x')`); // touches the table, not the value
    const joiner = recorder<number>();
    try {
      await entered.promise; // the cycle is re-running the entry, which is still dirty
      await engine.subscribe("xs", xs, {}, joiner.listener);
    } finally {
      gate.resolve();
    }
    expect(joiner.events[0]).toMatchObject({ kind: "value", value: 0, provisional: true });
    const settled = await joiner.wait((e) => e.kind === "value" && e.cycle !== null);
    expect(settled).toMatchObject({ value: 0 });
    expect(first.events.length).toBe(1); // the premise: the re-run changed nothing, so nothing was pushed
  });
});

test("a first value from a clean entry is not provisional", async () => {
  await withEngine(async ({ engine }) => {
    const r = recorder<number>();
    await engine.subscribe(
      "n",
      query(async (ctx) => (await ctx.db.select().from(users)).length),
      {},
      r.listener,
    );
    expect(r.events[0]).toMatchObject({ kind: "value", value: 0 });
    expect((r.events[0] as { provisional?: boolean }).provisional).toBeUndefined();
  });
});
