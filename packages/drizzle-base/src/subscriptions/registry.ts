// Which registered read-sets a committed transaction can change. Each registration carries its snapshot's
// visibility: a transaction visible in it is already in the result (rule B) — before registration through the
// buffer replay, after it through apply(). DDL is the exception: a result's catalog lookups may predate the DDL
// even when its snapshot saw it, so DDL dirties everything. register() is synchronous: no stream event may slip
// between the insert and the replay.
import { type ReadSet, touches } from "../readset";
import type { Projection, RecentCommits } from "./buffer";
import { type Visibility, visibleIn } from "./xid";

interface Entry {
  readSet: ReadSet;
  visibility: Visibility;
}

export class Registry<K> {
  private entries = new Map<K, Entry>();
  private byTable = new Map<string, Set<K>>();
  private opaque = new Set<K>();
  private dirty = new Set<K>();

  register(key: K, readSet: ReadSet, visibility: Visibility, buffer: RecentCommits): boolean {
    this.remove(key);
    this.entries.set(key, { readSet, visibility });
    if (readSet.opaque.length) this.opaque.add(key);
    for (const t of readSet.tables) {
      let set = this.byTable.get(t);
      if (!set) {
        set = new Set();
        this.byTable.set(t, set);
      }
      set.add(key);
    }
    for (const b of buffer.all())
      if (!visibleIn(b.xid, visibility) && touches(readSet, b.txn)) {
        this.dirty.add(key);
        return true;
      }
    return false;
  }

  remove(key: K): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.opaque.delete(key);
    this.dirty.delete(key);
    for (const t of e.readSet.tables) this.byTable.get(t)?.delete(key);
  }

  apply(xid: number, txn: Projection): K[] {
    const out: K[] = [];
    if (txn.ddl) {
      for (const k of this.entries.keys()) if (!this.dirty.has(k)) out.push(k);
      for (const k of out) this.dirty.add(k);
      return out;
    }
    const candidates = new Set<K>();
    if (txn.changes.length || txn.wholeTables.size) for (const k of this.opaque) candidates.add(k);
    for (const c of txn.changes) for (const k of this.byTable.get(c.table) ?? []) candidates.add(k);
    for (const t of txn.wholeTables) for (const k of this.byTable.get(t) ?? []) candidates.add(k);
    for (const k of candidates) {
      const e = this.entries.get(k);
      if (!e || this.dirty.has(k) || visibleIn(xid, e.visibility) || !touches(e.readSet, txn)) continue;
      this.dirty.add(k);
      out.push(k);
    }
    return out;
  }

  isDirty(key: K): boolean {
    return this.dirty.has(key);
  }

  dirtyKeys(): K[] {
    return [...this.dirty];
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }

  get size(): number {
    return this.entries.size;
  }
}
