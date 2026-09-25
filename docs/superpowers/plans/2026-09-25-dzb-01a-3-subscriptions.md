# DZB-01a-3 — Subscriptions: registration, the flush cycle, the shared cache, read-your-writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `SubscriptionEngine` that keeps every subscribed query's value current: it consumes the capture stream, marks exactly the subscriptions a committed transaction can change (table level, 01a), re-runs them in flush cycles under ONE exported snapshot, pushes consistent batches, shares one entry per (function, args), and lets a mutation return only once its effect has been pushed.

**Architecture:** Three pure pieces — 32-bit xid visibility (`xid.ts`), the recent-commits buffer (`buffer.ts`), the read-set index (`registry.ts`) — and the engine (`engine.ts`) that wires them to the runtime and the stream. A cycle: export a snapshot S → emit a barrier and wait for it in the stream (every commit visible in S has then been applied) → re-run the dirty entries in S, one transaction per connection → re-register each with S (replaying the buffer, which re-dirties what S did not see) → push the changed values as one batch → prune the buffer.

**Tech Stack:** existing (Bun.sql, drizzle-orm 0.45.3, libpg-query, pg-logical-replication), Postgres 18.6.

**Spec:** `docs/specs/DZB-01-foundation.md` — POST-REVIEW block: D7 (xid visibility), D8 + P-A3 (one exported snapshot per cycle, a stream barrier), P-A4 (buffer pruning), P-A7 (read-your-writes by position, decoupled from the flush), P-M5 (32-bit comparison), P-M10 (one transaction per connection per cycle), D10 (the cache), P-M1 (DDL → `Catalog.clear()` + re-run everything), P-M6 (capture failure drops every subscription), RA-B1 (append to the buffer before matching, no await).

## Global Constraints

