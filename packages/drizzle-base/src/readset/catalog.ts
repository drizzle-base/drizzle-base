// Resolves what a statement names into what Postgres will actually read, through pg_catalog. Resolution runs
// on the FUNCTION'S OWN connection, inside its transaction: the same search_path the statement used, and no
// second pool connection (resolving on the pool while the function held one deadlocked a small pool — final
// review #2/#3). Memoised by (schemas, name as written): `schemas` is current_schemas(true), which also names the
// session's temp schema. prefetch() resolves every name a run needs in ONE statement; the per-name loaders stay
// as the reference it is tested against.
import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import type { FunctionRef, OperatorRef, Refs, RelationRef } from "./refs";

export interface Member {
  name: string; // "schema.name"
  relkind: string;
  rls: boolean;
  published: boolean; // listed in the publication, or a partition whose published root carries it
}
export interface RelationInfo {
  schema: string;
  name: string;
  relkind: string; // of the relation named: r table, p partitioned, v view, m matview, f foreign, …
  members: Member[]; // what the scan reads: the relation, plus its descendants unless ONLY
  ancestors: string[]; // "schema.name": the capture reports a partition's changes under its root
}
interface RelRow {
  i: number;
  schema: string;
  name: string;
  relkind: string;
  members: Member[] | null;
  ancestors: string[];
}
type BatchRow = { rels: RelRow[]; fns: { i: number; ns: string; vol: string }[]; ops: { i: number; ns: string }[] };
export interface FunctionInfo {
  user: boolean; // defined outside pg_catalog: its body may read any table (spec D4)
  volatile: boolean; // not immutable: the result can change without a write (spec D10, RA-B3)
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const relName = (r: RelationRef) => (r.schema ? `${q(r.schema)}.${q(r.name)}` : q(r.name));
// One key per lookup, shared by prefetch and the per-name methods: a mismatch would silently turn prefetch into
// a no-op (correct, but one round trip per name again).
const relKey = (r: RelationRef, sp: string) => `${sp}|${r.only}|${relName(r)}`;
const fnKey = (f: FunctionRef, sp: string) => `${sp}|${f.schema ?? ""}|${f.name}`;
const opKey = (o: OperatorRef, sp: string) => `${sp}|${o.schema ?? ""}|${o.name}`;

// Every lookup of a run in one statement: loadRelation's walk with the input index `i` carried through every
// recursive CTE (so one name's family never mixes with another's), and loadFunction / loadOperator joined
// against their inputs. Members and ancestors are ordered, as in the per-name loader: their order decides the
// order of a read-set's opaque reasons.
const BATCH = `
with recursive input as (select * from jsonb_to_recordset($1::jsonb -> 'rels') as x(i int, name text, only_ bool)),
target as (select i, only_, to_regclass(name) as oid from input),
up(i, oid) as (select i, oid from target where oid is not null
               union select up.i, h.inhparent from pg_inherits h join up on h.inhrelid = up.oid),
down(i, oid) as (select i, oid from target where oid is not null
                 union select down.i, h.inhrelid from pg_inherits h join down on h.inhparent = down.oid),
scanned(i, oid) as (select i, oid from target where oid is not null
                    union select d.i, d.oid from down d join target t on t.i = d.i where not t.only_),
listed as (select c.oid from pg_publication_tables pt join pg_namespace n on n.nspname = pt.schemaname
           join pg_class c on c.relnamespace = n.oid and c.relname = pt.tablename where pt.pubname = $2),
rels as (
  select t.i, n.nspname as schema, c.relname as name, c.relkind::text as relkind,
    (select json_agg(json_build_object(
        'name', mn.nspname || '.' || mc.relname, 'relkind', mc.relkind::text, 'rls', mc.relrowsecurity,
        'published', mc.oid in (select oid from listed)
          or (mc.relispartition and exists (
                select 1 from pg_partition_ancestors(mc.oid) a where a.relid in (select oid from listed))))
        order by mn.nspname, mc.relname)
     from scanned s join pg_class mc on mc.oid = s.oid join pg_namespace mn on mn.oid = mc.relnamespace
     where s.i = t.i) as members,
    coalesce((select array_agg(an.nspname || '.' || ac.relname order by an.nspname, ac.relname)
              from up u join pg_class ac on ac.oid = u.oid join pg_namespace an on an.oid = ac.relnamespace
              where u.i = t.i and u.oid <> c.oid), '{}') as ancestors
  from target t join pg_class c on c.oid = t.oid join pg_namespace n on n.oid = c.relnamespace),
fin as (select * from jsonb_to_recordset($1::jsonb -> 'fns') as x(i int, name text, schema text)),
fns as (select f.i, n.nspname as ns, p.provolatile::text as vol from fin f
        join pg_proc p on p.proname = f.name join pg_namespace n on n.oid = p.pronamespace
        where case when f.schema is not null then n.nspname = f.schema else n.nspname = any(current_schemas(true)) end),
oin as (select * from jsonb_to_recordset($1::jsonb -> 'ops') as x(i int, name text, schema text)),
ops as (select o.i, pn.nspname as ns from oin o
        join pg_operator op on op.oprname = o.name join pg_namespace n on n.oid = op.oprnamespace
        join pg_proc p on p.oid = op.oprcode join pg_namespace pn on pn.oid = p.pronamespace
        where case when o.schema is not null then n.nspname = o.schema else n.nspname = any(current_schemas(true)) end)
select (select coalesce(json_agg(r), '[]') from rels r) as rels,
       (select coalesce(json_agg(f), '[]') from fns f) as fns,
       (select coalesce(json_agg(o), '[]') from ops o) as ops`;

// The batch, PREPAREd once per connection: the pool never prepares (prepare: false), and re-planning this
// statement on every run cost more than its round trips (1.0–1.5 ms of planning against 0.64 ms of execution,
// measured). A catalog statement is safe to prepare: it reads system catalogs, whose shape never changes. The name
// carries a hash of the text, so a changed batch never meets an old plan on a long-lived connection.
export const CATALOG_STATEMENT = `dzb_catalog_${createHash("sha256").update(BATCH).digest("hex").slice(0, 12)}`;

// Whether this connection already holds CATALOG_STATEMENT. The runtime reads it in the statement it sends first
// (no extra round trip); prefetch sets it once it has prepared.
export interface PreparedState {
  ready: boolean;
}

// EXECUTE takes no bind parameters, so the payload travels as a literal. A dollar quote has no escapes, so it does
// not depend on standard_conforming_strings; its tag is random and never one that occurs in the text, so the text
// cannot close it early. The only way text enters the prepared path.
export function dollarQuote(text: string): string {
  for (;;) {
    const tag = `$dzb_${randomBytes(6).toString("hex")}$`;
    if (!text.includes(tag)) return `${tag}${text}${tag}`;
  }
}

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class Catalog {
  private rels = new Map<string, Promise<RelationInfo | null>>();
  private fns = new Map<string, Promise<FunctionInfo | null>>();
  private ops = new Map<string, Promise<boolean | null>>();

  constructor(private readonly publication: string) {}

  clear(): void {
    this.rels.clear();
    this.fns.clear();
    this.ops.clear();
  }

  private cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let hit = map.get(key);
    if (!hit) {
      hit = load();
      this.remember(map, key, hit);
    }
    return hit;
  }

