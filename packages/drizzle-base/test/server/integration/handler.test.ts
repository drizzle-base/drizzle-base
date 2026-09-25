// The WebSocket server on a real engine: subscriptions, one frame per cycle, read-your-writes on the wire, errors,
// limits, cleanup and reset. Every property here has a sabotage recorded in the 01a-4a plan's ledger.
import { describe, expect, test } from "bun:test";
import { count, sql } from "drizzle-orm";
import type { ServerFrame } from "../../../src/protocol";
import { functions } from "../../../src/runtime";
import { DrizzleBaseError, defineApi } from "../../../src/server";
import { comments, posts, type schema, users } from "../../support/app";
import { deferred, interceptReserved, isExport } from "../../support/hooks";
import { withServer } from "../../support/server";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";

let gate = deferred();
let gated = false;
let entered = deferred();
const api = defineApi({
  users: {
    count: query(async (ctx) => (await ctx.db.select({ n: count() }).from(users))[0]?.n ?? -1),
    names: query(async (ctx) => (await ctx.db.select().from(users)).map((u) => u.name).sort()),
    add: mutation(async (ctx, a: { name: string }) => {
      await ctx.db.insert(users).values({ name: a.name });
      return { added: a.name, at: new Date(0) };
    }),
  },
  posts: {
    titles: query(async (ctx) => (await ctx.db.select().from(posts)).map((p) => p.title).sort()),
    add: mutation(async (ctx, a: { title: string }) => ctx.db.insert(posts).values({ authorId: U, title: a.title })),
  },
  comments: {
    count: query(async (ctx) => (await ctx.db.select({ n: count() }).from(comments))[0]?.n ?? -1),
    // For read-your-writes: changes nothing the subscriptions below read.
    touch: mutation(async (ctx) => ctx.db.insert(comments).values({ postId: U, body: "b" })),
  },
  slow: {
    names: query(async (ctx) => {
      const rows = (await ctx.db.select().from(users)).map((u) => u.name).sort();
      if (gated) {
        gated = false;
        entered.resolve();
        await gate.promise;
      }
      return rows;
    }),
  },
  fails: {
    secret: query(async () => {
      throw new Error("secret detail: a@b.c");
    }),
    // A driver error whose message carries the SQL and its params: the marker must never reach the wire.
    driver: query(async (ctx) => {
      const n = (await ctx.db.select().from(users)).length;
      if (n > 0) await ctx.db.execute(sql`select ${"marker-7f3a@example.com"}::int`);
      return n;
    }),
    app: mutation(async () => {
      throw new DrizzleBaseError("not allowed", { reason: "quota", limit: 3n });
    }),
    unencodable: mutation(async (ctx) => {
      await ctx.db.insert(users).values({ name: "must roll back" });
      return new Map([[1, 2]]);
    }),
    weird: query(async () => new Map([[1, 2]])),
  },
  checked: {
    echo: query({
      args: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (v: unknown) =>
            typeof (v as { n?: unknown }).n === "number"
              ? { value: { n: (v as { n: number }).n * 2 } }
              : { issues: [{ message: "n must be a number" }] },
        },
      },
      handler: async (_ctx, a: { n: number }) => a.n,
    }),
  },
});

const is =
  <T extends ServerFrame["t"]>(t: T, id?: string) =>
  (f: ServerFrame): f is Extract<ServerFrame, { t: T }> =>
    f.t === t && (id === undefined || (f as { id?: string }).id === id);