- Module `src/subscriptions/`, entered through `index.ts`; LAYERS already allow it `sql, capture, readset, runtime`. Not exported from `drizzle-base/server` yet (01a-4's server wires it).
- **Rule B, everywhere:** a streamed transaction is reflected in a result iff its xid is visible in that result's snapshot. Compared modulo 2^32 (`((a - b) | 0) < 0`), never widened with an epoch.
- **No await** between inserting a read-set into the index and replaying the buffer against it; `onEvent` is synchronous from start to end.
- **The buffer is pruned only while no fresh query is in flight**, and only below the minimum `xmin` of the cycle's snapshot (every later snapshot has an xmin at least as large). It never empties because "nothing is registered".
- **A barrier is matched by id AND by LSN** (`lsnToBigInt` on both sides: Postgres prints `1/343C4E8`, the replication library `00000001/0343C4E8` — probed). A forged barrier with the right id but another LSN is ignored.
- **A cycle's pushes are delivered only after every re-run of that cycle finished**, all from one snapshot.
- A mutation's `mutate()` resolves after a cycle that **started after its commit** has delivered its pushes.
- Snapshot ids interpolated into `SET TRANSACTION SNAPSHOT` are validated against `^[0-9A-F]+-[0-9A-F]+-[0-9]+$`.
- Tests: TDD, each property with a sabotage that turns it red; a case whose premise did not happen is vacuous. `bun run check` and `bun run test` green. Branch `feat/dzb-01a-3-subscriptions`.

## Review Focus

1. **A subscription created while writes are committing** — its result must converge to the database once writes stop, whatever the interleaving. (Task 6: `every subscription converges after the writes stop`.)
2. **Two queries on one screen** — a batch never shows a list and its count from different points in time. (Task 6: `one cycle's pushes come from one snapshot`.)
3. **A handler that throws** — it must not poison the cycle's other re-runs nor loop forever. (Task 3: `a failing call does not break the others`; Task 4: `a query that throws is reported and stays registered`.)
4. **Many subscribers to one query** — one re-run per cycle, not one per subscriber; a volatile query is never shared. (Task 4.)
5. **The capture dies** — every subscriber learns it (reset), nothing stale is served. (Task 7.)

---

## File Structure

```
packages/drizzle-base/
  src/capture/lsn.ts                 lsnToBigInt (export from capture/index.ts)
  src/runtime/runtime.ts             + runInSnapshot(snapshotId, calls)
  src/subscriptions/xid.ts           low32, xidPrecedes, visibilityOf, visibleIn
  src/subscriptions/buffer.ts        RecentCommits
  src/subscriptions/registry.ts      Registry<K>
  src/subscriptions/stable.ts        stableHash (value → string, for "did the result change")
  src/subscriptions/engine.ts        SubscriptionEngine
  src/subscriptions/index.ts         barrel
  test/subscriptions/unit/{xid,buffer,registry,stable}.test.ts
  test/runtime/integration/snapshot.test.ts
  test/subscriptions/integration/{engine,ryw,properties,reset}.test.ts
  test/support/engine.ts             withEngine(): app + capture + runtime + engine, wired and torn down
  load/subscriptions/reactive_latency.ts
```

---

### Task 1: xid visibility, LSN comparison, the buffer (pure)

**Files:** Create `src/capture/lsn.ts`, `src/subscriptions/xid.ts`, `src/subscriptions/buffer.ts`, `src/subscriptions/index.ts` (initial barrel); modify `src/capture/index.ts`. Test: `test/subscriptions/unit/xid.test.ts`, `test/subscriptions/unit/buffer.test.ts`.

**Interfaces — produces:**
```ts
function lsnToBigInt(lsn: string): bigint;                         // "1/343C4E8" and "00000001/0343C4E8" → same value
function low32(x: bigint): number;
function xidPrecedes(a: number, b: number): boolean;               // TransactionIdPrecedes, modulo 2^32
interface Visibility { xmin: number; xmax: number; xip: ReadonlySet<number> }
function visibilityOf(s: Snapshot): Visibility;                    // Snapshot from ../runtime
function visibleIn(xid: number, v: Visibility): boolean;
interface Buffered { xid: number; txn: TxnTables }
class RecentCommits { append(xid: number, txn: TxnTables): void; all(): readonly Buffered[]; prune(xmin: number): number; get size(): number }
```

- [ ] **Step 1: Branch; write the failing tests**

```bash
cd ~/www/drizzlebase && git checkout -b feat/dzb-01a-3-subscriptions
```

`test/subscriptions/unit/xid.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { lsnToBigInt } from "../../../src/capture";
import { low32, visibleIn, xidPrecedes } from "../../../src/subscriptions";

const vis = (xmin: number, xmax: number, xip: number[] = []) => ({ xmin, xmax, xip: new Set(xip) });

describe("xid visibility (rule B)", () => {
  test("before xmin: visible; at or after xmax: not; in between: visible unless running", () => {
    const v = vis(100, 110, [103, 107]);
    expect(visibleIn(99, v)).toBe(true);
    expect(visibleIn(100, vis(100, 110, [100]))).toBe(false); // xmin is itself the oldest running xid
    expect(visibleIn(103, v)).toBe(false);
    expect(visibleIn(105, v)).toBe(true);
    expect(visibleIn(110, v)).toBe(false);
    expect(visibleIn(200, v)).toBe(false);
  });

  test("across the 2^32 wraparound, compared modulo 2^32", () => {
    const xmin = 0xffff_fff0, xmax = 0x0000_0010; // the snapshot spans the wrap
    const v = vis(xmin, xmax, [0x0000_0005]);
    expect(visibleIn(0xffff_ffe0, v)).toBe(true); // just before xmin
    expect(visibleIn(0xffff_fff8, v)).toBe(true); // between xmin and the wrap, not running
    expect(visibleIn(0x0000_0003, v)).toBe(true); // after the wrap, before xmax
    expect(visibleIn(0x0000_0005, v)).toBe(false); // running
    expect(visibleIn(0x0000_0020, v)).toBe(false); // after xmax
    expect(xidPrecedes(0xffff_fff0, 0x0000_0010)).toBe(true);
    expect(xidPrecedes(0x0000_0010, 0xffff_fff0)).toBe(false);
  });

  test("low32 truncates an xid8", () => {
    expect(low32((5n << 32n) + 42n)).toBe(42);
  });
});

describe("lsnToBigInt", () => {
  test("Postgres's and the replication library's spellings are the same position", () => {
    expect(lsnToBigInt("1/343C4E8")).toBe(lsnToBigInt("00000001/0343C4E8"));
    expect(lsnToBigInt("0/10")).toBeLessThan(lsnToBigInt("0/11"));
    expect(lsnToBigInt("1/0")).toBeGreaterThan(lsnToBigInt("0/FFFFFFFF"));
  });
});
```

`test/subscriptions/unit/buffer.test.ts`:
```ts
import { expect, test } from "bun:test";
import { RecentCommits } from "../../../src/subscriptions";

const txn = (table: string) => ({ ddl: false, changes: [{ table }], wholeTables: new Set<string>() });

test("prune drops only transactions that precede the given xmin (modulo 2^32), and keeps order", () => {
  const b = new RecentCommits();
  for (const x of [98, 99, 100, 101]) b.append(x, txn(`t${x}`));
  expect(b.prune(100)).toBe(2);
  expect(b.all().map((e) => e.xid)).toEqual([100, 101]);
});

test("prune across the wraparound", () => {
  const b = new RecentCommits();
  b.append(0xffff_fff0, txn("a"));
  b.append(0x0000_0002, txn("b"));
  expect(b.prune(0x0000_0001)).toBe(1);
  expect(b.all().map((e) => e.xid)).toEqual([2]);
});
```

- [ ] **Step 2: Run — expect FAIL** — `cd packages/drizzle-base && bun test test/subscriptions/unit` → cannot resolve `../../../src/subscriptions`.

- [ ] **Step 3: Implement**

`src/capture/lsn.ts`:
```ts
// A WAL position as a number. Postgres prints "1/343C4E8"; pg-logical-replication zero-pads to
// "00000001/0343C4E8" — compared as strings the same barrier would never match (probed).
export function lsnToBigInt(lsn: string): bigint {
  const [hi = "0", lo = "0"] = lsn.split("/");
  return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
}
```
Append `export { lsnToBigInt } from "./lsn";` to `src/capture/index.ts`.

`src/subscriptions/xid.ts`:
```ts
// Rule B (spec D7): a streamed transaction is reflected in a result iff its xid is visible in the result's
// snapshot. The stream's xids are 32-bit; pg_current_snapshot() is xid8. Both are compared modulo 2^32, as
// Postgres's TransactionIdPrecedes does — live xids are within 2^31 of each other, so the signed 32-bit difference
// orders them (spec P-M5). Widening a 32-bit xid with an epoch read at another time misorders it across a wrap.
import type { Snapshot } from "../runtime";

const U32 = 2n ** 32n;

export const low32 = (x: bigint): number => Number(x % U32);

export function xidPrecedes(a: number, b: number): boolean {
  return ((a - b) | 0) < 0;
}

export interface Visibility {
  xmin: number;
  xmax: number;
  xip: ReadonlySet<number>;
}

export function visibilityOf(s: Snapshot): Visibility {
  return { xmin: low32(s.xmin), xmax: low32(s.xmax), xip: new Set(s.xip.map(low32)) };
}

export function visibleIn(xid: number, v: Visibility): boolean {
  if (xidPrecedes(xid, v.xmin)) return true; // finished before the oldest transaction the snapshot saw running
  if (!xidPrecedes(xid, v.xmax)) return false; // not yet started when the snapshot was taken
  return !v.xip.has(xid); // in between: visible unless it was still running
}
```

`src/subscriptions/buffer.ts`:
```ts
// Committed transactions recently seen in the stream, kept so a query registered with an OLDER snapshot can learn
// about commits its snapshot did not see (spec D7). A transaction whose xid precedes a snapshot's xmin is visible
// to that snapshot and to every later one, so it can go — the engine passes the smallest xmin any registration
// could still use, and never prunes while a fresh query's snapshot is unknown (spec P-A4).
import type { TxnTables } from "../readset";
import { xidPrecedes } from "./xid";

export interface Buffered {
  xid: number;
  txn: TxnTables;
}

export class RecentCommits {
  private items: Buffered[] = [];

  append(xid: number, txn: TxnTables): void {
    this.items.push({ xid, txn });
  }

  all(): readonly Buffered[] {
    return this.items;
  }

  prune(xmin: number): number {
    const before = this.items.length;
    this.items = this.items.filter((b) => !xidPrecedes(b.xid, xmin));
    return before - this.items.length;
  }

  get size(): number {
    return this.items.length;
  }
}
```

`src/subscriptions/index.ts`:
```ts
export { type Buffered, RecentCommits } from "./buffer";
export { low32, type Visibility, visibilityOf, visibleIn, xidPrecedes } from "./xid";
```

- [ ] **Step 4: Run — expect PASS**; typecheck clean.
- [ ] **Step 5: Sabotage** — replace `((a - b) | 0) < 0` with `a < b`: the wraparound test goes red; restore with `cp`.
- [ ] **Step 6: Commit** `feat(dzb-01a-3): xid visibility modulo 2^32, LSN comparison, the recent-commits buffer`.

---

### Task 2: The read-set index (pure)

**Files:** Create `src/subscriptions/registry.ts`, `src/subscriptions/stable.ts`; extend the barrel. Test: `test/subscriptions/unit/registry.test.ts`, `test/subscriptions/unit/stable.test.ts`.

**Interfaces — produces:**
```ts
class Registry<K> {
  register(key: K, readSet: ReadSet, visibility: Visibility, buffer: RecentCommits): boolean; // true = dirty from birth
  remove(key: K): void;
  apply(xid: number, txn: TxnTables): K[];      // newly dirty keys
  markAllDirty(): K[];
  dirtyKeys(): K[];
  has(key: K): boolean;
  get size(): number;
}
function stableHash(value: unknown): string;     // equal iff the pushed value would be equal
```

- [ ] **Step 1: Failing tests**

`test/subscriptions/unit/registry.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { ReadSet } from "../../../src/readset";
import { RecentCommits, Registry } from "../../../src/subscriptions";

const rs = (tables: string[], opaque: string[] = []): ReadSet => ({ tables: new Set(tables), opaque, volatile: [] });
const txn = (tables: string[], ddl = false) => ({ ddl, changes: tables.map((table) => ({ table })), wholeTables: new Set<string>() });
const vis = (xmin: number, xmax: number, xip: number[] = []) => ({ xmin, xmax, xip: new Set(xip) });

describe("Registry", () => {
  test("a transaction marks the subscriptions whose tables it changed — unless their snapshot already saw it", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("posts", rs(["app.posts"]), vis(100, 105), b);
    r.register("users", rs(["app.users"]), vis(100, 105), b);
    expect(r.apply(99, txn(["app.posts"]))).toEqual([]); // visible in the snapshot: already reflected
    expect(r.apply(107, txn(["app.posts"]))).toEqual(["posts"]);
    expect(r.apply(108, txn(["app.posts"]))).toEqual([]); // already dirty: not "newly"
    expect(r.dirtyKeys()).toEqual(["posts"]);
  });

  test("an opaque read-set is touched by any change; DDL touches everything", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("view", rs([], ["view app.v"]), vis(100, 100), b);
    r.register("posts", rs(["app.posts"]), vis(100, 100), b);
    expect(r.apply(120, txn(["app.other"]))).toEqual(["view"]);
    expect(r.apply(121, txn([], true)).sort()).toEqual(["posts"]);
  });

  test("registration replays the buffer: a commit the snapshot did not see makes it dirty from birth", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    b.append(103, txn(["app.posts"])); // running when the snapshot was taken
    b.append(90, txn(["app.posts"])); // visible to it
    expect(r.register("a", rs(["app.posts"]), vis(100, 110, [103]), b)).toBe(true);
    expect(r.register("b", rs(["app.users"]), vis(100, 110, [103]), b)).toBe(false);
  });

  test("re-registering clears the dirty bit and replaces the read-set; remove forgets it", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("q", rs(["app.posts"]), vis(100, 100), b);
    r.apply(150, txn(["app.posts"]));
    r.register("q", rs(["app.users"]), vis(160, 160), b);
    expect(r.dirtyKeys()).toEqual([]);
    expect(r.apply(170, txn(["app.posts"]))).toEqual([]); // no longer reads posts
    r.remove("q");
    expect(r.apply(171, txn(["app.users"]))).toEqual([]);
    expect(r.size).toBe(0);
  });
});
```

`test/subscriptions/unit/stable.test.ts`:
```ts
import { expect, test } from "bun:test";
import { stableHash } from "../../../src/subscriptions";

test("key order does not matter; values, dates and bigints do", () => {
  expect(stableHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stableHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  expect(stableHash(new Date(0))).not.toBe(stableHash(new Date(1)));
  expect(stableHash({ n: 1n })).not.toBe(stableHash({ n: 2n }));
  expect(stableHash([1, 2])).not.toBe(stableHash([2, 1])); // array order is part of the result
  expect(stableHash(undefined)).toBe(stableHash(null));
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

`src/subscriptions/registry.ts`:
```ts
// Which registered read-sets a committed transaction can change. Keys are cache entries. Each registration
// carries its snapshot's visibility: a transaction visible in it is already in the result (rule B), whether it
// reaches us before or after the registration — before, through the buffer replay in register(); after, through
// apply(). register() is synchronous on purpose: no stream event may slip between the insert and the replay.
import { type ReadSet, type TxnTables, touches } from "../readset";
import type { RecentCommits } from "./buffer";
import { type Visibility, visibleIn } from "./xid";

interface Entry {
  readSet: ReadSet;
  visibility: Visibility;
  dirty: boolean;
}

export class Registry<K> {
  private entries = new Map<K, Entry>();
  private byTable = new Map<string, Set<K>>();
  private opaque = new Set<K>();

  register(key: K, readSet: ReadSet, visibility: Visibility, buffer: RecentCommits): boolean {
    this.remove(key);
    const e: Entry = { readSet, visibility, dirty: false };
    this.entries.set(key, e);
    if (readSet.opaque.length) this.opaque.add(key);
    for (const t of readSet.tables) {
      let set = this.byTable.get(t);
      if (!set) this.byTable.set(t, (set = new Set()));
      set.add(key);
    }
    for (const b of buffer.all())
      if (!visibleIn(b.xid, visibility) && touches(readSet, b.txn)) {
        e.dirty = true;
        break;
      }
    return e.dirty;
  }

  remove(key: K): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.opaque.delete(key);
    for (const t of e.readSet.tables) this.byTable.get(t)?.delete(key);
  }

  apply(xid: number, txn: TxnTables): K[] {
    const candidates = new Set<K>();
    if (txn.ddl) for (const k of this.entries.keys()) candidates.add(k);
    else {
      if (txn.changes.length || txn.wholeTables.size) for (const k of this.opaque) candidates.add(k);
      for (const c of txn.changes) for (const k of this.byTable.get(c.table) ?? []) candidates.add(k);
      for (const t of txn.wholeTables) for (const k of this.byTable.get(t) ?? []) candidates.add(k);
    }
    const out: K[] = [];
    for (const k of candidates) {
      const e = this.entries.get(k)!;
      if (e.dirty || visibleIn(xid, e.visibility) || !touches(e.readSet, txn)) continue;
      e.dirty = true;
      out.push(k);
    }
    return out;
  }

  markAllDirty(): K[] {
    for (const e of this.entries.values()) e.dirty = true;
    return [...this.entries.keys()];
  }

  dirtyKeys(): K[] {
    return [...this.entries].filter(([, e]) => e.dirty).map(([k]) => k);
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
```

`src/subscriptions/stable.ts`:
```ts
// "Did the result change?" — a push is sent only when it did. Object key order is not part of a result; array order,
// dates and bigints are. undefined and null push the same JSON, so they hash the same.
export function stableHash(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
```
Barrel: add `export { Registry } from "./registry";` and `export { stableHash } from "./stable";`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Sabotage one at a time** — (a) drop the `visibleIn(xid, e.visibility)` check in `apply`: the first test goes red; (b) remove the buffer replay loop in `register`: the replay test goes red. Restore with `cp`.
- [ ] **Step 6: Commit** `feat(dzb-01a-3): the read-set index — rule B on apply and on registration, DDL and opaque, stableHash`.

---

### Task 3: Queries in an imported snapshot (runtime)

**Files:** Modify `src/runtime/runtime.ts` (+ `index.ts` exports). Test: `test/runtime/integration/snapshot.test.ts`.

**Interfaces — produces:**
```ts
type SnapshotCall<S> = (ctx: Ctx<S>) => Promise<unknown>;
type SnapshotResult = { ok: true; value: unknown; readSet: ReadSet } | { ok: false; error: unknown; readSet: ReadSet };
Runtime.runInSnapshot(snapshotId: string, calls: SnapshotCall<S>[]): Promise<SnapshotResult[]>
```
One reserved connection, one `REPEATABLE READ READ ONLY` transaction that imports the snapshot (P-M10); each call inside its own savepoint so a failing handler cannot abort the others; each call's read-set is resolved on that connection (even for a failing call: what it read before failing).

- [ ] **Step 1: Failing test**

`test/runtime/integration/snapshot.test.ts`:
```ts
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Runtime } from "../../../src/runtime";
import { posts, schema, users, withApp } from "../../support/app";

test("calls see the exported snapshot, not a commit made after it", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    const ex = await pool.reserve();
    try {
      await ex.unsafe("begin isolation level repeatable read read only");
      const [{ id }] = await ex.unsafe("select pg_export_snapshot() as id");
      await pool.unsafe(`insert into dzb_app.users(name) values ('after export')`);
      const [a, b] = await rt.runInSnapshot(id as string, [
        async (ctx) => (await ctx.db.select().from(users)).length,
        async (ctx) => (await ctx.db.select().from(posts)).length,
      ]);
      expect(a).toMatchObject({ ok: true, value: 0 });
      expect(b).toMatchObject({ ok: true, value: 0 });
      if (a?.ok) expect([...a.readSet.tables]).toEqual(["dzb_app.users"]);
    } finally {
      await ex.unsafe("commit");
      ex.release();
    }
  });
});

