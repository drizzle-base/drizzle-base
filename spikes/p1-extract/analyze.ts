// THROWAWAY SPIKE (P1) — path 2: derive a read-set from the SQL Drizzle emits (toSQL / the proxy capture).
//
// The rule every branch obeys: DROPPING a conjunct only WIDENS the read-set (over-invalidation, a cost);
// KEEPING a conjunct we do not understand could NARROW it wrongly (under-invalidation, a bug). So anything
// unrecognised is dropped, never guessed.
import { type Expr, type From, parse, type SelectStatement, type Statement } from "pgsql-ast-parser";

export const BASE_TABLES = new Set(["countries", "cities", "users", "posts", "comments"]);

export type Tier = "INTERVAL" | "DYNAMIC" | "PREDICATE" | "KEYQUERY" | "TABLE";
export interface Bound { col: string; op: string; value: unknown }
export interface Edge { col: string; to: string; toAccess: Access | null; toCol: string | null; preserved: boolean }
export interface Access {
	id: number;
	table: string;
	alias: string;
	where: string; // where in the statement tree this scan lives
	bounds: Bound[][]; // AND of ORs: each inner list is a disjunction on ONE column
	// equality to another access's column. `preserved`: every row of the SOURCE side's read-set reaches the
	// result, so the keys can be read from the result. Only then is DYNAMIC sound (an inner join drops rows).
	edges: Edge[];
	preds: Expr[]; // JS-evaluable single-table predicates (residuals)
	dropped: string[]; // conjuncts we could not use (they widen, never narrow)
	tier?: Tier;
	anchoredBy?: string;
	anchorEdge?: Edge;
}
export interface Analysis {
	accesses: Access[];
	flags: Set<string>;
	error?: string;
}

const NONDET = new Set(["now", "random", "clock_timestamp", "current_timestamp", "current_date", "gen_random_uuid", "statement_timestamp", "timeofday", "localtimestamp"]);
// Functions we could re-implement in JS with PG-identical semantics (or conservatively).
const EVALUABLE_FNS = new Set(["lower", "upper", "length", "abs", "coalesce", "any"]);
const RANGE_OPS = new Set(["=", "<", "<=", ">", ">="]);

type ScopeEntry = { kind: "table"; access: Access } | { kind: "derived"; name: string };
type Scope = Map<string, ScopeEntry>;

class Analyzer {
	accesses: Access[] = [];
	flags = new Set<string>();
	ctes = new Set<string>();
	constructor(private params: unknown[]) {}

	value(e: Expr): { ok: true; v: unknown } | { ok: false } {
		switch (e.type) {
			case "parameter": return { ok: true, v: this.params[Number(e.name.slice(1)) - 1] };
			case "integer": case "numeric": case "string": case "boolean": return { ok: true, v: (e as { value: unknown }).value };
			case "null": return { ok: true, v: null };
			case "cast": return this.value(e.operand);
			case "list": case "array": {
				const vs = e.expressions.map((x) => this.value(x));
				return vs.every((x) => x.ok) ? { ok: true, v: vs.map((x) => (x as { v: unknown }).v) } : { ok: false };
			}
			default: return { ok: false };
		}
	}

	// Resolve a column ref to the access (scan) it belongs to, in this scope or an outer one.
	resolve(e: Expr, scopes: Scope[]): { access: Access; col: string } | { derived: string } | null {
		if (e.type !== "ref") return null;
		if (e.table) {
			for (const s of scopes) {
				const hit = s.get(e.table.name);
				if (hit) return hit.kind === "table" ? { access: hit.access, col: e.name } : { derived: hit.name };
			}
			return null;
		}
		// Unqualified: only safe when the innermost scope has exactly one table.
		const inner = [...scopes[0].values()];
		if (inner.length === 1 && inner[0].kind === "table") return { access: inner[0].access, col: e.name };
		return null;
	}