describe("subscriptions on the wire", () => {
  test("upd first, then a txn per change, and nothing after unsub", async () => {
    await withServer(api, async ({ sql: pool, connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "a", name: "users.names", args: {} });
      c.send({ t: "sub", id: "b", name: "users.count", args: {} });
      expect(await c.next(is("upd", "a"))).toEqual({ t: "upd", id: "a", c: null, value: [] });
      await c.next(is("upd", "b"));
      await pool.unsafe(`insert into dzb_app.users(name) values ('ann')`);
      const txn = await c.next(is("txn"));
      expect(txn.t === "txn" && typeof txn.c === "number").toBe(true);
      c.send({ t: "unsub", id: "a" });
      await pool.unsafe(`insert into dzb_app.users(name) values ('bob')`);
      const later = await c.next(
        (f) => f.t === "txn" && f.u.some((x) => x.id === "b" && "value" in x && x.value === 2),
      );
      expect(later.t === "txn" && later.u.some((x) => x.id === "a")).toBe(false); // the premise: b still flows
    });
  });

  test("two subscriptions changed by one transaction arrive in ONE txn frame", async () => {
    await withServer(api, async ({ sql: pool, connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "names", name: "users.names", args: {} });
      c.send({ t: "sub", id: "count", name: "users.count", args: {} });
      await c.next(is("upd", "names"));
      await c.next(is("upd", "count"));
      await pool.unsafe(`insert into dzb_app.users(name) values ('cy')`);
      const txn = await c.next(is("txn"));
      expect(txn.t === "txn" && txn.u.map((x) => x.id).sort()).toEqual(["count", "names"]);
    });
  });

  test("a joiner on an entry another connection already has gets its value at once, on a quiet database", async () => {
    await withServer(api, async ({ sql: pool, connect }) => {
      const a = await connect();
      a.send({ t: "sub", id: "q", name: "users.names", args: {} });
      await a.next(is("upd", "q"));
      await pool.unsafe(`insert into dzb_app.users(name) values ('dee')`);
      await a.next(is("txn")); // the entry's last value now carries a cycle id
      const b = await connect();
      b.send({ t: "sub", id: "q2", name: "users.names", args: {} });
      expect(await b.next(is("upd", "q2"), 2_000)).toMatchObject({ value: ["dee"] });
    });
  });

  test("a first value older than an applied commit is held, and the settled one goes out as upd", async () => {
    await withServer(api, async ({ sql: pool, engine, connect }) => {
      const c = await connect();
      gate = deferred();
      entered = deferred();
      gated = true;
      c.send({ t: "sub", id: "s", name: "slow.names", args: {} });
      try {
        await entered.promise; // the open's snapshot sees no users
        await pool.unsafe(`insert into dzb_app.users(name) values ('eve')`);
        await engine.flush(); // applied before the open registers: its replay will find it
      } finally {
        gate.resolve();
      }
      const upd = await c.next(is("upd", "s"));
      expect(upd).toMatchObject({ value: ["eve"] });
      expect(upd.t === "upd" && typeof upd.c).toBe("number");
      expect(c.frames.filter(is("upd", "s")).length).toBe(1);
    });
  });
});

describe("read-your-writes on the wire", () => {
  test("res names a cycle; a txn at or after it follows even when nothing watched changed — 20 in a row", async () => {
    await withServer(api, async ({ connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "p", name: "posts.titles", args: {} });
      await c.next(is("upd", "p"));
      for (let i = 0; i < 20; i++) {
        c.send({ t: "mut", id: `m${i}`, name: "comments.touch", args: {} });
        const res = await c.next(is("res", `m${i}`));
        if (res.t !== "res" || res.c === null) throw new Error("expected a confirmed reply");
        const stamp = await c.next((f) => f.t === "txn" && f.c >= (res.c as number));
        expect(c.frames.indexOf(res)).toBeLessThan(c.frames.indexOf(stamp)); // the reply comes first
      }
    });
  });

  test("the txn that resolves a mutation carries the write to every subscription it changed", async () => {
    await withServer(api, async ({ connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "n", name: "users.names", args: {} });
      await c.next(is("upd", "n"));
      let names: unknown = [];
      for (let i = 0; i < 10; i++) {
        c.send({ t: "mut", id: `a${i}`, name: "users.add", args: { name: `u${i}` } });
        const res = await c.next(is("res", `a${i}`));
        expect(res).toMatchObject({ value: { added: `u${i}`, at: { $t: "date", v: "1970-01-01T00:00:00.000Z" } } });
        const c0 = res.t === "res" ? (res.c as number) : -1;
        // what the client holds once a txn at or after the named cycle arrived
        await c.next((f) => f.t === "txn" && f.c >= c0);
        for (const f of c.frames)
          if (f.t === "upd" || f.t === "txn")
            for (const x of f.t === "txn" ? f.u : [f]) if (x.id === "n" && "value" in x) names = x.value;
        expect(names).toContain(`u${i}`);
      }
    });
  });

  test("a mutation whose named cycle fails is still carried by a later cycle (compared with ≥)", async () => {
    await withServer(api, async ({ sql: pool, connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "p", name: "posts.titles", args: {} });
      await c.next(is("upd", "p"));
      let fail = true;
      const restore = interceptReserved(pool, (q) => {
        if (!isExport(q) || !fail) return undefined;
        fail = false;
        return Promise.reject(new Error("simulated: the named cycle fails"));
      });
      try {
        c.send({ t: "mut", id: "m", name: "comments.touch", args: {} });
        const res = await c.next(is("res", "m"));
        const named = res.t === "res" ? (res.c as number) : -1;
        const stamp = await c.next((f) => f.t === "txn" && f.c >= named);
        expect(fail).toBe(false); // the premise: a cycle did fail
        expect(stamp.t === "txn" && stamp.c > named).toBe(true); // carried by a LATER cycle than the named one
      } finally {
        restore();
      }
    });
  });

  test("two pending mutations are both carried", async () => {
    await withServer(api, async ({ connect }) => {
      const c = await connect();
      c.send({ t: "mut", id: "x", name: "comments.touch", args: {} });
      c.send({ t: "mut", id: "y", name: "comments.touch", args: {} });
      const rx = await c.any(is("res", "x")); // replies may come in either order
      const ry = await c.any(is("res", "y"));
      const top = Math.max(rx.t === "res" ? (rx.c as number) : 0, ry.t === "res" ? (ry.c as number) : 0);
      await c.any((f) => f.t === "txn" && f.c >= top);
    });
  });
});