test("a failing call does not break the others, and reports what it read", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    const ex = await pool.reserve();
    try {
      await ex.unsafe("begin isolation level repeatable read read only");
      const [{ id }] = await ex.unsafe("select pg_export_snapshot() as id");
      const [bad, good] = await rt.runInSnapshot(id as string, [
        async (ctx) => {
          await ctx.db.select().from(users);
          await ctx.db.execute(sql`select 1/0`);
        },
        async (ctx) => (await ctx.db.select().from(posts)).length,
      ]);
      expect(bad?.ok).toBe(false);
      expect([...(bad?.readSet.tables ?? [])]).toEqual(["dzb_app.users"]);
      expect(good).toMatchObject({ ok: true, value: 0 });
    } finally {
      await ex.unsafe("commit");
      ex.release();
    }
  });
});

test("a snapshot id that is not one is refused before reaching Postgres", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await expect(rt.runInSnapshot("x'; drop table dzb_app.users; --", [])).rejects.toThrow(/snapshot id/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`runInSnapshot` is not a function).
- [ ] **Step 3: Implement** — in `src/runtime/runtime.ts` add the types and the method:

```ts
export type SnapshotCall<S extends Record<string, unknown>> = (ctx: Ctx<S>) => Promise<unknown>;
export type SnapshotResult =
  | { ok: true; value: unknown; readSet: ReadSet }
  | { ok: false; error: unknown; readSet: ReadSet };

const SNAPSHOT_ID = /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/i;
```
and inside `class Runtime`:
```ts
  // Re-runs for one flush cycle (spec D8, P-M10): ONE transaction on ONE connection imports the cycle's exported
  // snapshot and runs every call in it, each inside a savepoint so a throwing handler cannot abort the others.
  async runInSnapshot(snapshotId: string, calls: SnapshotCall<S>[]): Promise<SnapshotResult[]> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw new Error(`not a snapshot id: ${JSON.stringify(snapshotId)}`);
    await loadParser();
    const conn = await this.opts.sql.reserve();
    const results: SnapshotResult[] = [];
    try {
      await conn.unsafe("begin isolation level repeatable read read only");
      try {
        await conn.unsafe(`set transaction snapshot '${snapshotId}'`);
        const [{ sp }] = await conn.unsafe("select current_setting('search_path') as sp");
        for (const call of calls) {
          const client = new CapturingClient(conn, "query");
          await conn.unsafe("savepoint dzb_call");
          let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
          try {
            outcome = { ok: true, value: await call(this.ctx(client)) };
            await conn.unsafe("release savepoint dzb_call");
          } catch (error) {
            await conn.unsafe("rollback to savepoint dzb_call");
            outcome = { ok: false, error };
          } finally {
            client.close();
          }
          const readSet = await readSetOf(client.statements, this.catalog, conn, sp as string);
          results.push({ ...outcome, readSet });
        }
        await conn.unsafe("commit");
        return results;
      } catch (e) {
        await conn.unsafe("rollback").catch(() => {});
        throw e;
      }
    } finally {
      try {
        conn.release();
      } catch {
        // a terminated connection may refuse release
      }
    }
  }
```
Export `type SnapshotCall, type SnapshotResult` from `src/runtime/index.ts`.

- [ ] **Step 4: Run — expect PASS**; typecheck.
- [ ] **Step 5: Sabotage** — remove the `set transaction snapshot` line: the first test goes red (sees the later insert). Restore.
- [ ] **Step 6: Commit** `feat(dzb-01a-3): runInSnapshot — a cycle's re-runs in one imported-snapshot transaction, one savepoint per call`.

---

### Task 4: The engine — subscribe, the cycle, the cache

**Files:** Create `src/subscriptions/engine.ts`, `test/support/engine.ts`; extend the barrel. Test: `test/subscriptions/integration/engine.test.ts`.

**Interfaces — produces:**
```ts
type EngineEvent<R> =
  | { kind: "value"; cycle: number; value: R }
  | { kind: "error"; cycle: number; error: unknown }
  | { kind: "reset"; reason: string };
interface EngineStats { cycles: number; reruns: number; uselessReruns: number; pushes: number }
class SubscriptionEngine<S extends Record<string, unknown>> {
  constructor(opts: { runtime: Runtime<S>; sql: SQL; connections?: number; onError?: (e: unknown) => void });
  subscribe<A, R>(name: string, def: QueryDef<S, A, R>, args: A, listener: (e: EngineEvent<R>) => void): Promise<() => void>;
  onEvent(e: StreamEvent): void;                     // synchronous
  flush(): Promise<number>;                          // run (or join) a cycle that starts after this call; resolves with its id after its pushes
  mutate<A, R>(def: MutationDef<S, A, R>, args: A): Promise<{ value: R; cycle: number }>;   // Task 5
  reset(reason: string): void;                       // Task 7
  readonly stats: EngineStats;
  close(): void;
}
// test/support/engine.ts
function withEngine(fn: (h: { sql: SQL; names: CaptureNames; runtime: Runtime<typeof schema>; engine: SubscriptionEngine<typeof schema> }) => Promise<void>, opts?: { connections?: number }): Promise<void>;
function nextEvent<R>(): { listener: (e: EngineEvent<R>) => void; events: EngineEvent<R>[]; wait(pred: (e: EngineEvent<R>) => boolean, ms?: number): Promise<EngineEvent<R>> };
```

- [ ] **Step 1: The support harness**

`test/support/engine.ts`:
```ts
// A running engine on the test application: capture → engine.onEvent, capture failure → engine.reset.
import type { SQL } from "bun";
import { type CaptureNames, PgoutputCapture } from "../../src/capture";
import { Runtime } from "../../src/runtime";
import { type EngineEvent, SubscriptionEngine } from "../../src/subscriptions";
import { schema, withApp } from "./app";
import { pgConfig } from "./db";

export interface EngineHarness {
  sql: SQL;
  names: CaptureNames;
  runtime: Runtime<typeof schema>;
  engine: SubscriptionEngine<typeof schema>;
}

export async function withEngine(fn: (h: EngineHarness) => Promise<void>, opts: { connections?: number } = {}): Promise<void> {
  await withApp(async (sql, names) => {
    const runtime = new Runtime({ sql, schema, publication: names.publication });
    const engine = new SubscriptionEngine({ runtime, sql, connections: opts.connections });
    const capture = new PgoutputCapture({ connection: pgConfig, names });
    await capture.start({ onEvent: (e) => engine.onEvent(e), onError: (e) => engine.reset(String(e)) });
    try {
      await fn({ sql, names, runtime, engine });
    } finally {
      engine.close();
      await capture.stop();
    }
  });
}

export function recorder<R>() {
  const events: EngineEvent<R>[] = [];
  const waiters: { pred: (e: EngineEvent<R>) => boolean; resolve: (e: EngineEvent<R>) => void }[] = [];
  return {
    events,
    listener: (e: EngineEvent<R>) => {
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    },
    wait(pred: (e: EngineEvent<R>) => boolean, ms = 5_000): Promise<EngineEvent<R>> {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return Promise.race([
        new Promise<EngineEvent<R>>((resolve) => waiters.push({ pred, resolve })),
        Bun.sleep(ms).then(() => {
          throw new Error(`no matching event in ${ms} ms; got ${JSON.stringify(events)}`);
        }),
      ]);
    },
    last(): EngineEvent<R> | undefined {
      return events.at(-1);
    },
  };
}
```

- [ ] **Step 2: Failing tests**

`test/subscriptions/integration/engine.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { posts, schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";
const userPosts = query(async (ctx, a: { id: string }) =>
  (await ctx.db.select().from(posts).where(eq(posts.authorId, a.id))).map((p) => p.title).sort(),
);

describe("SubscriptionEngine", () => {
  test("the first value, then a new one after a write through a mutation", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      expect(r.last()).toMatchObject({ kind: "value", value: [] });
      await engine.mutate(mutation(async (ctx) => ctx.db.insert(posts).values({ authorId: U, title: "hello" })), {});
      await r.wait((e) => e.kind === "value" && (e.value as string[]).includes("hello"));
    });
  });

  test("a raw SQL write (Drizzle Studio, psql) re-pushes", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'from psql')`);
      await r.wait((e) => e.kind === "value" && (e.value as string[]).includes("from psql"));
    });
  });

  test("a write to a table the query does not read re-runs nothing", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      const before = { ...engine.stats };
      await pool.unsafe(`insert into dzb_app.comments(post_id, body) values (uuidv7(), 'unrelated')`);
      await engine.flush(); // a full cycle ran: the comment's commit has been applied
      expect(engine.stats.cycles).toBeGreaterThan(before.cycles); // the premise: a cycle did run
      expect(engine.stats.reruns).toBe(before.reruns);
      expect(r.events.length).toBe(1);
    });
  });

  test("subscribers to the same query share one entry: one re-run per cycle", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      let runs = 0;
      const counted = query(async (ctx) => {
        runs++;
        return (await ctx.db.select().from(users)).length;
      });
      const a = recorder<number>(), b = recorder<number>();
      await engine.subscribe("users:count", counted, {}, a.listener);
      await engine.subscribe("users:count", counted, {}, b.listener);
      expect(runs).toBe(1);
      expect(b.last()).toMatchObject({ kind: "value", value: 0 });
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await Promise.all([a.wait((e) => e.kind === "value" && e.value === 1), b.wait((e) => e.kind === "value" && e.value === 1)]);
      expect(runs).toBe(2);
    });
  });

  test("a query reading now() is not shared", async () => {
    await withEngine(async ({ engine }) => {
      let runs = 0;
      const clock = query(async (ctx) => {
        runs++;
        return (await ctx.db.execute(sql`select now()::text as t`))[0];
      });
      await engine.subscribe("clock", clock, {}, recorder().listener);
      await engine.subscribe("clock", clock, {}, recorder().listener);
      expect(runs).toBe(2);
    });
  });

  test("DDL re-runs every subscription", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      const before = engine.stats.reruns;
      await pool.unsafe(`alter table dzb_app.users add column nickname text`);
      await engine.flush();
      expect(engine.stats.reruns).toBeGreaterThan(before);
    });
  });

  test("a query that throws is reported and stays registered", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const boom = query(async (ctx) => {
        const rows = await ctx.db.select().from(users);
        if (rows.length > 0) throw new Error("no users allowed");
        return rows.length;
      });
      const r = recorder<number>();
      await engine.subscribe("boom", boom, {}, r.listener);
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await r.wait((e) => e.kind === "error");
      await pool.unsafe(`delete from dzb_app.users`);
      await r.wait((e) => e.kind === "value" && e.value === 0 && r.events.some((x) => x.kind === "error"));
    });
  });

  test("a re-run that returns the same value pushes nothing (and is counted as useless)", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      const other = "0190a000-0000-7000-8000-000000000009";
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${other}', 'someone else')`);
      await engine.flush();
      expect(engine.stats.reruns).toBeGreaterThan(0); // the premise: table level re-ran it
      expect(engine.stats.uselessReruns).toBe(engine.stats.reruns);
      expect(r.events.length).toBe(1);
    });
  });

  test("unsubscribing the last listener forgets the entry", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const r = recorder<string[]>();
      const off = await engine.subscribe("posts:byUser", userPosts, { id: U }, r.listener);
      off();
      const before = engine.stats.reruns;
      await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'nobody listens')`);
      await engine.flush();
      expect(engine.stats.reruns).toBe(before);
    });
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (no engine).
- [ ] **Step 4: Implement `src/subscriptions/engine.ts`**

```ts
// The subscription engine: keeps every subscribed query's value current.
//
// Stream side (onEvent, synchronous): a committed transaction is appended to the buffer, then applied to the index,
// which marks the entries it can change (rule B, spec D7); DDL also clears the catalog cache (P-M1).
// Cycle side (async, one at a time): export a snapshot S; emit a barrier and wait for it in the stream — every
// commit visible in S has then been applied (P-A3); re-run the dirty entries in S (runInSnapshot, one transaction
// per connection, P-M10); re-register each with S, whose buffer replay re-dirties what S did not see; push the
// changed values as one batch; prune the buffer below S's xmin when no fresh query is in flight (P-A4).
import type { SQL } from "bun";
import { emitBarrier, lsnToBigInt, type StreamEvent } from "../capture";
import { type MutationDef, parseSnapshot, type QueryDef, type Runtime, type SnapshotCall } from "../runtime";
import { RecentCommits } from "./buffer";
import { Registry } from "./registry";
import { stableHash } from "./stable";
import { visibilityOf } from "./xid";

