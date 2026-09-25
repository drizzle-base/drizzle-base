// A barrier is a NON-transactional logical message: the walsender decodes it at the position it was written,
// after every transaction whose commit record precedes it. Seeing barrier `id` in the stream therefore
// proves every commit before emitBarrier() returned has been delivered (spec P-A3, P-A7).
import type { SQL } from "bun";
import { BARRIER_PREFIX } from "./types";

export async function emitBarrier(sql: SQL, id: string): Promise<string> {
	const [row] = await sql`select pg_logical_emit_message(false, ${BARRIER_PREFIX}, ${id})::text as lsn`;
	return row.lsn as string;
}
