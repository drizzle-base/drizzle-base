# DZB-01a-3 — Subscriptions: registration, the flush cycle, the shared cache, read-your-writes — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `SubscriptionEngine` that keeps every subscribed query's value current: it consumes the capture stream, marks exactly the subscriptions a committed transaction can change (table level, 01a), re-runs them in flush cycles under ONE exported snapshot, pushes consistent batches, shares one entry per (function, args), and tells a mutation which cycle will carry its effect.

**Architecture:** Pure pieces — 32-bit xid visibility and snapshot containment (`xid.ts`), a projection-only recent-commits buffer (`buffer.ts`), the read-set index (`registry.ts`), `stableHash` — and the engine (`engine.ts`) that wires them to the runtime and the stream. A cycle: export S → emit a barrier and wait for it (every commit visible in S has been applied) → re-run the dirty entries whose current value S contains, in S, one transaction per connection → re-register each with S (the buffer replay re-dirties what S did not see) → push the changed values as one batch → prune the buffer.

**Tech Stack:** existing; Postgres 18.6.

**Spec:** `docs/specs/DZB-01-foundation.md` — POST-REVIEW block: D7, D8, P-A3, P-A4, P-A7, P-M1, P-M5, P-M6, P-M10, D10, RA-B1.

## v2 — what the plan review changed (25 Sep 2026)

An adversarial review of v1 (correctness/concurrency), FIX-FIRST. It **confirmed the core** with probes and PG 18's
source: a barrier emitted after `pg_export_snapshot()` covers every commit visible in S (the commit record is
inserted before the transaction leaves the ProcArray); barriers match by LSN (5/5); the buffer replay covers
commits streamed during re-runs; pruning below S.xmin is sound because snapshot xmin never goes backwards. It found
seven blocking holes in v1's engine and showed that v1's two property tests could not fail on the bugs they named
(table-level invalidation re-dirties any stale subscription on the next write — the masking P4 avoided with
precise queries). v2's answers, each pinned by a test that fails without it:

| Finding | v2 |
|---|---|
| A1 two concurrent subscribes of one key open it twice; an unsubscribe removes the other's live entry | check-then-create with no await; unsubscribe only `if (entries.get(key) === entry)`, idempotent (Task 4) |
| A2 a subscriber can receive an older value after a newer one | a cycle re-runs only entries whose current value's snapshot is contained in S; the others wait for the next cycle (`contains`, Tasks 1 and 4) |
| A3 DDL can leave a read-set wrong forever (catalog cache poisoned by a snapshot that predates the DDL) | a streamed DDL dirties every entry regardless of visibility; the catalog stops caching until a cycle whose snapshot sees the DDL completes (Tasks 2, 3, 6) |
| A4 a failed cycle leaves dirty entries stuck; a throwing listener blocks the others | the loop runs while anything is dirty, with backoff after a failure; every listener call is isolated (Tasks 4, 6) |
| A5 `reset()` races in-flight opens; nothing blocks subscribing while the capture is down | a generation counter discards stale opens and cycles; `reset()` puts the engine down until `resume()` (Task 7) |
| A6 `mutate()` reports a committed write as failed | a confirmation failure is `CommittedUnconfirmedError` carrying `commitLsn` (Task 5) |
| A7 the buffer grows without bound | it keeps only the table projection; a timer prunes it against a fresh `pg_snapshot_xmin`, blocked only by fresh queries that started before that snapshot (Tasks 1, 7) |
| M1 vacuous tests | deterministic tests: a transaction held open, a gate inside the handler, two tables where one transaction moves a unit (Task 6) |
| M2 `mutate()` waited for a whole cycle | P-A7 as specified: wait for a barrier after the commit, return the id of the first cycle that starts after it (Task 5) |
| M3 DDL poisons Bun.sql's prepared statements (`0A000`) | the runtime's pool is created with `prepare: false` — probed: after `ALTER … TYPE` a warm pool returns the new type instead of `0A000`; ~0.41 ms vs ~0.34 ms per query (Task 3) |
| M4 transient errors cached and never retried | SQLSTATE classes 08/40/53/57 (and a lost connection) leave the entry dirty for the next cycle; a read-set resolution failure widens to OPAQUE instead of failing the lane (Tasks 3, 6) |
| M5 fresh values carried a cycle id they do not belong to | a fresh value has `cycle: null` (Task 4) |
| M6 liveness was a key check, not an identity check | `entries.get(key) === entry` everywhere (Task 4) |
| M7 `emitBarrier` outside the timeout; `close()` did not stop anything | the timeout covers the whole barrier and is cleared; `close()` stops the loop, the timer and rejects waiters (Task 4) |
| B1 `stableHash` flattened Map/Set/typed arrays to `{}` | handled; an unknown class instance hashes as always-changed (Task 2) |
| B2, B3, B5, B6 | args cloned at subscribe; a dirty set, not an O(N) scan; `flush()` after `close()` rejects; a re-run that turns volatile makes the entry unshareable |

Not taken: M5's "a joiner of a dirty entry waits for the next cycle" — a joiner gets the entry's current value and
then the cycle's push, like any subscriber; recorded as a deliberate choice. B7 (OPAQUE relations outside the
stream never re-run by writes to them) goes into the product docs when they exist.

## Global Constraints

- Module `src/subscriptions/`, through `index.ts`; LAYERS allow `sql, capture, readset, runtime`. Not exported from `drizzle-base/server` yet.
- **Rule B:** a streamed transaction is reflected in a result iff its xid is visible in that result's snapshot (modulo 2^32). **DDL is the exception**: it dirties every entry.
- **No await** between inserting a read-set into the index and replaying the buffer, nor anywhere in `onEvent`.
- **A cycle never pushes a value older than the one its subscribers already have** (`contains(S, entry.visibility)`).
- **A barrier is matched by id AND LSN** (`lsnToBigInt`), and its timeout covers the `emitBarrier` round trip.
- **The runtime's pool uses `prepare: false`.**
- Snapshot ids validated against `^[0-9A-F]+-[0-9A-F]+-[0-9]+$`. Tests: TDD, each property with a sabotage that turns it red; premises asserted. Branch `feat/dzb-01a-3-subscriptions` (exists; this plan is committed on it).

## Review Focus

1. A subscription created while a commit it did not see is being streamed — the replay must catch it (Task 6: `a commit streamed during the handler is caught by the replay`).
2. A list and a count on two tables moved by one transaction — never from two points in time (Task 6: `two tables moved by one transaction never disagree in a cycle`).
3. DDL that turns a table name into a view (Task 6: `a rename plus a view under the old name`).
4. The capture dies (Task 7: `reset puts the engine down`); a mutation whose confirmation cannot arrive (Task 5).
5. A write workload with no subscription at all — the buffer stays bounded (Task 7).

---

### Task 1: xid visibility and containment, LSN comparison, the buffer (pure)

**Files:** Create `src/capture/lsn.ts` (+ export), `src/subscriptions/xid.ts`, `src/subscriptions/buffer.ts`, `src/subscriptions/index.ts`. Tests: `test/subscriptions/unit/xid.test.ts`, `test/subscriptions/unit/buffer.test.ts`.