export type EngineEvent<R> =
  | { kind: "value"; cycle: number; value: R }
  | { kind: "error"; cycle: number; error: unknown }
  | { kind: "reset"; reason: string };

export interface EngineStats {
  cycles: number;
  reruns: number;
  uselessReruns: number; // re-run, same result: the cost of table-level invalidation (spec P-M13's metric)
  pushes: number;
}

interface CacheEntry<S extends Record<string, unknown>> {
  key: string;
  run: SnapshotCall<S>;
  hash: string;
  last: EngineEvent<unknown>;
  listeners: Set<(e: EngineEvent<unknown>) => void>;
}

interface BarrierWait {
  expected?: bigint;
  seen?: bigint;
  resolve: () => void;
}

export class SubscriptionEngine<S extends Record<string, unknown>> {
  readonly stats: EngineStats = { cycles: 0, reruns: 0, uselessReruns: 0, pushes: 0 };
  private readonly buffer = new RecentCommits();
  private readonly registry = new Registry<string>();
  private readonly entries = new Map<string, CacheEntry<S>>();
  private readonly pending = new Map<string, Promise<CacheEntry<S>>>();
  private readonly barriers = new Map<string, BarrierWait>();
  private inflight = 0; // fresh queries whose snapshot is not registered yet: pruning waits for them
  private started = 0; // cycles started
  private cycleWaiters: { after: number; resolve: (id: number) => void; reject: (e: unknown) => void }[] = [];
  private running = false;
  private again = false;
  private closed = false;
  private uniq = 0;

