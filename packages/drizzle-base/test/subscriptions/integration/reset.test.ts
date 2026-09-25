import { expect, test } from "bun:test";
import { functions } from "../../../src/runtime";
import { EngineDownError } from "../../../src/subscriptions";
import { type schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query } = functions<typeof schema>();

test("reset puts the engine down: subscribers are told, nothing old is pushed, subscribing waits for resume()", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    let runs = 0;
    const q = query(async (ctx) => {
      runs++;
      return (await ctx.db.select().from(users)).length;
    });
    const r = recorder<number>();
    await engine.subscribe("n", q, {}, r.listener);
    engine.reset("walsender terminated");
    expect(r.last()).toMatchObject({ kind: "reset" });
    await expect(engine.subscribe("n", q, {}, () => {})).rejects.toBeInstanceOf(EngineDownError);
    await pool.unsafe(`insert into dzb_app.users(name) values ('after reset')`);
    await Bun.sleep(200);
    expect(r.events.at(-1)?.kind).toBe("reset");
    engine.resume();
    const again = recorder<number>();
    await engine.subscribe("n", q, {}, again.listener);
    expect(runs).toBe(2);
    expect(again.last()).toMatchObject({ kind: "value", value: 1 });
  });
});

test("an unsubscribe from before a reset cannot remove the entry that now holds the key", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    const q = query(async (ctx) => (await ctx.db.select().from(users)).length);
    const offOld = await engine.subscribe("n", q, {}, () => {});
    engine.reset("test");
    engine.resume();
    const fresh = recorder<number>();
    await engine.subscribe("n", q, {}, fresh.listener);
    offOld(); // the old entry is gone; its closure must not touch the new one
    await pool.unsafe(`insert into dzb_app.users(name) values ('still live')`);
    await fresh.wait((e) => e.kind === "value" && e.value === 1);
  });
});

test("a reset from inside a listener stops the rest of that cycle's pushes", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    const n = query(async (ctx) => (await ctx.db.select().from(users)).length);
    const names = query(async (ctx) => (await ctx.db.select().from(users)).map((u) => u.name));
    const second = recorder<unknown>();
    await engine.subscribe("n", n, {}, (e) => {
      if (e.kind === "value" && e.value === 1) engine.reset("from a listener");
    });
    await engine.subscribe("names", names, {}, second.listener);
    await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
    await second.wait((e) => e.kind === "reset");
    await Bun.sleep(100);
    const afterReset = second.events.slice(second.events.findIndex((e) => e.kind === "reset") + 1);
    expect(afterReset).toEqual([]); // no value delivered after it was told "reset"
    expect(second.events.filter((e) => e.kind === "value").length).toBe(1); // only the fresh value, from before
  });
});

test("flush() while down rejects instead of hanging; after resume() it completes a cycle", async () => {
  await withEngine(async ({ engine }) => {
    engine.reset("test");
    const early = await Promise.race([
      engine.flush().then(
        () => "resolved",
        (e: unknown) => (e instanceof EngineDownError ? "rejected" : "other"),
      ),
      Bun.sleep(1_000).then(() => "hung"),
    ]);
    expect(early).toBe("rejected");
    engine.resume();
    expect(await engine.flush()).toBeGreaterThan(0);
  });
});
