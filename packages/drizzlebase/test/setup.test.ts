import { describe, expect, test } from "bun:test";
import { checkCapture, ensureCapture } from "../src/capture/setup";
import { withCaptureSchema } from "./db";

describe("ensureCapture + checkCapture", () => {
	test("a fresh schema passes after ensureCapture", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".posts(id int primary key, v int)`);
			expect(await checkCapture(sql, n)).not.toEqual([]); // before: no publication, no slot, no FULL
			await ensureCapture(sql, n);
			expect(await checkCapture(sql, n)).toEqual([]);
			await ensureCapture(sql, n); // idempotent
			expect(await checkCapture(sql, n)).toEqual([]);
		});
	});

	test("a table created after setup without FULL is named", async () => {
		await withCaptureSchema(async (sql, n) => {
			await ensureCapture(sql, n);
			await sql.unsafe(`create table "${n.schema}".late(id int primary key)`);
			const problems = await checkCapture(sql, n);
			expect(problems.join("\n")).toContain(`"${n.schema}"."late" is not REPLICA IDENTITY FULL`);
		});
	});

	test("a partition leaf is checked, not only its parent", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".m(id int, k int, primary key (id, k)) partition by list (k)`);
			await sql.unsafe(`create table "${n.schema}".m1 partition of "${n.schema}".m for values in (1)`);
			await ensureCapture(sql, n);
			expect(await checkCapture(sql, n)).toEqual([]);
			await sql.unsafe(`create table "${n.schema}".m2 partition of "${n.schema}".m for values in (2)`);
			expect((await checkCapture(sql, n)).join("\n")).toContain(`"${n.schema}"."m2" is not REPLICA IDENTITY FULL`);
		});
	});

	test("a virtual generated column is refused", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".g(id int primary key, a int, b int generated always as (a * 2) virtual)`);
			await ensureCapture(sql, n);
			expect((await checkCapture(sql, n)).join("\n")).toContain(`"${n.schema}"."g" has VIRTUAL generated column "b"`);
		});
	});

	test("a stored generated column works: UPDATE is accepted under FULL + the publication", async () => {
		await withCaptureSchema(async (sql, n) => {
			await sql.unsafe(`create table "${n.schema}".gs(id int primary key, a int, b int generated always as (a * 2) stored)`);
			await ensureCapture(sql, n);
			await sql.unsafe(`insert into "${n.schema}".gs(id, a) values (1, 1)`);
			await sql.unsafe(`update "${n.schema}".gs set a = 2 where id = 1`); // throws without publish_generated_columns = stored
			expect(await checkCapture(sql, n)).toEqual([]);
		});
	});

	test("a disabled ddl event trigger is named", async () => {
		await withCaptureSchema(async (sql, n) => {
			await ensureCapture(sql, n);
			await sql.unsafe(`alter event trigger drizzlebase_ddl_end disable`);
			try {
				expect((await checkCapture(sql, n)).join("\n")).toContain("event trigger drizzlebase_ddl_end is missing or disabled");
			} finally {
				await sql.unsafe(`alter event trigger drizzlebase_ddl_end enable`);
			}
		});
	});

	test("a publication without via_partition_root is named", async () => {
		await withCaptureSchema(async (sql, n) => {
			await ensureCapture(sql, n);
			await sql.unsafe(`alter publication "${n.publication}" set (publish_via_partition_root = false)`);
			expect((await checkCapture(sql, n)).join("\n")).toContain("publish_via_partition_root");
		});
	});
});
