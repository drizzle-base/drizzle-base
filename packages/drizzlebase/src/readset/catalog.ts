// Resolves what a statement names into what Postgres will actually read, through pg_catalog, with the same
// search_path the function's connection uses. Cached by the name as written; clear() on DDL (spec P-M1).
import type { SQL } from "bun";
import type { FunctionRef, RelationRef } from "./refs";

export interface RelationInfo {
	schema: string;
	name: string;
	relkind: string; // r table, p partitioned, v view, m matview, f foreign, …
	rls: boolean;
	published: boolean; // it, or a partition ancestor, is in the publication
	related: string[]; // "schema.name" of every inheritance/partition ancestor and descendant
}
export interface FunctionInfo {
	user: boolean; // defined outside pg_catalog: its body may read any table (spec D4)
	volatile: boolean; // not immutable: the result can change without a write (spec D10, RA-B3)
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

export class Catalog {
	private rels = new Map<string, Promise<RelationInfo | null>>();
	private fns = new Map<string, Promise<FunctionInfo | null>>();

	constructor(
		private readonly sql: SQL,
		private readonly publication: string,
	) {}

	clear(): void {
		this.rels.clear();
		this.fns.clear();
	}

	relation(r: RelationRef): Promise<RelationInfo | null> {
		const key = r.schema ? `${q(r.schema)}.${q(r.name)}` : q(r.name);
		let hit = this.rels.get(key);
		if (!hit) {
			hit = this.loadRelation(key);
			this.rels.set(key, hit);
		}
		return hit;
	}

	fn(f: FunctionRef): Promise<FunctionInfo | null> {
		const key = f.schema ? `${f.schema}.${f.name}` : f.name;
		let hit = this.fns.get(key);
		if (!hit) {
			hit = this.loadFunction(f);
			this.fns.set(key, hit);
		}
		return hit;
	}

	private async loadRelation(key: string): Promise<RelationInfo | null> {
		const [row] = await this.sql`
			with recursive target as (select to_regclass(${key}) as oid),
			up(oid) as (select oid from target union select i.inhparent from pg_inherits i join up on i.inhrelid = up.oid),
			down(oid) as (select oid from target union select i.inhrelid from pg_inherits i join down on i.inhparent = down.oid),
			family as (select oid from up union select oid from down)
			select n.nspname as schema, c.relname as name, c.relkind::text as relkind, c.relrowsecurity as rls,
			  exists (select 1 from family f join pg_class fc on fc.oid = f.oid join pg_namespace fn on fn.oid = fc.relnamespace
			          join pg_publication_tables pt on pt.schemaname = fn.nspname and pt.tablename = fc.relname
			          where pt.pubname = ${this.publication}) as published,
			  coalesce((select array_agg(fn.nspname || '.' || fc.relname order by 1) from family f
			            join pg_class fc on fc.oid = f.oid join pg_namespace fn on fn.oid = fc.relnamespace
			            where f.oid <> c.oid), '{}') as related
			from target t join pg_class c on c.oid = t.oid join pg_namespace n on n.oid = c.relnamespace`;
		if (!row) return null;
		return { schema: row.schema, name: row.name, relkind: row.relkind, rls: row.rls, published: row.published, related: row.related as string[] };
	}

	private async loadFunction(f: FunctionRef): Promise<FunctionInfo | null> {
		const rows = f.schema
			? await this.sql`select n.nspname as ns, p.provolatile::text as vol from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = ${f.name} and n.nspname = ${f.schema}`
			: await this.sql`select n.nspname as ns, p.provolatile::text as vol from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = ${f.name} and n.nspname = any(current_schemas(true))`;
		if (!rows.length) return null;
		// Overloads are not resolved here: any overload outside pg_catalog, or any non-immutable one, decides.
		return {
			user: rows.some((r: { ns: string }) => r.ns !== "pg_catalog"),
			volatile: rows.some((r: { vol: string }) => r.vol !== "i"),
		};
	}
}
