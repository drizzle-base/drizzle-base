// What the capture layer hands to the rest of drizzlebase: committed transactions in commit order, and
// barriers. A barrier is a non-transactional logical message: it is decoded at the WAL position where it was
// written, so every transaction whose commit record precedes it has already been delivered (spec P-A3).
export type Row = Record<string, unknown>;

export interface Change {
	table: string; // "<schema>.<name>"; the partition root when publish_via_partition_root is on
	relOid: number;
	op: "insert" | "update" | "delete";
	old: Row | null;
	new: Row | null;
}

export interface CapturedTxn {
	xid: number; // 32-bit: compare modulo 2^32 against a snapshot (spec P-M5), never widen with an epoch
	commitLsn: string;
	commitEndLsn: string; // what is acknowledged to the server once the transaction is applied
	changes: Change[];
	// Tables whose changes must invalidate at TABLE level: truncated, over the row cap, or changed without an
	// old image (a relation that is not REPLICA IDENTITY FULL). Invariant 1: widen, never drop.
	wholeTables: Set<string>;
	ddl: boolean; // carried a drizzlebase.ddl message: invalidate everything, recycle the pool (spec P-M1)
}

export type StreamEvent = { kind: "txn"; txn: CapturedTxn } | { kind: "barrier"; id: string; lsn: string };

export const BARRIER_PREFIX = "drizzlebase.barrier";
export const DDL_PREFIX = "drizzlebase.ddl";