	// Collect every table-alias a predicate references; null if it touches something opaque.
	refsOf(e: Expr, scopes: Scope[], out: Set<Access>): boolean {
		let ok = true;
		const walk = (x: Expr): void => {
			switch (x.type) {
				case "ref": { const r = this.resolve(x, scopes); if (r && "access" in r) out.add(r.access); else ok = false; return; }
				case "parameter": case "integer": case "numeric": case "string": case "boolean": case "null": return;
				case "binary": walk(x.left); walk(x.right); return;
				case "unary": walk(x.operand); return;
				case "cast": walk(x.operand); return;
				case "list": case "array": x.expressions.forEach(walk); return;
				case "ternary": walk(x.value); walk(x.lo); walk(x.hi); return;
				case "call": {
					const fn = x.function.name.toLowerCase();
					if (NONDET.has(fn)) this.flags.add(`nondeterministic:${fn}()`);
					if (!EVALUABLE_FNS.has(fn)) ok = false;
					x.args.forEach(walk);
					return;
				}
				case "keyword": this.flags.add(`nondeterministic:${x.keyword}`); ok = false; return;
				default: ok = false;
			}
		};
		walk(e);
		return ok;
	}

	conjuncts(e: Expr | undefined | null): Expr[] {
		if (!e) return [];
		if (e.type === "binary" && e.op === "AND") return [...this.conjuncts(e.left), ...this.conjuncts(e.right)];
		return [e];
	}

