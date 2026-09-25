// THROWAWAY SPIKE (P2) — does a capture method see every row image a write produced?
//
// For each step: snapshot every table, run one random write (single row, multi-row, FK cascade, a user
// trigger, upsert, truncate, a rolled-back transaction, a primary-key move), snapshot again, and compare the
// DIFF (ground truth) with what the capture method reported. Soundness needs capture ⊇ diff (every OLD and
// NEW image of a changed row present, or a table-level marker for that table). Extras are only cost.
//
//   bun equiv.ts --method=row|stmt|returning|logical [--steps=1500] [--seed=1]
import { SQL } from "bun";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const METHOD = arg("method", "row");
const STEPS = Number(arg("steps", "1500"));
let rs = Number(arg("seed", "1")) >>> 0;
const rnd = () => { rs = (rs + 0x6d2b79f5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

if (!process.env.PGPASSWORD) throw new Error("PGPASSWORD missing: run from spikes/p2-capture (bun loads .env)");
const sql = new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max: 1 });

const UUIDS = [1, 2, 3, 4, 5, 6].map((i) => `0190a000-0000-7000-8000-00000000000${i}`);
const DATES = ["2025-12-30T00:00:00", "2026-01-01T00:00:00", "2026-03-01T00:00:00"];
const gen: Record<string, Record<string, () => unknown>> = {
	users: { name: () => pick(["Dan", "Ana", "Bob"]), email: () => pick(["a@b.c", "x"]), age: () => pick([null, 15, 18, 30, 65]), deleted: () => rnd() < 0.3, created_at: () => pick(DATES) },
	posts: { author_id: () => pick(UUIDS), title: () => pick(["draft a", "t", "it's"]), published: () => rnd() < 0.5, views: () => pick([0, 40, 51]) },
	parents: { v: () => pick([0, 1, 2]) },
	children: { parent_id: () => pick([1, 2, 3, 4]), v: () => pick([0, 1]) },
};
const PK: Record<string, () => unknown> = { users: () => pick(UUIDS), posts: () => 1 + Math.floor(rnd() * 12), parents: () => 1 + Math.floor(rnd() * 4), children: () => 1 + Math.floor(rnd() * 12) };
const TABLES = ["users", "posts", "parents", "children", "audit"];
const CAPTURED = ["users", "posts", "parents", "children", "audit"];

const DDL = `
drop table if exists users, posts, parents, children, audit, _outbox cascade;
select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = 'spike';
create table users(id uuid primary key, name text not null, email text not null, age int, deleted boolean not null default false, created_at timestamp not null default now());
create table posts(id int primary key, author_id uuid not null, title text not null, published boolean not null default false, views int not null default 0);
create table parents(id int primary key, v int not null);
create table children(id int primary key, parent_id int not null references parents(id) on delete cascade on update cascade, v int not null);
create table audit(id bigserial primary key, parent_id int, note text);
-- a USER trigger, the kind of thing an app adds: writes a second table the statement never named
create or replace function audit_parents() returns trigger language plpgsql as $$
begin insert into audit(parent_id, note) values (coalesce(new.id, old.id), tg_op); return null; end $$;
create trigger audit_parents after update on parents for each row execute function audit_parents();
create table _outbox(id bigserial primary key, xid xid8 not null default pg_current_xact_id(), tbl text not null, op text not null, old jsonb, new jsonb);
`;

const ROW_CAPTURE = `
create or replace function _cap_row() returns trigger language plpgsql as $$
begin
  insert into _outbox(tbl, op, old, new) values (tg_table_name, tg_op,
    case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
create or replace function _cap_truncate() returns trigger language plpgsql as $$
begin insert into _outbox(tbl, op) values (tg_table_name, 'TRUNCATE'); return null; end $$;
`;
const STMT_CAPTURE = `
create or replace function _cap_ins() returns trigger language plpgsql as $$
begin insert into _outbox(tbl, op, new) select tg_table_name, 'INSERT', to_jsonb(n) from n; return null; end $$;
create or replace function _cap_upd() returns trigger language plpgsql as $$
begin
  insert into _outbox(tbl, op, old) select tg_table_name, 'UPDATE', to_jsonb(o) from o;
  insert into _outbox(tbl, op, new) select tg_table_name, 'UPDATE', to_jsonb(n) from n;
  return null;
end $$;
create or replace function _cap_del() returns trigger language plpgsql as $$
begin insert into _outbox(tbl, op, old) select tg_table_name, 'DELETE', to_jsonb(o) from o; return null; end $$;
`;