**Interfaces — produces:**
```ts
function lsnToBigInt(lsn: string): bigint;
function low32(x: bigint): number;
function xidPrecedes(a: number, b: number): boolean;
interface Visibility { xmin: number; xmax: number; xip: ReadonlySet<number> }
function visibilityOf(s: Snapshot): Visibility;
function visibleIn(xid: number, v: Visibility): boolean;
function contains(outer: Visibility, inner: Visibility): boolean;   // every xid visible in inner is visible in outer
interface Projection { ddl: boolean; changes: readonly { table: string }[]; wholeTables: ReadonlySet<string> }
function project(txn: TxnTables): Projection;                      // tables only: no row images are kept
class RecentCommits { append(xid: number, p: Projection): void; all(): readonly { xid: number; txn: Projection }[]; prune(xmin: number): number; clear(): void; get size(): number }
```

- [ ] **Step 1: Failing tests** (the branch exists)

`test/subscriptions/unit/xid.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { lsnToBigInt } from "../../../src/capture";
import { contains, low32, visibleIn, xidPrecedes } from "../../../src/subscriptions";

const vis = (xmin: number, xmax: number, xip: number[] = []) => ({ xmin, xmax, xip: new Set(xip) });

describe("visibleIn (rule B)", () => {
  test("before xmin visible; at or after xmax not; in between visible unless running", () => {
    const v = vis(100, 110, [103, 107]);
    expect(visibleIn(99, v)).toBe(true);
    expect(visibleIn(100, vis(100, 110, [100]))).toBe(false);
    expect(visibleIn(103, v)).toBe(false);
    expect(visibleIn(105, v)).toBe(true);
    expect(visibleIn(110, v)).toBe(false);
  });

  test("across the 2^32 wraparound", () => {
    const v = vis(0xffff_fff0, 0x0000_0010, [0x0000_0005]);
    expect(visibleIn(0xffff_ffe0, v)).toBe(true);
    expect(visibleIn(0xffff_fff8, v)).toBe(true);
    expect(visibleIn(0x0000_0003, v)).toBe(true);
    expect(visibleIn(0x0000_0005, v)).toBe(false);
    expect(visibleIn(0x0000_0020, v)).toBe(false);
    expect(xidPrecedes(0xffff_fff0, 0x0000_0010)).toBe(true);
    expect(low32((5n << 32n) + 42n)).toBe(42);
  });
});

describe("contains(outer, inner): outer saw everything inner saw", () => {
  test("a later snapshot contains an earlier one; not the reverse", () => {
    const early = vis(100, 105, [102]);
    const late = vis(103, 110, [106]);
    expect(contains(late, early)).toBe(true);
    expect(contains(early, late)).toBe(false);
  });
  test("a transaction running in outer but finished in inner breaks containment", () => {
    expect(contains(vis(100, 110, [104]), vis(100, 108, []))).toBe(false);
  });
  test("equal snapshots contain each other", () => {
    expect(contains(vis(100, 110, [104]), vis(100, 110, [104]))).toBe(true);
  });
});

test("lsnToBigInt: Postgres's and the replication library's spellings are one position", () => {
  expect(lsnToBigInt("1/343C4E8")).toBe(lsnToBigInt("00000001/0343C4E8"));
  expect(lsnToBigInt("1/0")).toBeGreaterThan(lsnToBigInt("0/FFFFFFFF"));
});
```

`test/subscriptions/unit/buffer.test.ts`:
```ts
import { expect, test } from "bun:test";
import { project, RecentCommits } from "../../../src/subscriptions";

const txn = (tables: string[]) => ({
  ddl: false,
  changes: tables.map((table) => ({ table, relOid: 1, op: "insert" as const, old: null, new: { big: "x".repeat(1000) } })),
  wholeTables: new Set<string>(),
});

test("project keeps the tables, not the row images", () => {
  const p = project(txn(["a", "a", "b"]));
  expect(p.changes).toEqual([{ table: "a" }, { table: "b" }]);
  expect(JSON.stringify(p)).not.toContain("xxxx");
});

test("prune drops what precedes xmin (modulo 2^32); clear empties", () => {
  const b = new RecentCommits();
  for (const x of [98, 99, 100, 101]) b.append(x, project(txn([`t${x}`])));
  expect(b.prune(100)).toBe(2);
  expect(b.all().map((e) => e.xid)).toEqual([100, 101]);
  b.append(0xffff_fff0, project(txn(["w"])));
  expect(b.prune(0x0000_0102)).toBe(3);
  b.append(5, project(txn(["z"])));
  b.clear();
  expect(b.size).toBe(0);
});
```

- [ ] **Step 2: Run — expect FAIL.**
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
// snapshot. The stream's xids are 32-bit; pg_current_snapshot() is xid8. Both compare modulo 2^32 like Postgres's
// TransactionIdPrecedes (spec P-M5): live xids are within 2^31 of each other.
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
  if (xidPrecedes(xid, v.xmin)) return true;
  if (!xidPrecedes(xid, v.xmax)) return false;
  return !v.xip.has(xid);
}

