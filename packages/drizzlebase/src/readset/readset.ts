// The TABLE-level read-set of DZB-01a: which tables a query read, whether anything it read is invisible to
// the stream (OPAQUE: any change must re-run it), and whether its result can change with no write at all
// (volatile: never cached). Row-level precision comes in 01b/01c; this level must already never narrow.
import type { SQL } from "bun";
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
// Built-in functions that run SQL, or read a table named by a string argument: the tables they read never
// appear as relations in the statement (final review #4).
const SQL_EXECUTORS = new Set([
	"query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "table_to_xml", "table_to_xmlschema",
	"table_to_xml_and_xmlschema", "cursor_to_xml", "cursor_to_xmlschema", "schema_to_xml", "schema_to_xmlschema",
	"schema_to_xml_and_xmlschema", "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema", "ts_stat",
]);

const add = (list: string[], x: string) => {
	if (!list.includes(x)) list.push(x);
};

export async function buildReadSet(refs: Refs, catalog: Catalog, exec: SQL, searchPath: string): Promise<ReadSet> {
	const rs: ReadSet = { tables: new Set(), opaque: [], volatile: [] };
	for (const r of refs.relations) {
		const shown = r.schema ? `${r.schema}.${r.name}` : r.name;
		const info = await catalog.relation(r, exec, searchPath);
		if (!info) {
			// Only a name that resolves to nothing may be a CTE; a CTE that shadows a real table keeps the table.
			if (!r.schema && refs.cteNames.has(r.name)) continue;
			add(rs.opaque, `unknown relation ${shown}`);
			continue;
		}
		const full = `${info.schema}.${info.name}`;
		if (info.relkind === "v" || info.relkind === "m") {
			add(rs.opaque, `view ${full}`);
			continue;
		}
		// Every member the scan reaches must be a readable table the stream carries — not only one of the family
		// (final review #5: a publication FOR TABLE ONLY parent left the children's changes unstreamed).
		for (const m of info.members) {
			if (!READABLE.has(m.relkind)) add(rs.opaque, `relation ${m.name} of kind ${m.relkind}`);
			else if (m.rls) add(rs.opaque, `row level security on ${m.name}`);
			else if (!m.published) add(rs.opaque, `${m.name} is not in the publication`);
			rs.tables.add(m.name);
		}
		for (const a of info.ancestors) rs.tables.add(a);
	}
	for (const f of refs.functions) {
		const shown = f.schema ? `${f.schema}.${f.name}` : f.name;
		const info = await catalog.fn(f, exec, searchPath);
		if (!info) add(rs.opaque, `unknown function ${shown}`);
		else if (info.user) add(rs.opaque, `user function ${shown}`);
		else {
			if (SQL_EXECUTORS.has(f.name)) add(rs.opaque, `function ${shown} reads tables its SQL does not name`);
			if (info.volatile) add(rs.volatile, shown);
		}
	}
	for (const o of refs.operators) {
		const user = await catalog.operator(o, exec, searchPath);
		const shown = o.schema ? `${o.schema}.${o.name}` : o.name;
		if (user === null) add(rs.opaque, `unknown operator ${shown}`);
		else if (user) add(rs.opaque, `user operator ${shown}`);
	}
	for (const v of refs.valueFunctions) add(rs.volatile, v);
	return rs;
}

export async function readSetOf(stmts: readonly { stmt: Node }[], catalog: Catalog, exec: SQL, searchPath: string): Promise<ReadSet> {
	const all: ReadSet = { tables: new Set(), opaque: [], volatile: [] };
	for (const s of stmts) {
		const one = await buildReadSet(collectRefs(s.stmt), catalog, exec, searchPath);
		for (const t of one.tables) all.tables.add(t);
		for (const o of one.opaque) add(all.opaque, o);
		for (const v of one.volatile) add(all.volatile, v);
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