describe("errors", () => {
  test("unknown names and kind confusion are not_found; bad frames are bad_request", async () => {
    await withServer(api, async ({ connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "1", name: "nope", args: {} });
      expect(await c.next(is("err", "1"))).toMatchObject({ code: "not_found" });
      c.send({ t: "sub", id: "2", name: "users.add", args: {} });
      expect(await c.next(is("err", "2"))).toMatchObject({ code: "not_found" });
      c.send({ t: "mut", id: "3", name: "users.names", args: {} });
      expect(await c.next(is("err", "3"))).toMatchObject({ code: "not_found" });
      c.sendRaw("not json");
      expect(await c.next(is("err"))).toMatchObject({ code: "bad_request" });
      c.send({ t: "sub", id: "4", name: "users.names", args: [] });
      expect(await c.next(is("err", "4"))).toMatchObject({ code: "bad_request" });
    });
  });

  test("args are validated before the handler, which gets the schema's output", async () => {
    await withServer(api, async ({ connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "ok", name: "checked.echo", args: { n: 21 } });
      expect(await c.next(is("upd", "ok"))).toMatchObject({ value: 42 });
      c.send({ t: "sub", id: "bad", name: "checked.echo", args: { n: "x" } });
      expect(await c.next(is("err", "bad"))).toMatchObject({ code: "invalid_args", message: "n must be a number" });
    });
  });

  test("an internal failure reaches the client with no detail, pushed or replied", async () => {
    await withServer(api, async ({ sql: pool, connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "s", name: "fails.secret", args: {} });
      expect(await c.next(is("err", "s"))).toEqual({ t: "err", id: "s", code: "internal" });
      c.send({ t: "sub", id: "d", name: "fails.driver", args: {} });
      await c.next(is("upd", "d"));
      await pool.unsafe(`insert into dzb_app.users(name) values ('triggers the driver error')`);
      const pushed = await c.next((f) => f.t === "txn" && f.u.some((x) => x.id === "d" && "error" in x));
      expect(pushed.t === "txn" && pushed.u.find((x) => x.id === "d")).toEqual({
        id: "d",
        error: { code: "internal" },
      });
      c.send({ t: "sub", id: "w", name: "fails.weird", args: {} });
      expect(await c.next(is("upd", "w"))).toEqual({ t: "upd", id: "w", c: null, error: { code: "internal" } });
      expect(JSON.stringify(c.frames)).not.toContain("marker-7f3a");
      expect(JSON.stringify(c.frames)).not.toContain("secret detail");
    });
  });

  test("an application error carries its message and data", async () => {
    await withServer(api, async ({ connect }) => {
      const c = await connect();
      c.send({ t: "mut", id: "m", name: "fails.app", args: {} });
      expect(await c.next(is("err", "m"))).toEqual({
        t: "err",
        id: "m",
        code: "app",
        message: "not allowed",
        data: { reason: "quota", limit: { $t: "bigint", v: "3" } },
      });
    });
  });

  test("a mutation whose result cannot be sent fails and its write rolls back", async () => {
    await withServer(api, async ({ sql: pool, connect }) => {
      const c = await connect();
      c.send({ t: "mut", id: "m", name: "fails.unencodable", args: {} });
      expect(await c.next(is("err", "m"))).toEqual({ t: "err", id: "m", code: "internal" });
      const [{ n }] = await pool.unsafe("select count(*)::int as n from dzb_app.users where name = 'must roll back'");
      expect(n).toBe(0);
    });
  });
});