  constructor(
    private readonly opts: {
      runtime: Runtime<S>;
      sql: SQL;
      connections?: number;
      barrierTimeoutMs?: number; // a stream that stopped delivering must fail the cycle, not hang it and every mutate()
      onError?: (e: unknown) => void;
    },
  ) {}

  async subscribe<A, R>(name: string, def: QueryDef<S, A, R>, args: A, listener: (e: EngineEvent<R>) => void): Promise<() => void> {
    const shared = `${name}\u0000${stableHash(args)}`;
    const existing = this.entries.get(shared) ?? (await this.pending.get(shared));
    // Join only a SHARED entry that still exists: a volatile one (its key carries a suffix) is never joined.
    const entry = existing && existing.key === shared && this.entries.has(shared) ? existing : await this.open(shared, def, args);
    const l = listener as (e: EngineEvent<unknown>) => void;
    entry.listeners.add(l);
    l(entry.last);
    return () => {
      entry.listeners.delete(l);
      if (entry.listeners.size === 0) {
        this.entries.delete(entry.key);
        this.registry.remove(entry.key);
      }
    };
  }

  private open<A, R>(shared: string, def: QueryDef<S, A, R>, args: A): Promise<CacheEntry<S>> {
    const p = (async () => {
      this.inflight++;
      try {
        const run: SnapshotCall<S> = (ctx) => def.handler(ctx, args);
        const r = await this.opts.runtime.runQuery(def, args);
        // A volatile result (now(), random()…) is never shared: its key is unique to this subscription (spec D10).
        const key = r.readSet.volatile.length ? `${shared}\u0000${++this.uniq}` : shared;
        const entry: CacheEntry<S> = {
          key,
          run,
          hash: stableHash(r.value),
          last: { kind: "value", cycle: this.started, value: r.value },
          listeners: new Set(),
        };
        this.entries.set(key, entry);
        if (this.registry.register(key, r.readSet, visibilityOf(r.snapshot), this.buffer)) this.schedule();
        return entry;
      } finally {
        this.inflight--;
        this.pending.delete(shared);
      }
    })();
    this.pending.set(shared, p);
    return p;
  }

