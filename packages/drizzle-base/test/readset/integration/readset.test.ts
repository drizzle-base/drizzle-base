import { beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { CapturedTxn } from "../../../src/capture";
import {
  buildReadSet,
  CATALOG_STATEMENT,
  Catalog,
  collectRefs,
  type ReadSet,
  readSetOf,
  touches,
} from "../../../src/readset";
import { loadParser, parseStatement } from "../../../src/sql";
import { withApp } from "../../../test/support/app";

beforeAll(loadParser);
// Resolution runs on the given connection with its search_path, as the runtime does inside a function.
const rs = async (sql: SQL, catalog: Catalog, sqlText: string) => {
  const [{ sp }] = await sql`select current_setting('search_path') as sp`;
  return buildReadSet(collectRefs(parseStatement(sqlText).stmt), catalog, sql, sp as string);
};
const sorted = (r: ReadSet) => [...r.tables].sort();

describe("buildReadSet", () => {
  test("tables resolve to schema.name, quoted or not", async () => {
    await withApp(async (sql, n) => {
      const c = new Catalog(n.publication);
      const r = await rs(
        sql,
        c,
        `select * from dzb_app.users u where not exists (select 1 from "dzb_app"."posts" p where p.author_id = u.id)`,
      );
      expect(sorted(r)).toEqual(["dzb_app.posts", "dzb_app.users"]);
      expect(r.opaque).toEqual([]);
      expect(r.volatile).toEqual([]);
    });
  });

  test("a view, an RLS table, a table outside the publication and an unknown relation are opaque", async () => {
    await withApp(async (sql, n) => {
      const c = new Catalog(n.publication);
      expect((await rs(sql, c, `select * from dzb_app.adults`)).opaque.join()).toMatch(/view/);
      expect((await rs(sql, c, `select * from dzb_app.secrets`)).opaque.join()).toMatch(/row level security/);
      expect((await rs(sql, c, `select * from public.dzb_outside`)).opaque.join()).toMatch(/not in the publication/);
      expect((await rs(sql, c, `select * from dzb_app.nope`)).opaque.join()).toMatch(/unknown relation/);
    });
  });

  test("a user function makes the read-set opaque", async () => {
    await withApp(async (sql, n) => {
      const r = await rs(sql, new Catalog(n.publication), `select dzb_app.post_count(id) from dzb_app.users`);
      expect(r.opaque.join()).toMatch(/user function dzb_app.post_count/);
    });
  });

  test("non-immutable functions and SQL value functions are volatile; immutable ones are not", async () => {
    await withApp(async (sql, n) => {
      const c = new Catalog(n.publication);
      expect((await rs(sql, c, `select now(), random() from dzb_app.users`)).volatile.sort()).toEqual([
        "now",
        "random",
      ]);
      expect((await rs(sql, c, `select current_date from dzb_app.users`)).volatile).toEqual(["SVFOP_CURRENT_DATE"]);
      expect((await rs(sql, c, `select lower(name), count(*) from dzb_app.users group by 1`)).volatile).toEqual([]);
    });
  });

  test("a partition leaf also names its root; the root names its leaves", async () => {
    await withApp(async (sql, n) => {
      const c = new Catalog(n.publication);
      expect(sorted(await rs(sql, c, `select * from dzb_app.events_1`))).toEqual([
        "dzb_app.events",
        "dzb_app.events_1",
      ]);
      expect(sorted(await rs(sql, c, `select * from dzb_app.events`))).toEqual(["dzb_app.events", "dzb_app.events_1"]);
    });
  });

  test("an inheritance parent also names its children", async () => {
    await withApp(async (sql, n) => {
      expect(sorted(await rs(sql, new Catalog(n.publication), `select * from dzb_app.animals`))).toEqual([
        "dzb_app.animals",
        "dzb_app.dogs",
      ]);
    });
  });

  test("a CTE named like a table never removes the table", async () => {
    await withApp(async (sql, n) => {
      const c = new Catalog(n.publication);
      // search_path does not include dzb_app, so the bare "posts" below is the CTE; the qualified one is the table.
      // The default search_path has no dzb_app: the bare "posts" is only the CTE, the qualified one the table.
      const r = await rs(sql, c, `with posts as (select 1 as id) select * from posts, dzb_app.posts`);
      expect(sorted(r)).toEqual(["dzb_app.posts"]);
      expect(r.opaque).toEqual([]);
      // public IS on the search_path: this CTE shadows the real table public.dzb_outside. The table must still
      // be resolved (here it is unpublished, so the read-set turns opaque) — never skipped as "just a CTE".
      const shadow = await rs(sql, c, `with dzb_outside as (select 1 as id) select * from dzb_outside`);
      expect(shadow.opaque.join()).toMatch(/public.dzb_outside is not in the publication/);
    });
  });
});

describe("shapes the final review found escaping the read-set", () => {
  test("built-in functions that run SQL, and user operators, make it opaque", async () => {
    await withApp(async (sql, n) => {
      const c = new Catalog(n.publication);
      expect(
        (await rs(sql, c, `select query_to_xml('select * from dzb_app.posts', true, false, '')`)).opaque.join(),
      ).toMatch(/query_to_xml reads tables/);
      expect((await rs(sql, c, `select table_to_xml('dzb_app.posts', true, false, '')`)).opaque.join()).toMatch(
        /table_to_xml reads tables/,
      );
      await sql.unsafe(`create function dzb_app.eq_via_table(int, int) returns boolean language sql stable as $$ select exists (select 1 from dzb_app.posts) and $1 = $2 $$;
				create operator dzb_app.=== (leftarg = int, rightarg = int, function = dzb_app.eq_via_table)`);
      expect((await rs(sql, c, `select 1 operator(dzb_app.===) 2`)).opaque.join()).toMatch(/user operator dzb_app.===/);
      expect((await rs(sql, c, `select * from dzb_app.users where age = 3 and name like 'a%'`)).opaque).toEqual([]); // built-in operators stay clean
    });
  });

  test("every table the scan reaches must be in the publication, not just one of the family", async () => {
    await withApp(async (sql, _n) => {
      const onlyParent = `pub_only_parent_${process.pid}`,
        onlyChild = `pub_only_child_${process.pid}`;
      await sql.unsafe(
        `create publication ${onlyParent} for table only dzb_app.animals; create publication ${onlyChild} for table dzb_app.dogs`,
      );
      try {
        // the parent is published, its child is not: reading the parent also reads the child's rows
        const a = await rs(sql, new Catalog(onlyParent), `select * from dzb_app.animals`);
        expect(a.opaque.join()).toMatch(/dzb_app.dogs is not in the publication/);
        // FROM ONLY reads only the parent: clean
        expect((await rs(sql, new Catalog(onlyParent), `select * from only dzb_app.animals`)).opaque).toEqual([]);
        // the child is published, the parent's own rows are not
        expect((await rs(sql, new Catalog(onlyChild), `select * from dzb_app.animals`)).opaque.join()).toMatch(
          /dzb_app.animals is not in the publication/,
        );
      } finally {
        await sql.unsafe(`drop publication ${onlyParent}; drop publication ${onlyChild}`);
      }
    });
  });
});

describe("touches", () => {
  const txn = (over: Partial<CapturedTxn>): CapturedTxn => ({
    xid: 1,
    commitLsn: "0/1",
    commitEndLsn: "0/2",
    changes: [],
    wholeTables: new Set(),
    ddl: false,
    ...over,
  });
  const change = (table: string) => ({ table, relOid: 1, op: "insert" as const, old: null, new: { id: 1 } });
  const read: ReadSet = { tables: new Set(["dzb_app.users", "dzb_app.posts"]), opaque: [], volatile: [] };

  test("a change or a whole-table mark on a read table touches; on another table it does not", () => {
    expect(touches(read, txn({ changes: [change("dzb_app.posts")] }))).toBe(true);
    expect(touches(read, txn({ wholeTables: new Set(["dzb_app.users"]) }))).toBe(true);
    expect(touches(read, txn({ changes: [change("dzb_app.comments")] }))).toBe(false);
  });

  test("DDL touches everything; an opaque read-set is touched by any change", () => {
    expect(touches(read, txn({ ddl: true }))).toBe(true);
    const opaque: ReadSet = { tables: new Set(), opaque: ["view dzb_app.adults"], volatile: [] };
    expect(touches(opaque, txn({ changes: [change("dzb_app.comments")] }))).toBe(true);
    expect(touches(opaque, txn({}))).toBe(false);
  });
});

// One catalog statement per run (Catalog.prefetch) must resolve exactly what the per-name loaders resolve. The
// statements below put in ONE statement what a batch could confuse across names: the same relation with and
// without ONLY, several families, a two-level hierarchy read at its middle and its leaf, one table reached by two
// keys, quoted names, a sequence, a function and an operator that exist in two schemas.
describe("prefetch resolves exactly what the per-name loaders resolve", () => {
  const EXTRA = `
    create table dzb_app.events_2 partition of dzb_app.events for values in (2) partition by list (id);
    create table dzb_app.events_2a partition of dzb_app.events_2 for values in (1);
    create table dzb_app.puppies(age int) inherits (dzb_app.dogs);
    create table dzb_app."MixedCase"(id int primary key);
    create table dzb_app."a.b"(id int primary key);
    create table dzb_app."a$q$b'c"(id int primary key);
    create table dzb_app."$dzb_x$"(id int primary key);
    create sequence dzb_app.seq_x;
    create function dzb_app.lower(text) returns text language sql immutable as $$ select $1 $$;
    drop schema if exists dzb_ops cascade;
    create schema dzb_ops;
    create function dzb_ops.eq3(int, int) returns boolean language sql immutable as $$ select $1 = $2 $$;
    create operator dzb_ops.=== (leftarg = int, rightarg = int, function = dzb_ops.eq3);
    create function dzb_app.eq3(int, int) returns boolean language sql stable as $$ select $1 = $2 $$;
    create operator dzb_app.=== (leftarg = int, rightarg = int, function = dzb_app.eq3);`;
  const CORPUS = [
    `select * from only dzb_app.animals a1, dzb_app.animals a2`,
    `select * from dzb_app.animals a1, only dzb_app.animals a2`,
    `select * from only dzb_app.animals, dzb_app.users`,
    `select * from only dzb_app.events, dzb_app.animals`,
    `select * from dzb_app.users, only dzb_app.dogs, dzb_app.events_2`,
    `select * from dzb_app.events_1, dzb_app.animals, dzb_app.users`,
    `select * from dzb_app.events_2, dzb_app.events_2a, dzb_app.dogs, dzb_app.puppies`,
    `select * from dzb_app.events, only dzb_app.dogs, dzb_app.puppies`,
    `select * from users, dzb_app.users, posts`,
    `select * from dzb_app."MixedCase", dzb_app."a.b", dzb_app.mixedcase`,
    `select * from dzb_app."a$q$b'c", dzb_app."$dzb_x$"`,
    `select * from dzb_app.seq_x, dzb_app.adults, dzb_app.secrets, public.dzb_outside, dzb_app.nope`,
    `with posts as (select 1 as id) select * from posts, dzb_app.posts, dzb_outside`,
    `select lower(name), dzb_app.lower(name), pg_catalog.lower(name), now(), dzb_app.post_count(id) from dzb_app.users`,
    `select 1 === 2, 1 operator(dzb_ops.===) 2, 1 operator(dzb_app.===) 2, 3 between 1 and 4, 'a' || 'b'`,
    `select query_to_xml('select 1', true, false, ''), random(), current_date from dzb_app.users`,
    `select 1`,
  ];
  const norm = (r: ReadSet) => ({ tables: [...r.tables].sort(), opaque: r.opaque, volatile: r.volatile });

  // "planned": the batch is planned on every call; "prepared": the runtime's path, PREPAREd once per connection.
  for (const mode of ["planned", "prepared"] as const)
    for (const searchPath of ["public", "dzb_app, public", "dzb_ops, dzb_app, public"])
      test(`${mode}, on search_path ${searchPath}`, async () => {
        await withApp(async (sql, n) => {
          await sql.unsafe(EXTRA);
          const conn = await sql.reserve();
          try {
            await conn.unsafe(`set search_path to ${searchPath}`);
            const [{ sp, ready }] = await conn.unsafe(
              "select current_schemas(true)::text as sp, exists (select 1 from pg_prepared_statements where name = $1) as ready",
              [CATALOG_STATEMENT],
            );
            const state = mode === "prepared" ? { ready: ready as boolean } : undefined;
            let differed = 0;
            for (const text of CORPUS) {
              const stmt = parseStatement(text).stmt;
              const batched = await readSetOf([{ stmt }], new Catalog(n.publication), conn, sp as string, state);
              const single = await buildReadSet(collectRefs(stmt), new Catalog(n.publication), conn, sp as string);
              expect({ text, ...norm(batched) }).toEqual({ text, ...norm(single) });
              // Per name, not only per statement: a cycle's lanes share one Catalog, so a name's memoised info is
              // reused by OTHER queries — an ancestor credited to the wrong name would vanish in this statement's
              // union and still be missing for a query that reads that name alone.
              const refs = collectRefs(stmt);
              const pre = new Catalog(n.publication);
              const ref = new Catalog(n.publication);
              await pre.prefetch([refs], conn, sp as string, state);
              for (const r of refs.relations)
                expect({ text, r, info: await pre.relation(r, conn, sp as string) }).toEqual({
                  text,
                  r,
                  info: await ref.relation(r, conn, sp as string),
                });
              for (const f of refs.functions)
                expect({ text, f, info: await pre.fn(f, conn, sp as string) }).toEqual({
                  text,
                  f,
                  info: await ref.fn(f, conn, sp as string),
                });
              for (const o of refs.operators)
                expect({ text, o, info: await pre.operator(o, conn, sp as string) }).toEqual({
                  text,
                  o,
                  info: await ref.operator(o, conn, sp as string),
                });
              if (single.opaque.length || single.volatile.length) differed++;
            }
            expect(differed).toBeGreaterThan(5); // the premise: the corpus exercises the widening paths
            if (state) expect(state.ready).toBe(true); // the premise: the prepared path really ran
          } finally {
            await conn.unsafe("reset search_path");
            conn.release();
            await sql.unsafe("drop schema if exists dzb_ops cascade");
          }
        });
      });

  test("one catalog statement for a whole run, none for a second run on the same Catalog, none for no names", async () => {
    await withApp(async (sql, n) => {
      const conn = await sql.reserve();
      try {
        let issued = 0;
        // every statement the catalog sends: tagged-template calls and unsafe()
        const counted = new Proxy(conn, {
          apply(target, self, args) {
            issued++;
            return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, self, args);
          },
          get(target, prop) {
            if (prop !== "unsafe") return Reflect.get(target, prop);
            return (...a: Parameters<typeof conn.unsafe>) => {
              issued++;
              return target.unsafe(...a);
            };
          },
        });
        const [{ sp }] = await conn.unsafe("select current_schemas(true)::text as sp");
        const run = (text: string, c: Catalog) =>
          readSetOf([{ stmt: parseStatement(text).stmt }], c, counted as unknown as SQL, sp as string);
        // bare and qualified forms of every kind, and ONLY both ways
        const text = `select upper(u.name), pg_catalog.lower(u.name) from dzb_app.users u, only dzb_app.animals a,
          dzb_app.animals b where u.age = 1 and a.id operator(pg_catalog.=) b.id`;
        const c = new Catalog(n.publication);
        await run(text, c);
        expect(issued).toBe(1);
        await run(text, c);
        expect(issued).toBe(1);
        await run("select 1", new Catalog(n.publication));
        expect(issued).toBe(1);
        // The prepared path: PREPARE + EXECUTE the first time on this connection, EXECUTE alone after that.
        const state = { ready: false };
        const prepared = (c: Catalog) =>
          readSetOf([{ stmt: parseStatement(text).stmt }], c, counted as unknown as SQL, sp as string, state);
        issued = 0;
        await prepared(new Catalog(n.publication));
        expect(issued).toBe(2);
        expect(state.ready).toBe(true);
        await prepared(new Catalog(n.publication));
        expect(issued).toBe(3);
      } finally {
        conn.release();
      }
    });
  });
});