  // A failed lookup is not remembered — but only its own entry goes: another writer may have stored a good one
  // under the same key since.
  private remember<T>(map: Map<string, Promise<T>>, key: string, p: Promise<T>): void {
    map.set(key, p);
    p.catch(() => {
      if (map.get(key) === p) map.delete(key);
    });
  }

  private pending<T>(map: Map<string, Promise<T>>, key: string): Pending<T> {
    let resolve: (v: T) => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const p = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.remember(map, key, p);
    return { resolve, reject };
  }

  // Resolves, in one statement, every name the given statements use that is not memoised yet. Each missing key
  // gets a pending entry BEFORE the first await, so a concurrent caller sharing this Catalog (a cycle's lanes)
  // waits for this statement instead of issuing its own. A failure rejects them all (and forgets them).
  async prefetch(refs: readonly Refs[], exec: SQL, searchPath: string, prepared?: PreparedState): Promise<void> {
    const rels: (Pending<RelationInfo | null> & { name: string; only: boolean })[] = [];
    const fns: (Pending<FunctionInfo | null> & { name: string; schema: string | null })[] = [];
    const ops: (Pending<boolean | null> & { name: string; schema: string | null })[] = [];
    for (const r of refs) {
      for (const x of r.relations) {
        const key = relKey(x, searchPath);
        if (!this.rels.has(key)) rels.push({ ...this.pending(this.rels, key), name: relName(x), only: x.only });
      }
      // an empty schema means the search path, as in loadFunction / loadOperator (truthiness, not null)
      for (const x of r.functions) {
        const key = fnKey(x, searchPath);
        if (!this.fns.has(key)) fns.push({ ...this.pending(this.fns, key), name: x.name, schema: x.schema || null });
      }
      for (const x of r.operators) {
        const key = opKey(x, searchPath);
        if (!this.ops.has(key)) ops.push({ ...this.pending(this.ops, key), name: x.name, schema: x.schema || null });
      }
    }
    if (!rels.length && !fns.length && !ops.length) return;
    const payload = JSON.stringify({
      rels: rels.map((x, i) => ({ i, name: x.name, only_: x.only })),
      fns: fns.map((x, i) => ({ i, name: x.name, schema: x.schema })),
      ops: ops.map((x, i) => ({ i, name: x.name, schema: x.schema })),
    });
    let row: BatchRow;
    try {
      row = await this.issue(exec, payload, prepared);
    } catch (e) {
      for (const x of [...rels, ...fns, ...ops]) x.reject(e);
      throw e;
    }
    const relById = new Map(row.rels.map((r) => [r.i, r]));
    for (const [i, x] of rels.entries()) {
      const r = relById.get(i);
      x.resolve(
        r
          ? { schema: r.schema, name: r.name, relkind: r.relkind, members: r.members ?? [], ancestors: r.ancestors }
          : null,
      );
    }
    for (const [i, x] of fns.entries()) {
      const found = row.fns.filter((f) => f.i === i);
      // Overloads are not resolved: any overload outside pg_catalog, or any non-immutable one, decides.
      x.resolve(
        found.length
          ? { user: found.some((f) => f.ns !== "pg_catalog"), volatile: found.some((f) => f.vol !== "i") }
          : null,
      );
    }
    for (const [i, x] of ops.entries()) {
      const found = row.ops.filter((o) => o.i === i);
      x.resolve(found.length ? found.some((o) => o.ns !== "pg_catalog") : null);
    }
  }