  onEvent(e: StreamEvent): void {
    if (this.closed) return;
    if (e.kind === "barrier") {
      const w = this.barriers.get(e.id);
      if (!w) return;
      w.seen = lsnToBigInt(e.lsn);
      if (w.expected !== undefined && w.expected === w.seen) w.resolve();
      return;
    }
    const { txn } = e;
    if (txn.ddl) this.opts.runtime.catalog.clear();
    this.buffer.append(txn.xid, txn);
    if (this.registry.apply(txn.xid, txn).length) this.schedule();
  }

  // Resolves with the id of a cycle that STARTED after this call, once that cycle's pushes are delivered.
  flush(): Promise<number> {
    const after = this.started;
    const p = new Promise<number>((resolve, reject) => this.cycleWaiters.push({ after, resolve, reject }));
    this.schedule(true);
    return p;
  }

  async mutate<A, R>(def: MutationDef<S, A, R>, args: A): Promise<{ value: R; cycle: number }> {
    const { value } = await this.opts.runtime.runMutation(def, args);
    // Any cycle that starts now exports a snapshot that contains the commit, and waits for a barrier written after
    // it — so the commit has been applied before the cycle re-runs (spec P-A7).
    return { value, cycle: await this.flush() };
  }

  // Task 7 gives this its behaviour, under its own test.
  reset(_reason: string): void {}

  close(): void {
    this.closed = true;
    for (const w of this.cycleWaiters) w.reject(new Error("engine closed"));
    this.cycleWaiters = [];
  }

