// Every relation and function a statement can reach, found by walking the WHOLE parse tree. The spike's
// analyzer dropped a conjunct it did not understand and the tables inside it with it (NOT EXISTS, NOT IN
// (subquery), OR … IN (subquery), CASE: review A, RA-A1). A plain walk cannot drop anything: every RangeVar
// node, wherever it sits, is reported (spec P-A1).
import type { Node } from "../sql/parse";

export interface RelationRef {
	schema: string | null;
	name: string;
}
export interface FunctionRef {
	schema: string | null;
	name: string;
}
export interface Refs {
	relations: RelationRef[];
	functions: FunctionRef[];
	valueFunctions: string[]; // CURRENT_DATE, LOCALTIMESTAMP…: parsed as SQLValueFunction, not FuncCall
	cteNames: Set<string>;
}

const str = (n: unknown): string => ((n as { String?: { sval?: string } })?.String?.sval ?? "");

export function collectRefs(stmt: Node): Refs {
	const refs: Refs = { relations: [], functions: [], valueFunctions: [], cteNames: new Set() };
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (!v || typeof v !== "object") return;
		// A relation is recognised by its shape, not by a "RangeVar" key: the target of INSERT/UPDATE/DELETE (and
		// SELECT INTO, LOCK) is a RangeVar body stored directly under `relation`/`rel`, with no wrapper.
		const self = v as Node;
		if (typeof self.relname === "string") refs.relations.push({ schema: (self.schemaname as string | undefined) ?? null, name: self.relname });
		for (const [key, child] of Object.entries(self)) {
			const c = child as Node;
			if (key === "FuncCall") {
				const parts = (c.funcname as unknown[]).map(str);
				refs.functions.push({ schema: parts.length > 1 ? parts[parts.length - 2]! : null, name: parts[parts.length - 1]! });
			} else if (key === "SQLValueFunction") refs.valueFunctions.push(c.op as string);
			else if (key === "CommonTableExpr") refs.cteNames.add(c.ctename as string);
			walk(child);
		}
	};
	walk(stmt);
	return refs;
}