// outer ⊇ inner: every transaction visible in inner is visible in outer. A cycle re-runs an entry at S only if S
// contains the snapshot of the value the subscribers already have — otherwise the push would go back in time.
export function contains(outer: Visibility, inner: Visibility): boolean {
  if (xidPrecedes(outer.xmax, inner.xmax)) return false; // inner saw transactions outer had not started
  for (const x of outer.xip) if (xidPrecedes(x, inner.xmax) && visibleIn(x, inner)) return false; // running in outer, done in inner
  return true;
}
```

`src/subscriptions/buffer.ts`:
```ts
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
```

`src/subscriptions/index.ts`:
```ts
export { type Projection, project, RecentCommits } from "./buffer";
export { contains, low32, type Visibility, visibilityOf, visibleIn, xidPrecedes } from "./xid";
```

- [ ] **Step 4: Run — expect PASS**; typecheck.
- [ ] **Step 5: Sabotage one at a time** — `((a - b) | 0) < 0` → `a < b` (wraparound red); drop the `outer.xip` loop in `contains` (the "running in outer, done in inner" test red). Restore with `cp`.
- [ ] **Step 6: Commit** `feat(dzb-01a-3): xid visibility and snapshot containment modulo 2^32, LSN comparison, a projection-only buffer`.

---

### Task 2: The read-set index and `stableHash` (pure)

**Files:** Create `src/subscriptions/registry.ts`, `src/subscriptions/stable.ts`; extend the barrel. Tests: `test/subscriptions/unit/registry.test.ts`, `test/subscriptions/unit/stable.test.ts`.

**Interfaces — produces:**
```ts
class Registry<K> {
  register(key: K, readSet: ReadSet, visibility: Visibility, buffer: RecentCommits): boolean; // dirty from birth
  remove(key: K): void;
  apply(xid: number, txn: Projection): K[];   // newly dirty; DDL dirties every entry regardless of visibility
  dirtyKeys(): K[];
  get dirtyCount(): number;
  get size(): number;
}
function stableHash(value: unknown): string;
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
  test("marks what a transaction changed — unless the snapshot already saw it", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("posts", rs(["app.posts"]), vis(100, 105), b);
    r.register("users", rs(["app.users"]), vis(100, 105), b);
    expect(r.apply(99, txn(["app.posts"]))).toEqual([]);
    expect(r.apply(107, txn(["app.posts"]))).toEqual(["posts"]);
    expect(r.apply(108, txn(["app.posts"]))).toEqual([]);
    expect(r.dirtyKeys()).toEqual(["posts"]);
    expect(r.dirtyCount).toBe(1);
  });

  test("an opaque read-set is touched by any change", () => {
    const r = new Registry<string>();
    r.register("view", rs([], ["view app.v"]), vis(100, 100), new RecentCommits());
    expect(r.apply(120, txn(["app.other"]))).toEqual(["view"]);
  });

  test("DDL dirties every entry, even one whose snapshot saw it (its catalog may predate it)", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("a", rs(["app.posts"]), vis(200, 200), b);
    r.register("b", rs(["app.users"]), vis(200, 200), b);
    expect(r.apply(150, txn([], true)).sort()).toEqual(["a", "b"]);
  });

  test("registration replays the buffer: a commit the snapshot did not see makes it dirty from birth", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    b.append(103, txn(["app.posts"]));
    b.append(90, txn(["app.posts"]));
    expect(r.register("a", rs(["app.posts"]), vis(100, 110, [103]), b)).toBe(true);
    expect(r.register("b", rs(["app.users"]), vis(100, 110, [103]), b)).toBe(false);
  });

  test("re-registering clears the dirty bit and replaces the read-set; remove forgets it", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("q", rs(["app.posts"]), vis(100, 100), b);
    r.apply(150, txn(["app.posts"]));
    r.register("q", rs(["app.users"]), vis(160, 160), b);
    expect(r.dirtyCount).toBe(0);
    expect(r.apply(170, txn(["app.posts"]))).toEqual([]);
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

test("key order does not matter; values, dates, bigints, bytes, maps and sets do", () => {
  expect(stableHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stableHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  expect(stableHash(new Date(0))).not.toBe(stableHash(new Date(1)));
  expect(stableHash({ n: 1n })).not.toBe(stableHash({ n: 2n }));
  expect(stableHash(new Uint8Array([1]))).not.toBe(stableHash(new Uint8Array([2])));
  expect(stableHash(new Map([["a", 1]]))).not.toBe(stableHash(new Map([["a", 2]])));
  expect(stableHash(new Set([1]))).not.toBe(stableHash(new Set([2])));
  expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  expect(stableHash(undefined)).toBe(stableHash(null));
});

test("an unknown class instance never compares equal (always pushed): widening, not silence", () => {
  class Point {
    constructor(readonly x: number) {}
  }
  expect(stableHash(new Point(1))).not.toBe(stableHash(new Point(1)));
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

`src/subscriptions/registry.ts`:
```ts
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
      if (!set) this.byTable.set(t, (set = new Set()));
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
      const e = this.entries.get(k)!;
      if (this.dirty.has(k) || visibleIn(xid, e.visibility) || !touches(e.readSet, txn)) continue;
      this.dirty.add(k);
      out.push(k);
    }
    return out;
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
```

`src/subscriptions/stable.ts`:
```ts
// "Did the result change?" — a push is sent only when it did. Object key order is not part of a result; array order,
// dates, bigints, bytes, map and set contents are. An unknown class instance cannot be compared safely: it hashes as
// always-changed (a push too many, never one too few).
let unique = 0;

export function stableHash(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (ArrayBuffer.isView(v)) return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex") };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [normalize(k), normalize(x)]) };
  if (v instanceof Set) return { $set: [...v].map(normalize) };
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return { $unknown: ++unique };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
```
Barrel: `export { Registry } from "./registry"; export { stableHash } from "./stable";`

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Sabotage one at a time** — drop `visibleIn(...)` in `apply` (first test red); remove the replay loop (replay test red); make DDL respect visibility (DDL test red). Restore with `cp`.
- [ ] **Step 6: Commit** `feat(dzb-01a-3): the read-set index — rule B, DDL dirties everything, a dirty set; stableHash for bytes, maps, sets`.

---

### Task 3: Runtime — queries in an imported snapshot; catalog caching switch; `prepare: false`

**Files:** Modify `src/runtime/runtime.ts`, `src/runtime/index.ts`, `src/readset/catalog.ts`, `test/support/db.ts`, `docs/ARCHITECTURE.md`. Tests: `test/runtime/integration/snapshot.test.ts`.

**Interfaces — produces:**
```ts
type SnapshotCall<S> = (ctx: Ctx<S>) => Promise<unknown>;
type SnapshotResult = { ok: true; value: unknown; readSet: ReadSet } | { ok: false; error: unknown; readSet: ReadSet };
Runtime.runInSnapshot(snapshotId: string, calls: SnapshotCall<S>[]): Promise<SnapshotResult[]>;
function isTransient(e: unknown): boolean;   // SQLSTATE 08/40/53/57 or no SQLSTATE (a lost connection)
Catalog.caching: boolean;                    // false: every lookup goes to pg_catalog and is not remembered
```

- [ ] **Step 1: `prepare: false` for every test pool** — in `test/support/db.ts`, `testSql` passes `prepare: false` to `new SQL({...})`, with the comment `// Bun.sql's prepared statements break after ALTER … TYPE (0A000 on every retry, probed): drizzle-base's pool never prepares.` The requirement is added to `docs/ARCHITECTURE.md` in the `runtime` module row: "its pool is created with `prepare: false`".

- [ ] **Step 2: Failing tests** — `test/runtime/integration/snapshot.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { sql } from "drizzle-orm";
import { isTransient, Runtime } from "../../../src/runtime";
import { posts, schema, users, withApp } from "../../support/app";

async function exported<T>(pool: SQL, fn: (id: string) => Promise<T>): Promise<T> {
  const ex = await pool.reserve();
  try {
    await ex.unsafe("begin isolation level repeatable read read only");
    const [{ id }] = await ex.unsafe("select pg_export_snapshot() as id");
    return await fn(id as string);
  } finally {
    await ex.unsafe("commit");
    ex.release();
  }
}

test("calls see the exported snapshot, not a commit made after it", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await exported(pool, async (id) => {
      await pool.unsafe(`insert into dzb_app.users(name) values ('after export')`);
      const [a, b] = await rt.runInSnapshot(id, [
        async (ctx) => (await ctx.db.select().from(users)).length,
        async (ctx) => (await ctx.db.select().from(posts)).length,
      ]);
      expect(a).toMatchObject({ ok: true, value: 0 });
      expect(b).toMatchObject({ ok: true, value: 0 });
      if (a?.ok) expect([...a.readSet.tables]).toEqual(["dzb_app.users"]);
    });
  });
});

test("a failing call does not break the others, and reports what it read", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await exported(pool, async (id) => {
      const [bad, good] = await rt.runInSnapshot(id, [
        async (ctx) => {
          await ctx.db.select().from(users);
          await ctx.db.execute(sql`select 1/0`);
        },
        async (ctx) => (await ctx.db.select().from(posts)).length,
      ]);
      expect(bad?.ok).toBe(false);
      expect([...(bad?.readSet.tables ?? [])]).toEqual(["dzb_app.users"]);
      expect(good).toMatchObject({ ok: true, value: 0 });
    });
  });
});

test("a snapshot id that is not one is refused before reaching Postgres", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await expect(rt.runInSnapshot("x'; drop table dzb_app.users; --", [])).rejects.toThrow(/snapshot id/);
  });
});

test("after ALTER … TYPE a warm pool returns the new type, not 0A000 (prepare: false)", async () => {
  await withApp(async (pool, n) => {
    const rt = new Runtime({ sql: pool, schema, publication: n.publication });
    await pool.unsafe(`insert into dzb_app.users(name, age) values ('a', 7)`);
    const age = { kind: "query" as const, handler: async (ctx: Parameters<Parameters<typeof rt.runInSnapshot>[1][number]>[0]) => (await ctx.db.execute(sql`select age from dzb_app.users`))[0] };
    for (let i = 0; i < 3; i++) await rt.runQuery(age, {});
    await pool.unsafe(`alter table dzb_app.users alter column age type text using age::text || 'y'`);
    expect((await rt.runQuery(age, {})).value).toEqual({ age: "7y" });
  });
});

test("isTransient: connection, conflict, resource and operator classes; not a deterministic error", () => {
  const e = (errno?: string) => Object.assign(new Error("x"), { name: "PostgresError", errno });
  for (const c of ["08006", "40001", "40P01", "53300", "57014", "57P01"]) expect(isTransient(e(c))).toBe(true);
  expect(isTransient(new Error("socket closed"))).toBe(true);
  for (const c of ["22012", "42703", "23505"]) expect(isTransient(e(c))).toBe(false);
  expect(isTransient({ cause: e("40001") })).toBe(true);
});
```

- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement** — `Catalog`: add `caching = true;` and at the top of `cached(...)`: `if (!this.caching) return load();`. In `runtime.ts` export `isTransient` (reusing the `rootError` walk):
```ts
// Errors worth retrying on the next cycle instead of caching as the query's result: connection (08), conflict (40),
// resources (53), operator intervention (57), or no SQLSTATE at all (a lost socket).
export function isTransient(e: unknown): boolean {
  const code = sqlState(e);
  return code === undefined || /^(08|40|53|57)/.test(code);
}
```
and `runInSnapshot` (P-M10: one transaction per connection per cycle; a savepoint per call; a read-set resolution failure widens to OPAQUE for that call):
```ts
export type SnapshotCall<S extends Record<string, unknown>> = (ctx: Ctx<S>) => Promise<unknown>;
export type SnapshotResult = { ok: true; value: unknown; readSet: ReadSet } | { ok: false; error: unknown; readSet: ReadSet };
const SNAPSHOT_ID = /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/i;
```
```ts
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
          let readSet: ReadSet;
          try {
            readSet = await readSetOf(client.statements, this.catalog, conn, sp as string);
          } catch (e) {
            readSet = { tables: new Set(), opaque: [`read-set resolution failed: ${String(e)}`], volatile: [] };
          }
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
Export `isTransient, type SnapshotCall, type SnapshotResult` from `src/runtime/index.ts`. If the ALTER test's handler type is awkward, type it as `QueryDef<typeof schema, Record<string, never>, unknown>` built with `functions<typeof schema>().query(...)` instead.

- [ ] **Step 5: Run — expect PASS.** Sabotages: remove `set transaction snapshot` (first test red); `prepare: true` in `testSql` (ALTER test red). Restore.
- [ ] **Step 6: Commit** `feat(dzb-01a-3): runInSnapshot, isTransient, a catalog caching switch; the pool never prepares (ALTER … TYPE)`.

---

### Task 4: The engine — subscribe, the cycle, the cache

**Files:** Create `src/subscriptions/engine.ts`, `test/support/engine.ts`; extend the barrel. Test: `test/subscriptions/integration/engine.test.ts`.

**Interfaces — produces:**
```ts
type EngineEvent<R> =
  | { kind: "value"; cycle: number | null; value: R }   // null: a fresh value from its own snapshot
  | { kind: "error"; cycle: number | null; error: unknown }
  | { kind: "reset"; reason: string };
interface EngineStats { cycles: number; failedCycles: number; reruns: number; uselessReruns: number; transientReruns: number; pushes: number }
class EngineDownError extends Error {}
class CommittedUnconfirmedError extends Error { readonly commitLsn: string; readonly value: unknown }
class SubscriptionEngine<S> {
  constructor(opts: { runtime: Runtime<S>; sql: SQL; connections?: number; barrierTimeoutMs?: number; pruneEveryMs?: number; onError?: (e: unknown) => void });
  subscribe<A, R>(name: string, def: QueryDef<S, A, R>, args: A, listener: (e: EngineEvent<R>) => void): Promise<() => void>;
  onEvent(e: StreamEvent): void;
  flush(): Promise<number>;
  mutate<A, R>(def: MutationDef<S, A, R>, args: A): Promise<{ value: R; cycle: number; commitLsn: string }>;   // Task 5
  reset(reason: string): void;   // Task 7
  resume(): void;                // Task 7
  readonly stats: EngineStats;
  get bufferSize(): number;
  close(): void;
}
```

- [ ] **Step 1: The support harness** — `test/support/engine.ts`:
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
  capture: PgoutputCapture;
}

export async function withEngine(
  fn: (h: EngineHarness) => Promise<void>,
  opts: { connections?: number; barrierTimeoutMs?: number; pruneEveryMs?: number } = {},
): Promise<void> {
  await withApp(async (sql, names) => {
    const runtime = new Runtime({ sql, schema, publication: names.publication });
    const engine = new SubscriptionEngine({ runtime, sql, ...opts });
    const capture = new PgoutputCapture({ connection: pgConfig, names });
    await capture.start({ onEvent: (e) => engine.onEvent(e), onError: (e) => engine.reset(String(e)) });
    try {
      await fn({ sql, names, runtime, engine, capture });
    } finally {
      engine.close();
      await capture.stop(); // idempotent: a test may have stopped it already
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
      for (const w of [...waiters])
        if (w.pred(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
    },
    wait(pred: (e: EngineEvent<R>) => boolean, ms = 5_000): Promise<EngineEvent<R>> {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return Promise.race([
        new Promise<EngineEvent<R>>((resolve) => waiters.push({ pred, resolve })),
        Bun.sleep(ms).then((): never => {
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

- [ ] **Step 2: Failing tests** — `test/subscriptions/integration/engine.test.ts`:
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

  test("two subscribes of one key at once share one entry; one unsubscribing leaves the other live", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      let runs = 0;
      const q = query(async (ctx) => {
        runs++;
        return (await ctx.db.select().from(users)).length;
      });
      const a = recorder<number>(),
        b = recorder<number>();
      const [offA] = await Promise.all([engine.subscribe("k", q, {}, a.listener), engine.subscribe("k", q, {}, b.listener)]);
      expect(runs).toBe(1);
      offA();
      offA(); // idempotent
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await b.wait((e) => e.kind === "value" && e.value === 1);
    });
  });

  test("a listener that throws does not keep the value from the others", async () => {
    await withEngine(async ({ sql: pool, engine }) => {
      const q = query(async (ctx) => (await ctx.db.select().from(users)).length);
      await engine.subscribe("k", q, {}, (e) => {
        if (e.kind === "value" && e.value === 1) throw new Error("closed socket");
      });
      const b = recorder<number>();
      await engine.subscribe("k", q, {}, b.listener);
      await pool.unsafe(`insert into dzb_app.users(name) values ('x')`);
      await b.wait((e) => e.kind === "value" && e.value === 1);
    });
  });

  test("a fresh value carries no cycle id", async () => {
    await withEngine(async ({ engine }) => {
      const r = recorder<number>();
      await engine.subscribe("k", query(async (ctx) => (await ctx.db.select().from(users)).length), {}, r.listener);
      expect(r.last()).toMatchObject({ kind: "value", cycle: null });
    });
  });
});
```


- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement `src/subscriptions/engine.ts`**

```ts
// The subscription engine: keeps every subscribed query's value current.
//
// Stream side (onEvent, synchronous): a committed transaction's table projection is appended to the buffer, then
// applied to the index (rule B; DDL dirties everything and suspends catalog caching). Cycle side (async, one at a
// time, while anything is dirty): export S; a barrier (every commit visible in S applied); re-run the dirty
// entries whose current value S contains, in S (P-M10); re-register with S (the replay re-dirties what S missed);
// push the changed values as one batch; prune. Entries S does not contain wait for the next cycle, so no
// subscriber ever goes back in time.
import type { SQL } from "bun";
import { emitBarrier, lsnToBigInt, type StreamEvent } from "../capture";
import { isTransient, type MutationDef, parseSnapshot, type QueryDef, type Runtime, type SnapshotCall } from "../runtime";
import { project, RecentCommits } from "./buffer";
import { Registry } from "./registry";
import { stableHash } from "./stable";
import { contains, type Visibility, visibilityOf, visibleIn } from "./xid";

export type EngineEvent<R> =
  | { kind: "value"; cycle: number | null; value: R }
  | { kind: "error"; cycle: number | null; error: unknown }
  | { kind: "reset"; reason: string };

export interface EngineStats {
  cycles: number;
  failedCycles: number;
  reruns: number;
  uselessReruns: number; // re-run, same result: the cost of table-level invalidation (the number 01b must lower)
  transientReruns: number;
  pushes: number;
}

export class EngineDownError extends Error {
  override name = "EngineDownError";
  constructor(reason = "the change stream is down; subscribe again after resume()") {
    super(reason);
  }
}

export class CommittedUnconfirmedError extends Error {
  override name = "CommittedUnconfirmedError";
  constructor(
    readonly commitLsn: string,
    readonly value: unknown,
    cause: unknown,
  ) {
    super("the mutation COMMITTED, but its effect could not be confirmed in the change stream", { cause });
  }
}

type Listener = (e: EngineEvent<unknown>) => void;

interface CacheEntry<S extends Record<string, unknown>> {
  key: string;
  run: SnapshotCall<S>;
  shareable: boolean;
  hash: string;
  last: EngineEvent<unknown>;
  visibility: Visibility; // the snapshot the subscribers' current value comes from
  listeners: Set<Listener>;
}

function deliver(l: Listener, e: EngineEvent<unknown>): void {
  try {
    l(e);
  } catch {
    // one subscriber's failure (a closed socket) must not keep the value from the others
  }
}

export class SubscriptionEngine<S extends Record<string, unknown>> {
  readonly stats: EngineStats = { cycles: 0, failedCycles: 0, reruns: 0, uselessReruns: 0, transientReruns: 0, pushes: 0 };
  private readonly buffer = new RecentCommits();
  private readonly registry = new Registry<string>();
  private readonly entries = new Map<string, CacheEntry<S>>();
  private readonly pending = new Map<string, Promise<CacheEntry<S>>>();
  private readonly barriers = new Map<string, { expected?: bigint; seen?: bigint; resolve: () => void }>();
  private readonly inflight = new Set<number>(); // tickets of fresh queries not registered yet (start order)
  private ticket = 0;
  private started = 0;
  private generation = 0;
  private down = false;
  private closed = false;
  private running = false;
  private forced = false;
  private failures = 0;
  private ddlPending: number | null = null;
  private uniq = 0;
  private cycleWaiters: { after: number; resolve: (id: number) => void; reject: (e: unknown) => void }[] = [];
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly opts: {
      runtime: Runtime<S>;
      sql: SQL;
      connections?: number;
      barrierTimeoutMs?: number;
      pruneEveryMs?: number;
      onError?: (e: unknown) => void;
    },
  ) {
    this.pruneTimer = setInterval(() => void this.pruneNow().catch((e) => this.opts.onError?.(e)), opts.pruneEveryMs ?? 1_000);
  }

  get bufferSize(): number {
    return this.buffer.size;
  }

  async subscribe<A, R>(name: string, def: QueryDef<S, A, R>, args: A, listener: (e: EngineEvent<R>) => void): Promise<() => void> {
    if (this.down || this.closed) throw new EngineDownError();
    const shared = `${name}\u0000${stableHash(args)}`;
    // Check-then-create with no await in between: two subscribes of one key in the same tick share one open.
    const live = this.entries.get(shared);
    let promise = live?.shareable ? Promise.resolve(live) : this.pending.get(shared);
    const joined = promise !== undefined;
    if (!promise) promise = this.open(shared, def, structuredClone(args));
    let entry = await promise;
    if (joined && (!entry.shareable || this.entries.get(entry.key) !== entry)) entry = await this.open(shared, def, structuredClone(args));
    const l = listener as Listener;
    entry.listeners.add(l);
    deliver(l, entry.last);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.listeners.delete(l);
      if (entry.listeners.size === 0 && this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
        this.registry.remove(entry.key);
      }
    };
  }

  private open<A, R>(shared: string, def: QueryDef<S, A, R>, args: A): Promise<CacheEntry<S>> {
    const gen = this.generation;
    const ticket = ++this.ticket;
    this.inflight.add(ticket);
    const p = (async () => {
      try {
        const r = await this.opts.runtime.runQuery(def, args);
        if (gen !== this.generation || this.down) throw new EngineDownError("the change stream reset during subscribe");
        const shareable = r.readSet.volatile.length === 0;
        const key = shareable ? shared : `${shared}\u0000${++this.uniq}`;
        const visibility = visibilityOf(r.snapshot);
        const entry: CacheEntry<S> = {
          key,
          run: (ctx) => def.handler(ctx, args),
          shareable,
          hash: stableHash(r.value),
          last: { kind: "value", cycle: null, value: r.value },
          visibility,
          listeners: new Set(),
        };
        this.entries.set(key, entry);
        if (this.registry.register(key, r.readSet, visibility, this.buffer)) this.schedule();
        return entry;
      } finally {
        this.inflight.delete(ticket);
        if (this.pending.get(shared) === p) this.pending.delete(shared);
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
    if (txn.ddl) {
      // A lookup made under a snapshot that predates this DDL must not be cached (plan review A3).
      this.opts.runtime.catalog.clear();
      this.opts.runtime.catalog.caching = false;
      this.ddlPending = txn.xid;
    }
    const p = project(txn);
    this.buffer.append(txn.xid, p);
    if (this.registry.apply(txn.xid, p).length || this.registry.dirtyCount > 0) this.schedule();
  }

  flush(): Promise<number> {
    if (this.closed) return Promise.reject(new EngineDownError("engine closed"));
    const after = this.started;
    const p = new Promise<number>((resolve, reject) => this.cycleWaiters.push({ after, resolve, reject }));
    this.forced = true;
    this.schedule();
    return p;
  }

  async mutate<A, R>(def: MutationDef<S, A, R>, args: A): Promise<{ value: R; cycle: number; commitLsn: string }> {
    const run = await this.opts.runtime.runMutation(def, args);
    return { value: run.value, cycle: await this.flush(), commitLsn: run.commitLsn }; // Task 5 replaces this
  }

  reset(_reason: string): void {} // Task 7

  resume(): void {} // Task 7

  close(): void {
    this.closed = true;
    this.down = true;
    clearInterval(this.pruneTimer);
    for (const w of this.cycleWaiters) w.reject(new EngineDownError("engine closed"));
    this.cycleWaiters = [];
  }

  private schedule(): void {
    if (this.closed || this.down || this.running) return;
    if (!this.forced && this.registry.dirtyCount === 0) return;
    void this.loop();
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (!this.closed && !this.down && (this.forced || this.registry.dirtyCount > 0)) {
        this.forced = false;
        try {
          await this.cycle();
          this.failures = 0;
        } catch (e) {
          this.stats.failedCycles++;
          this.opts.onError?.(e);
          this.failures++;
          this.forced = this.forced || this.cycleWaiters.length > 0;
          await Bun.sleep(Math.min(2_000, 50 * 2 ** this.failures)); // retry: dirty entries must not stay stuck
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async barrier(): Promise<void> {
    const id = crypto.randomUUID();
    let resolve!: () => void;
    const seen = new Promise<void>((r) => {
      resolve = r;
    });
    const w: { expected?: bigint; seen?: bigint; resolve: () => void } = { resolve };
    this.barriers.set(id, w);
    const ms = this.opts.barrierTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          w.expected = lsnToBigInt(await emitBarrier(this.opts.sql, id));
          if (w.seen === w.expected) w.resolve();
          await seen;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`barrier not seen in the stream within ${ms} ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.barriers.delete(id);
    }
  }

  private async cycle(): Promise<void> {
    const id = ++this.started;
    const gen = this.generation;
    const ex = await this.opts.sql.reserve();
    try {
      await ex.unsafe("begin isolation level repeatable read read only");
      const ticketAtExport = this.ticket;
      const [{ sid, snap }] = await ex.unsafe("select pg_export_snapshot() as sid, pg_current_snapshot()::text as snap");
      await this.barrier();
      const S = visibilityOf(parseSnapshot(snap as string));
      // Only entries whose current value S contains: re-running a newer value at an older S would go back in time.
      const due = this.registry
        .dirtyKeys()
        .map((k) => this.entries.get(k))
        .filter((e): e is CacheEntry<S> => e !== undefined && contains(S, e.visibility));
      const lanes = Math.max(1, Math.min(this.opts.connections ?? 4, due.length));
      const chunks: CacheEntry<S>[][] = Array.from({ length: lanes }, () => []);
      due.forEach((e, i) => chunks[i % lanes]!.push(e));
      const results = due.length
        ? await Promise.all(chunks.map((c) => this.opts.runtime.runInSnapshot(sid as string, c.map((e) => e.run))))
        : [];
      if (gen !== this.generation) return; // reset while re-running: nothing from before the reset may be pushed
      const changed: CacheEntry<S>[] = [];
      chunks.forEach((chunk, lane) =>
        chunk.forEach((entry, i) => {
          const r = results[lane]![i]!;
          this.stats.reruns++;
          if (this.entries.get(entry.key) !== entry) return; // unsubscribed (or replaced) during the cycle
          if (!r.ok && isTransient(r.error)) {
            this.stats.transientReruns++; // stays dirty: retried next cycle, never cached as the result
            return;
          }
          this.registry.register(entry.key, r.readSet, S, this.buffer);
          entry.visibility = S;
          if (r.readSet.volatile.length) entry.shareable = false;
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
      if (this.ddlPending !== null && visibleIn(this.ddlPending, S)) {
        this.opts.runtime.catalog.clear();
        this.opts.runtime.catalog.caching = true;
        this.ddlPending = null;
      }
      this.pruneBelow(S.xmin, ticketAtExport);
      this.stats.cycles++;
      for (const entry of changed)
        for (const l of entry.listeners) {
          this.stats.pushes++;
          deliver(l, entry.last);
        }
      this.cycleWaiters = this.cycleWaiters.filter((w) => {
        if (w.after >= id) return true;
        w.resolve(id);
        return false;
      });
    } finally {
      await ex.unsafe("rollback").catch(() => {});
      ex.release();
    }
  }

  // A buffered commit can go once every registration still to come sees it: fresh queries started after the
  // snapshot behind `xmin` have an xmin at least as large; the ones started before it must finish first.
  private pruneBelow(xmin: number, ticketAtSnapshot: number): void {
    for (const t of this.inflight) if (t <= ticketAtSnapshot) return;
    this.buffer.prune(xmin);
  }

  private async pruneNow(): Promise<void> {
    if (this.closed || this.buffer.size === 0) return;
    const ticketAt = this.ticket;
    const [{ x }] = await this.opts.sql`select pg_snapshot_xmin(pg_current_snapshot())::text as x`;
    this.pruneBelow(Number(BigInt(x as string) % 2n ** 32n), ticketAt);
  }
}
```
Barrel: `export { CommittedUnconfirmedError, EngineDownError, type EngineEvent, type EngineStats, SubscriptionEngine } from "./engine";`

- [ ] **Step 5: Run — expect PASS**; typecheck; `bun run check`.
- [ ] **Step 6: Sabotage one at a time, each turning its named test red** (restore with `cp`): drop the `if (hash === entry.hash)` short-circuit (same-value test); let joiners share a non-shareable entry (`now()` test); `await Promise.resolve()` before `this.pending.set` in `open` (concurrent subscribes test: `runs` = 2); remove `deliver`'s try/catch (listener test); make `off` delete by key without the identity check and call it twice after a re-subscribe of the same key (add that case to the concurrent test if the first sabotage does not already redden it).
- [ ] **Step 7: Commit** `feat(dzb-01a-3): the subscription engine — cycles in one exported snapshot, never back in time, barriers by id and LSN, a shared cache`.

---

### Task 5: Read-your-writes by position (P-A7)

**Files:** Modify `src/subscriptions/engine.ts` (`mutate`). Test: `test/subscriptions/integration/ryw.test.ts`.

- [ ] **Step 1: Failing tests**
```ts
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { CommittedUnconfirmedError } from "../../../src/subscriptions";
import { posts, schema } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query, mutation } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";
const add = mutation(async (ctx, a: { t: string }) => ctx.db.insert(posts).values({ authorId: U, title: a.t }));

test("the returned cycle carries the write: the first push at or after it contains it — 20 in a row", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
    const titles = query(async (ctx) => (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title));
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    for (let i = 0; i < 20; i++) {
      const { cycle } = await engine.mutate(add, { t: `p${i}` });
      const e = await r.wait((x) => x.kind === "value" && x.cycle !== null && x.cycle >= cycle);
      expect(e.kind === "value" && e.value.includes(`p${i}`)).toBe(true);
    }
  });
});