describe("limits, origins, cleanup, reset", () => {
  test("subscription cap, duplicate ids and the in-flight cap", async () => {
    await withServer(
      api,
      async ({ connect }) => {
        const c = await connect();
        c.send({ t: "sub", id: "1", name: "users.names", args: {} });
        c.send({ t: "sub", id: "1", name: "users.count", args: {} });
        expect(await c.next(is("err", "1"))).toMatchObject({ code: "duplicate_id" });
        c.send({ t: "sub", id: "2", name: "users.count", args: {} });
        await c.next(is("upd", "2"));
        c.send({ t: "sub", id: "3", name: "posts.titles", args: {} });
        expect(await c.next(is("err", "3"))).toMatchObject({ code: "too_many_subscriptions" });
      },
      { maxSubscriptions: 2 },
    );
    await withServer(
      api,
      async ({ connect }) => {
        const c = await connect();
        gate = deferred();
        entered = deferred();
        gated = true;
        c.send({ t: "sub", id: "held", name: "slow.names", args: {} });
        try {
          await entered.promise;
          c.send({ t: "sub", id: "more", name: "users.count", args: {} });
          expect(await c.next(is("err", "more"))).toMatchObject({ code: "too_busy" });
        } finally {
          gate.resolve();
        }
      },
      { maxInFlight: 1 },
    );
  });

  test("a frame over the payload limit closes the socket", async () => {
    await withServer(
      api,
      async ({ connect }) => {
        const c = await connect();
        c.send({ t: "sub", id: "big", name: "users.names", args: { pad: "x".repeat(4096) } });
        expect((await c.closed).code).not.toBe(1000);
      },
      { maxPayloadLength: 1024 },
    );
  });

  test("the default refuses a foreign browser origin and admits loopback and non-browser clients", async () => {
    await withServer(api, async ({ url, connect }) => {
      const http = url.replace("ws://", "http://");
      const upgrade = {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      expect((await fetch(http, { headers: { ...upgrade, Origin: "https://evil.example" } })).status).toBe(403);
      const local = await connect({ Origin: "http://localhost:5173" });
      local.send({ t: "ping" });
      await local.next(is("pong"));
      const none = await connect();
      none.send({ t: "ping" });
      await none.next(is("pong"));
    });
  });

  test("closing a socket releases its subscriptions, also one still being opened", async () => {
    await withServer(api, async ({ engine, handler, connect }) => {
      const before = engine.size;
      const c = await connect();
      c.send({ t: "sub", id: "a", name: "users.names", args: {} });
      c.send({ t: "sub", id: "b", name: "posts.titles", args: {} });
      await c.next(is("upd", "a"));
      await c.next(is("upd", "b"));
      expect(engine.size).toBe(before + 2); // the premise
      c.close();
      await c.closed;
      for (let i = 0; i < 100 && engine.size !== before; i++) await Bun.sleep(10);
      expect(engine.size).toBe(before);

      const d = await connect();
      gate = deferred();
      entered = deferred();
      gated = true;
      d.send({ t: "sub", id: "p", name: "slow.names", args: {} });
      await entered.promise; // pending: the engine has no listener for it yet
      d.close();
      await d.closed;
      gate.resolve();
      for (let i = 0; i < 200 && handler.pendingCalls > 0; i++) await Bun.sleep(10);
      expect(handler.pendingCalls).toBe(0); // the premise: the open has resolved (and registered an entry)
      expect(engine.size).toBe(before);
    });
  });

  test("an unsubscribe while the subscription is still opening releases it when the open resolves", async () => {
    await withServer(api, async ({ engine, handler, connect }) => {
      const before = engine.size;
      const c = await connect();
      gate = deferred();
      entered = deferred();
      gated = true;
      c.send({ t: "sub", id: "p", name: "slow.names", args: {} });
      await entered.promise;
      c.send({ t: "unsub", id: "p" });
      c.send({ t: "ping" });
      await c.next(is("pong")); // the unsub was processed
      gate.resolve();
      for (let i = 0; i < 200 && handler.pendingCalls > 0; i++) await Bun.sleep(10);
      expect(handler.pendingCalls).toBe(0); // the premise: the open has resolved
      expect(engine.size).toBe(before);
      expect(c.frames.some(is("upd", "p"))).toBe(false);
    });
  });

  test("an engine reset reaches the client; subscribing while down is unavailable; after resume it works", async () => {
    await withServer(api, async ({ engine, connect }) => {
      const c = await connect();
      c.send({ t: "sub", id: "a", name: "users.names", args: {} });
      await c.next(is("upd", "a"));
      engine.reset("test");
      await c.next(is("reset"));
      c.send({ t: "sub", id: "b", name: "users.names", args: {} });
      expect(await c.next(is("err", "b"))).toMatchObject({ code: "unavailable" });
      engine.resume();
      c.send({ t: "sub", id: "c", name: "users.names", args: {} });
      await c.next(is("upd", "c"));
      expect(c.frames.filter(is("reset")).length).toBe(1);
    });
  });
});
