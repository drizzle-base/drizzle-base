// Test connections. Tests create, truncate and drop objects: they must never reach a database that is not
// named as a test database. The guard runs at import, before any connection exists.
import { SQL } from "bun";
import { type CaptureNames, dropCapture } from "../src/capture/setup";

export function assertTestDatabase(name: string): void {
	if (!name.includes("test")) throw new Error(`refusing to run tests against database "${name}": its name must contain "test"`);
}

const database = process.env.DZB_TEST_DB ?? "dzb_test";
assertTestDatabase(database);
if (!process.env.POSTGRES_PASSWORD) throw new Error("POSTGRES_PASSWORD missing: run scripts/gen-env.sh, then docker compose up -d pg");

export const pgConfig = {
	host: "127.0.0.1",
	port: Number(process.env.DZB_TEST_PORT ?? 5478),
	database,
	user: "postgres",
	password: process.env.POSTGRES_PASSWORD,
};

export function testSql(max = 4): SQL {
	return new SQL({ hostname: pgConfig.host, port: pgConfig.port, database: pgConfig.database, username: pgConfig.user, password: pgConfig.password, max });
}

// Slot, publication and schema names must be unique per test: slots are cluster-wide objects.
export function uniqueName(prefix: string): string {
	return `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

// A throwaway schema + publication + slot per test, dropped afterwards even when the test fails.
// A test that times out is abandoned without running its finally: its slot would stay behind and retain WAL
// forever. Test objects carry the owning pid in their name; anything whose pid is gone is swept.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function sweepAbandoned(sql: SQL): Promise<void> {
	const dead = (name: string) => { const pid = Number(name.split("_")[1]); return Number.isInteger(pid) && pid !== process.pid && !alive(pid); };
	for (const r of await sql`select slot_name from pg_replication_slots where slot_name ~ '^slot_[0-9]+_' and not active`)
		if (dead(r.slot_name)) await sql`select pg_drop_replication_slot(${r.slot_name})`;
	for (const r of await sql`select pubname from pg_publication where pubname ~ '^pub_[0-9]+_'`)
		if (dead(r.pubname)) await sql.unsafe(`drop publication if exists "${r.pubname}"`);
	for (const r of await sql`select nspname from pg_namespace where nspname ~ '^s_[0-9]+_'`)
		if (dead(r.nspname)) await sql.unsafe(`drop schema if exists "${r.nspname}" cascade`);
}

export async function withCaptureSchema(fn: (sql: SQL, n: CaptureNames) => Promise<void>): Promise<void> {
	const sql = testSql();
	await sweepAbandoned(sql);
	const n: CaptureNames = { schema: uniqueName("s"), publication: uniqueName("pub"), slot: uniqueName("slot") };
	await sql.unsafe(`create schema "${n.schema}"`);
	try {
		await fn(sql, n);
	} finally {
		await dropCapture(sql, n);
		await sql.unsafe(`drop schema if exists "${n.schema}" cascade`);
		await sql.close();
	}
}