test("a committed mutation whose effect cannot be confirmed is CommittedUnconfirmedError, not a failure", async () => {
  await withEngine(
    async ({ sql: pool, capture, engine }) => {
      await pool.unsafe(`insert into dzb_app.users(id, name) values ('${U}', 'Dan')`);
      await capture.stop();
      const err = await engine.mutate(add, { t: "landed" }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CommittedUnconfirmedError);
      expect((err as CommittedUnconfirmedError).commitLsn).toMatch(/\//);
      const [{ n }] = await pool.unsafe("select count(*)::int as n from dzb_app.posts where title = 'landed'");
      expect(n).toBe(1); // it DID commit
    },
    { barrierTimeoutMs: 500 },
  );
});
```
- [ ] **Step 2: Run — expect FAIL** (the second test: a plain error).
- [ ] **Step 3: Implement** — replace `mutate`:
```ts
  // P-A7: read-your-writes by position. After COMMIT, a barrier written after it proves the stream has applied the
  // commit (its entries are dirty); the first cycle that starts after that exports a snapshot containing the commit.
  // The reply names that cycle; the client resolves when it has received a transition at or after it — a slow
  // re-run delays the transition, never the reply. A confirmation failure is not a mutation failure.
  async mutate<A, R>(def: MutationDef<S, A, R>, args: A): Promise<{ value: R; cycle: number; commitLsn: string }> {
    const run = await this.opts.runtime.runMutation(def, args);
    try {
      if (this.down || this.closed) throw new EngineDownError();
      await this.barrier();
      const cycle = this.started + 1;
      this.forced = true;
      this.schedule();
      return { value: run.value, cycle, commitLsn: run.commitLsn };
    } catch (e) {
      throw new CommittedUnconfirmedError(run.commitLsn, run.value, e);
    }
  }
```
- [ ] **Step 4: Run — expect PASS.** Sabotage: return `cycle: 0` → the first test red on its second iteration (an earlier push without `p1` matches). Restore.
- [ ] **Step 5: Commit** `feat(dzb-01a-3): read-your-writes by position — the reply names the cycle; an unconfirmed commit is CommittedUnconfirmedError`.

---

### Task 6: The consistency properties (deterministic)

**Files:** Test: `test/subscriptions/integration/properties.test.ts`.

- [ ] **Step 1: Tests**
```ts
import { expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { functions } from "../../../src/runtime";
import { comments, posts, schema } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query } = functions<typeof schema>();
const U = "0190a000-0000-7000-8000-000000000001";
const titles = query(async (ctx) => (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title).sort());

test("a commit its snapshot saw as running reaches the subscription through apply()", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    const held = await pool.reserve();
    await held.unsafe("begin");
    await held.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'held')`);
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    await held.unsafe("commit");
    held.release();
    await r.wait((e) => e.kind === "value" && e.value.includes("held"));
  });
});

test("a commit streamed during the handler is caught by the replay (and not pruned under it)", async () => {
  await withEngine(
    async ({ sql: pool, engine }) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gated = query(async (ctx) => {
        const rows = (await ctx.db.select().from(posts).where(eq(posts.authorId, U))).map((p) => p.title);
        await gate;
        return rows;
      });
      const held = await pool.reserve();
      await held.unsafe("begin");
      await held.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'during')`);
      const r = recorder<string[]>();
      const subscribed = engine.subscribe("gated", gated, {}, r.listener);
      await Bun.sleep(100); // the handler's snapshot exists, with the held xid running
      await held.unsafe("commit");
      held.release();
      await engine.flush(); // streamed and applied — to nothing registered yet
      await Bun.sleep(300); // longer than pruneEveryMs: a prune that ignored the in-flight query would drop it now
      release();
      await subscribed;
      expect(r.events[0]).toMatchObject({ kind: "value", value: [] }); // the premise: the fresh value missed it
      await r.wait((e) => e.kind === "value" && e.value.includes("during"));
    },
    { pruneEveryMs: 50 },
  );
});

