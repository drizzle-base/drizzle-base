// pgoutput messages → StreamEvents. Pure: no I/O, so every rule is unit-tested. pg-logical-replication has
// already parsed tuples and filled unchanged-TOAST ('u') columns of the NEW image from the OLD one, which is
// complete under REPLICA IDENTITY FULL (review A checked it).
import type { Pgoutput } from "pg-logical-replication";
import { BARRIER_PREFIX, type Change, DDL_PREFIX, type StreamEvent } from "./types";

interface Open {
	xid: number;
	commitLsn: string;
	changes: Change[];
	wholeTables: Set<string>;
	ddl: boolean;
}

const tableOf = (r: Pgoutput.MessageRelation) => `${r.schema}.${r.name}`;
// The reader decodes xid and relation OID with readInt32; both are unsigned 32-bit in Postgres (`>>> 0`).
const decoder = new TextDecoder();

export class TxnAssembler {
	private open: Open | null = null;

	constructor(private readonly rowCap: number) {}

	feed(msg: Pgoutput.Message): StreamEvent | null {
		switch (msg.tag) {
			case "begin":
				this.open = { xid: msg.xid >>> 0, commitLsn: msg.commitLsn ?? "", changes: [], wholeTables: new Set(), ddl: false };
				return null;
			case "insert":
				this.add(msg.relation, "insert", null, msg.new);
				return null;
			case "update":
				this.add(msg.relation, "update", msg.old, msg.new);
				return null;
			case "delete":
				this.add(msg.relation, "delete", msg.old, null);
				return null;
			case "truncate": {
				const o = this.need("truncate");
				for (const r of msg.relations) o.wholeTables.add(tableOf(r));
				return null;
			}
			case "message": {
				if (msg.prefix === BARRIER_PREFIX && !msg.transactional)
					return { kind: "barrier", id: decoder.decode(msg.content), lsn: msg.messageLsn ?? "" };
				if (msg.prefix === DDL_PREFIX && msg.transactional) this.need("ddl message").ddl = true;
				return null;
			}
			case "commit": {
				const o = this.need("commit");
				this.open = null;
				return {
					kind: "txn",
					txn: { xid: o.xid, commitLsn: o.commitLsn, commitEndLsn: msg.commitEndLsn ?? "", changes: o.changes, wholeTables: o.wholeTables, ddl: o.ddl },
				};
			}
			default:
				return null; // relation, type, origin: metadata the parser already applied
		}
	}

	private need(what: string): Open {
		if (!this.open) throw new Error(`pgoutput ${what} outside a transaction`);
		return this.open;
	}

	private add(rel: Pgoutput.MessageRelation, op: Change["op"], old: Record<string, unknown> | null, next: Record<string, unknown> | null): void {
		const o = this.need(op);
		const table = tableOf(rel);
		const missingOld = op !== "insert" && (rel.replicaIdentity !== "full" || old === null);
		if (missingOld || o.changes.length >= this.rowCap) {
			o.wholeTables.add(table);
			return;
		}
		if (o.wholeTables.has(table)) return; // already table-level: its row images add nothing
		o.changes.push({ table, relOid: rel.relationOid >>> 0, op, old, new: next });
	}
}