  // The one statement of a prefetch (plus a one-time PREPARE on the prepared path); a method of its own so a
  // test can count them. Both go over the simple protocol: the extended one would read the PREPARE body's $1 as
  // a protocol parameter.
  protected async issue(exec: SQL, payload: string, prepared?: PreparedState): Promise<BatchRow> {
    if (!prepared) {
      const [row] = await exec.unsafe(BATCH, [payload, this.publication]);
      return row as BatchRow;
    }
    if (!prepared.ready) {
      await exec.unsafe(`prepare ${CATALOG_STATEMENT}(jsonb, text) as ${BATCH}`).simple();
      prepared.ready = true;
    }
    const [row] = await exec
      .unsafe(`execute ${CATALOG_STATEMENT}(${dollarQuote(payload)}, ${dollarQuote(this.publication)})`)
      .simple();
    return row as BatchRow;
  }

  relation(r: RelationRef, exec: SQL, searchPath: string): Promise<RelationInfo | null> {
    return this.cached(this.rels, relKey(r, searchPath), () => this.loadRelation(exec, relName(r), r.only));
  }

  fn(f: FunctionRef, exec: SQL, searchPath: string): Promise<FunctionInfo | null> {
    return this.cached(this.fns, fnKey(f, searchPath), () => this.loadFunction(exec, f));
  }

