// REVIEW-A probe: what does pgoutput (via pg_logical_slot_get_binary_changes, proto 1) actually deliver?
// Run from spikes/p2-capture (bun loads .env): bun ../review-a/pgoutput.ts
import { SQL } from "bun";

if (!process.env.PGPASSWORD) throw new Error("run from spikes/p2-capture");
const db = new SQL({ hostname: "127.0.0.1", port: 5477, database: "spike", username: "postgres", password: process.env.PGPASSWORD, max: 2 });
const SLOT = "review_a_slot";

// ── minimal pgoutput v1 decoder ─────────────────────────────────────────────
const rels = new Map<number, { name: string; cols: { name: string; type: number }[] }>();
function decode(buf: Uint8Array): string {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let p = 0;
	const u8 = () => dv.getUint8(p++);
	const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
	const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
	const u64 = () => { const v = dv.getBigUint64(p); p += 8; return v; };
	const str = () => { let e = p; while (buf[e] !== 0) e++; const s = new TextDecoder().decode(buf.subarray(p, e)); p = e + 1; return s; };
	const tuple = (rel: number) => {
		const n = u16();
		const out: string[] = [];
		for (let i = 0; i < n; i++) {
			const k = String.fromCharCode(u8());
			const name = rels.get(rel)?.cols[i]?.name ?? `c${i}`;
			if (k === "n") out.push(`${name}=NULL`);
			else if (k === "u") out.push(`${name}=<UNCHANGED-TOAST>`);
			else { const len = u32(); const v = new TextDecoder().decode(buf.subarray(p, p + len)); p += len; out.push(`${name}=${v.length > 40 ? `${v.slice(0, 12)}…(${v.length} chars)` : v}`); }
		}
		return `{${out.join(", ")}}`;
	};
	const t = String.fromCharCode(u8());
	switch (t) {
		case "B": { u64(); u64(); return `BEGIN xid=${u32()}`; }
		case "C": return "COMMIT";
		case "R": {
			const oid = u32(); const ns = str(); const name = str(); const ri = String.fromCharCode(u8()); const n = u16();
			const cols = [];
			for (let i = 0; i < n; i++) { u8(); const cn = str(); const ty = u32(); u32(); cols.push({ name: cn, type: ty }); }
			rels.set(oid, { name: `${ns}.${name}`, cols });
			return `RELATION ${ns}.${name} oid=${oid} ri=${ri} cols=[${cols.map((c) => `${c.name}:${c.type}`).join(",")}]`;
		}
		case "I": { const r = u32(); u8(); return `INSERT ${rels.get(r)?.name} new=${tuple(r)}`; }
		case "U": {
			const r = u32(); let k = String.fromCharCode(u8()); let old = "";
			if (k === "K" || k === "O") { old = ` old(${k})=${tuple(r)}`; k = String.fromCharCode(u8()); }
			return `UPDATE ${rels.get(r)?.name}${old} new=${tuple(r)}`;
		}
		case "D": { const r = u32(); const k = String.fromCharCode(u8()); return `DELETE ${rels.get(r)?.name} old(${k})=${tuple(r)}`; }
		case "T": { const n = u32(); const opt = u8(); const ids = []; for (let i = 0; i < n; i++) ids.push(rels.get(u32())?.name ?? "?"); return `TRUNCATE opts=${opt} rels=${ids.join(",")}`; }
		default: return `MSG ${t}`;
	}
}
async function drain(label: string) {
	const rows = await db`select lsn::text, xid::text, data from pg_logical_slot_get_binary_changes(${SLOT}, null, null, 'proto_version', '1', 'publication_names', 'review_a_pub')`;
	console.log(`── ${label}: ${rows.length} messages`);
	for (const r of rows) console.log(`   [slot xid col=${r.xid}] ${decode(r.data as Uint8Array)}`);
}

await db.unsafe(`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = '${SLOT}'`);
await db.unsafe(`drop publication if exists review_a_pub;
drop table if exists ra_toast, ra_gen, ra_part, ra_other, ra_alter cascade;
create table ra_toast(id int primary key, small int, big text);
create table ra_gen(id int primary key, a int, s int generated always as (a * 10) stored);
create table ra_part(id int, region text, primary key(id, region)) partition by list(region);
create table ra_part_br partition of ra_part for values in ('br');
create table ra_other(id int primary key);
create table ra_alter(id int primary key, v numeric);
alter table ra_toast replica identity full; alter table ra_gen replica identity full; alter table ra_part replica identity full;
alter table ra_part_br replica identity full; alter table ra_alter replica identity full;
insert into ra_alter values (1, 1.4), (2, 2.6);
insert into ra_toast values (1, 1, (select string_agg(md5(g::text), '') from generate_series(1, 400) g));
create publication review_a_pub for table ra_toast, ra_gen, ra_part, ra_alter with (publish_generated_columns = stored);`);
await db.unsafe(`select pg_create_logical_replication_slot('${SLOT}', 'pgoutput')`);

// 1. TOAST: update a non-toasted column of a row whose `big` is out of line
await db.unsafe(`update ra_toast set small = 2 where id = 1`);
await drain("1. update small col of a toasted row (REPLICA IDENTITY FULL)");

// 2. generated columns: stored and PG18 virtual
await db.unsafe(`insert into ra_gen(id, a) values (1, 1); update ra_gen set a = 2 where id = 1`);
await drain("2. stored generated column, publish_generated_columns=stored (virtual: UPDATE/DELETE refused, see review)");

// 3. partitioned table: which relation do changes arrive under?
await db.unsafe(`insert into ra_part values (1, 'br')`);
await drain("3. insert into partitioned ra_part (publish_via_partition_root default)");

// 4. a transaction with an xid but no published change (read-your-writes needs to see it pass)
const [{ x }] = await db.begin(async (tx) => { const r = await tx`select pg_current_xact_id()::text as x`; await tx`insert into ra_other values (1)`; return r; });
await drain(`4. mutation xid=${x} writing only an unpublished table`);
const [{ y }] = await db.begin(async (tx) => tx`select pg_current_xact_id()::text as y`);
await drain(`4b. mutation xid=${y} with no writes at all`);

// 5. savepoints: first write inside a subtransaction — which xid does BEGIN carry?
const [{ top }] = await db.begin(async (tx) => {
	await tx.unsafe(`savepoint s1; insert into ra_gen(id, a) values (2, 2); release savepoint s1`);
	return tx`select pg_current_xact_id()::text as top`;
});
await drain(`5. write inside a savepoint; top-level xid = ${top}`);

// 6. ALTER COLUMN TYPE with a rewrite that CHANGES values, no DML
await db.unsafe(`alter table ra_alter alter column v type int using (v * 10)::int`);
await drain("6. ALTER COLUMN TYPE … USING (rewrites every row's value)");
console.log("   ra_alter now:", JSON.stringify(await db`select * from ra_alter order by id`));

// 7. relation messages: are they re-sent on every poll (each SQL call is a new decoding session)?
await db.unsafe(`update ra_toast set small = 3 where id = 1`);
await drain("7a. a second poll touching ra_toast");
await db.unsafe(`update ra_toast set small = 4 where id = 1`);
await drain("7b. a third poll touching ra_toast");

// 8. TRUNCATE with cascade semantics
await db.unsafe(`truncate ra_toast`);
await drain("8. truncate");

await db.unsafe(`select pg_drop_replication_slot('${SLOT}'); drop publication review_a_pub`);
await db.close();
process.exit(0);
