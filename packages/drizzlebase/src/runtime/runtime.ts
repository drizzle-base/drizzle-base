// Runs functions. A query is one REPEATABLE READ READ ONLY transaction whose first statement records
// pg_current_snapshot() — the snapshot the subscription layer compares streamed xids against (spec D7). A
// mutation is SERIALIZABLE, retried on 40001/40P01 only, and reports pg_current_wal_insert_lsn() read after
// COMMIT on the same connection: at or past its commit record, which is what read-your-writes waits for (P-A7).
// A COMMIT that fails for any reason other than a Postgres error has an unknown outcome and is never retried
// (P-M7): the write may have landed.
import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { Catalog } from "../readset/catalog";
import { type ReadSet, readSetOf } from "../readset/readset";
import { loadParser } from "../sql/parse";
import { CapturingClient, type Recorded } from "./client";
import type { Ctx, MutationDef, QueryDef } from "./functions";

export interface Snapshot {
	text: string; // pg_current_snapshot() as text: "xmin:xmax:xip,…"
	xmin: bigint;
	xmax: bigint;
	xip: bigint[];
}
export interface QueryRun<R> {
	value: R;
	snapshot: Snapshot;
	readSet: ReadSet;
	statements: Recorded[];
}
export interface MutationRun<R> {
	value: R;
	commitLsn: string;
	attempts: number;
}

export class MutationConflictError extends Error {
	override name = "MutationConflictError";
	constructor(
		readonly sqlState: string,
		readonly attempts: number,
		cause: unknown,
	) {
		super(`mutation gave up after ${attempts} attempts (SQLSTATE ${sqlState})`, { cause });
	}
}
// The transaction was already aborted when the handler returned — it caught an error and carried on. Postgres
// answers COMMIT with the tag ROLLBACK and no error, so without this check the mutation "succeeds" with nothing
// written. A definite failure: nothing was applied.
export class MutationAbortedError extends Error {
	override name = "MutationAbortedError";
	constructor() {
		super("the mutation's transaction was aborted by an error its handler caught; nothing was written");
	}
}
export class CommitOutcomeUnknownError extends Error {
	override name = "CommitOutcomeUnknownError";
	constructor(cause: unknown) {
		super("the connection failed during COMMIT: the mutation may or may not have been applied", { cause });
	}
}

const RETRYABLE = new Set(["40001", "40P01"]);
// Drizzle wraps every driver error in DrizzleQueryError and keeps the original as `cause`: the SQLSTATE lives
// on the innermost error, so both checks walk the chain (a retry that looked only at the outer error never
// retried a serialization failure).
const rootError = (e: unknown): unknown => {
	let cur = e;
	for (let i = 0; i < 5 && (cur as { cause?: unknown })?.cause; i++) cur = (cur as { cause: unknown }).cause;
	return cur;
};
const sqlState = (e: unknown): string | undefined => (rootError(e) as { errno?: unknown })?.errno?.toString();
const isServerError = (e: unknown) => (rootError(e) as { name?: string })?.name === "PostgresError";

export function parseSnapshot(text: string): Snapshot {
	const [xmin = "0", xmax = "0", xip = ""] = text.split(":");
	return { text, xmin: BigInt(xmin), xmax: BigInt(xmax), xip: xip ? xip.split(",").map(BigInt) : [] };
}

export class Runtime<S extends Record<string, unknown>> {
	readonly catalog: Catalog;
	private readonly maxAttempts: number;

	constructor(private readonly opts: { sql: SQL; schema: S; publication: string; maxAttempts?: number }) {
		this.catalog = new Catalog(opts.publication);
		this.maxAttempts = opts.maxAttempts ?? 5;
	}

	private ctx(client: CapturingClient): Ctx<S> {
		// drizzle-orm/bun-sql types its client as Bun's SQL; CapturingClient implements the part the driver calls.
		return { db: drizzle({ client: client as unknown as SQL, schema: this.opts.schema }) };
	}

	async runQuery<A, R>(def: QueryDef<S, A, R>, args: A): Promise<QueryRun<R>> {
		await loadParser();
		const conn = await this.opts.sql.reserve();
		const client = new CapturingClient(conn, "query");
		try {
			await conn.unsafe("begin isolation level repeatable read read only");
			try {
				const [{ s, sp }] = await conn.unsafe("select pg_current_snapshot()::text as s, current_setting('search_path') as sp");
				const value = await def.handler(this.ctx(client), args);
				const readSet = await readSetOf(client.statements, this.catalog, conn, sp as string);
				await conn.unsafe("commit");
				return { value, snapshot: parseSnapshot(s as string), readSet, statements: [...client.statements] };
			} catch (e) {
				await conn.unsafe("rollback").catch(() => {});
				throw e;
			}
		} finally {
			client.close();
			try {
				conn.release();
			} catch {
				// a terminated connection may refuse release; the pool discards it
			}
		}
	}

	async runMutation<A, R>(def: MutationDef<S, A, R>, args: A): Promise<MutationRun<R>> {
		await loadParser();
		for (let attempt = 1; ; attempt++) {
			let committed: { value: R; attempts: number } | null = null;
			const conn = await this.opts.sql.reserve();
			const client = new CapturingClient(conn, "mutation");
			try {
				await conn.unsafe("begin isolation level serializable");
				let value: R;
				try {
					value = await def.handler(this.ctx(client), args);
				} catch (e) {
					await conn.unsafe("rollback").catch(() => {});
					const code = sqlState(e);
					if (code && RETRYABLE.has(code)) {
						if (attempt >= this.maxAttempts) throw new MutationConflictError(code, attempt, e);
						await backoff(attempt);
						continue;
					}
					throw e;
				}
				let tag: string | undefined;
				try {
					tag = ((await conn.unsafe("commit")) as { command?: string }).command;
				} catch (e) {
					const code = sqlState(e);
					if (isServerError(e) && code && RETRYABLE.has(code)) {
						if (attempt >= this.maxAttempts) throw new MutationConflictError(code, attempt, e);
						await backoff(attempt);
						continue; // a serialization failure at COMMIT rolled the transaction back: safe to retry
					}
					// A Postgres error at COMMIT is a definite failure — unless it is a connection (08) or operator
					// intervention (57, e.g. pg_terminate_backend) class: then the COMMIT may or may not have run.
					if (isServerError(e) && code && !/^(08|57)/.test(code)) throw e;
					throw new CommitOutcomeUnknownError(e);
				}
				if (tag === "ROLLBACK") throw new MutationAbortedError();
				committed = { value, attempts: attempt };
			} finally {
				client.close();
				try {
					conn.release();
				} catch {
					// a terminated connection may refuse release; the pool discards it
				}
			}
			if (committed) return { ...committed, commitLsn: await this.walPosition() };
		}
	}

	// The WAL insert position is global and only moves forward: read on any connection after COMMIT returned, it
	// is at or past the commit record. Reading it on the pool — not on the function's connection — means a
	// connection that dies after a successful COMMIT cannot turn a landed write into an error (final review #9).
	private async walPosition(): Promise<string> {
		for (let i = 1; ; i++) {
			try {
				const [{ l }] = await this.opts.sql`select pg_current_wal_insert_lsn()::text as l`;
				return l as string;
			} catch (e) {
				if (i >= 3) throw e;
				await Bun.sleep(20 * i);
			}
		}
	}
}

const backoff = (attempt: number) => Bun.sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
