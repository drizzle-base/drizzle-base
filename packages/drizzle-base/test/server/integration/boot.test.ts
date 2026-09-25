// startDrizzleBase wires the pool, the capture checks, the runtime, the engine, the capture and the server — and
// restarts the capture after a failure: subscribers are reset at once, a new slot is created, the engine resumes.
import { expect, test } from "bun:test";
import { count } from "drizzle-orm";
import type { ServerFrame } from "../../../src/protocol";
import { functions } from "../../../src/runtime";
import { defineApi, startDrizzleBase } from "../../../src/server";
import { schema, users, withApp } from "../../support/app";
import { pgConfig } from "../../support/db";

const { query } = functions<typeof schema>();
const api = defineApi({
  users: {
    names: query(async (ctx) => (await ctx.db.select().from(users)).map((u) => u.name).sort()),
    count: query(async (ctx) => (await ctx.db.select({ n: count() }).from(users))[0]?.n ?? -1),
  },
});

async function open(url: string) {
  const ws = new WebSocket(url);
  const frames: ServerFrame[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as ServerFrame));
  await new Promise((r) => ws.addEventListener("open", r));
  const until = async (pred: (f: ServerFrame) => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
      const hit = frames.find(pred);
      if (hit) return hit;
    }
    throw new Error(`no matching frame; got ${JSON.stringify(frames)}`);
  };
  return { ws, frames, until, send: (f: unknown) => ws.send(JSON.stringify(f)) };
}

test("a killed capture resets subscribers, restarts on a new slot, and a write made while down is seen", async () => {
  await withApp(async (sql, names) => {
    const db = await startDrizzleBase({ connection: pgConfig, schema, api, names, port: 0 });
    const c = await open(db.url);
    try {
      expect(new URL(db.url).hostname).toBe("127.0.0.1"); // loopback unless the caller says otherwise
      c.send({ t: "sub", id: "a", name: "users.names", args: {} });
      await c.until((f) => f.t === "upd" && f.id === "a");
      await sql.unsafe(`insert into dzb_app.users(name) values ('before')`);
      await c.until((f) => f.t === "txn" && f.u.some((x) => x.id === "a"));

      await sql`select pg_terminate_backend(active_pid) from pg_replication_slots where slot_name = ${names.slot} and active_pid is not null`;
      await c.until((f) => f.t === "reset");
      await sql.unsafe(`insert into dzb_app.users(name) values ('while down')`);

      // resubscribe until the engine is back (unavailable while the capture restarts)
      let upd: ServerFrame | undefined;
      for (let i = 0; i < 100 && !upd; i++) {
        c.send({ t: "sub", id: `b${i}`, name: "users.names", args: {} });
        const f = await c.until((x) => (x.t === "upd" || x.t === "err") && x.id === `b${i}`);
        if (f.t === "upd") upd = f;
        else await Bun.sleep(100);
      }
      expect(upd).toMatchObject({ value: ["before", "while down"] });
      const subId = upd?.t === "upd" ? upd.id : "";
      await sql.unsafe(`insert into dzb_app.users(name) values ('after')`);
      await c.until(
        (f) =>
          f.t === "txn" && f.u.some((x) => x.id === subId && "value" in x && (x.value as string[]).includes("after")),
      );
    } finally {
      c.ws.close();
      await db.stop();
    }
  });
}, 30_000);

test("boot refuses to start when the capture is not in place", async () => {
  await withApp(async (_sql, names) => {
    await expect(
      startDrizzleBase({ connection: pgConfig, schema, api, names: { ...names, slot: "no_such_slot" }, port: 0 }),
    ).rejects.toThrow(/no_such_slot is missing/);
  });
});
