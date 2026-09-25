// THROWAWAY SPIKE (P3) — the soundness oracle for P1's read-sets.
//
// Property, per case: after ANY write, if the query's result changed, then at least one changed row (its OLD or
// its NEW image) is inside the read-set the analyzer derived BEFORE the write. A miss is under-invalidation —
// a subscriber keeps a stale answer forever. The reverse (invalidated, result unchanged) is only cost; we count it.
//
// Changes are observed by DIFFING table snapshots, never by trusting the write we issued: the oracle must not
// share a blind spot with a capture mechanism it is supposed to judge.
//
//   bun oracle.ts [--steps=400] [--seed=1] [--only=B01] [--sabotage=inner|gte|leftjoin]
import { PGlite } from "@electric-sql/pglite";
import type { Expr } from "pgsql-ast-parser";
import { parse } from "pgsql-ast-parser";
import { drizzle } from "drizzle-orm/pg-proxy";
import { type Access, type Analysis, type Bound, analyzeSql, exprText } from "./analyze";
import { type Case, cases } from "./cases";
import * as schema from "./schema";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const STEPS = Number(arg("steps", "400"));
const SEED = Number(arg("seed", "1"));
const ONLY = arg("only", "");
const SABOTAGE = arg("sabotage", "");

// ── deterministic randomness ─────────────────────────────────────────────────
let rs = SEED >>> 0;
const rnd = () => { rs = (rs + 0x6d2b79f5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

// ── small domains, so writes collide with the cases' constants (id 10, U1, age 18/30, 'Dan%', …) ─────────
const UUIDS = [1, 2, 3, 4, 5, 6].map((i) => `0190a000-0000-7000-8000-00000000000${i}`);
const DATES = ["2025-12-30T00:00:00", "2026-01-01T00:00:00", "2026-01-02T00:00:00", "2026-03-01T00:00:00"];
const gen: Record<string, Record<string, () => unknown>> = {
	countries: { name: () => pick(["Brazil", "Chile", "Peru"]), population: () => pick([null, 10, 100]) },
	cities: { country_id: () => pick([null, 1, 2, 3, 10, 11]), name: () => pick(["Rio", "SP", "Lima"]), population: () => pick([null, 5, 50, 97, 500]) },
	users: {
		name: () => pick(["Dan", "dan", "Danilo", "Ana", "Bob"]), email: () => pick(["a@b.c", "A@B.C", "x", "a", "b"]),
		age: () => pick([null, 15, 18, 21, 30, 40, 65, 70]), manager_id: () => pick([null, ...UUIDS]),
		deleted: () => rnd() < 0.3, created_at: () => pick(DATES),
	},
	posts: {
		author_id: () => pick(UUIDS), title: () => pick(["draft a", "draft", "t", "hello"]), published: () => rnd() < 0.5,
		views: () => pick([0, 40, 49, 50, 51, 60]), created_at: () => pick(DATES),
	},
	comments: { post_id: () => pick([96, 97, 98, 99, 100, 101, 102]), author_id: () => pick(UUIDS), body: () => pick(["hi", "ok"]) },
};
const PK: Record<string, () => unknown> = {
	countries: () => pick([1, 2, 3, 9, 10, 11, 12]), cities: () => 1 + Math.floor(rnd() * 20), users: () => pick(UUIDS),
	posts: () => 95 + Math.floor(rnd() * 10), comments: () => 1 + Math.floor(rnd() * 15),
};
const TABLES = Object.keys(gen);

const DDL = `
drop table if exists countries, cities, users, posts, comments;
create table countries(id int primary key, name text not null, population int);
create table cities(id int primary key, country_id int, name text not null, population int);
create table users(id uuid primary key default gen_random_uuid(), name text not null, email text not null, age int,
  manager_id uuid, deleted boolean not null default false, created_at timestamp not null default now());
create table posts(id int primary key, author_id uuid not null, title text not null, published boolean not null default false,
  views int not null default 0, created_at timestamp not null default now());
create table comments(id int primary key, post_id int not null, author_id uuid not null, body text not null);`;

const pg = await PGlite.create();

async function insertRandom(t: string): Promise<boolean> {
	const cols = ["id", ...Object.keys(gen[t])];
	const vals = [PK[t](), ...Object.values(gen[t]).map((g) => g())];
	const r = await pg.query(`insert into ${t}(${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) on conflict do nothing`, vals);
	return (r.affectedRows ?? 0) > 0;
}
async function randomWrite(): Promise<void> {
	const t = pick(TABLES);
	const op = rnd();
	if (op < 0.4) { await insertRandom(t); return; }
	const ids = (await pg.query<{ id: unknown }>(`select id from ${t}`)).rows.map((r) => r.id);
	if (!ids.length) { await insertRandom(t); return; }
	const id = pick(ids);
	if (op < 0.85) {
		const cols = Object.keys(gen[t]).filter(() => rnd() < 0.5);
		if (!cols.length) cols.push(pick(Object.keys(gen[t])));
		await pg.query(`update ${t} set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1`, [id, ...cols.map((c) => gen[t][c]())]);
	} else if (op < 0.9) {
		await pg.query(`update ${t} set id = $2 where id = $1 and not exists (select 1 from ${t} where id = $2)`, [id, PK[t]()]); // a key move
	} else {
		await pg.query(`delete from ${t} where id = $1`, [id]);
	}
}
async function seed(): Promise<void> {
	await pg.exec(DDL);
	// Anchors: the constants the cases filter on must exist, or most writes cannot change their results.
	await pg.exec(`insert into countries values (10, 'Chile', 10);
	  insert into cities values (1, 10, 'Rio', 50), (2, 10, 'SP', 500);
	  insert into users(id, name, email, age, manager_id) values ('${UUIDS[0]}', 'Dan', 'a@b.c', 30, '${UUIDS[1]}'), ('${UUIDS[1]}', 'Ana', 'x', 18, null);
	  insert into posts(id, author_id, title, published, views, created_at) values (100, '${UUIDS[0]}', 'hello', true, 51, '2026-01-02'), (101, '${UUIDS[0]}', 'draft', false, 40, '2026-03-01');
	  insert into comments values (1, 100, '${UUIDS[1]}', 'hi');`);
	for (const t of TABLES) for (let i = 0; i < 6; i++) await insertRandom(t);
}

type Snap = Record<string, Map<string, Record<string, unknown>>>;
async function snapshot(): Promise<Snap> {
	const q = TABLES.map((t) => `select '${t}' as t, to_json(x) as j from ${t} x`).join(" union all ");
	const out: Snap = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
	for (const r of (await pg.query<{ t: string; j: Record<string, unknown> }>(q)).rows) out[r.t].set(String(r.j.id), r.j);
	return out;
}
function diff(a: Snap, b: Snap) {
	const ch: { table: string; old?: Record<string, unknown>; new?: Record<string, unknown> }[] = [];
	for (const t of TABLES) {
		for (const [k, o] of a[t]) { const n = b[t].get(k); if (!n) ch.push({ table: t, old: o }); else if (JSON.stringify(o) !== JSON.stringify(n)) ch.push({ table: t, old: o, new: n }); }
		for (const [k, n] of b[t]) if (!a[t].has(k)) ch.push({ table: t, new: n });
	}
	return ch;
}

// ── a JS evaluator with SQL three-valued logic; MAYBE means "cannot tell" and always counts as a match ───────
const MAYBE = Symbol("maybe");
type V = unknown;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const norm = (v: V): V => (typeof v === "string" && ISO.test(v) ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`) : v);
function cmp(a: V, b: V): number | typeof MAYBE | null {
	if (a === null || b === null || a === undefined || b === undefined) return null;
	const x = norm(a), y = norm(b);
	if (typeof x !== typeof y) return MAYBE;
	if (typeof x === "string" && typeof y === "string") return x < y ? -1 : x > y ? 1 : 0; // C collation on ASCII
	return (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
}
const likeRe = (p: string, flags: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, flags);
function evalE(e: Expr, row: Record<string, V>, params: V[]): V | typeof MAYBE {
	const ev = (x: Expr) => evalE(x, row, params);
	switch (e.type) {
		case "ref": return e.name in row ? row[e.name] : MAYBE;
		case "parameter": return params[Number(e.name.slice(1)) - 1];
		case "integer": case "numeric": case "string": case "boolean": return (e as { value: V }).value;
		case "null": return null;
		case "list": case "array": return e.expressions.map(ev);
		case "unary": {
			const v = ev(e.operand);
			if (v === MAYBE) return MAYBE;
			if (e.op === "IS NULL") return v === null;
			if (e.op === "IS NOT NULL") return v !== null;
			if (e.op === "NOT") return v === null ? null : !v;
			return MAYBE;
		}
		case "binary": {
			if (e.op === "AND" || e.op === "OR") {
				const l = ev(e.left), r = ev(e.right);
				if (l === MAYBE || r === MAYBE) return MAYBE;
				if (e.op === "AND") return l === false || r === false ? false : l === null || r === null ? null : true;
				return l === true || r === true ? true : l === null || r === null ? null : false;
			}
			const l = ev(e.left);
			if (e.op === "=" && e.right.type === "call" && e.right.function.name.toLowerCase() === "any") {
				const list = ev(e.right.args[0]);
				if (l === MAYBE || !Array.isArray(list)) return MAYBE;
				return l === null ? null : list.some((x) => cmp(l, x) === 0);
			}
			const r = ev(e.right);
			if (l === MAYBE || r === MAYBE) return MAYBE;
			switch (e.op) {
				case "=": case "!=": case "<": case "<=": case ">": case ">=": {
					const c = cmp(l, r);
					if (c === null) return null;
					if (c === MAYBE) return MAYBE;
					return { "=": c === 0, "!=": c !== 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0 }[e.op];
				}
				case "LIKE": case "ILIKE": case "NOT LIKE": case "NOT ILIKE":
					if (l === null || r === null) return null;
					if (typeof l !== "string" || typeof r !== "string") return MAYBE;
					return likeRe(r, e.op.includes("ILIKE") ? "i" : "").test(l) !== e.op.startsWith("NOT");
				case "IN": case "NOT IN": {
					if (!Array.isArray(r)) return MAYBE;
					if (l === null) return null;
					const hit = r.some((x) => cmp(l, x) === 0);
					return e.op === "IN" ? hit : r.some((x) => x === null) && !hit ? null : !hit;
				}
				case "+": case "-": case "*": case "/":
					if (l === null || r === null) return null;
					if (typeof l !== "number" || typeof r !== "number") return MAYBE;
					return e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : Math.trunc(l / r);
				default: return MAYBE;
			}
		}
		case "call": {
			const fn = e.function.name.toLowerCase();
			const a = e.args.map(ev);
			if (a.some((x) => x === MAYBE)) return MAYBE;
			if (fn === "lower" || fn === "upper") return a[0] === null ? null : typeof a[0] === "string" ? (fn === "lower" ? a[0].toLowerCase() : a[0].toUpperCase()) : MAYBE;
			if (fn === "coalesce") return a.find((x) => x !== null) ?? null;
			return MAYBE;
		}
		default: return MAYBE;
	}
}

function boundHolds(b: Bound, row: Record<string, V>): boolean {
	const v = row[b.col];
	if (v === undefined) return true;
	if (b.op === "isnull") return v === null;
	if (b.op === "in") return Array.isArray(b.value) && b.value.some((x) => { const c = cmp(v, x); return c === MAYBE || c === 0; });
	if (b.op === "between") { const [lo, hi] = b.value as V[]; const c1 = cmp(v, lo), c2 = cmp(v, hi); if (c1 === MAYBE || c2 === MAYBE) return true; return c1 !== null && c2 !== null && c1 >= 0 && c2 <= 0; }
	const c = cmp(v, b.value);
	if (c === MAYBE) return true;
	if (c === null) return false;
	const op = SABOTAGE === "gte" && b.op === ">=" ? ">" : b.op; // sabotage: a narrowing comparator bug
	return { "=": c === 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0 }[op] ?? true;
}

// ── read-set membership ──────────────────────────────────────────────────────
interface Ctx { a: Analysis; params: V[]; snap: Snap; resultKeys: Map<Access, Set<string>> }
const keyOf = (v: V) => (v === null || v === undefined ? "∅" : String(norm(v)));

function inReadSet(acc: Access, row: Record<string, V>, ctx: Ctx, memo: Map<Access, Set<string> | "ALL">): boolean {
	if (acc.tier === "TABLE") return true;
	for (const ors of acc.bounds) if (!ors.some((b) => boundHolds(b, row))) return false;
	for (const p of acc.preds) { const r = evalE(p, row, ctx.params); if (r !== MAYBE && r !== true) return false; }
	const e = acc.anchorEdge;
	if (e?.toAccess && e.toCol) {
		const keys = keysOf(e.toAccess, e.toCol, acc, ctx, memo);
		if (keys !== "ALL" && !keys.has(keyOf(row[e.col]))) return false;
	}
	return true;
}
// Keys of the SOURCE side: from the result when the edge is preserved (what the runtime would do), otherwise
// the side query — every source row in the source's own read-set, evaluated on the pre-write snapshot.
function keysOf(src: Access, col: string, dependent: Access, ctx: Ctx, memo: Map<Access, Set<string> | "ALL">): Set<string> | "ALL" {
	const fromResult = dependent.tier === "DYNAMIC" || (SABOTAGE === "inner" && dependent.tier === "KEYQUERY");
	if (fromResult && ctx.resultKeys.has(dependent)) return ctx.resultKeys.get(dependent)!;
	if (memo.has(src)) return memo.get(src)!;
	const out = new Set<string>();
	for (const r of ctx.snap[src.table].values()) if (inReadSet(src, r, ctx, memo)) out.add(keyOf(r[col]));
	memo.set(src, out);
	return out;
}

// For a DYNAMIC scan whose source is a ROOT scan with the key column projected, read the keys off the raw rows.
function resultKeyColumns(sqlText: string, a: Analysis): Map<Access, number> {
	const out = new Map<Access, number>();
	let root: { columns?: { expr: Expr }[]; from?: unknown[] };
	try { root = parse(sqlText.replace(/;\s*$/, ""))[0] as typeof root; } catch { return out; }
	for (const acc of a.accesses) {
		const e = acc.anchorEdge;
		const wants = acc.tier === "DYNAMIC" || (SABOTAGE === "inner" && acc.tier === "KEYQUERY");
		if (!wants || !e?.toAccess || !e.toCol || e.toAccess.where !== "root") continue;
		const idx = (root.columns ?? []).findIndex((c) => c.expr.type === "ref" && c.expr.name === e.toCol && (c.expr.table?.name ?? e.toAccess!.alias) === e.toAccess!.alias);
		if (idx >= 0) out.set(acc, idx);
	}
	return out;
}

// ── canonical comparison of results ──────────────────────────────────────────
const canon = (v: V): V => Array.isArray(v) ? v.map(canon).map((x) => JSON.stringify(x)).sort() : v && typeof v === "object" && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)])) : v instanceof Date ? v.toISOString() : v;

// ── run ──────────────────────────────────────────────────────────────────────
let raw: { sql: string; params: V[]; rows: V[][] }[] = [];
const db = drizzle(async (sql, params) => {
	const r = await pg.query<V[]>(sql, params, { rowMode: "array" });
	raw.push({ sql, params, rows: r.rows });
	return { rows: r.rows };
}, { schema });

async function runCase(c: Case) {
	raw = [];
	let result: V;
	try { result = await c.run(db); } catch (e) { return { error: String(e).slice(0, 120) }; }
	return { result, stmts: raw };
}

const summary: string[] = [];
let totalViol = 0;
for (const c of cases) {
	if (c.cat === "write" || (ONLY && !c.id.startsWith(ONLY))) continue;
	await seed();
	const first = await runCase(c);
	if ("error" in first) { summary.push(`${c.id.padEnd(34)} SKIP (${first.error})`); continue; }
	if (first.stmts.length !== 1) { summary.push(`${c.id.padEnd(34)} SKIP (${first.stmts.length} statements)`); continue; }
	const { sql: sqlText, params } = first.stmts[0];
	const a = analyzeSql(sqlText, params);
	if (SABOTAGE === "leftjoin") for (const acc of a.accesses) if (acc.tier === "DYNAMIC") acc.tier = "KEYQUERY";
	if ([...a.flags].some((f) => f.startsWith("nondeterministic"))) { summary.push(`${c.id.padEnd(34)} SKIP (nondeterministic)`); continue; }
	const keyCols = resultKeyColumns(sqlText, a);
	let before = await snapshot();
	let prev = first;
	let changed = 0, invalidated = 0, viol = 0, orderOnly = 0, over = 0, keyMismatch = 0, fromResult = 0;
	const examples: string[] = [];
	for (let i = 0; i < STEPS; i++) {
		// read-set context from the PRE-write state
		const resultKeys = new Map<Access, Set<string>>();
		for (const [acc, idx] of keyCols) resultKeys.set(acc, new Set(prev.stmts[0].rows.map((r) => keyOf(r[idx]))));
		const ctx: Ctx = { a, params, snap: before, resultKeys };
		const memo = new Map<Access, Set<string> | "ALL">();
		// the claim behind DYNAMIC: result keys == side-query keys when the edge is preserved
		for (const [acc] of keyCols) {
			const e = acc.anchorEdge!;
			const side = new Set<string>();
			for (const r of before[e.toAccess!.table].values()) if (inReadSet(e.toAccess!, r, { ...ctx, resultKeys: new Map() }, new Map())) side.add(keyOf(r[e.toCol!]));
			side.delete("∅");
			const res = new Set([...resultKeys.get(acc)!].filter((k) => k !== "∅"));
			if ([...side].some((k) => !res.has(k))) keyMismatch++;
			fromResult++;
		}

		await randomWrite();
		const after = await snapshot();
		const changes = diff(before, after);
		const next = await runCase(c);
		if ("error" in next) { summary.push(`${c.id} ERROR mid-run ${next.error}`); break; }
		const hit = changes.some((ch) => a.accesses.some((acc) => acc.table === ch.table && ((ch.old && inReadSet(acc, ch.old, ctx, memo)) || (ch.new && inReadSet(acc, ch.new, ctx, memo)))));
		const rawChanged = JSON.stringify(prev.result) !== JSON.stringify(next.result);
		const canonChanged = JSON.stringify(canon(prev.result)) !== JSON.stringify(canon(next.result));
		if (rawChanged) changed++;
		if (hit) invalidated++;
		if (hit && !rawChanged) over++;
		if (canonChanged && !hit) {
			viol++;
			if (examples.length < 2) examples.push(`step ${i}: ${JSON.stringify(changes).slice(0, 300)}`);
		} else if (rawChanged && !hit) orderOnly++;
		before = after;
		prev = next;
	}
	totalViol += viol;
	const tiers = a.accesses.map((x) => `${x.table}:${x.tier}`).join(" ");
	summary.push(`${c.id.padEnd(34)} ${viol ? "VIOLATION" : changed === 0 ? "VACUOUS  " : "sound    "} changed=${String(changed).padStart(3)} invalidated=${String(invalidated).padStart(3)} over=${String(over).padStart(3)} viol=${viol} orderOnly=${orderOnly}${fromResult ? ` keysFromResult=${fromResult} keyMismatch=${keyMismatch}` : ""}  [${tiers}]`);
	for (const ex of examples) summary.push(`      ${ex}`);
}
console.log(`steps=${STEPS} seed=${SEED}${SABOTAGE ? ` SABOTAGE=${SABOTAGE}` : ""}`);
for (const l of summary) console.log(l);
console.log(`\nTOTAL VIOLATIONS: ${totalViol}   VACUOUS: ${summary.filter((l) => l.includes("VACUOUS")).length}`);
process.exit(0);