  private schedule(force = false): void {
    if (this.closed) return;
    this.again = this.again || force || this.registry.dirtyKeys().length > 0;
    if (!this.running) void this.loop();
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.again && !this.closed) {
        this.again = false;
        try {
          await this.cycle();
        } catch (e) {
          this.opts.onError?.(e);
          for (const w of this.cycleWaiters) w.reject(e);
          this.cycleWaiters = [];
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async barrier(): Promise<void> {
    const id = crypto.randomUUID();
    const wait: BarrierWait = { resolve: () => {} };
    const done = new Promise<void>((resolve) => {
      wait.resolve = resolve;
    });
    this.barriers.set(id, wait);
    try {
      wait.expected = lsnToBigInt(await emitBarrier(this.opts.sql, id));
      if (wait.seen !== undefined && wait.seen === wait.expected) wait.resolve();
      const ms = this.opts.barrierTimeoutMs ?? 10_000;
      await Promise.race([
        done,
        Bun.sleep(ms).then(() => {
          throw new Error(`barrier not seen in the stream within ${ms} ms`);
        }),
      ]);
    } finally {
      this.barriers.delete(id);
    }
  }

  private async cycle(): Promise<void> {
    const id = ++this.started;
    const ex = await this.opts.sql.reserve();
    try {
      await ex.unsafe("begin isolation level repeatable read read only");
      const [{ sid, snap }] = await ex.unsafe("select pg_export_snapshot() as sid, pg_current_snapshot()::text as snap");
      await this.barrier();
      const visibility = visibilityOf(parseSnapshot(snap as string));
      const dirty = this.registry
        .dirtyKeys()
        .map((k) => this.entries.get(k))
        .filter((e): e is CacheEntry<S> => e !== undefined);
      const lanes = Math.max(1, Math.min(this.opts.connections ?? 4, dirty.length));
      const chunks: CacheEntry<S>[][] = Array.from({ length: lanes }, () => []);
      dirty.forEach((e, i) => chunks[i % lanes]!.push(e));
      const results = await Promise.all(chunks.map((c) => this.opts.runtime.runInSnapshot(sid as string, c.map((e) => e.run))));
      const changed: CacheEntry<S>[] = [];
      chunks.forEach((chunk, lane) =>
        chunk.forEach((entry, i) => {
          const r = results[lane]![i]!;
          this.stats.reruns++;
          if (!this.entries.has(entry.key)) return; // unsubscribed during the cycle
          this.registry.register(entry.key, r.readSet, visibility, this.buffer);
          const hash = r.ok ? stableHash(r.value) : `error:${String(r.error)}`;
          if (hash === entry.hash) {
            this.stats.uselessReruns++;
            return;
          }
          entry.hash = hash;
          entry.last = r.ok ? { kind: "value", cycle: id, value: r.value } : { kind: "error", cycle: id, error: r.error };
          changed.push(entry);
        }),
      );
      await ex.unsafe("commit");
      if (this.inflight === 0) this.buffer.prune(visibility.xmin);
      this.stats.cycles++;
      for (const entry of changed)
        for (const l of entry.listeners) {
          this.stats.pushes++;
          l(entry.last);
        }
      this.cycleWaiters = this.cycleWaiters.filter((w) => {
        if (w.after >= id) return true;
        w.resolve(id);
        return false;
      });
      if (this.registry.dirtyKeys().length) this.again = true;
    } finally {
      await ex.unsafe("rollback").catch(() => {});
      ex.release();
    }
  }
}
```

Barrel: `export { type EngineEvent, type EngineStats, SubscriptionEngine } from "./engine";`

Two notes the implementer must hold to:
- `reset()` is empty until Task 7, which writes it test-first.
- `subscribe()` may join an entry being opened by a concurrent `subscribe()` of the same key (`pending`), so two quick subscribers still share.

- [ ] **Step 5: Run — expect PASS**; typecheck; `bun run check`.
- [ ] **Step 6: Sabotage one at a time, each must turn its named test red** (restore with `cp` after each): (a) remove the `if (hash === entry.hash)` short-circuit → `a re-run that returns the same value pushes nothing` fails; (b) drop the `existing.key === shared &&` condition and let volatile keys be joined → `a query reading now() is not shared` fails; (c) make the unsubscribe closure keep the registry entry → `unsubscribing the last listener forgets the entry` fails; (d) in `onEvent`, call `apply` BEFORE `append` and put an `await Promise.resolve()` between them → nothing may break here (the order matters only under concurrency, which Task 6 covers) — note the result, then restore.
- [ ] **Step 7: Commit** `feat(dzb-01a-3): the subscription engine — cycles in one exported snapshot, barriers by id and LSN, the shared cache`.

---

### Task 5: Read-your-writes

**Files:** Test: `test/subscriptions/integration/ryw.test.ts` (the behaviour exists since Task 4; this task pins it).

- [ ] **Step 1: Test**

```ts
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { posts, schema } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";

test("when mutate() resolves, every subscriber has already received the write — 20 times in a row", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
    const titles = query(async (ctx) => (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title));
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    const add = mutation(async (ctx, a: { t: string }) => ctx.db.insert(posts).values({ authorId: U, title: a.t }));
    for (let i = 0; i < 20; i++) {
      const { cycle } = await engine.mutate(add, { t: `p${i}` });
      const last = r.last();
      expect(last?.kind).toBe("value");
      expect(last?.kind === "value" && last.value.includes(`p${i}`)).toBe(true);
      expect(last?.kind === "value" && last.cycle).toBeLessThanOrEqual(cycle);
    }
  });
});
```

- [ ] **Step 2: Run — expect PASS.** Then **sabotage**: make `mutate()` return `{ value, cycle: 0 }` right after `runMutation` → the test goes red on the first iteration. Restore.
- [ ] **Step 3: Commit** `test(dzb-01a-3): read-your-writes — mutate() resolves after the write was pushed`.

---

### Task 6: The consistency properties

**Files:** Test: `test/subscriptions/integration/properties.test.ts`.

- [ ] **Step 1: Tests**

```ts
import { expect, test } from "bun:test";
import { count, eq, sql } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { posts, schema } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query } = functions<typeof schema>();
const AUTHORS = [1, 2, 3, 4, 5].map((i) => `0190a000-0000-7000-8000-00000000000${i}`);

test("one cycle's pushes come from one snapshot: a list and its count always agree", async () => {
  await withEngine(
    async ({ sql: pool, engine }) => {
      const list = query(async (ctx) => (await ctx.db.select().from(posts)).length);
      const total = query(async (ctx) => (await ctx.db.select({ n: count() }).from(posts))[0]!.n);
      const latest: { list?: number; total?: number } = {};
      const byCycle = new Map<number, { list?: number; total?: number }>();
      const note = (k: "list" | "total") => (e: { kind: string; cycle?: number; value?: unknown }) => {
        if (e.kind !== "value" || e.cycle === undefined) return;
        latest[k] = e.value as number;
        byCycle.set(e.cycle, { ...byCycle.get(e.cycle), [k]: e.value as number });
      };
      await engine.subscribe("list", list, {}, note("list"));
      await engine.subscribe("total", total, {}, note("total"));
      let stop = false;
      const writer = (async () => {
        while (!stop) {
          await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${AUTHORS[0]}', 'w')`);
          if (Math.random() < 0.3) await pool.unsafe(`delete from dzb_app.posts where id = (select id from dzb_app.posts limit 1)`);
        }
      })();
      await Bun.sleep(1_500);
      stop = true;
      await writer;
      await engine.flush();
      const bothInOneCycle = [...byCycle.values()].filter((v) => v.list !== undefined && v.total !== undefined);
      expect(bothInOneCycle.length).toBeGreaterThan(5); // the premise: many cycles re-ran both
      for (const v of bothInOneCycle) expect(v.list).toBe(v.total);
      expect(latest.list).toBe(latest.total);
    },
    { connections: 2 },
  );
}, 30_000);

