// The one gate every statement from a function passes. libpg-query is Postgres's own parser compiled to
// WASM, so "parses here" means "parses in Postgres" — INTERSECT, quoted identifiers, CTEs and all (the spike's
// JS parser could not, spec F4). The gate also enforces the driver's contract (spec P-A5): one statement per
// call, and only SELECT/INSERT/UPDATE/DELETE — transactions belong to drizzlebase, DDL to migrations.
import { loadModule, parseSync } from "libpg-query";

export type Node = Record<string, unknown>;
export interface Parsed {
	kind: "select" | "insert" | "update" | "delete";
	stmt: Node;
}

export class ForbiddenStatementError extends Error {
	override name = "ForbiddenStatementError";
}

const KINDS: Record<string, Parsed["kind"]> = { SelectStmt: "select", InsertStmt: "insert", UpdateStmt: "update", DeleteStmt: "delete" };
const CACHE_MAX = 5_000; // distinct texts; inArray() lengths and sql.raw make the set open-ended (RB-B1)
const cache = new Map<string, Parsed>();
let loaded: Promise<void> | null = null;

export function loadParser(): Promise<void> {
	loaded ??= loadModule();
	return loaded;
}

export function parseStatement(sqlText: string): Parsed {
	const hit = cache.get(sqlText);
	if (hit) return hit;
	let tree: { stmts?: { stmt: Node }[] };
	try {
		tree = parseSync(sqlText) as { stmts?: { stmt: Node }[] };
	} catch (e) {
		throw new ForbiddenStatementError(`unparseable SQL: ${e instanceof Error ? e.message : String(e)}`);
	}
	const stmts = tree.stmts ?? [];
	if (stmts.length !== 1) throw new ForbiddenStatementError(`exactly one statement per call, got ${stmts.length}`);
	const node = stmts[0]!.stmt;
	const type = Object.keys(node)[0] ?? "";
	const kind = KINDS[type];
	if (!kind)
		throw new ForbiddenStatementError(`${type} is not allowed in a function: only SELECT, INSERT, UPDATE and DELETE (drizzlebase owns transactions; DDL belongs to migrations)`);
	const parsed: Parsed = { kind, stmt: node[type] as Node };
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
	cache.set(sqlText, parsed);
	return parsed;
}