async function install(): Promise<void> {
	await sql.unsafe(DDL);
	if (METHOD === "row" || METHOD === "stmt") await sql.unsafe(METHOD === "row" ? ROW_CAPTURE : `${STMT_CAPTURE}${ROW_CAPTURE}`);
	for (const t of CAPTURED) {
		if (METHOD === "row") await sql.unsafe(`create trigger _cap after insert or update or delete on ${t} for each row execute function _cap_row()`);
		if (METHOD === "stmt") {
			await sql.unsafe(`create trigger _cap_i after insert on ${t} referencing new table as n for each statement execute function _cap_ins()`);
			await sql.unsafe(`create trigger _cap_u after update on ${t} referencing old table as o new table as n for each statement execute function _cap_upd()`);
			await sql.unsafe(`create trigger _cap_d after delete on ${t} referencing old table as o for each statement execute function _cap_del()`);
		}
		if (METHOD === "row" || METHOD === "stmt") await sql.unsafe(`create trigger _cap_t after truncate on ${t} for each statement execute function _cap_truncate()`);
		if (METHOD === "logical") await sql.unsafe(`alter table ${t} replica identity full`);
	}
	if (METHOD === "logical") await sql.unsafe(`select pg_create_logical_replication_slot('spike', 'test_decoding')`);
}

// ── the writes ───────────────────────────────────────────────────────────────
// `returning` captures whatever RETURNING OLD/NEW gives back on the MUTATION path (every write here goes
// through `write()`, i.e. we are generous to it: Studio/psql writes would not even reach it).
type Img = { tbl: string; old?: unknown; new?: unknown; truncate?: boolean };
let pending: Img[] = [];
let lastRaw: string[] = []; // returning-path images, published only on COMMIT
async function write(text: string, params: unknown[] = [], tx: typeof sql = sql): Promise<void> {
	const isDml = /^\s*(insert|update|delete)\b/i.test(text);
	if (METHOD === "returning" && isDml) {
		const tbl = text.match(/^\s*(?:insert\s+into|update|delete\s+from)\s+(\w+)/i)![1];
		const rows = await tx.unsafe(`${text} returning to_jsonb(old) as o, to_jsonb(new) as n`, params);
		for (const r of rows) pending.push({ tbl, old: r.o ?? undefined, new: r.n ?? undefined });
		return;
	}
	await tx.unsafe(text, params);
}
async function insertRandom(t: string): Promise<void> {
	const cols = ["id", ...Object.keys(gen[t])];
	await write(`insert into ${t}(${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) on conflict do nothing`, [PK[t](), ...Object.values(gen[t]).map((g) => g())]);
}
let lastKind = "";
async function randomWrite(): Promise<void> {
	const k = rnd();
	const t = pick(["users", "posts", "parents", "children"]);
	if (k < 0.3) { lastKind = "insert"; if (t === "children") { const ps = await sql`select id from parents`; if (!ps.length) return insertRandom("parents"); await write(`insert into children values ($1, $2, 0) on conflict do nothing`, [PK.children(), pick(ps).id]); return; } return insertRandom(t); }
	if (k < 0.55) {
		lastKind = "update-one";
		const ids = await sql.unsafe(`select id from ${t}`); if (!ids.length) return insertRandom(t);
		const cols = Object.keys(gen[t]).filter((c) => t !== "children" || c !== "parent_id");
		const c = pick(cols);
		return write(`update ${t} set ${c} = $2 where id = $1`, [pick(ids).id, gen[t][c]()]);
	}
	if (k < 0.62) { lastKind = "update-many"; return write(`update users set age = coalesce(age, 0) + 1 where age < 30`); }
	if (k < 0.67) { lastKind = "delete-many"; return write(`delete from posts where views < 45`); }
	if (k < 0.75) { lastKind = "delete-cascade"; return write(`delete from parents where id = $1`, [PK.parents()]); }
	if (k < 0.8) { lastKind = "update-with-user-trigger"; return write(`update parents set v = v + 1 where id = $1`, [PK.parents()]); }
	if (k < 0.84) { lastKind = "pk-move-cascade"; return write(`update parents set id = $2 where id = $1 and not exists (select 1 from parents where id = $2)`, [PK.parents(), 5 + Math.floor(rnd() * 3)]); }
	if (k < 0.89) { lastKind = "upsert"; return write(`insert into posts(id, author_id, title) values ($1, $2, 't') on conflict (id) do update set views = posts.views + 1`, [PK.posts(), pick(UUIDS)]); }
	if (k < 0.91) { lastKind = "truncate"; return write(`truncate posts`); }
	if (k < 0.96) {
		lastKind = "rollback";
		try { await sql.begin(async (tx) => { await write(`update users set name = 'ROLLED BACK'`, [], tx); throw new Error("abort"); }); } catch { /* expected */ }
		pending = []; // the returning path must drop what an aborted transaction returned
		return;
	}
	lastKind = "tx-two-statements";
	await sql.begin(async (tx) => { await write(`update posts set views = views + 1 where author_id = $1`, [pick(UUIDS)], tx); await write(`delete from children where v = 1`, [], tx); });
}