test("every subscription converges after the writes stop, whenever it was created", async () => {
  await withEngine(async ({ sql: pool, runtime, engine }) => {
    const byAuthor = query(async (ctx, a: { id: string }) =>
      (await ctx.db.select().from(posts).where(eq(posts.authorId, a.id))).map((p) => p.title).sort(),
    );
    const views = query(async (ctx) => (await ctx.db.execute(sql`select count(*)::int as n from dzb_app.posts`))[0]);
    let stop = false;
    const writers = [0, 1, 2, 3].map(async (w) => {
      let i = 0;
      while (!stop) {
        const a = AUTHORS[Math.floor(Math.random() * AUTHORS.length)]!;
        if (Math.random() < 0.7) await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${a}', 'w${w}-${i++}')`);
        else await pool.unsafe(`update dzb_app.posts set author_id = '${a}' where id = (select id from dzb_app.posts order by random() limit 1)`);
      }
    });
    const subs: { rec: ReturnType<typeof recorder<unknown>>; fresh: () => Promise<unknown> }[] = [];
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(Math.random() * 40); // created while writes are committing
      const a = AUTHORS[i % AUTHORS.length]!;
      const rec = recorder<unknown>();
      if (i % 3 === 0) {
        await engine.subscribe("views", views, {}, rec.listener);
        subs.push({ rec, fresh: async () => (await runtime.runQuery(views, {})).value });
      } else {
        await engine.subscribe("byAuthor", byAuthor, { id: a }, rec.listener);
        subs.push({ rec, fresh: async () => (await runtime.runQuery(byAuthor, { id: a })).value });
      }
    }
    stop = true;
    await Promise.all(writers);
    await engine.flush();
    await engine.flush();
    for (const s of subs) {
      const last = s.rec.last();
      expect(last?.kind).toBe("value");
      expect(last?.kind === "value" ? last.value : undefined).toEqual(await s.fresh());
    }
  });
}, 60_000);
```

- [ ] **Step 2: Run — expect PASS.**
- [ ] **Step 3: Sabotage, one at a time, each must turn its test red** (restore with `cp` after each):
  (a) `runInSnapshot` without `set transaction snapshot` → the list/count test fails (with `connections: 2` the two queries run on different connections, at different points in time).
  (b) `Registry.register` without the buffer replay → the convergence test fails (a subscription created while a commit it did not see was being streamed stays stale). If it stays green over 3 runs, increase writers/subscriptions before believing it: the property must be demonstrably able to fail.
  (c) `visibleIn` treating `xip` as visible → the convergence test fails.
- [ ] **Step 4: Commit** `test(dzb-01a-3): consistency properties — one snapshot per batch, convergence under concurrent writes`.

---

### Task 7: Capture failure resets everything; reactive latency bench

**Files:** Modify `src/subscriptions/engine.ts` (`reset`). Test: `test/subscriptions/integration/reset.test.ts`. Create `load/subscriptions/reactive_latency.ts`. Modify `docs/BENCH.md`.

- [ ] **Step 1: Failing test**

```ts
import { expect, test } from "bun:test";
import { functions } from "../../../src/runtime";
import { schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query } = functions<typeof schema>();

test("a terminated walsender resets every subscription, and nothing is served from before", async () => {
  await withEngine(async ({ sql: pool, names, engine }) => {
    const r = recorder<number>();
    await engine.subscribe("n", query(async (ctx) => (await ctx.db.select().from(users)).length), {}, r.listener);
    await pool`select pg_terminate_backend(active_pid) from pg_replication_slots where slot_name = ${names.slot} and active_pid is not null`;
    await r.wait((e) => e.kind === "reset");
    const before = engine.stats.reruns;
    await pool.unsafe(`insert into dzb_app.users(name) values ('after reset')`);
    await Bun.sleep(300);
    expect(engine.stats.reruns).toBe(before); // the dropped subscription is not re-run
  });
});
```

- [ ] **Step 2: Run — expect FAIL or pass vacuously; then replace `reset()` with the clean version:**

```ts
  // The capture failed (spec D14, P-M6): commits may have been lost, so no registered result can be trusted.
  // Every subscriber is told; the caller recreates the slot BEFORE clients subscribe again.
  reset(reason: string): void {
    const listeners = [...this.entries.values()].flatMap((e) => [...e.listeners]);
    for (const key of this.entries.keys()) this.registry.remove(key);
    this.entries.clear();
    this.buffer.clear();
    for (const l of listeners) l({ kind: "reset", reason });
  }
```
and add `clear(): void { this.items = []; }` to `RecentCommits` (with a one-line unit test in `buffer.test.ts`: after `clear()` the size is 0).

- [ ] **Step 3: Run — expect PASS**; sabotage: make `reset` notify without removing entries → the re-run assertion fails. Restore.

- [ ] **Step 4: The bench** — `load/subscriptions/reactive_latency.ts`:

```ts
// Commit → push latency and the useless re-run ratio of table-level invalidation (DZB-01a-3). N subscriptions,
// each on the posts of its own author; 200 raw-SQL inserts, each for ONE author: at table level every
// subscription re-runs on every insert, and N−1 of those re-runs are useless — the number 01b must beat.
//   bun --preload ./test/support/env.ts load/subscriptions/reactive_latency.ts
import { eq } from "drizzle-orm";
import { functions } from "../../src/runtime";
import { posts, schema } from "../../test/support/app";
import { withEngine } from "../../test/support/engine";

const { query } = functions<typeof schema>();
const byAuthor = query(async (ctx, a: { id: string }) => (await ctx.db.select().from(posts).where(eq(posts.authorId, a.id))).length);
const author = (i: number) => `0190a000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;

for (const n of [1, 100, 1000]) {
  await withEngine(async ({ sql, engine }) => {
    const seen = new Map<string, (t: number) => void>();
    for (let i = 0; i < n; i++)
      await engine.subscribe("byAuthor", byAuthor, { id: author(i) }, (e) => {
        if (e.kind === "value" && i === 0) seen.get(String(e.value))?.(performance.now());
      });
    const base = { ...engine.stats };
    const xs: number[] = [];
    for (let k = 1; k <= 200; k++) {
      const pushed = new Promise<number>((r) => seen.set(String(k), r));
      const t0 = performance.now();
      await sql.unsafe(`insert into dzb_app.posts(author_id, title) values ('${author(0)}', 't')`);
      xs.push((await pushed) - t0);
    }
    xs.sort((a, b) => a - b);
    const reruns = engine.stats.reruns - base.reruns, useless = engine.stats.uselessReruns - base.uselessReruns;
    console.log(JSON.stringify({ subscriptions: n, p50_ms: +xs[100]!.toFixed(2), p99_ms: +xs[197]!.toFixed(2), reruns, useless, useless_ratio: +(useless / reruns).toFixed(3) }));
  }, { connections: 4 });
}
process.exit(0);
```
Run it and record a `## Subscriptions (DZB-01a-3)` table in `docs/BENCH.md` from its output: subscriptions, p50/p99 commit → push, re-runs, useless re-runs and the ratio, with the command and one paragraph on what it measured.

- [ ] **Step 5: Full suite, check, commit** — `bun run check && bun run test`; slots count 0. Commit `feat(dzb-01a-3): a capture failure resets every subscription; bench: reactive latency and the useless re-run ratio`.

---

### Task 8: Final review

- [ ] One fresh reviewer (most capable model) on the branch: rule B on every path, the barrier (id + LSN, the race where the stream beats `emitBarrier`'s reply), pruning (in-flight fresh queries, the reset path), cycle scheduling (lost wake-ups, a cycle that throws, `flush()` waiters), cache races (concurrent subscribe of one key, unsubscribe during a cycle), and test honesty (every property's sabotage). Critical/Important fixed with a failing test first; record the review in the spec's POST-REVIEW block; the owner merges.
