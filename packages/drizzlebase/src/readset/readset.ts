// The TABLE-level read-set of DZB-01a: which tables a query read, whether anything it read is invisible to
// the stream (OPAQUE: any change must re-run it), and whether its result can change with no write at all
// (volatile: never cached). Row-level precision comes in 01b/01c; this level must already never narrow.
import type { CapturedTxn } from "../capture/types";
import type { Node } from "../sql/parse";
import type { Catalog } from "./catalog";
import { collectRefs, type Refs } from "./refs";

export interface ReadSet {
	tables: Set<string>; // "schema.name", the format CapturedTxn uses
	opaque: string[]; // reasons; non-empty = invalidated by any committed change
	volatile: string[]; // non-immutable functions and SQL value functions: the result is not cacheable
}

const READABLE = new Set(["r", "p"]);

export async function buildReadSet(refs: Refs, catalog: Catalog): Promise<ReadSet> {
	const rs: ReadSet = { tables: new Set(), opaque: [], volatile: [] };
	for (const r of refs.relations) {
		const shown = r.schema ? `${r.schema}.${r.name}` : r.name;
		const info = await catalog.relation(r);
		if (!info) {
			// Only a name that resolves to nothing may be a CTE; a CTE that shadows a real table keeps the table.
			if (!r.schema && refs.cteNames.has(r.name)) continue;
			rs.opaque.push(`unknown relation ${shown}`);
			continue;
		}
		const full = `${info.schema}.${info.name}`;
		if (info.relkind === "v" || info.relkind === "m") rs.opaque.push(`view ${full}`);
		else if (!READABLE.has(info.relkind)) rs.opaque.push(`relation ${full} of kind ${info.relkind}`);
		else if (info.rls) rs.opaque.push(`row level security on ${full}`);
		else if (!info.published) rs.opaque.push(`${full} is not in the publication`);
		else {
			rs.tables.add(full);
			for (const x of info.related) rs.tables.add(x);
		}
	}
	for (const f of refs.functions) {
		const shown = f.schema ? `${f.schema}.${f.name}` : f.name;
		const info = await catalog.fn(f);
		if (!info) rs.opaque.push(`unknown function ${shown}`);
		else if (info.user) rs.opaque.push(`user function ${shown}`);
		else if (info.volatile && !rs.volatile.includes(shown)) rs.volatile.push(shown);
	}
	for (const v of refs.valueFunctions) if (!rs.volatile.includes(v)) rs.volatile.push(v);
	return rs;
}

export async function readSetOf(stmts: readonly { stmt: Node }[], catalog: Catalog): Promise<ReadSet> {
	const all: ReadSet = { tables: new Set(), opaque: [], volatile: [] };
	for (const s of stmts) {
		const one = await buildReadSet(collectRefs(s.stmt), catalog);
		for (const t of one.tables) all.tables.add(t);
		for (const o of one.opaque) if (!all.opaque.includes(o)) all.opaque.push(o);
		for (const v of one.volatile) if (!all.volatile.includes(v)) all.volatile.push(v);
	}
	return all;
}

export function touches(rs: ReadSet, txn: CapturedTxn): boolean {
	if (txn.ddl) return true;
	const changedSomething = txn.changes.length > 0 || txn.wholeTables.size > 0;
	if (rs.opaque.length) return changedSomething;
	for (const t of txn.wholeTables) if (rs.tables.has(t)) return true;
	return txn.changes.some((c) => rs.tables.has(c.table));
}
