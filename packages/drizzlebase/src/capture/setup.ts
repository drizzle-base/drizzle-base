// Creates and validates what capture depends on. checkCapture lists EVERY problem so boot refuses to start
// naming them all (fail closed, spec D13/P-A6/P-M1/P-M3): a missing piece means changes that never reach
// subscriptions, which is the one failure drizzlebase must not have.
// Identifiers come from configuration, not from users, and are double-quoted everywhere.
import type { SQL } from "bun";
import { DDL_PREFIX } from "./types";

export interface CaptureNames {
	slot: string;
	publication: string;
	schema: string;
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// The DDL signal: a TRANSACTIONAL logical message, so it reaches the stream in commit order with the DDL
// itself. A rewriting ALTER emits no row changes at all (review A, pgoutput.out §6); this is how it is seen.
const DDL_FUNCTION = `
create or replace function drizzlebase_emit_ddl() returns event_trigger language plpgsql as $$
begin
  perform pg_logical_emit_message(true, ${lit(DDL_PREFIX)}, coalesce(tg_tag, ''));
end $$;`;

export async function ensureCapture(sql: SQL, n: CaptureNames): Promise<void> {
	const [pub] = await sql`select 1 as x from pg_publication where pubname = ${n.publication}`;
	if (!pub)
		await sql.unsafe(
			`create publication ${q(n.publication)} for tables in schema ${q(n.schema)} with (publish_generated_columns = stored, publish_via_partition_root = true)`,
		);
	await sql.unsafe(DDL_FUNCTION);
	for (const [name, event] of [["drizzlebase_ddl_end", "ddl_command_end"], ["drizzlebase_ddl_drop", "sql_drop"]] as const) {
		const [t] = await sql`select 1 as x from pg_event_trigger where evtname = ${name}`;
		if (!t) await sql.unsafe(`create event trigger ${name} on ${event} execute function drizzlebase_emit_ddl()`);
	}
	await setReplicaIdentityFull(sql, n.schema);
	const [slot] = await sql`select 1 as x from pg_replication_slots where slot_name = ${n.slot}`;
	if (!slot) await sql`select pg_create_logical_replication_slot(${n.slot}, 'pgoutput')`;
}

// Ordinary tables only (relkind 'r'): partitions are leaves of kind 'r' and are what carry the old image.
export async function setReplicaIdentityFull(sql: SQL, schema: string): Promise<string[]> {
	const rows = await sql`
		select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
		where ns.nspname = ${schema} and c.relkind = 'r' and c.relreplident <> 'f' order by c.relname`;
	const names = rows.map((r: { relname: string }) => r.relname);
	for (const t of names) await sql.unsafe(`alter table ${q(schema)}.${q(t)} replica identity full`);
	return names;
}

export async function checkCapture(sql: SQL, n: CaptureNames): Promise<string[]> {
	const problems: string[] = [];
	const [{ wal_level }] = await sql`select current_setting('wal_level') as wal_level`;
	if (wal_level !== "logical") problems.push(`wal_level is ${wal_level}, must be logical`);

	const [slot] = await sql`select plugin from pg_replication_slots where slot_name = ${n.slot}`;
	if (!slot) problems.push(`replication slot ${n.slot} is missing`);
	else if (slot.plugin !== "pgoutput") problems.push(`replication slot ${n.slot} uses ${slot.plugin}, must be pgoutput`);

	const [pub] = await sql`select pubviaroot, pubgencols from pg_publication where pubname = ${n.publication}`;
	if (!pub) problems.push(`publication ${n.publication} is missing`);
	else {
		if (!pub.pubviaroot) problems.push(`publication ${n.publication} must set publish_via_partition_root = true`);
		if (pub.pubgencols !== "s") problems.push(`publication ${n.publication} must set publish_generated_columns = stored`);
		const [inSchema] = await sql`
			select 1 as x from pg_publication_namespace pn join pg_namespace ns on ns.oid = pn.pnnspid
			join pg_publication p on p.oid = pn.pnpubid where p.pubname = ${n.publication} and ns.nspname = ${n.schema}`;
		if (!inSchema) problems.push(`publication ${n.publication} does not cover schema ${n.schema}`);
	}

	const notFull = await sql`
		select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
		where ns.nspname = ${n.schema} and c.relkind = 'r' and c.relreplident <> 'f' order by c.relname`;
	for (const r of notFull) problems.push(`${q(n.schema)}.${q(r.relname)} is not REPLICA IDENTITY FULL`);

	const virtual = await sql`
		select c.relname, a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
		join pg_namespace ns on ns.oid = c.relnamespace
		where ns.nspname = ${n.schema} and a.attgenerated = 'v' and not a.attisdropped order by 1, 2`;
	for (const r of virtual) problems.push(`${q(n.schema)}.${q(r.relname)} has VIRTUAL generated column ${q(r.attname)}, which cannot be published`);

	for (const name of ["drizzlebase_ddl_end", "drizzlebase_ddl_drop"]) {
		const [t] = await sql`select evtenabled from pg_event_trigger where evtname = ${name}`;
		if (!t || t.evtenabled === "D") problems.push(`event trigger ${name} is missing or disabled`);
	}
	return problems;
}

export async function assertCapture(sql: SQL, n: CaptureNames): Promise<void> {
	const problems = await checkCapture(sql, n);
	if (problems.length) throw new Error(`drizzlebase cannot start, changes could be lost:\n- ${problems.join("\n- ")}`);
}

export async function dropCapture(sql: SQL, n: CaptureNames): Promise<void> {
	// A consumer that just stopped can leave the slot marked active for a moment; an active slot cannot be dropped.
	for (let i = 0; i < 50; i++) {
		const [s] = await sql`select active from pg_replication_slots where slot_name = ${n.slot}`;
		if (!s) break;
		if (!s.active) { await sql`select pg_drop_replication_slot(${n.slot})`; break; }
		await Bun.sleep(100);
	}
	await sql.unsafe(`drop publication if exists ${q(n.publication)}`);
}
