// The driver surface drizzle-orm/bun-sql calls, over ONE reserved connection that drizzlebase has already put
// inside BEGIN. Every statement passes parseStatement (one SELECT/INSERT/UPDATE/DELETE) and is recorded for the
// read-set. db.transaction() arrives here as begin(): it must become a SAVEPOINT — the real begin() committed
// the outer transaction and changed the snapshot under the query (review A, RA-A4).
import type { ReservedSQL } from "bun";
import { collectRefs } from "../readset";
import { ForbiddenStatementError, type Node, type Parsed, parseStatement } from "../sql";

// Functions whose effect outlives the transaction on the pooled connection: a search_path set here would make
// the next function on that connection resolve names differently from the catalog (final review #3); a session
// advisory lock would be held by whoever reserves the connection next.
const SESSION_STATE = new Set([
	"set_config", "pg_advisory_lock", "pg_advisory_lock_shared", "pg_try_advisory_lock", "pg_try_advisory_lock_shared",
	"pg_advisory_unlock", "pg_advisory_unlock_shared", "pg_advisory_unlock_all",
]);

export interface Recorded {
	sql: string;
	params: unknown[];
	kind: Parsed["kind"];
	stmt: Node;
}

export class ClosedClientError extends Error {
	override name = "ClosedClientError";
	constructor() {
		super("the function has returned and its connection is closed: a statement was issued after its transaction ended");
	}
}

// State shared by a client and the per-savepoint views it hands to nested db.transaction() callbacks.
interface Shared {
	statements: Recorded[];
	closed: boolean;
	seq: number; // savepoint names are unique per transaction, never derived from nesting depth
}

export class CapturingClient {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly shared: Shared;

	constructor(
		private readonly conn: ReservedSQL,
		private readonly mode: "query" | "mutation",
		shared?: Shared,
	) {
		this.shared = shared ?? { statements: [], closed: false, seq: 0 };
	}

	get statements(): readonly Recorded[] {
		return this.shared.statements;
	}

	// Called by the runtime before the connection goes back to the pool: a statement a handler fires after it
	// returned (an unawaited call, a Promise.all sibling) would otherwise run outside the transaction — or inside
	// the next function's.
	close(): void {
		this.shared.closed = true;
	}

	private live(): void {
		if (this.shared.closed) throw new ClosedClientError();
	}

	unsafe(query: string, params: unknown[] = []): ReturnType<ReservedSQL["unsafe"]> {
		this.live();
		const parsed = parseStatement(query);
		if (this.mode === "query" && parsed.kind !== "select")
			throw new ForbiddenStatementError(`${parsed.kind.toUpperCase()} in a query: queries are read-only, use a mutation`);
		for (const f of collectRefs(parsed.stmt).functions)
			if (SESSION_STATE.has(f.name)) throw new ForbiddenStatementError(`${f.name}() changes session state, which would outlive this function's transaction`);
		this.shared.statements.push({ sql: query, params, kind: parsed.kind, stmt: parsed.stmt });
		return this.conn.unsafe(query, params);
	}

	begin<T>(cb: (c: CapturingClient) => Promise<T>): Promise<T> {
		return this.savepoint(cb);
	}

	// Savepoints opened side by side (Promise.all of two db.transaction()) would interleave: releasing the first
	// also destroys every savepoint opened after it. Blocks at one level therefore run one after another; each
	// block gets its own view, so a nested transaction inside it queues on that view and cannot deadlock on itself.
	savepoint<T>(cb: (c: CapturingClient) => Promise<T>): Promise<T> {
		const run = this.queue.then(() => this.inSavepoint(cb));
		this.queue = run.catch(() => {});
		return run;
	}

	private async inSavepoint<T>(cb: (c: CapturingClient) => Promise<T>): Promise<T> {
		this.live();
		const name = `dzb_sp_${++this.shared.seq}`;
		await this.conn.unsafe(`savepoint ${name}`);
		let out: T;
		try {
			out = await cb(new CapturingClient(this.conn, this.mode, this.shared));
		} catch (e) {
			try {
				await this.conn.unsafe(`rollback to savepoint ${name}`);
			} catch (rollbackError) {
				// The user's error is what matters; the rollback failure rides along instead of replacing it.
				if (e && typeof e === "object") Object.assign(e, { rollbackError });
			}
			throw e;
		}
		await this.conn.unsafe(`release savepoint ${name}`);
		return out;
	}
}