// ── ground truth and the capture's report ────────────────────────────────────
type Snap = Record<string, Map<string, string>>;
async function snapshot(): Promise<Snap> {
	const out: Snap = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
	for (const t of TABLES) for (const r of await sql.unsafe(`select id::text as k, to_jsonb(x)::text as j from ${t} x`)) out[t].set(r.k, canon(JSON.parse(r.j)));
	return out;
}
const canon = (o: unknown): string => JSON.stringify(Object.fromEntries(Object.entries(o as object).sort().map(([k, v]) => [k, typeof v === "string" && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(v) ? v.replace(" ", "T") : v])));
function diffImages(a: Snap, b: Snap): string[] {
	const out: string[] = [];
	for (const t of TABLES) {
		for (const [k, o] of a[t]) { const n = b[t].get(k); if (n !== o) { out.push(`${t} ${o}`); if (n) out.push(`${t} ${n}`); } }
		for (const [k, n] of b[t]) if (!a[t].has(k)) out.push(`${t} ${n}`);
	}
	return out;
}

// test_decoding: `table public.t: UPDATE: old-key: a[integer]:1 b[text]:'x' new-tuple: a[integer]:1 …`
function parseTuple(s: string): Record<string, unknown> {
	const o: Record<string, unknown> = {};
	const re = /(\w+)\[([^\]]+)\]:('(?:[^']|'')*'|\S+)/g;
	for (let m = re.exec(s); m; m = re.exec(s)) {
		const [, col, type, raw] = m;
		if (raw === "null") o[col] = null;
		else if (raw.startsWith("'")) o[col] = raw.slice(1, -1).replace(/''/g, "'");
		else if (type === "boolean") o[col] = raw === "true";
		else if (/int|numeric|bigint/.test(type)) o[col] = Number(raw);
		else o[col] = raw;
	}
	return o;
}
async function captured(): Promise<{ images: Set<string>; truncated: Set<string> }> {
	const images = new Set<string>(), truncated = new Set<string>();
	const add = (tbl: string, img: unknown) => { if (img) images.add(`${tbl} ${canon(img)}`); };
	if (METHOD === "row" || METHOD === "stmt") {
		for (const r of await sql`delete from _outbox returning tbl, op, old, new`) {
			if (r.op === "TRUNCATE") truncated.add(r.tbl); else { add(r.tbl, r.old); add(r.tbl, r.new); }
		}
	} else if (METHOD === "returning") {
		for (const p of pending) { add(p.tbl, p.old); add(p.tbl, p.new); }
		pending = [];
	} else {
		lastRaw = [];
		for (const r of await sql`select data from pg_logical_slot_get_changes('spike', null, null)`) {
			lastRaw.push(r.data);
			const m = (r.data as string).match(/^table public\.(\w+): (INSERT|UPDATE|DELETE|TRUNCATE):(.*)$/s);
			if (!m) continue;
			const [, tbl, op, rest] = m;
			if (op === "TRUNCATE") { truncated.add(tbl); continue; }
			const [oldPart, newPart] = rest.includes("new-tuple:") ? rest.split("new-tuple:") : op === "DELETE" ? [rest, ""] : ["", rest];
			// test_decoding leaves NULL columns out of the old tuple; the table's column list fills them back in.
			const oldImg = oldPart.replace("old-key:", "").trim() ? parseTuple(oldPart) : undefined;
			if (oldImg) for (const c of COLUMNS[tbl] ?? []) if (!(c in oldImg)) oldImg[c] = null;
			add(tbl, oldImg);
			add(tbl, newPart.trim() ? parseTuple(newPart) : undefined);
		}
	}
	return { images, truncated };
}

await install();
const COLUMNS: Record<string, string[]> = {};
for (const r of await sql`select table_name as t, column_name as c from information_schema.columns where table_schema = 'public'`) (COLUMNS[r.t] ??= []).push(r.c);
for (let i = 0; i < 8; i++) for (const t of ["users", "posts", "parents"]) await insertRandom(t);
await captured(); // discard the seed's own images
let before = await snapshot();
const misses: Record<string, number> = {};
let steps = 0, missSteps = 0, extras = 0, truth = 0;
const examples: string[] = [];
for (; steps < STEPS; steps++) {
	await randomWrite();
	const after = await snapshot();
	const want = diffImages(before, after);
	const got = await captured();
	truth += want.length;
	const missing = want.filter((w) => !got.images.has(w) && !got.truncated.has(w.split(" ")[0]));
	extras += [...got.images].filter((g) => !want.includes(g)).length;
	if (missing.length) {
		missSteps++;
		misses[lastKind] = (misses[lastKind] ?? 0) + 1;
		if (process.env.DEBUG && examples.length < 1) console.log("WANT", want, "\nRAW", lastRaw, "\nGOT", [...got.images]);
		if (examples.length < 4) examples.push(`${lastKind}: missing ${missing.length}/${want.length}, e.g. ${missing[0].slice(0, 110)}`);
	}
	before = after;
}
console.log(`method=${METHOD} steps=${steps} images(truth)=${truth} stepsWithMisses=${missSteps} extras=${extras}`);
console.log(`misses by write kind: ${JSON.stringify(misses)}`);
for (const e of examples) console.log(`  ${e}`);
await sql.close();
process.exit(0);
