// The wire encodes a mutation's return value; a value that cannot be encoded must fail the mutation BEFORE it
// commits, never after (a write the client then believes failed). And a WAL position that cannot be read after
// COMMIT is not a failure: the write landed.
import { expect, test } from "bun:test";
import { functions, Runtime } from "../../../src/runtime";
import { schema, users, withApp } from "../../support/app";

const { mutation } = functions<typeof schema>();

test("an encode hook that throws rolls the mutation back", async () => {
  await withApp(async (sql, n) => {
    const rt = new Runtime({ sql, schema, publication: n.publication });
    const add = mutation(async (ctx) => {
      await ctx.db.insert(users).values({ name: "should not land" });
      return { ok: true };
    });
    const refused = await rt
      .runMutation(
        add,
        {},
        {
          encode: () => {
            throw new Error("not encodable");
          },
        },
      )
      .then(
        () => "committed",
        (e: unknown) => String(e),
      );
    expect(refused).toMatch(/not encodable/);
    const [{ c }] = await sql.unsafe("select count(*)::int as c from dzb_app.users");
    expect(c).toBe(0);
    const ok = await rt.runMutation(add, {}, { encode: (v) => JSON.stringify(v) });
    expect(ok.encoded).toBe('{"ok":true}');
  });
});

test("a WAL position unreadable after COMMIT gives commitLsn null, not an error", async () => {
  await withApp(async (sql, n) => {
    const rt = new Runtime({ sql, schema, publication: n.publication });
    (rt as unknown as { walPosition: () => Promise<string> }).walPosition = async () => {
      throw new Error("connection lost after COMMIT");
    };
    const run = await rt.runMutation(
      mutation(async (ctx) => ctx.db.insert(users).values({ name: "landed" })),
      {},
    );
    expect(run.commitLsn).toBeNull();
    const [{ c }] = await sql.unsafe("select count(*)::int as c from dzb_app.users");
    expect(c).toBe(1);
  });
});
