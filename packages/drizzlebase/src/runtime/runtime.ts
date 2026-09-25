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
		this.catalog = new Catalog(opts.sql, opts.publication);
		this.maxAttempts = opts.maxAttempts ?? 5;
	}

	private ctx(client: CapturingClient): Ctx<S> {
		// drizzle-orm/bun-sql types its client as Bun's SQL; CapturingClient implements the part the driver calls.
		return { db: drizzle({ client: client as unknown as SQL, schema: this.opts.schema }) };
	}

	async runQuery<A, R>(def: QueryDef<S, A, R>, args: A): Promise<QueryRun<R>> {
		await loadParser();
		const conn = await this.opts.sql.reserve();
		try {
			await conn.unsafe("begin isolation level repeatable read read only");
			try {
				const [{ s }] = await conn.unsafe("select pg_current_snapshot()::text as s");
				const client = new CapturingClient(conn, "query");
				const value = await def.handler(this.ctx(client), args);
				const readSet = await readSetOf(client.statements, this.catalog);
				await conn.unsafe("commit");
				return { value, snapshot: parseSnapshot(s as string), readSet, statements: client.statements };
			} catch (e) {
				await conn.unsafe("rollback").catch(() => {});
				throw e;
			}
		} finally {
			conn.release();
		}
	}

	async runMutation<A, R>(def: MutationDef<S, A, R>, args: A): Promise<MutationRun<R>> {
		await loadParser();
		for (let attempt = 1; ; attempt++) {
			const conn = await this.opts.sql.reserve();
			try {
				await conn.unsafe("begin isolation level serializable");
				let value: R;
				try {
					value = await def.handler(this.ctx(new CapturingClient(conn, "mutation")), args);
				} catch (e) {
					await conn.unsafe("rollback").catch(() => {});
					const code = sqlState(e);
					if (code && RETRYABLE.has(code)) {
						if (attempt >= this.maxAttempts) throw new MutationConflictError(code, attempt, e);
						await Bun.sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
						continue;
					}
					throw e;
				}
				try {
					await conn.unsafe("commit");
				} catch (e) {
					const code = sqlState(e);
					if (isServerError(e) && code && RETRYABLE.has(code)) {
						if (attempt >= this.maxAttempts) throw new MutationConflictError(code, attempt, e);
						continue; // a serialization failure at COMMIT rolled the transaction back: safe to retry
					}
					// A Postgres error at COMMIT is a definite failure — unless it is a connection (08) or operator
					// intervention (57, e.g. pg_terminate_backend) class: then the COMMIT may or may not have run.
					if (isServerError(e) && code && !/^(08|57)/.test(code)) throw e;
					throw new CommitOutcomeUnknownError(e);
				}
				const [{ l }] = await conn.unsafe("select pg_current_wal_insert_lsn()::text as l");
				return { value, commitLsn: l as string, attempts: attempt };
			} finally {
				try {
					conn.release();
				} catch {
					// a terminated connection may refuse release; the pool discards it
				}
			}
		}
	}
}
