import { beforeAll, describe, expect, test } from "bun:test";
import type { CapturedTxn } from "../src/capture/types";
import { Catalog } from "../src/readset/catalog";
import { buildReadSet, type ReadSet, touches } from "../src/readset/readset";
import { collectRefs } from "../src/readset/refs";
import { loadParser, parseStatement } from "../src/sql/parse";
import { withApp } from "./fixtures/app";

beforeAll(loadParser);
const rs = (catalog: Catalog, sqlText: string) => buildReadSet(collectRefs(parseStatement(sqlText).stmt), catalog);
const sorted = (r: ReadSet) => [...r.tables].sort();

describe("buildReadSet", () => {
	test("tables resolve to schema.name, quoted or not", async () => {
		await withApp(async (sql, n) => {
			const c = new Catalog(sql, n.publication);
			const r = await rs(c, `select * from dzb_app.users u where not exists (select 1 from "dzb_app"."posts" p where p.author_id = u.id)`);
			expect(sorted(r)).toEqual(["dzb_app.posts", "dzb_app.users"]);
			expect(r.opaque).toEqual([]);
			expect(r.volatile).toEqual([]);
		});
	});

	test("a view, an RLS table, a table outside the publication and an unknown relation are opaque", async () => {
		await withApp(async (sql, n) => {
			const c = new Catalog(sql, n.publication);
			expect((await rs(c, `select * from dzb_app.adults`)).opaque.join()).toMatch(/view/);
			expect((await rs(c, `select * from dzb_app.secrets`)).opaque.join()).toMatch(/row level security/);
			expect((await rs(c, `select * from public.dzb_outside`)).opaque.join()).toMatch(/not in the publication/);
			expect((await rs(c, `select * from dzb_app.nope`)).opaque.join()).toMatch(/unknown relation/);
		});
	});

	test("a user function makes the read-set opaque", async () => {
		await withApp(async (sql, n) => {
			const r = await rs(new Catalog(sql, n.publication), `select dzb_app.post_count(id) from dzb_app.users`);
			expect(r.opaque.join()).toMatch(/user function dzb_app.post_count/);
		});
	});

	test("non-immutable functions and SQL value functions are volatile; immutable ones are not", async () => {
		await withApp(async (sql, n) => {
			const c = new Catalog(sql, n.publication);
			expect((await rs(c, `select now(), random() from dzb_app.users`)).volatile.sort()).toEqual(["now", "random"]);
			expect((await rs(c, `select current_date from dzb_app.users`)).volatile).toEqual(["SVFOP_CURRENT_DATE"]);
			expect((await rs(c, `select lower(name), count(*) from dzb_app.users group by 1`)).volatile).toEqual([]);
		});
	});

	test("a partition leaf also names its root; the root names its leaves", async () => {
		await withApp(async (sql, n) => {
			const c = new Catalog(sql, n.publication);
			expect(sorted(await rs(c, `select * from dzb_app.events_1`))).toEqual(["dzb_app.events", "dzb_app.events_1"]);
			expect(sorted(await rs(c, `select * from dzb_app.events`))).toEqual(["dzb_app.events", "dzb_app.events_1"]);
		});
	});

	test("an inheritance parent also names its children", async () => {
		await withApp(async (sql, n) => {
			expect(sorted(await rs(new Catalog(sql, n.publication), `select * from dzb_app.animals`))).toEqual(["dzb_app.animals", "dzb_app.dogs"]);
		});
	});

	test("a CTE named like a table never removes the table", async () => {
		await withApp(async (sql, n) => {
			const c = new Catalog(sql, n.publication);
			// search_path does not include dzb_app, so the bare "posts" below is the CTE; the qualified one is the table.
			// The default search_path has no dzb_app: the bare "posts" is only the CTE, the qualified one the table.
			const r = await rs(c, `with posts as (select 1 as id) select * from posts, dzb_app.posts`);
			expect(sorted(r)).toEqual(["dzb_app.posts"]);
			expect(r.opaque).toEqual([]);
			// public IS on the search_path: this CTE shadows the real table public.dzb_outside. The table must still
			// be resolved (here it is unpublished, so the read-set turns opaque) — never skipped as "just a CTE".
			const shadow = await rs(c, `with dzb_outside as (select 1 as id) select * from dzb_outside`);
			expect(shadow.opaque.join()).toMatch(/public.dzb_outside is not in the publication/);
		});
	});
});

describe("touches", () => {
	const txn = (over: Partial<CapturedTxn>): CapturedTxn => ({ xid: 1, commitLsn: "0/1", commitEndLsn: "0/2", changes: [], wholeTables: new Set(), ddl: false, ...over });
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