  // true = user-defined (its function lives outside pg_catalog), false = built-in, null = unknown
  operator(o: OperatorRef, exec: SQL, searchPath: string): Promise<boolean | null> {
    return this.cached(this.ops, opKey(o, searchPath), () => this.loadOperator(exec, o));
  }

  private async loadRelation(exec: SQL, name: string, only: boolean): Promise<RelationInfo | null> {
    const [row] = await exec`
			with recursive target as (select to_regclass(${name}) as oid),
			up(oid) as (select oid from target union select i.inhparent from pg_inherits i join up on i.inhrelid = up.oid),
			down(oid) as (select oid from target union select i.inhrelid from pg_inherits i join down on i.inhparent = down.oid),
			scanned as (select oid from target union select oid from down where not ${only}),
			listed as (select c.oid from pg_publication_tables pt join pg_namespace n on n.nspname = pt.schemaname
			           join pg_class c on c.relnamespace = n.oid and c.relname = pt.tablename where pt.pubname = ${this.publication})
			select n.nspname as schema, c.relname as name, c.relkind::text as relkind,
			  (select json_agg(json_build_object(
			      'name', mn.nspname || '.' || mc.relname, 'relkind', mc.relkind::text, 'rls', mc.relrowsecurity,
			      'published', mc.oid in (select oid from listed)
			        or (mc.relispartition and exists (
			              select 1 from pg_partition_ancestors(mc.oid) a where a.relid in (select oid from listed))))
			    order by mn.nspname, mc.relname)
			   from scanned s join pg_class mc on mc.oid = s.oid join pg_namespace mn on mn.oid = mc.relnamespace) as members,
			  coalesce((select array_agg(an.nspname || '.' || ac.relname order by an.nspname, ac.relname) from up u join pg_class ac on ac.oid = u.oid
			            join pg_namespace an on an.oid = ac.relnamespace where u.oid <> c.oid), '{}') as ancestors
			from target t join pg_class c on c.oid = t.oid join pg_namespace n on n.oid = c.relnamespace`;
    if (!row) return null;
    return {
      schema: row.schema,
      name: row.name,
      relkind: row.relkind,
      members: row.members as Member[],
      ancestors: row.ancestors as string[],
    };
  }

  private async loadFunction(exec: SQL, f: FunctionRef): Promise<FunctionInfo | null> {
    const rows = f.schema
      ? await exec`select n.nspname as ns, p.provolatile::text as vol from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = ${f.name} and n.nspname = ${f.schema}`
      : await exec`select n.nspname as ns, p.provolatile::text as vol from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = ${f.name} and n.nspname = any(current_schemas(true))`;
    if (!rows.length) return null;
    // Overloads are not resolved: any overload outside pg_catalog, or any non-immutable one, decides.
    return {
      user: rows.some((r: { ns: string }) => r.ns !== "pg_catalog"),
      volatile: rows.some((r: { vol: string }) => r.vol !== "i"),
    };
  }

  private async loadOperator(exec: SQL, o: OperatorRef): Promise<boolean | null> {
    const rows = o.schema
      ? await exec`select pn.nspname as ns from pg_operator op join pg_namespace n on n.oid = op.oprnamespace join pg_proc p on p.oid = op.oprcode join pg_namespace pn on pn.oid = p.pronamespace where op.oprname = ${o.name} and n.nspname = ${o.schema}`
      : await exec`select pn.nspname as ns from pg_operator op join pg_namespace n on n.oid = op.oprnamespace join pg_proc p on p.oid = op.oprcode join pg_namespace pn on pn.oid = p.pronamespace where op.oprname = ${o.name} and n.nspname = any(current_schemas(true))`;
    if (!rows.length) return null;
    return rows.some((r: { ns: string }) => r.ns !== "pg_catalog");
  }
}