	// A single disjunct that bounds one column: col OP value.
	asBound(e: Expr, scopes: Scope[]): { access: Access; bound: Bound } | null {
		if (e.type === "binary" && RANGE_OPS.has(e.op)) {
			const flip: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };
			for (const [c, v, op] of [[e.left, e.right, e.op], [e.right, e.left, flip[e.op]]] as const) {
				const r = this.resolve(c, scopes);
				const val = this.value(v);
				if (r && "access" in r && val.ok) return { access: r.access, bound: { col: r.col, op, value: val.v } };
			}
		}
		if (e.type === "binary" && e.op === "IN") {
			const r = this.resolve(e.left, scopes);
			const val = this.value(e.right);
			if (r && "access" in r && val.ok) return { access: r.access, bound: { col: r.col, op: "in", value: val.v } };
		}
		if (e.type === "ternary" && e.op === "BETWEEN") {
			const r = this.resolve(e.value, scopes);
			const lo = this.value(e.lo), hi = this.value(e.hi);
			if (r && "access" in r && lo.ok && hi.ok) return { access: r.access, bound: { col: r.col, op: "between", value: [lo.v, hi.v] } };
		}
		if (e.type === "unary" && e.op === "IS NULL") {
			const r = this.resolve(e.operand, scopes);
			if (r && "access" in r) return { access: r.access, bound: { col: r.col, op: "isnull", value: null } };
		}
		return null;
	}

	applyConjunct(e: Expr, scopes: Scope[], restrictable: Set<Access>): void {
		const text = exprText(e);
		// Subqueries: IN (select) and EXISTS.
		if (e.type === "binary" && e.op === "IN" && (e.right as { type: string }).type === "select") {
			const r = this.resolve(e.left, scopes);
			const sub = this.statement(e.right as unknown as Statement, scopes, "IN-subquery");
			const out = (e.right as unknown as { columns?: { expr: Expr }[] }).columns?.[0]?.expr;
			const toCol = out && out.type === "ref" ? out.name : null;
			if (r && "access" in r && sub.length) r.access.edges.push({ col: r.col, to: `subquery#${sub[0].id}.${toCol} (hidden keys)`, toAccess: toCol ? sub[0] : null, toCol, preserved: false });
			this.flags.add("subquery-values-not-in-result");
			return;
		}
		if (e.type === "call" && e.function.name.toLowerCase() === "exists") {
			this.statement(e.args[0] as unknown as Statement, scopes, "EXISTS");
			return;
		}
		// Equality between two scans: a join edge.
		if (e.type === "binary" && e.op === "=") {
			const l = this.resolve(e.left, scopes), r = this.resolve(e.right, scopes);
			if (l && r && "access" in l && "access" in r && l.access !== r.access) {
				if (restrictable.has(l.access)) l.access.edges.push({ col: l.col, to: `${r.access.alias}.${r.col}`, toAccess: r.access, toCol: r.col, preserved: false });
				if (restrictable.has(r.access)) r.access.edges.push({ col: r.col, to: `${l.access.alias}.${l.col}`, toAccess: l.access, toCol: l.col, preserved: false });
				return;
			}
		}
		// A single bound, or an OR of bounds on the SAME column (a multi-interval).
		const disj = e.type === "binary" && e.op === "OR" ? orList(e) : [e];
		const bs = disj.map((d) => this.asBound(d, scopes));
		if (bs.every((b) => b !== null)) {
			const acc = bs[0]!.access, col = bs[0]!.bound.col;
			if (bs.every((b) => b!.access === acc && b!.bound.col === col)) {
				if (restrictable.has(acc)) acc.bounds.push(bs.map((b) => b!.bound));
				else acc.dropped.push(`${text} (outer side of an outer join)`);
				return;
			}
		}
		// A predicate over exactly one scan that we could evaluate in JS on the row image.
		const refs = new Set<Access>();
		const ok = this.refsOf(e, scopes, refs);
		if (ok && refs.size === 1) {
			const acc = [...refs][0];
			if (restrictable.has(acc)) acc.preds.push(e);
			else acc.dropped.push(`${text} (outer side of an outer join)`);
			return;
		}
		for (const a of refs) a.dropped.push(text);
		if (!refs.size) this.flags.add(`dropped-conjunct: ${text}`);
	}

	statement(st: Statement, outer: Scope[], where: string): Access[] {
		switch (st.type) {
			case "select": return this.select(st, outer, where);
			case "union": case "union all": return [...this.statement(st.left, outer, `${where}/${st.type}-L`), ...this.statement(st.right, outer, `${where}/${st.type}-R`)];
			case "with": {
				for (const b of st.bind) { this.ctes.add(b.alias.name); this.statement(b.statement, outer, `${where}/cte:${b.alias.name}`); }
				return this.statement(st.in, outer, where);
			}
			case "values": return [];
			case "insert": case "update": case "delete": return this.write(st, outer, where);
			default: this.flags.add(`unsupported-statement:${st.type}`); return [];
		}
	}

	write(st: Statement, outer: Scope[], where: string): Access[] {
		if (st.type === "insert") {
			this.flags.add(`write:insert ${st.into.name}${st.returning ? " (returning)" : ""}${st.onConflict ? " +onConflict" : ""}`);
			if (st.insert.type !== "values") this.statement(st.insert, outer, `${where}/insert-select`);
			return [];
		}
		if (st.type === "update" || st.type === "delete") {
			const t = st.type === "update" ? st.table : st.from;
			const acc = this.newAccess(t.name, t.alias ?? t.name, `${where}/${st.type}-target`);
			const scope: Scope = new Map([[acc.alias, { kind: "table", access: acc }]]);
			if (st.type === "update" && st.from) this.fromItem(st.from, scope, [scope, ...outer], `${where}/update-from`, new Set());
			const restrict = new Set(this.accesses);
			for (const c of this.conjuncts(st.where)) this.applyConjunct(c, [scope, ...outer], restrict);
			this.flags.add(`write:${st.type} ${t.name} — rows touched = the target's read-set below`);
			return [acc];
		}
		return [];
	}

	newAccess(table: string, alias: string, where: string): Access {
		const a: Access = { id: this.accesses.length, table, alias, where, bounds: [], edges: [], preds: [], dropped: [] };
		this.accesses.push(a);
		return a;
	}

	// Adds a FROM item to `scope`; returns the accesses it introduced and which of them a WHERE may restrict.
	fromItem(f: From, scope: Scope, scopes: Scope[], where: string, nullable: Set<Access>): void {
		const before = this.accesses.length;
		if (f.type === "table") {
			const name = f.name.name, alias = f.name.alias ?? name;
			if (this.ctes.has(name)) scope.set(alias, { kind: "derived", name: `cte:${name}` });
			else if (BASE_TABLES.has(name)) scope.set(alias, { kind: "table", access: this.newAccess(name, alias, where) });
			else { this.flags.add(`unknown-relation:${name}`); scope.set(alias, { kind: "derived", name }); }
		} else if (f.type === "statement") {
			const lateral = (f as { lateral?: boolean }).lateral;
			this.statement(f.statement, lateral ? scopes : scopes.slice(1), `${where}/${lateral ? "lateral" : "derived"}:${f.alias}`);
			scope.set(f.alias, { kind: "derived", name: f.alias });
		} else {
			this.flags.add(`unsupported-from:${f.type}`);
		}
		const introduced = this.accesses.slice(before);
		const j = f.join;
		if (j) {
			const all = new Set(this.accesses);
			// ON restricts the NULLABLE side's rows; for LEFT that is the new item, for RIGHT the earlier ones.
			let restrict: Set<Access>;
			if (j.type === "INNER JOIN") restrict = all;
			else if (j.type === "LEFT JOIN") restrict = new Set(introduced);
			else if (j.type === "RIGHT JOIN") restrict = new Set([...all].filter((a) => !introduced.includes(a)));
			else restrict = new Set();
			if (j.type === "LEFT JOIN") introduced.forEach((a) => nullable.add(a));
			if (j.type === "RIGHT JOIN") all.forEach((a) => { if (!introduced.includes(a)) nullable.add(a); });
			if (j.type === "FULL JOIN") all.forEach((a) => nullable.add(a));
			for (const c of this.conjuncts(j.on)) this.applyConjunct(c, scopes, restrict);
			// LEFT JOIN (incl. `left join lateral … on true`, the RQB shape): the earlier side survives whole,
			// so an edge from the new side to it may read its keys from the result.
			if (j.type === "LEFT JOIN")
				for (const a of introduced) for (const e of a.edges) if (e.toAccess && !introduced.includes(e.toAccess)) e.preserved = true;
			if (j.type === "FULL JOIN" || j.type === "CROSS JOIN") this.flags.add(`join:${j.type}`);
		}
	}

	select(st: SelectStatement & { type: "select" }, outer: Scope[], where: string): Access[] {
		const scope: Scope = new Map();
		const scopes = [scope, ...outer];
		const before = this.accesses.length;
		const nullable = new Set<Access>();
		for (const f of st.from ?? []) this.fromItem(f, scope, scopes, where, nullable);
		const mine = this.accesses.slice(before);
		// WHERE restricts every scan of this level (a WHERE on the nullable side still filters rows OUT).
		const restrict = new Set(this.accesses);
		for (const c of this.conjuncts(st.where)) {
			this.applyConjunct(c, scopes, restrict);
			// A WHERE that tests the nullable side filters the preserved side's rows too: not preserved any more.
			const refs = new Set<Access>();
			this.refsOf(c, scopes, refs);
			for (const a of refs) if (nullable.has(a)) for (const e of a.edges) e.preserved = false;
		}
		if (st.having) this.flags.add("having (post-aggregate filter: no narrowing, correct as-is)");
		if (st.groupBy?.length) this.flags.add("groupBy/aggregate: dynamic keys must be projected by the runtime");
		if (st.limit?.offset) this.flags.add("offset (a change before the window shifts it: predicate still covers it)");
		if (st.limit?.limit) this.flags.add("limit (precision refinement possible: bound by the last row's sort key)");
		for (const o of st.orderBy ?? []) this.refsOf(o.by, scopes, new Set());
		for (const c of st.columns ?? []) this.scanForSubqueries(c.expr, scopes, `${where}/column`);
		return mine;
	}

	// Scalar subqueries in the select list (D05) and non-determinism anywhere in it.
	scanForSubqueries(e: Expr, scopes: Scope[], where: string): void {
		const walk = (x: Expr | undefined): void => {
			if (!x) return;
			if ((x as { type: string }).type === "select" || (x as { type: string }).type === "union") { this.statement(x as unknown as Statement, scopes, where); return; }
			if (x.type === "call") { const fn = x.function.name.toLowerCase(); if (NONDET.has(fn)) this.flags.add(`nondeterministic:${fn}()`); x.args.forEach(walk); }
			if (x.type === "binary") { walk(x.left); walk(x.right); }
			if (x.type === "cast") walk(x.operand);
		};
		walk(e);
	}

	// Anchoring, parent-first (creation order = FROM/nesting order):
	//   preserved edge to an anchored scan → DYNAMIC (its own bounds kept as a residual)
	//   own bounds → INTERVAL; own JS-evaluable predicate → PREDICATE
	//   non-preserved edge to an anchored scan → KEYQUERY (keys need a side query; fallback TABLE)
	//   nothing → wait; if a whole pass anchors nothing, the first unanchored scan reads the TABLE.
	// Edges only point at ALREADY anchored scans, so no circular DYNAMIC can form.
	classify(): void {
		const anchored = new Set<Access>();
		const edgeTo = (a: Access, preserved: boolean) => a.edges.find((e) => e.preserved === preserved && e.toAccess !== null && anchored.has(e.toAccess));
		for (;;) {
			let changed = false;
			for (const a of this.accesses) {
				if (anchored.has(a)) continue;
				const pe = edgeTo(a, true), ne = edgeTo(a, false);
				if (pe) { a.tier = "DYNAMIC"; a.anchorEdge = pe; a.anchoredBy = `${pe.col} ∈ keys of ${pe.to} (from the result)`; }
				else if (a.bounds.length) a.tier = "INTERVAL";
				else if (a.preds.length) a.tier = "PREDICATE";
				else if (ne) { a.tier = "KEYQUERY"; a.anchorEdge = ne; a.anchoredBy = `${ne.col} ∈ keys of ${ne.to} (NOT all in the result: side query)`; }
				else continue;
				anchored.add(a);
				changed = true;
			}
			if (changed) continue;
			const root = this.accesses.find((x) => !anchored.has(x));
			if (!root) break;
			root.tier = "TABLE";
			anchored.add(root);
		}
	}
}

