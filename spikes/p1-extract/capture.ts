// THROWAWAY SPIKE (P1) — run each case through drizzle's pg-proxy driver and capture the SQL it would send.
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "./schema";
import { cases } from "./cases";

export interface Captured { id: string; cat: string; stmts: { sql: string; params: unknown[] }[]; error?: string }

export async function captureAll(): Promise<Captured[]> {
	let sink: { sql: string; params: unknown[] }[] = [];
	const db = drizzle(async (sql, params) => { sink.push({ sql, params }); return { rows: [] }; }, { schema });
	const out: Captured[] = [];
	for (const c of cases) {
		sink = [];
		try { await c.run(db); out.push({ id: c.id, cat: c.cat, stmts: sink }); }
		catch (e) { out.push({ id: c.id, cat: c.cat, stmts: sink, error: String(e) }); }
	}
	return out;
}

if (import.meta.main) {
	for (const c of await captureAll()) {
		console.log(`\n## ${c.id}${c.error ? `  ERROR ${c.error}` : ""}`);
		for (const s of c.stmts) console.log(s.sql, JSON.stringify(s.params));
	}
}
