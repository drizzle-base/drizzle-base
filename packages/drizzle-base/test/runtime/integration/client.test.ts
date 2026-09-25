import { beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { CapturingClient } from "../../../src/runtime";
import { ForbiddenStatementError, loadParser } from "../../../src/sql";
import { schema, users, withApp } from "../../../test/support/app";

beforeAll(loadParser);

async function inTxn<T>(
  pool: SQL,
  mode: "query" | "mutation",
  fn: (
    db: ReturnType<typeof drizzle<typeof schema>>,
    client: CapturingClient,
    conn: Awaited<ReturnType<SQL["reserve"]>>,
  ) => Promise<T>,
): Promise<T> {
  const conn = await pool.reserve();
  try {
    await conn.unsafe(
      mode === "query" ? "begin isolation level repeatable read read only" : "begin isolation level serializable",
    );
    const client = new CapturingClient(conn, mode);
    // drizzle-orm/bun-sql types its client as Bun's SQL; CapturingClient implements the part the driver calls.
    const db = drizzle({ client: client as unknown as SQL, schema });
    const out = await fn(db, client, conn);
    await conn.unsafe("commit");
    return out;
  } catch (e) {
    await conn.unsafe("rollback").catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

describe("CapturingClient under drizzle-orm/bun-sql", () => {
  test("builder, relational and execute all run through it and are recorded", async () => {
    await withApp(async (pool) => {
      await pool.unsafe(
        `insert into dzb_app.users(id, name, age) values ('0190a000-0000-7000-8000-000000000001', 'Dan', 30)`,
      );
      const out = await inTxn(pool, "query", async (db, client) => {
        const a = await db.select().from(users).where(eq(users.age, 30));
        const b = await db.query.users.findFirst({ with: { posts: true } });
        const c = await db.execute(sql`select count(*)::int as n from dzb_app.users`);
        return { a, b, c: c[0], kinds: client.statements.map((s) => s.kind), n: client.statements.length };
      });
      expect(out.a[0]?.name).toBe("Dan");
      expect(out.b?.posts).toEqual([]);
      expect(out.c).toEqual({ n: 1 });
      expect(out.kinds).toEqual(["select", "select", "select"]);
    });
  });

  test("a nested db.transaction() does not end the outer transaction", async () => {
    await withApp(async (pool) => {
      await inTxn(pool, "query", async (db, _client, conn) => {
        const [{ s: before }] = await conn.unsafe("select pg_current_snapshot()::text as s");
        await db.transaction(async (tx) => {
          await tx.select().from(users);
          await tx.transaction(async (inner) => inner.select().from(users));
        });
        await pool.unsafe(`insert into dzb_app.users(name) values ('committed elsewhere')`); // another connection
        const [{ s: after }] = await conn.unsafe("select pg_current_snapshot()::text as s");
        const [{ inTx }] = await conn.unsafe('select now() = statement_timestamp() as "inTx"');
        expect(after).toBe(before); // still the same snapshot: the outer transaction is alive
        expect(inTx).toBe(false); // now() is frozen at BEGIN inside a transaction
      });
    });
  });

  test("a failing inner transaction rolls back to its savepoint, the outer one continues", async () => {
    await withApp(async (pool) => {
      const n = await inTxn(pool, "mutation", async (db) => {
        await db.insert(users).values({ name: "kept" });
        await db
          .transaction(async (tx) => {
            await tx.insert(users).values({ name: "discarded" });
            throw new Error("inner");
          })
          .catch(() => {});
        return (await db.select().from(users)).map((u) => u.name);
      });
      expect(n).toEqual(["kept"]);
    });
  });

  test("transaction control, DDL, several statements, and writes inside a query are refused before reaching Postgres", async () => {
    await withApp(async (pool) => {
      await inTxn(pool, "query", async (db) => {
        // Drizzle wraps any driver error in DrizzleQueryError and keeps ours as `cause`.
        const refused = async (f: () => PromiseLike<unknown>, reason: RegExp) => {
          const err = await (async () => f())().then(
            () => null,
            (e: unknown) => e,
          );
          const cause = (err as { cause?: unknown })?.cause ?? err;
          expect(cause).toBeInstanceOf(ForbiddenStatementError);
          expect(String((cause as Error).message)).toMatch(reason);
        };
        await refused(() => db.execute(sql`commit`), /TransactionStmt/);
        await refused(() => db.execute(sql`drop table dzb_app.users`), /DropStmt/);
        await refused(() => db.execute(sql.raw(`select 1; delete from dzb_app.users`)), /exactly one statement/);
        await refused(() => db.insert(users).values({ name: "x" }), /read-only/);
        await refused(() => db.transaction(async () => {}, { isolationLevel: "read committed" }), /VariableSetStmt/);
      });
      const [{ n }] = await pool.unsafe("select count(*)::int as n from dzb_app.users");
      expect(n).toBe(0);
    });
  });
});
