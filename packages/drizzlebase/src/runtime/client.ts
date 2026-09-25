// The driver surface drizzle-orm/bun-sql calls, over ONE reserved connection that drizzlebase has already put
// inside BEGIN. Every statement passes parseStatement (one SELECT/INSERT/UPDATE/DELETE) and is recorded for the
// read-set. db.transaction() arrives here as begin(): it must become a SAVEPOINT — the real begin() committed
// the outer transaction and changed the snapshot under the query (review A, RA-A4).
import type { ReservedSQL } from "bun";
import { ForbiddenStatementError, type Node, type Parsed, parseStatement } from "../sql/parse";

export interface Recorded {
	sql: string;
	params: unknown[];
	kind: Parsed["kind"];
	stmt: Node;
}

export class CapturingClient {
	readonly statements: Recorded[] = [];
	private depth = 0;

	constructor(
		private readonly conn: ReservedSQL,
		private readonly mode: "query" | "mutation",
	) {}

	unsafe(query: string, params: unknown[] = []): ReturnType<ReservedSQL["unsafe"]> {
		const parsed = parseStatement(query);
		if (this.mode === "query" && parsed.kind !== "select")
			throw new ForbiddenStatementError(`${parsed.kind.toUpperCase()} in a query: queries are read-only, use a mutation`);
		this.statements.push({ sql: query, params, kind: parsed.kind, stmt: parsed.stmt });
		return this.conn.unsafe(query, params);
	}

	begin<T>(cb: (c: CapturingClient) => Promise<T>): Promise<T> {
		return this.savepoint(cb);
	}

	async savepoint<T>(cb: (c: CapturingClient) => Promise<T>): Promise<T> {
		const name = `dzb_sp_${++this.depth}`;
		await this.conn.unsafe(`savepoint ${name}`);
		try {
			const out = await cb(this);
			await this.conn.unsafe(`release savepoint ${name}`);
			return out;
		} catch (e) {
			await this.conn.unsafe(`rollback to savepoint ${name}`);
			throw e;
		} finally {
			this.depth--;
		}
	}
}