function orList(e: Expr): Expr[] {
	return e.type === "binary" && e.op === "OR" ? [...orList(e.left), ...orList(e.right)] : [e];
}

export function exprText(e: Expr): string {
	switch (e.type) {
		case "ref": return `${e.table ? `${e.table.name}.` : ""}${e.name}`;
		case "parameter": return e.name;
		case "integer": case "numeric": return String(e.value);
		case "string": return `'${e.value}'`;
		case "boolean": return String(e.value);
		case "null": return "null";
		case "binary": return `(${exprText(e.left)} ${e.op} ${exprText(e.right)})`;
		case "unary": return `${e.op} ${exprText(e.operand)}`;
		case "call": return `${e.function.name}(${e.args.map(exprText).join(", ")})`;
		case "cast": return `${exprText(e.operand)}::${(e.to as { name?: string }).name ?? "?"}`;
		case "list": case "array": return `(${e.expressions.map(exprText).join(", ")})`;
		case "ternary": return `${exprText(e.value)} ${e.op} ${exprText(e.lo)} AND ${exprText(e.hi)}`;
		case "keyword": return e.keyword;
		default: return `<${e.type}>`;
	}
}

export function analyzeSql(sqlText: string, params: unknown[]): Analysis {
	const a = new Analyzer(params);
	let stmts: Statement[];
	try {
		stmts = parse(sqlText.replace(/;\s*$/, ""));
	} catch (e) {
		const tables = [...BASE_TABLES].filter((t) => new RegExp(`\\b${t}\\b`, "i").test(sqlText));
		return { accesses: tables.map((t, i) => ({ id: i, table: t, alias: t, where: "unparsed", bounds: [], edges: [], preds: [], dropped: [], tier: "TABLE" as Tier })), flags: new Set(["UNPARSED → every mentioned table"]), error: String(e).split("\n")[0] };
	}
	for (const st of stmts) a.statement(st, [], "root");
	a.classify();
	return { accesses: a.accesses, flags: a.flags };
}
