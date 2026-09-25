import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { CommitOutcomeUnknownError, MutationAbortedError, MutationConflictError, Runtime } from "../../../src/runtime";
import { testSql } from "../../../test/support/db";
import { posts, schema, users, withApp } from "../../../test/support/app";

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

	test("a handler that swallows an error leaves an aborted transaction: the mutation fails, it never reports success", async () => {
		// Postgres answers COMMIT on an aborted transaction with the tag ROLLBACK and no error.
		await withApp(async (sql0, n) => {
			await sql0.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			const swallows = mutation(async (ctx) => {
				await ctx.db.insert(posts).values({ authorId: U, title: "should not survive" });
				try {
					await ctx.db.insert(users).values({ id: U, name: "duplicate key" });
				} catch {
					// the handler "handles" it — but the transaction is already aborted
				}
				return "ok";
			});
			await expect(rt.runMutation(swallows, {})).rejects.toBeInstanceOf(MutationAbortedError);
			const [{ c }] = await sql0.unsafe("select count(*)::int as c from dzb_app.posts");
			expect(c).toBe(0);
		});
	});

	test("a statement issued after the handler returned never runs: the connection is closed to it", async () => {
		await withApp(async (sql0, n) => {
			await sql0.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			let late: Promise<unknown> | null = null;
			const leaks = mutation(async (ctx) => {
				late = Bun.sleep(50).then(() => ctx.db.insert(posts).values({ authorId: U, title: "after return" }));
				return "done";
			});
			await rt.runMutation(leaks, {});
			const outcome = await (late as unknown as Promise<unknown>).then(() => "ran", (e: unknown) => String((e as { cause?: Error })?.cause?.message ?? e));
			expect(outcome).toMatch(/closed/);
			const [{ c }] = await sql0.unsafe("select count(*)::int as c from dzb_app.posts");
			expect(c).toBe(0);
		});
	});

	test("two db.transaction() blocks started together both land (savepoints are serialized)", async () => {
		await withApp(async (sql0, n) => {
			await sql0.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			const both = mutation(async (ctx) => {
				const r = await Promise.allSettled([
					// a opens its savepoint first and finishes first: releasing it would also destroy b's, opened later.
					ctx.db.transaction(async (tx) => { await tx.insert(posts).values({ authorId: U, title: "a" }); return "a"; }),
					ctx.db.transaction(async (tx) => { await tx.insert(posts).values({ authorId: U, title: "b" }); await Bun.sleep(30); return "b"; }),
				]);
				return r.map((x) => x.status);
			});
			expect((await rt.runMutation(both, {})).value).toEqual(["fulfilled", "fulfilled"]);
			const titles = (await sql0.unsafe("select title from dzb_app.posts order by title")).map((r: { title: string }) => r.title);
			expect(titles).toEqual(["a", "b"]);
		});
	});

	test("concurrent queries on a small pool finish even with a cold catalog (no second connection is taken)", async () => {
		await withApp(async (_sql0, n) => {
			const small = testSql(2);
			try {
				const rt = new Runtime({ sql: small, schema, publication: n.publication });
				const q = query(async (ctx) => ctx.db.query.users.findMany({ with: { posts: true } }));
				const all = Promise.all([rt.runQuery(q, {}), rt.runQuery(q, {})]);
				const done = await Promise.race([all.then(() => "done"), Bun.sleep(8_000).then(() => "hung")]);
				expect(done).toBe("done");
			} finally {
				await small.close();
			}
		});
	}, 30_000);

	test("functions that change session state are refused (a search_path set here would outlive the transaction)", async () => {
		await withApp(async (sql0, n) => {
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			for (const text of ["select set_config('search_path', 'dzb_app', false)", "select pg_advisory_lock(42)"]) {
				const q = query(async (ctx) => ctx.db.execute(sql.raw(text)));
				const err = await rt.runQuery(q, {}).then(() => null, (e: unknown) => e);
				expect(String((err as { cause?: Error })?.cause?.message ?? err)).toMatch(/session state/);
			}
		});
	});

	test("a serialization failure raised AT COMMIT (write skew) is retried, and the invariant holds", async () => {
		await withApp(async (sql0, n) => {
			await sql0.unsafe(`create table dzb_app.doctors(id int primary key, on_call boolean not null); insert into dzb_app.doctors values (1, true), (2, true)`);
			const rt = new Runtime({ sql: sql0, schema, publication: n.publication });
			let arrived = 0;
			let release!: () => void;
			const bothWrote = new Promise<void>((r) => { release = r; });
			const goOff = mutation(async (ctx, a: { id: number }) => {
				const [row] = await ctx.db.execute<{ c: number }>(sql`select count(*)::int as c from dzb_app.doctors where on_call`);
				if (row!.c >= 2) await ctx.db.execute(sql`update dzb_app.doctors set on_call = false where id = ${a.id}`);
				// the first two runs wait for each other, so both have read and written before either commits
				if (++arrived <= 2) {
					if (arrived === 2) release();
					await bothWrote;
				}
			});
			const [a, b] = await Promise.all([rt.runMutation(goOff, { id: 1 }), rt.runMutation(goOff, { id: 2 })]);
			expect(a.attempts + b.attempts).toBe(3);
			const [{ c }] = await sql0.unsafe("select count(*)::int as c from dzb_app.doctors where on_call");
			expect(c).toBe(1); // write skew prevented: one doctor stays on call
		});
	});
});
