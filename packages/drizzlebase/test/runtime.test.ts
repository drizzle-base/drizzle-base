import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { functions } from "../src/runtime/functions";
import { CommitOutcomeUnknownError, MutationConflictError, Runtime } from "../src/runtime/runtime";
import { posts, schema, users, withApp } from "./fixtures/app";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";

const userWithPosts = query(async (ctx, a: { id: string }) => ctx.db.query.users.findFirst({ where: eq(users.id, a.id), with: { posts: true } }));
const addPost = mutation(async (ctx, a: { authorId: string; title: string }) => {
	const [p] = await ctx.db.insert(posts).values(a).returning();
	return p!.id;
});

describe("Runtime", () => {
	test("a query returns its value, its snapshot, and the tables it read", async () => {
		await withApp(async (sql0, n) => {
			await sql0.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			const run = await rt.runQuery(userWithPosts, { id: U });
			expect(run.value?.name).toBe("Dan");
			expect([...run.readSet.tables].sort()).toEqual(["dzb_app.posts", "dzb_app.users"]);
			expect(run.readSet.opaque).toEqual([]);
			expect(run.snapshot.xmin).toBeGreaterThan(0n);
			expect(run.snapshot.text).toMatch(/^\d+:\d+:/);
		});
	});

	test("every statement of a query sees one snapshot, whatever commits meanwhile", async () => {
		await withApp(async (sql0, n) => {
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			const twoReads = query(async (ctx) => {
				const a = await ctx.db.select().from(users);
				await sql0.unsafe(`insert into dzb_app.users(name) values ('meanwhile')`); // another connection commits
				const b = await ctx.db.select().from(users);
				return [a.length, b.length];
			});
			expect((await rt.runQuery(twoReads, {})).value).toEqual([0, 0]);
		});
	});

	test("a mutation commits and reports a WAL position; a query cannot write", async () => {
		await withApp(async (sql0, n) => {
			await sql0.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			const m = await rt.runMutation(addPost, { authorId: U, title: "hello" });
			expect(m.attempts).toBe(1);
			expect(m.commitLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
			const sneaky = query(async (ctx) => ctx.db.insert(posts).values({ authorId: U, title: "no" }));
			const err = await rt.runQuery(sneaky, {}).then(() => null, (e: unknown) => e);
			expect(String((err as { cause?: Error })?.cause?.message)).toMatch(/read-only/); // drizzle wraps ours as `cause`
		});
	});

	test("a serialization conflict is retried and both mutations land", async () => {
		await withApp(async (sql0, n) => {
			await sql0.unsafe(`create table dzb_app.counters(id int primary key, n int not null); insert into dzb_app.counters values (1, 0)`);
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			const bump = mutation(async (ctx) => {
				const [row] = await ctx.db.execute<{ n: number }>(sql`select n from dzb_app.counters where id = 1`);
				await Bun.sleep(50); // both transactions read before either writes
				await ctx.db.execute(sql`update dzb_app.counters set n = ${row!.n + 1} where id = 1`);
			});
			const [a, b] = await Promise.all([rt.runMutation(bump, {}), rt.runMutation(bump, {})]);
			expect(a.attempts + b.attempts).toBeGreaterThan(2);
			const [{ n: total }] = await sql0.unsafe("select n from dzb_app.counters where id = 1");
			expect(total).toBe(2);
		});
	});

	test("retries are bounded: past maxAttempts the conflict surfaces", async () => {
		await withApp(async (sql0, n) => {
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication, maxAttempts: 2 });
			let calls = 0;
			const alwaysConflicts = mutation(async (ctx) => {
				calls++;
				await ctx.db.execute(sql`select 1`);
				throw Object.assign(new Error("could not serialize access"), { name: "PostgresError", errno: "40001" });
			});
			await expect(rt.runMutation(alwaysConflicts, {})).rejects.toBeInstanceOf(MutationConflictError);
			expect(calls).toBe(2);
		});
	});

	test("a connection lost at COMMIT is CommitOutcomeUnknownError, not retried", async () => {
		await withApp(async (sql0, n) => {
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			let calls = 0;
			const killsItsOwnConnection = mutation(async (ctx) => {
				calls++;
				const rows = await ctx.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
				await sql0`select pg_terminate_backend(${rows[0]?.pid})`;
				await Bun.sleep(100);
			});
			await expect(rt.runMutation(killsItsOwnConnection, {})).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
			expect(calls).toBe(1);
		});
	});
});