test("two tables moved by one transaction never disagree in a cycle", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    await pool.unsafe(`insert into dzb_app.comments(post_id, body) select uuidv7(), 'c' from generate_series(1, 40)`);
    const nPosts = query(async (ctx) => (await ctx.db.select({ n: count() }).from(posts))[0]!.n);
    const nComments = query(async (ctx) => (await ctx.db.select({ n: count() }).from(comments))[0]!.n);
    const latest = { p: 0, c: 40 };
    const perCycle = new Map<number, { p?: number; c?: number }>();
    const note = (k: "p" | "c") => (e: { kind: string; cycle?: number | null; value?: unknown }) => {
      if (e.kind === "value" && typeof e.cycle === "number") perCycle.set(e.cycle, { ...perCycle.get(e.cycle), [k]: e.value as number });
    };
    await engine.subscribe("p", nPosts, {}, note("p"));
    await engine.subscribe("c", nComments, {}, note("c"));
    let stop = false;
    const writer = (async () => {
      while (!stop) {
        if (Math.random() < 0.5)
          await pool.unsafe(`update dzb_app.comments set body = body || '.' where id = (select id from dzb_app.comments limit 1)`);
        else
          await pool.begin(async (tx) => {
            await tx.unsafe(`delete from dzb_app.comments where id = (select id from dzb_app.comments limit 1)`);
            await tx.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'moved')`);
          });
      }
    })();
    await Bun.sleep(2_000);
    stop = true;
    await writer;
    await engine.flush();
    let checked = 0;
    for (const id of [...perCycle.keys()].sort((a, b) => a - b)) {
      Object.assign(latest, perCycle.get(id));
      checked++;
      expect(latest.p + latest.c).toBe(40);
    }
    expect(checked).toBeGreaterThan(10);
  });
}, 30_000);

test("a rename plus a view under the old name: the subscription follows the view", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    const all = query(async (ctx) => (await ctx.db.select().from(posts)).length);
    const r = recorder<number>();
    await engine.subscribe("all", all, {}, r.listener);
    await pool.unsafe(`alter table dzb_app.posts rename to articles; create view dzb_app.posts as select * from dzb_app.articles`);
    await engine.flush();
    await pool.unsafe(`insert into dzb_app.articles(author_id, title) values ('${U}', 'via the view')`);
    await r.wait((e) => e.kind === "value" && e.value === 1);
  });
});

test("a failed cycle does not leave dirty entries stuck", async () => {
  await withEngine(async ({ sql: pool, runtime, engine }) => {
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    const real = runtime.runInSnapshot.bind(runtime);
    let failOnce = true;
    runtime.runInSnapshot = async (...a: Parameters<typeof real>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("lane lost");
      }
      return real(...a);
    };
    await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'first')`);
    await r.wait((e) => e.kind === "value" && e.value.includes("first"));
    expect(engine.stats.failedCycles).toBeGreaterThan(0);
  });
});

