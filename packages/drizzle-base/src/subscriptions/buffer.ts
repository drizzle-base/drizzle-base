// Committed transactions recently seen in the stream — as table projections only (a 10 000-row transaction must
// not be held with its images) — kept so a query registered with an OLDER snapshot can learn about commits its
// snapshot did not see (spec D7). A transaction whose xid precedes a snapshot's xmin is visible to it and to every
// later snapshot (xmin never goes backwards), so it can be dropped once no older registration can still arrive.
import type { TxnTables } from "../readset";
import { xidPrecedes } from "./xid";

export interface Projection {
  ddl: boolean;
  changes: readonly { table: string }[];
  wholeTables: ReadonlySet<string>;
}

export function project(txn: TxnTables): Projection {
  const tables = [...new Set(txn.changes.map((c) => c.table))];
  return { ddl: txn.ddl, changes: tables.map((table) => ({ table })), wholeTables: new Set(txn.wholeTables) };
}

export class RecentCommits {
  private items: { xid: number; txn: Projection }[] = [];

  append(xid: number, txn: Projection): void {
    this.items.push({ xid, txn });
  }

  all(): readonly { xid: number; txn: Projection }[] {
    return this.items;
  }

  prune(xmin: number): number {
    const before = this.items.length;
    this.items = this.items.filter((b) => !xidPrecedes(b.xid, xmin));
    return before - this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
