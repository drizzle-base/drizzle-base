import { beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { CapturedTxn } from "../../src/capture";
import { emitBarrier, PgoutputCapture } from "../../src/capture";
import { touches } from "../../src/readset";
import { functions, Runtime } from "../../src/runtime";
import { loadParser } from "../../src/sql";
import { posts, schema, users, withApp } from "../../test/support/app";
import { pgConfig } from "../../test/support/db";

beforeAll(loadParser);
const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";

test("a query's read-set is touched by the writes that can change it — from a mutation or from raw SQL — and by nothing else", async () => {
  await withApp(async (sql, n) => {
    await sql.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
    const rt = new Runtime({ sql, schema, publication: n.publication });
    const txns: CapturedTxn[] = [];
    const waiters = new Map<string, () => void>();
    const cap = new PgoutputCapture({ connection: pgConfig, names: n });
    const errors: Error[] = [];
    await cap.start({
      onEvent: (e) => {
        if (e.kind === "txn") txns.push(e.txn);
        else waiters.get(e.id)?.();
      },
      onError: (e) => errors.push(e),
    });
    const step = async (id: string, write: () => Promise<unknown>) => {
      const from = txns.length;
      await write();
      const seen = new Promise<void>((r) => waiters.set(id, r));
      await emitBarrier(sql, id);
      await seen;
      return txns.slice(from);
    };
    try {
      const feed = query(async (ctx, a: { id: string }) =>
        ctx.db.query.users.findFirst({ where: eq(users.id, a.id), with: { posts: true } }),
      );
      const { readSet } = await rt.runQuery(feed, { id: U });
      const addPost = mutation(async (ctx) => ctx.db.insert(posts).values({ authorId: U, title: "via mutation" }));

      const viaMutation = await step("m", () => rt.runMutation(addPost, {}));
      const viaStudio = await step("s", () =>
        sql.unsafe(`update dzb_app.users set name = 'edited in Studio' where id = '${U}'`),
      );
      const unrelated = await step("u", () =>
        sql.unsafe(`insert into dzb_app.comments(post_id, body) values (uuidv7(), 'not read by the query')`),
      );

      expect(viaMutation.some((t) => touches(readSet, t))).toBe(true);
      expect(viaStudio.some((t) => touches(readSet, t))).toBe(true);
      expect(unrelated.length).toBeGreaterThan(0); // the premise: the unrelated write WAS captured
      expect(unrelated.some((t) => touches(readSet, t))).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await cap.stop();
    }
  });
}, 30_000);