test("a transient error is retried, never pushed as the result", async () => {
  await withEngine(async ({ sql: pool, runtime, engine }) => {
    const r = recorder<string[]>();
    await engine.subscribe("titles", titles, {}, r.listener);
    const real = runtime.runInSnapshot.bind(runtime);
    let once = true;
    runtime.runInSnapshot = async (id: string, calls: Parameters<typeof real>[1]) => {
      const out = await real(id, calls);
      if (!once) return out;
      once = false;
      return out.map((x) => ({ ok: false as const, error: Object.assign(new Error("timeout"), { name: "PostgresError", errno: "57014" }), readSet: x.readSet }));
    };
    await pool.unsafe(`insert into dzb_app.posts(author_id, title) values ('${U}', 'eventually')`);
    await r.wait((e) => e.kind === "value" && e.value.includes("eventually"));
    expect(r.events.some((e) => e.kind === "error")).toBe(false);
    expect(engine.stats.transientReruns).toBeGreaterThan(0);
  });
});
```
(`test/support/app.ts` already exports `comments`.)

- [ ] **Step 2: Run — expect PASS.**
- [ ] **Step 3: Sabotage one at a time — each must turn its test red** (restore with `cp`):
  (a) `Registry.register` without the replay → the gated test stays at `[]`.
  (b) `visibleIn` treating `xip` as visible → the held-open test and the gated test stay stale.
  (c) `pruneBelow` ignoring in-flight queries → the gated test.
  (d) `cycle()` without `await this.barrier()` → the two-table test.
  (e) keep `catalog.caching` on across DDL → the rename-plus-view test.
  (f) `schedule()` only on newly dirty entries (`if (this.registry.apply(...).length) this.schedule()`) → the failed-cycle test.
  (g) cache transient errors as results → the transient test.
  If (d) stays green over three runs, raise the writer's pace or add a second touch-only table before accepting the property as tested.
- [ ] **Step 4: Commit** `test(dzb-01a-3): deterministic consistency properties — held-open and gated commits, two tables moved together, DDL, failure recovery`.

---

### Task 7: Reset and resume; a bounded buffer; the reactive-latency bench

**Files:** Modify `src/subscriptions/engine.ts` (`reset`, `resume`). Tests: `test/subscriptions/integration/reset.test.ts`, `test/subscriptions/integration/buffer.test.ts`. Create `load/subscriptions/reactive_latency.ts`; modify `docs/BENCH.md`.

- [ ] **Step 1: Failing tests**
```ts
// test/subscriptions/integration/reset.test.ts
import { expect, test } from "bun:test";
import { functions } from "../../../src/runtime";
import { EngineDownError } from "../../../src/subscriptions";
import { schema, users } from "../../support/app";
import { recorder, withEngine } from "../../support/engine";

