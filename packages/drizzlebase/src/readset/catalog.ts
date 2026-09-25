// Resolves what a statement names into what Postgres will actually read, through pg_catalog. Resolution runs
// on the FUNCTION'S OWN connection, inside its transaction: the same search_path the statement used, and no
// second pool connection (resolving on the pool while the function held one deadlocked a small pool — final
// review #2/#3). Cached by (search_path, name as written); clear() on DDL (spec P-M1).
import type { SQL } from "bun";
import type { FunctionRef, OperatorRef, RelationRef } from "./refs";

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
export interface FunctionInfo {
  user: boolean; // defined outside pg_catalog: its body may read any table (spec D4)
  volatile: boolean; // not immutable: the result can change without a write (spec D10, RA-B3)
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

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
      map.set(key, hit);
      hit.catch(() => map.delete(key)); // a failed lookup is not remembered
    }
    return hit;
  }

  relation(r: RelationRef, exec: SQL, searchPath: string): Promise<RelationInfo | null> {
    const name = r.schema ? `${q(r.schema)}.${q(r.name)}` : q(r.name);
    return this.cached(this.rels, `${searchPath}|${r.only}|${name}`, () => this.loadRelation(exec, name, r.only));
  }

  fn(f: FunctionRef, exec: SQL, searchPath: string): Promise<FunctionInfo | null> {
    return this.cached(this.fns, `${searchPath}|${f.schema ?? ""}|${f.name}`, () => this.loadFunction(exec, f));
  }

  // true = user-defined (its function lives outside pg_catalog), false = built-in, null = unknown
  operator(o: OperatorRef, exec: SQL, searchPath: string): Promise<boolean | null> {
    return this.cached(this.ops, `${searchPath}|${o.schema ?? ""}|${o.name}`, () => this.loadOperator(exec, o));
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
			              select 1 from pg_partition_ancestors(mc.oid) a where a.relid in (select oid from listed)))))
			   from scanned s join pg_class mc on mc.oid = s.oid join pg_namespace mn on mn.oid = mc.relnamespace) as members,
			  coalesce((select array_agg(an.nspname || '.' || ac.relname) from up u join pg_class ac on ac.oid = u.oid
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