const { query } = functions<typeof schema>();

test("reset puts the engine down: subscribers are told, nothing old is pushed, subscribing waits for resume()", async () => {
  await withEngine(async ({ sql: pool, engine }) => {
    let runs = 0;
    const q = query(async (ctx) => {
      runs++;
      return (await ctx.db.select().from(users)).length;
    });
    const r = recorder<number>();
    await engine.subscribe("n", q, {}, r.listener);
    engine.reset("walsender terminated");
    expect(r.last()).toMatchObject({ kind: "reset" });
    await expect(engine.subscribe("n", q, {}, () => {})).rejects.toBeInstanceOf(EngineDownError);
    await pool.unsafe(`insert into dzb_app.users(name) values ('after reset')`);
    await Bun.sleep(200);
    expect(r.events.at(-1)?.kind).toBe("reset");
    engine.resume();
    const again = recorder<number>();
    await engine.subscribe("n", q, {}, again.listener);
    expect(runs).toBe(2);
    expect(again.last()).toMatchObject({ kind: "value", value: 1 });
  });
});
```
```ts
// test/subscriptions/integration/buffer.test.ts
import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine";

test("with no subscription at all, the buffer stays bounded under a write workload", async () => {
  await withEngine(
    async ({ sql: pool, engine }) => {
      let peak = 0;
      for (let i = 0; i < 200; i++) {
        await pool.unsafe(`insert into dzb_app.users(name) values ('u${i}')`);
        peak = Math.max(peak, engine.bufferSize);
      }
      await Bun.sleep(300);
      expect(peak).toBeGreaterThan(0);
      expect(engine.bufferSize).toBeLessThan(20);
    },
    { pruneEveryMs: 50 },
  );
});
```
- [ ] **Step 2: Run — expect FAIL** (reset is empty).
- [ ] **Step 3: Implement**
```ts
  // The capture failed (spec D14, P-M6): commits may have been lost, so no registered result can be trusted. Every
  // subscriber is told; the engine stays down — refusing subscribes — until resume(), which the caller invokes only
  // after recreating the slot and restarting the capture, so no new snapshot predates the new slot.
  reset(reason: string): void {
    this.generation++;
    this.down = true;
    const listeners = [...this.entries.values()].flatMap((e) => [...e.listeners]);
    for (const key of this.entries.keys()) this.registry.remove(key);
    this.entries.clear();
    this.pending.clear();
    this.buffer.clear();
    this.opts.runtime.catalog.clear();
    for (const w of this.cycleWaiters) w.reject(new EngineDownError());
    this.cycleWaiters = [];
    for (const l of listeners) deliver(l, { kind: "reset", reason });
  }

  resume(): void {
    if (!this.closed) this.down = false;
  }
```
- [ ] **Step 4: Run — expect PASS.** Sabotages: `reset` without `this.down = true` (the rejected subscribe resolves: red); make `pruneNow` return immediately (buffer test red). Restore.
- [ ] **Step 5: The bench** — `load/subscriptions/reactive_latency.ts`:
```ts
// Commit → push latency and the useless re-run ratio of table-level invalidation (DZB-01a-3). N subscriptions,
// each on the posts of its own author; 200 raw-SQL inserts, each for ONE author: at table level every subscription
// re-runs on every insert, N−1 of them uselessly — the number 01b must beat.
//   bun --preload ./test/support/env.ts load/subscriptions/reactive_latency.ts
import { eq } from "drizzle-orm";
import { functions } from "../../src/runtime";
import { posts, schema } from "../../test/support/app";
import { withEngine } from "../../test/support/engine";

const { query } = functions<typeof schema>();
const byAuthor = query(async (ctx, a: { id: string }) => (await ctx.db.select().from(posts).where(eq(posts.authorId, a.id))).length);
const author = (i: number) => `0190a000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;

for (const n of [1, 100, 1000]) {
  await withEngine(
    async ({ sql, engine }) => {
      const seen = new Map<number, (t: number) => void>();
      for (let i = 0; i < n; i++)
        await engine.subscribe("byAuthor", byAuthor, { id: author(i) }, (e) => {
          if (i === 0 && e.kind === "value") seen.get(e.value as number)?.(performance.now());
        });
      const base = { ...engine.stats };
      const xs: number[] = [];
      for (let k = 1; k <= 200; k++) {
        const pushed = new Promise<number>((r) => seen.set(k, r));
        const t0 = performance.now();
        await sql.unsafe(`insert into dzb_app.posts(author_id, title) values ('${author(0)}', 't')`);
        xs.push((await pushed) - t0);
      }
      xs.sort((a, b) => a - b);
      const reruns = engine.stats.reruns - base.reruns;
      const useless = engine.stats.uselessReruns - base.uselessReruns;
      console.log(JSON.stringify({ subscriptions: n, p50_ms: +xs[100]!.toFixed(2), p99_ms: +xs[197]!.toFixed(2), reruns, useless, useless_ratio: +(useless / reruns).toFixed(3) }));
    },
    { connections: 4 },
  );
}
process.exit(0);
```
Run it; record `## Subscriptions (DZB-01a-3)` in `docs/BENCH.md` from its output (subscriptions, p50/p99 commit → push, re-runs, useless, ratio; the command; what it measured).
- [ ] **Step 6: Full suite, check, commit** — `bun run check && bun run test`; slots 0. Commit `feat(dzb-01a-3): reset/resume, a bounded buffer; bench: reactive latency and the useless re-run ratio`.

---

### Task 8: Final review

- [ ] One fresh reviewer (most capable model) on the branch, with the plan's Review Focus and the v2 table: every finding of the plan review must be closed by code AND by a test that fails without it. Critical/Important fixed test-first; the review recorded in the spec's POST-REVIEW block; the owner merges.
