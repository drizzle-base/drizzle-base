# STUDIO-00 S3a — Editing: pending edits, atomic save, live conflicts, add and delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit cells, add rows and delete rows in the studio, Drizzle Studio's way (edits pend until Save), with two
things it lacks: a save is **atomic** (all or nothing, and a failure keeps every edit), and it is **conflict-aware**
(an edit carries the value it started from; a cell changed elsewhere meanwhile is shown live and refused on save
until the person chooses "keep mine" or "use theirs").

**Architecture:** The contract gains `applyEdits(table, { inserts, updates })` — one atomic write — where an update
may carry `expected` (the original values of the edited columns); a mismatch, or a row that is gone, is a
`conflict` error naming the row. Pending edits are a pure per-table `TableDraft` (`src/edit/draft.ts`) kept in the
studio's memory for every table, so switching tables or going Back loses nothing; `findConflicts` compares a draft
with the live page. The grid gets single-cell selection and in-place editors (typed by the same parser as filters);
JSON and arrays open an expanded editor. Deleting is immediate, after a confirmation, as in Drizzle Studio.

**Tech Stack:** as before; one more vendored shadcn primitive (Dialog, Base UI). No new dependency.

**Spec:** `docs/specs/STUDIO-00-ui-on-mocks.md` §4 rows "Inline editing — add, update, delete rows" and "Editors"
(the date/time picker, the Expand Row panel and any code editor are S3b). Decisions taken with the owner on
25 Sep 2026: atomic save with optimistic concurrency (`expected` + `conflict`); drafts kept per table in memory
instead of Drizzle Studio's discard prompt, `beforeunload` and `onDirtyChange` for the host; S3 split into S3a/S3b.

## Global Constraints

- Branch `feat/studio-s3-editing`; only `packages/studio/` and the spec. Before merging, check whether `main` moved.
- A save is one `applyEdits` call: nothing is written unless everything is; on failure every pending edit stays.
- An update always carries `expected` for the columns it changes; a stale one is refused (`conflict`), never merged.
- Enum and boolean editors offer NULL only when the column is nullable (Drizzle Studio's defect is not copied).
- Views and tables without a primary key show no editing affordance.
- Biome/TS strict; `bun run check` green before every commit; sabotages restored with `cp`.

## Review Focus

1. **A cell changed in another tab while I edit it** must not be overwritten silently: live marker, Save blocked
   until resolved, and a race the page has not shown yet is refused by the data source. (Task 1 conformance
   `a stale expected value is a conflict…`; Task 4 test `a change elsewhere to an edited cell…`.)
2. **A save where one change is bad** must write nothing and keep all edits. (Task 1 `one bad change commits
   nothing`; Task 4 `a failed save keeps every edit and says why`.)
3. **A row deleted elsewhere while it has pending edits**: the save says so and offers to drop that row's edits.
   (Task 1 `an expected value on a row that is gone is a conflict`; Task 4 `a row deleted elsewhere…`.)
4. **A new row missing a required value** cannot be saved, and says which. (Task 2 `missingRequired`; Task 4.)
5. **Edits survive switching tables and Back**; closing the tab with edits warns. (Task 4 `edits survive…`;
   Task 5 e2e `unsaved edits warn before the tab closes`.)

---

### Task 1: `applyEdits` — atomic, conflict-aware

**Files:**
- Modify: `packages/studio/src/contract/index.ts`, `src/mock/log.ts`, `src/mock/source.ts`, `test/conformance.ts`,
  `docs/specs/STUDIO-00-ui-on-mocks.md`

**Interfaces:**
- Produces: `interface RowUpdate { key: RowKey; values: Row; expected?: Row }`,
  `interface Edits { inserts: Row[]; updates: RowUpdate[] }`, `StudioDataSource.applyEdits(table: TableRef, edits:
  Edits): Promise<{ inserted: RowKey[] }>`, error code `"conflict"`, `StudioDataSourceError.key?: RowKey`.
  Log op `{ kind: "edit"; table: TableRef; rows: Row[]; changes: { key: RowKey; values: Row }[] }`.

- [ ] **Step 1: The failing conformance tests**

In `test/conformance.ts`, before `it("unknown tables and columns are reported with their codes"`, add:

```ts
    it("applyEdits inserts and updates in one write; one push shows both", async (open) => {
      const ds = await open();
      const [a] = await ds.insertRows(ITEMS, [{ label: "a" }]);
      const w = watch(ds, req());
      const first = await w.latest((p) => p.total === 1);
      const { inserted } = await ds.applyEdits(ITEMS, {
        inserts: [{ label: "new" }],
        updates: [{ key: a ?? {}, values: { label: "A" }, expected: { label: "a" } }],
      });
      expect(inserted).toEqual([{ id: expect.any(Number) }]);
      const next = await w.latest((p) => p.revision > first.revision, "the edit's push");
      expect(labels(next)).toEqual(["A", "new"]);
      expect(w.pages.filter((p) => p.revision > first.revision)).toHaveLength(1);
      w.stop();
    });

    it("one bad change commits nothing", async (open) => {
      const ds = await open();
      const [a] = await ds.insertRows(ITEMS, [{ label: "a" }]);
      await expectCode(
        ds.applyEdits(ITEMS, { inserts: [{ rank: 1 }], updates: [{ key: a ?? {}, values: { label: "A" } }] }),
        "not_null",
      );
      const w = watch(ds, req());
      expect(labels(await w.latest())).toEqual(["a"]);
      w.stop();
    });

    it("a stale expected value is a conflict naming the row, and commits nothing", async (open) => {
      const ds = await open();
      const other = await open();
      const [a] = await ds.insertRows(ITEMS, [{ label: "a" }]);
      await other.updateRows(ITEMS, [{ key: a ?? {}, values: { label: "theirs" } }]);
      try {
        await ds.applyEdits(ITEMS, {
          inserts: [{ label: "also refused" }],
          updates: [{ key: a ?? {}, values: { label: "mine" }, expected: { label: "a" } }],
        });
        throw new Error("expected a conflict");
      } catch (e) {
        expect(e).toBeInstanceOf(StudioDataSourceError);
        expect((e as StudioDataSourceError).code).toBe("conflict");
        expect((e as StudioDataSourceError).key).toEqual(a);
      }
      const w = watch(ds, req());
      expect(labels(await w.latest())).toEqual(["theirs"]);
      w.stop();
    });

    it("an expected value on a row that is gone is a conflict", async (open) => {
      const ds = await open();
      const [a] = await ds.insertRows(ITEMS, [{ label: "a" }]);
      await ds.deleteRows(ITEMS, [a ?? {}]);
      await expectCode(
        ds.applyEdits(ITEMS, { inserts: [], updates: [{ key: a ?? {}, values: { label: "x" }, expected: { label: "a" } }] }),
        "conflict",
      );
    });

    it("a matching expected value is applied; empty edits change nothing", async (open) => {
      const ds = await open();
      const [a] = await ds.insertRows(ITEMS, [{ label: "a", rank: 1 }]);
      await ds.applyEdits(ITEMS, { inserts: [], updates: [{ key: a ?? {}, values: { rank: 2 }, expected: { rank: 1 } }] });
      expect(await ds.applyEdits(ITEMS, { inserts: [], updates: [] })).toEqual({ inserted: [] });
      const w = watch(ds, req());
      expect((await w.latest()).rows[0]?.["rank"]).toBe(2);
      w.stop();
    });

    it("applyEdits refuses read-only relations", async (open) => {
      const ds = await open();
      await expectCode(ds.applyEdits(VIEW, { inserts: [{ label: "x" }], updates: [] }), "read_only");
    });

```

Run: `cd packages/studio && bun test ./test/unit/mock-source.test.ts 2>&1 | grep -E "^\(fail\)| pass$| fail$"`
Expected: the six new tests FAIL (`applyEdits is not a function`).

- [ ] **Step 2: Contract**

In `src/contract/index.ts`:

a) After `export type RowKey = …;` add:

```ts
/** An update. `expected` holds the values of the changed columns as the editor last saw them: if the row no longer
 * has them (someone else changed it, or it is gone), the write is refused with code "conflict". */
export interface RowUpdate {
  key: RowKey;
  values: Row;
  expected?: Row;
}

export interface Edits {
  inserts: Row[];
  updates: RowUpdate[];
}
```

b) `StudioErrorCode` gains `| "conflict"` (after `"unique_violation"`), and the class becomes:

```ts
export class StudioDataSourceError extends Error {
  override readonly name = "StudioDataSourceError";

  constructor(
    readonly code: StudioErrorCode,
    message: string,
    /** The row a conflict (or another row-level failure) is about. */
    readonly key?: RowKey,
  ) {
    super(message);
  }
}
```

c) In `StudioDataSource`, after `deleteRows`:

```ts
  /** One atomic write: every insert and update, or none. Resolves with the inserted rows' keys, in order. */
  applyEdits(table: TableRef, edits: Edits): Promise<{ inserted: RowKey[] }>;
```

- [ ] **Step 3: The log op and the mock**

`src/mock/log.ts` — add to `Op`:

```ts
  | { kind: "edit"; table: TableRef; rows: Row[]; changes: { key: RowKey; values: Row }[] };
```

`src/mock/source.ts`:

a) Imports: add `type Edits` and `type RowUpdate` to the contract import.

b) In `apply`, before `case "delete":` add:

```ts
      case "edit":
        t.rows.push(...structuredClone(op.rows));
        t.serial = maxSerial(t.def, op.rows, t.serial);
        for (const c of op.changes) for (const r of t.rows) if (matchesKey(r, c.key)) Object.assign(r, structuredClone(c.values));
        break;
```

c) After the `taken` helper, add:

```ts
  const pkOf = (t: LiveTable, row: Row): RowKey =>
    Object.fromEntries(t.def.info.primaryKey.map((k) => [k, row[k] ?? null]));

  /** Validates an update against the caught-up table: columns, NOT NULL, a key that stays unique, `expected`. */
  const checkUpdate = (t: LiveTable, c: RowUpdate) => {
    checkKey(t, c.key);
    checkValues(t, c.values);
    const rows = t.rows.filter((r) => matchesKey(r, c.key));
    if (c.expected) {
      const label = JSON.stringify(c.key);
      const row = rows[0];
      if (!row) throw new StudioDataSourceError("conflict", `row ${label} is gone: deleted elsewhere`, c.key);
      for (const [column, v] of Object.entries(c.expected)) {
        if (!same(row[column], v)) {
          throw new StudioDataSourceError("conflict", `"${column}" of row ${label} was changed elsewhere`, c.key);
        }
      }
    }
    if (!t.def.info.primaryKey.some((k) => Object.hasOwn(c.values, k))) return;
    for (const row of rows) {
      const k = keyOf(t, { ...row, ...c.values });
      if (t.rows.some((other) => other !== row && keyOf(t, other) === k)) throw taken(t, k);
    }
  };

  /** Materialises inserts (defaults, NOT NULL) and refuses a key that is taken, by the table or the batch. */
  const materializeAll = (t: LiveTable, rows: Row[]): Row[] => {
    const serial = { next: t.serial };
    const full = rows.map((r) => materialize(t, r, serial));
    const seen = new Set(t.rows.map((r) => keyOf(t, r)));
    for (const r of full) {
      const k = keyOf(t, r);
      if (seen.has(k)) throw taken(t, k);
      seen.add(k);
    }
    return full;
  };
```

d) Replace the `updateRows` and `insertRows` methods (from `async updateRows(ref, changes) {` to the end of
`insertRows`) with:

```ts
    async updateRows(ref, changes) {
      await commit(() => {
        const t = writable(ref);
        for (const c of changes) checkUpdate(t, c);
        return changes.length === 0 ? null : { kind: "update", table: refOf(ref), changes: structuredClone(changes) };
      }, "studio");
    },

    async insertRows(ref, rows) {
      let keys: RowKey[] = [];
      await commit(() => {
        const t = writable(ref);
        const full = materializeAll(t, rows);
        keys = full.map((r) => pkOf(t, r));
        return full.length === 0 ? null : { kind: "insert", table: refOf(ref), rows: full };
      }, "studio");
      return keys;
    },

    async applyEdits(ref, edits: Edits) {
      let inserted: RowKey[] = [];
      await commit(() => {
        const t = writable(ref);
        for (const u of edits.updates) checkUpdate(t, u);
        const rows = materializeAll(t, edits.inserts);
        inserted = rows.map((r) => pkOf(t, r));
        if (rows.length === 0 && edits.updates.length === 0) return null;
        const changes = edits.updates.map(({ key, values }) => ({ key: structuredClone(key), values: structuredClone(values) }));
        return { kind: "edit", table: refOf(ref), rows, changes };
      }, "studio");
      return { inserted };
    },
```

- [ ] **Step 4: Run, sabotage, spec, commit**

Run: `cd packages/studio && bun run typecheck && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"` → all pass.

Sabotages (restore with `cp`): (1) remove the `if (c.expected) { … }` block → both conflict tests red; (2) make
`applyEdits` two writes — `await this.updateRows(…)` then `await this.insertRows(…)` (write it with the local
functions) → `applyEdits inserts and updates in one write` (two pushes) and `one bad change commits nothing` red.

In the spec's "Contract changes" add:

```markdown
- 25 Sep 2026 (S3a): `applyEdits(table, { inserts, updates })` is one atomic write (Drizzle Studio's save is not:
  a failing change is dropped while the others land). An update may carry `expected`, the original values of the
  columns it changes; a mismatch or a vanished row is refused with code `conflict`, and the error carries the row's
  `key`. Optimistic concurrency, because a live studio shows other people's writes arriving.
```

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "feat(studio): applyEdits — one atomic write, with expected values and conflict errors"
```

---

### Task 2: The draft (pure) and cell values

**Files:**
- Create: `packages/studio/src/edit/draft.ts`, `src/edit/values.ts`
- Test: `test/unit/draft.test.ts`, `test/unit/cell-values.test.ts`

**Interfaces:**
- Produces (`src/edit/draft.ts`): `CellEdit { value: CellValue; original: CellValue }`,
  `PendingRow { key: RowKey; cells: Record<string, CellEdit> }`, `NewRow { id: string; values: Row }`,
  `TableDraft { updates: Record<string, PendingRow>; inserts: NewRow[] }`, `EMPTY_DRAFT`,
  `setCell(draft, rowId, key, column, value, original)`, `addRow(draft): { draft; id }`,
  `setNewCell(draft, id, column, value: CellValue | undefined)`, `removeNewRow(draft, id)`, `discardRow(draft, rowId)`,
  `changeCount(draft): number`, `isDirty(draft): boolean`, `toEdits(draft): Edits`,
  `Conflict { rowId; column; mine: CellValue; theirs: CellValue }`,
  `findConflicts(draft, rows: { id: string; row: Row }[]): Conflict[]`,
  `resolveConflict(draft, conflict, choice: "mine" | "theirs"): TableDraft`,
  `missingRequired(draft, columns: ColumnInfo[]): { id: string; column: string }[]`.
- Produces (`src/edit/values.ts`): `parseCellValue(col: ColumnInfo, text: string): Parsed`,
  `textForEditing(col: ColumnInfo, value: CellValue): string`, `opensExpanded(col: ColumnInfo): boolean`.

- [ ] **Step 1: The failing tests**

`test/unit/draft.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { col } from "../../src/mock";
import {
  addRow,
  changeCount,
  discardRow,
  EMPTY_DRAFT,
  findConflicts,
  isDirty,
  missingRequired,
  removeNewRow,
  resolveConflict,
  setCell,
  setNewCell,
  toEdits,
} from "../../src/edit/draft";

const K = { id: 1 };

describe("setCell", () => {
  test("the first original is kept across edits; going back to it removes the edit", () => {
    let d = setCell(EMPTY_DRAFT, "r1", K, "name", "b", "a");
    d = setCell(d, "r1", K, "name", "c", "b");
    expect(d.updates["r1"]?.cells["name"]).toEqual({ value: "c", original: "a" });
    d = setCell(d, "r1", K, "name", "a", "c");
    expect(d.updates["r1"]).toBeUndefined();
    expect(isDirty(d)).toBe(false);
  });
});

describe("new rows", () => {
  test("added at the top; a cell set back to undefined is the default again; removable", () => {
    const one = addRow(EMPTY_DRAFT);
    const two = addRow(one.draft);
    expect(two.draft.inserts.map((r) => r.id)).toEqual([two.id, one.id]);
    let d = setNewCell(two.draft, one.id, "email", "x@example.com");
    d = setNewCell(d, one.id, "name", "X");
    d = setNewCell(d, one.id, "name", undefined);
    expect(d.inserts.find((r) => r.id === one.id)?.values).toEqual({ email: "x@example.com" });
    expect(changeCount(d)).toBe(2);
    expect(removeNewRow(d, two.id).inserts.map((r) => r.id)).toEqual([one.id]);
  });
});

test("toEdits: updates carry what they change and what they expected", () => {
  let d = setCell(EMPTY_DRAFT, "r1", K, "name", "b", "a");
  d = setCell(d, "r1", K, "age", 3, 2);
  const n = addRow(d);
  d = setNewCell(n.draft, n.id, "email", "e");
  expect(toEdits(d)).toEqual({
    inserts: [{ email: "e" }],
    updates: [{ key: K, values: { name: "b", age: 3 }, expected: { name: "a", age: 2 } }],
  });
  expect(changeCount(discardRow(d, "r1"))).toBe(1);
});

describe("conflicts", () => {
  const d = setCell(EMPTY_DRAFT, "r1", K, "name", "mine", "a");
  test("a pending cell whose live value moved away from its original is a conflict", () => {
    expect(findConflicts(d, [{ id: "r1", row: { name: "a" } }])).toEqual([]);
    expect(findConflicts(d, [{ id: "r1", row: { name: "theirs" } }])).toEqual([
      { rowId: "r1", column: "name", mine: "mine", theirs: "theirs" },
    ]);
    expect(findConflicts(d, [])).toEqual([]);
  });
  test("keep mine rebases on theirs; use theirs drops the edit", () => {
    const c = { rowId: "r1", column: "name", mine: "mine", theirs: "theirs" };
    const kept = resolveConflict(d, c, "mine");
    expect(kept.updates["r1"]?.cells["name"]).toEqual({ value: "mine", original: "theirs" });
    expect(findConflicts(kept, [{ id: "r1", row: { name: "theirs" } }])).toEqual([]);
    expect(resolveConflict(d, c, "theirs").updates["r1"]).toBeUndefined();
  });
});

test("missingRequired: NOT NULL without a default, unset or NULL, on new rows", () => {
  const columns = [
    col("id", "integer", "serial", { isPrimaryKey: true, nullable: false, hasDefault: true }),
    col("email", "text", "text", { nullable: false }),
    col("name", "text", "text"),
  ];
  const n = addRow(EMPTY_DRAFT);
  expect(missingRequired(n.draft, columns)).toEqual([{ id: n.id, column: "email" }]);
  expect(missingRequired(setNewCell(n.draft, n.id, "email", null), columns)).toHaveLength(1);
  expect(missingRequired(setNewCell(n.draft, n.id, "email", "e"), columns)).toEqual([]);
});
```

`test/unit/cell-values.test.ts`:

```ts
import { expect, test } from "bun:test";
import { opensExpanded, parseCellValue, textForEditing } from "../../src/edit/values";
import { col } from "../../src/mock";

test("arrays are JSON arrays typed element by element", () => {
  const ints = col("xs", "array", "integer[]", { elementKind: "integer" });
  expect(parseCellValue(ints, "[1, 2, null]")).toEqual({ ok: true, value: [1, 2, null] });
  expect(parseCellValue(ints, '[1, "x"]')).toEqual({ ok: false, error: '"x" is not an integer' });
  expect(parseCellValue(ints, "1,2").ok).toBe(false);
  expect(parseCellValue(ints, "[[1]]").ok).toBe(false);
});

test("other kinds use the filter parser: text keeps spaces, numbers are typed", () => {
  expect(parseCellValue(col("n", "text", "text"), " a ")).toEqual({ ok: true, value: " a " });
  expect(parseCellValue(col("n", "integer", "integer"), "7")).toEqual({ ok: true, value: 7 });
});

test("text for editing: NULL is empty, arrays and json read well", () => {
  expect(textForEditing(col("n", "text", "text"), null)).toBe("");
  expect(textForEditing(col("xs", "array", "text[]"), ["a", "b"])).toBe('["a","b"]');
  expect(textForEditing(col("j", "json", "jsonb"), '{"a":1}')).toBe('{\n  "a": 1\n}');
  expect(textForEditing(col("b", "boolean", "boolean"), false)).toBe("false");
  expect(opensExpanded(col("j", "json", "jsonb"))).toBe(true);
  expect(opensExpanded(col("t", "text", "text"))).toBe(false);
});
```

Run: `cd packages/studio && bun test ./test/unit/draft.test.ts ./test/unit/cell-values.test.ts` → FAIL (modules missing).

- [ ] **Step 2: `src/edit/draft.ts`**

```ts
import type { CellValue, ColumnInfo, Edits, Row, RowKey } from "../contract";

export interface CellEdit {
  value: CellValue;
  /** The value when the first edit of this cell began: what a save expects the row still to have. */
  original: CellValue;
}

export interface PendingRow {
  key: RowKey;
  cells: Record<string, CellEdit>;
}

/** A row to insert; `values` holds only the columns the person set (the rest take DEFAULT or NULL). */
export interface NewRow {
  id: string;
  values: Row;
}

export interface TableDraft {
  updates: Record<string, PendingRow>;
  inserts: NewRow[];
}

export interface Conflict {
  rowId: string;
  column: string;
  mine: CellValue;
  theirs: CellValue;
}

export const EMPTY_DRAFT: TableDraft = { updates: {}, inserts: [] };

const same = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function setCell(
  draft: TableDraft,
  rowId: string,
  key: RowKey,
  column: string,
  value: CellValue,
  original: CellValue,
): TableDraft {
  const cells = { ...(draft.updates[rowId]?.cells ?? {}) };
  const first = cells[column]?.original ?? original;
  if (same(value, first)) delete cells[column];
  else cells[column] = { value, original: first };
  const updates = { ...draft.updates };
  if (Object.keys(cells).length === 0) delete updates[rowId];
  else updates[rowId] = { key, cells };
  return { ...draft, updates };
}

let nextNew = 0;

export function addRow(draft: TableDraft): { draft: TableDraft; id: string } {
  const id = `new:${nextNew++}`;
  return { draft: { ...draft, inserts: [{ id, values: {} }, ...draft.inserts] }, id };
}

/** `undefined` puts the column back to its DEFAULT (or NULL). */
export function setNewCell(draft: TableDraft, id: string, column: string, value: CellValue | undefined): TableDraft {
  return {
    ...draft,
    inserts: draft.inserts.map((r) => {
      if (r.id !== id) return r;
      const values = { ...r.values };
      if (value === undefined) delete values[column];
      else values[column] = value;
      return { ...r, values };
    }),
  };
}

export function removeNewRow(draft: TableDraft, id: string): TableDraft {
  return { ...draft, inserts: draft.inserts.filter((r) => r.id !== id) };
}

export function discardRow(draft: TableDraft, rowId: string): TableDraft {
  const updates = { ...draft.updates };
  delete updates[rowId];
  return { ...draft, updates };
}

export function changeCount(draft: TableDraft): number {
  return Object.values(draft.updates).reduce((n, r) => n + Object.keys(r.cells).length, 0) + draft.inserts.length;
}

export const isDirty = (draft: TableDraft): boolean => changeCount(draft) > 0;

export function toEdits(draft: TableDraft): Edits {
  return {
    inserts: draft.inserts.map((r) => r.values),
    updates: Object.values(draft.updates).map((r) => ({
      key: r.key,
      values: Object.fromEntries(Object.entries(r.cells).map(([c, e]) => [c, e.value])),
      expected: Object.fromEntries(Object.entries(r.cells).map(([c, e]) => [c, e.original])),
    })),
  };
}

/** Pending cells whose live value is no longer the one the edit started from. Rows not on the page are unknown. */
export function findConflicts(draft: TableDraft, rows: { id: string; row: Row }[]): Conflict[] {
  const out: Conflict[] = [];
  for (const { id, row } of rows) {
    const pending = draft.updates[id];
    if (!pending) continue;
    for (const [column, e] of Object.entries(pending.cells)) {
      const theirs = row[column] ?? null;
      if (!same(theirs, e.original)) out.push({ rowId: id, column, mine: e.value, theirs });
    }
  }
  return out;
}

/** "mine" rebases the edit on their value (so a save expects theirs); "theirs" drops the edit. */
export function resolveConflict(draft: TableDraft, c: Conflict, choice: "mine" | "theirs"): TableDraft {
  const row = draft.updates[c.rowId];
  if (!row) return draft;
  const cells = { ...row.cells };
  if (choice === "theirs" || same(c.mine, c.theirs)) delete cells[c.column];
  else cells[c.column] = { value: c.mine, original: c.theirs };
  const updates = { ...draft.updates };
  if (Object.keys(cells).length === 0) delete updates[c.rowId];
  else updates[c.rowId] = { ...row, cells };
  return { ...draft, updates };
}

export function missingRequired(draft: TableDraft, columns: ColumnInfo[]): { id: string; column: string }[] {
  const required = columns.filter((c) => !c.nullable && !c.hasDefault);
  return draft.inserts.flatMap((r) =>
    required.filter((c) => (r.values[c.name] ?? null) === null).map((c) => ({ id: r.id, column: c.name })),
  );
}
```

- [ ] **Step 3: `src/edit/values.ts`**

```ts
import type { CellValue, ColumnInfo } from "../contract";
import { type Parsed, parseScalar } from "../view";

/** Text typed in an editor, as the column's wire value (see CellValue). Arrays are JSON arrays of their elements. */
export function parseCellValue(col: ColumnInfo, text: string): Parsed {
  if (col.kind !== "array") return parseScalar(col, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not a JSON array, e.g. ["a", "b"]' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'not a JSON array, e.g. ["a", "b"]' };
  const element: ColumnInfo = { ...col, kind: col.elementKind ?? "text" };
  const values: CellValue[] = [];
  for (const item of parsed) {
    if (item === null) {
      values.push(null);
      continue;
    }
    if (typeof item === "object") return { ok: false, error: "nested arrays and objects are not supported" };
    const p = parseScalar(element, String(item));
    if (!p.ok) return p;
    values.push(p.value ?? null);
  }
  return { ok: true, value: values };
}

export function textForEditing(col: ColumnInfo, value: CellValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (col.kind === "json" && typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return String(value);
}

/** Kinds edited in the expanded editor (multi-line), not in the cell. */
export const opensExpanded = (col: ColumnInfo): boolean => col.kind === "json" || col.kind === "array";
```

- [ ] **Step 4: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test/unit/draft.test.ts ./test/unit/cell-values.test.ts` → `7 pass` + `3 pass`.

Sabotages (restore with `cp`): (1) `setCell` uses `original` instead of `first` → first test red; (2) `resolveConflict`
"mine" keeps `original: e.original` (use `row.cells[c.column]?.original`) → conflicts test 2 red; (3)
`missingRequired` ignores `null` (checks `=== undefined`) → last test red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): the per-table draft — pending cells with originals, new rows, conflicts, required values"
```

---

### Task 3: Editing in the grid — selection, cell editor, expanded editor, new rows, row selection

**Files:**
- Create: `packages/studio/src/ui/dialog.tsx`, `src/edit/cell-editor.tsx`, `src/edit/expanded-editor.tsx`,
  `src/grid/grid-cell.tsx`
- Modify (rewrite): `packages/studio/src/grid/data-grid.tsx`
- Modify: `packages/studio/src/styles.css`
- Test: `test/unit/grid-edit.test.tsx`

**Interfaces:**
- Consumes: Task 2.
- Produces: `interface GridEditing { draft: TableDraft; conflicts: ReadonlySet<string> /* cellKey */; selectedRows: ReadonlySet<string>; onToggleRow(rowId: string): void; onToggleAll(rowIds: string[]): void; onEditExisting(rowId: string, key: RowKey, column: string, value: CellValue, original: CellValue): void; onEditNew(id: string, column: string, value: CellValue | undefined): void; onRemoveNew(id: string): void }`;
  `DataGridProps.editing?: GridEditing` (absent = read-only). DOM: an editing cell holds a control labelled
  `Edit <column>` (input, or select for boolean/enum); the expanded editor is a `dialog` with a textarea labelled
  `Value of <column>` and buttons `Set NULL` (nullable), `Use DEFAULT` (new row with a default), `Format` (json),
  `Cancel`, `Save`; cells carry `aria-selected`, `data-pending`, `data-conflict`, `data-missing`; rows
  `data-new`; the lead column has `Select all rows` / `Select row` checkboxes and `Remove new row` buttons.

- [ ] **Step 1: The failing grid test**

`test/unit/grid-edit.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { Page, TableInfo } from "../../src/contract";
import { addRow, EMPTY_DRAFT, removeNewRow, setCell, setNewCell, type TableDraft } from "../../src/edit/draft";
import { DataGrid } from "../../src/grid/data-grid";
import { demoDataset } from "../../src/mock";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const users = demoDataset(1).tables[0]?.info as TableInfo;
const rows = (demoDataset(1).tables[0]?.rows ?? []).slice(0, 5);
const page: Page = { rows, total: 3000, hasMore: true, revision: 1 };

function Harness({ start = EMPTY_DRAFT, conflicts = new Set<string>() }: { start?: TableDraft; conflicts?: Set<string> }) {
  const [draft, setDraft] = useState(start);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      <output data-testid="draft">{JSON.stringify(draft)}</output>
      <DataGrid
        table={users}
        page={page}
        changed={new Set()}
        columns={layoutColumns(users.columns, EMPTY_LAYOUT).visible}
        sort={[]}
        onSort={() => {}}
        onResize={() => {}}
        editing={{
          draft,
          conflicts,
          selectedRows: selected,
          onToggleRow: (id) => setSelected(new Set([...selected, id])),
          onToggleAll: (ids) => setSelected(new Set(ids)),
          onEditExisting: (rowId, key, column, value, original) => setDraft(setCell(draft, rowId, key, column, value, original)),
          onEditNew: (id, column, value) => setDraft(setNewCell(draft, id, column, value)),
          onRemoveNew: (id) => setDraft(removeNewRow(draft, id)),
        }}
      />
    </>
  );
}

const draftNow = () => JSON.parse(screen.getByTestId("draft").textContent ?? "{}") as TableDraft;
const cell = (text: string) => screen.getByText(text).closest("[role=gridcell]") as HTMLElement;

describe("editing in the grid", () => {
  test("double-click edits; Enter commits a pending value; Esc cancels", () => {
    render(<Harness />);
    fireEvent.doubleClick(cell("User 1"));
    const input = screen.getByLabelText("Edit name");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cell("Renamed").getAttribute("data-pending")).toBe("true");
    expect(Object.values(draftNow().updates)[0]?.cells["name"]).toEqual({ value: "Renamed", original: "User 1" });
    fireEvent.doubleClick(cell("User 2"));
    fireEvent.change(screen.getByLabelText("Edit name"), { target: { value: "nope" } });
    fireEvent.keyDown(screen.getByLabelText("Edit name"), { key: "Escape" });
    expect(screen.getByText("User 2")).toBeTruthy();
    expect(Object.keys(draftNow().updates)).toHaveLength(1);
  });

  test("a click selects a cell and Enter starts editing it", () => {
    render(<Harness />);
    fireEvent.click(cell("User 3"));
    expect(cell("User 3").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(cell("User 3"), { key: "Enter" });
    expect(screen.getByLabelText("Edit name")).toBeTruthy();
  });

  test("an invalid value stays in the editor and says why", () => {
    render(<Harness />);
    const age = String(rows[0]?.["age"]);
    fireEvent.doubleClick(screen.getAllByText(age)[0]?.closest("[role=gridcell]") as HTMLElement);
    fireEvent.change(screen.getByLabelText("Edit age"), { target: { value: "old" } });
    fireEvent.keyDown(screen.getByLabelText("Edit age"), { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe('"old" is not an integer');
    expect(screen.getByLabelText("Edit age")).toBeTruthy();
    expect(Object.keys(draftNow().updates)).toHaveLength(0);
  });

  test("Tab commits and edits the next column", () => {
    render(<Harness />);
    fireEvent.doubleClick(cell("user1@example.com"));
    fireEvent.change(screen.getByLabelText("Edit email"), { target: { value: "a@b.c" } });
    fireEvent.keyDown(screen.getByLabelText("Edit email"), { key: "Tab" });
    expect(screen.getByLabelText("Edit name")).toBeTruthy();
  });

  test("enum and boolean edit with a select; a NOT NULL column offers no NULL", () => {
    render(<Harness />);
    fireEvent.doubleClick(screen.getAllByText(String(rows[0]?.["role"]))[0]?.closest("[role=gridcell]") as HTMLElement);
    const role = screen.getByLabelText("Edit role") as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).toEqual(["admin", "editor", "viewer"]);
    fireEvent.change(role, { target: { value: "admin" } });
    expect(Object.values(draftNow().updates)[0]?.cells["role"]?.value).toBe(rows[0]?.["role"] === "admin" ? undefined : "admin");
  });

  test("json opens the expanded editor; invalid JSON cannot be saved", () => {
    render(<Harness />);
    const profile = String(rows[0]?.["profile"]);
    fireEvent.doubleClick(cell(profile));
    const dialog = screen.getByRole("dialog");
    const area = within(dialog).getByLabelText("Value of profile");
    fireEvent.change(area, { target: { value: "{bad" } });
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(area, { target: { value: '{"a": 1}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(Object.values(draftNow().updates)[0]?.cells["profile"]?.value).toBe('{"a": 1}');
  });

  test("a new row shows DEFAULT and NULL, marks what is required, and can be removed", () => {
    const { draft } = addRow(EMPTY_DRAFT);
    render(<Harness start={draft} />);
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    const cells = within(newRow).getAllByRole("gridcell").slice(1);
    expect(cells.slice(0, 3).map((c) => c.textContent)).toEqual(["DEFAULT", "NULL", "NULL"]);
    expect(cells[1]?.getAttribute("data-missing")).toBe("true");
    fireEvent.click(within(newRow).getByRole("button", { name: "Remove new row" }));
    expect(draftNow().inserts).toEqual([]);
  });

  test("rows are selected with their checkbox, all at once from the header", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.getAllByRole("checkbox", { name: "Select row" }).every((c) => (c as HTMLInputElement).checked)).toBe(true);
  });

  test("a conflicted cell is marked", () => {
    const d = setCell(EMPTY_DRAFT, `["${rows[0]?.["id"]}"]`, { id: rows[0]?.["id"] ?? null }, "name", "mine", "User 1");
    render(<Harness start={d} conflicts={new Set([`["${rows[0]?.["id"]}"]\u0000name`])} />);
    expect(cell("mine").getAttribute("data-conflict")).toBe("true");
  });
});
```

(The conflict test builds the row id and cell key the way `rowIdOf`/`cellKey` do: `JSON.stringify([id])` and a
NUL separator.)

Run: `cd packages/studio && bun test ./test/unit/grid-edit.test.tsx` → FAIL.

- [ ] **Step 2: Tokens**

In `src/styles.css` add to `@theme inline`:

```css
  --color-edit: var(--edit);
  --color-edit-foreground: var(--edit-foreground);
```

to `:root`:

```css
  /* A pending edit: amber, as in Drizzle Studio; never confused with a live push (green). */
  --edit: oklch(0.97 0.05 85);
  --edit-foreground: oklch(0.5 0.13 60);
```

and to `.dark`:

```css
  --edit: oklch(0.34 0.07 75);
  --edit-foreground: oklch(0.9 0.1 85);
```

- [ ] **Step 3: Dialog (vendored shadcn base-nova, `cn`/`Button` relative)**

`src/ui/dialog.tsx`:

```tsx
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-base leading-none font-medium", className)} {...props} />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle };
```

- [ ] **Step 4: The editors**

`src/edit/cell-editor.tsx`:

```tsx
import { useCallback, useRef, useState } from "react";
import type { CellValue, ColumnInfo } from "../contract";
import { parseCellValue, textForEditing } from "./values";

export interface CellEditorProps {
  column: ColumnInfo;
  /** undefined: a new row's column still at its DEFAULT. */
  value: CellValue | undefined;
  onCommit(value: CellValue, move?: "next"): void;
  onCancel(): void;
}

const CONTROL = "h-full w-full min-w-0 bg-popover px-1 font-mono text-[13px] text-foreground outline-none";

/** In-place editor. Enter commits, Tab commits and moves right, Esc cancels; an invalid value stays and says why. */
export function CellEditor({ column, value, onCommit, onCancel }: CellEditorProps) {
  const [text, setText] = useState(value === undefined || value === null ? "" : textForEditing(column, value));
  // A commit unmounts the editor, which blurs it: without this the blur would commit (or cancel) a second time.
  const done = useRef(false);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  const focusOnMount = useCallback((el: HTMLElement | null) => el?.focus(), []);

  const choices = column.kind === "boolean" ? ["true", "false"] : column.kind === "enum" ? (column.enumValues ?? []) : null;
  if (choices) {
    const current = value === undefined || value === null ? "" : String(value);
    return (
      <select
        ref={focusOnMount}
        aria-label={`Edit ${column.name}`}
        className={CONTROL}
        defaultValue={current}
        onChange={(e) => {
          const t = e.target.value;
          finish(() => onCommit(t === "" ? null : column.kind === "boolean" ? t === "true" : t));
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(onCancel);
          e.stopPropagation();
        }}
        onBlur={() => finish(onCancel)}
      >
        {current === "" && !column.nullable && (
          <option value="" disabled>
            choose…
          </option>
        )}
        {column.nullable && <option value="">NULL</option>}
        {choices.map((c) => (
          <option key={c} value={c}>
            {column.kind === "boolean" ? c.toUpperCase() : c}
          </option>
        ))}
      </select>
    );
  }

  const parsed = parseCellValue(column, text);
  const commit = (move?: "next") => {
    if (parsed.ok) finish(() => onCommit(parsed.value ?? null, move));
  };
  return (
    <>
      <input
        ref={focusOnMount}
        aria-label={`Edit ${column.name}`}
        className={CONTROL}
        value={text}
        aria-invalid={!parsed.ok || undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Tab") {
            e.preventDefault();
            commit("next");
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(onCancel);
          }
        }}
        onBlur={() => (parsed.ok ? commit() : finish(onCancel))}
      />
      {!parsed.ok && (
        <span role="alert" className="absolute top-full left-0 z-20 rounded bg-destructive px-1.5 py-0.5 text-[11px] text-white">
          {parsed.error}
        </span>
      )}
    </>
  );
}
```

Note: the first render of a select for a NOT NULL enum with a value has no `choose…` and no NULL, so the test's
option list is exactly the enum values.

`src/edit/expanded-editor.tsx`:

```tsx
import { useState } from "react";
import type { CellValue, ColumnInfo } from "../contract";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import { parseCellValue, textForEditing } from "./values";

export interface ExpandedEditorProps {
  column: ColumnInfo;
  value: CellValue | undefined;
  isNew: boolean;
  /** undefined: back to DEFAULT (new rows only). */
  onSave(value: CellValue | undefined): void;
  onClose(): void;
}

export function ExpandedEditor({ column, value, isNew, onSave, onClose }: ExpandedEditorProps) {
  const [text, setText] = useState(value === undefined || value === null ? "" : textForEditing(column, value));
  const parsed = parseCellValue(column, text);
  const save = () => {
    if (parsed.ok) onSave(parsed.value ?? null);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogTitle>
          {column.name} <span className="font-mono text-xs text-muted-foreground">{column.pgType}</span>
        </DialogTitle>
        <textarea
          aria-label={`Value of ${column.name}`}
          className="h-64 w-full resize-y rounded-lg border border-input bg-transparent p-2 font-mono text-sm outline-none focus-visible:border-ring aria-invalid:border-destructive"
          value={text}
          aria-invalid={!parsed.ok || undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
          }}
        />
        {!parsed.ok && (
          <p role="alert" className="text-xs text-destructive">
            {parsed.error}
          </p>
        )}
        <DialogFooter>
          {column.nullable && (
            <Button type="button" variant="outline" onClick={() => onSave(null)}>
              Set NULL
            </Button>
          )}
          {isNew && column.hasDefault && (
            <Button type="button" variant="outline" onClick={() => onSave(undefined)}>
              Use DEFAULT
            </Button>
          )}
          {column.kind === "json" && parsed.ok && (
            <Button type="button" variant="ghost" onClick={() => setText(JSON.stringify(JSON.parse(text), null, 2))}>
              Format
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!parsed.ok} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: The cell and the grid**

`src/grid/grid-cell.tsx`:

```tsx
import type { CellValue, ColumnInfo } from "../contract";
import { CellEditor } from "../edit/cell-editor";
import { formatCell } from "../studio/format";

export interface GridCellProps {
  index: number;
  column: ColumnInfo;
  width: number;
  /** undefined: a new row's column still at its DEFAULT (or NULL). */
  value: CellValue | undefined;
  isNew: boolean;
  pending: boolean;
  conflict: boolean;
  changed: boolean;
  selected: boolean;
  editing: boolean;
  onSelect(): void;
  onStartEdit(): void;
  onCommit(value: CellValue, move?: "next"): void;
  onCancel(): void;
}

export function GridCell(p: GridCellProps) {
  const missing = p.isNew && (p.value ?? null) === null && !p.column.nullable && !p.column.hasDefault;
  const text = p.value === undefined ? (p.column.hasDefault ? "DEFAULT" : "NULL") : formatCell(p.value);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      role="gridcell"
      tabIndex={-1}
      aria-colindex={p.index}
      aria-selected={p.selected || undefined}
      data-null={p.value === null || p.value === undefined || undefined}
      data-changed={p.changed || undefined}
      data-pending={p.pending || (p.isNew && p.value !== undefined) || undefined}
      data-conflict={p.conflict || undefined}
      data-missing={missing || undefined}
      onClick={p.onSelect}
      onDoubleClick={p.onStartEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !p.editing) {
          e.preventDefault();
          p.onStartEdit();
        }
      }}
      className="relative flex shrink-0 items-center border-r px-2 whitespace-nowrap data-changed:animate-cell-flash data-null:text-muted-foreground data-pending:bg-edit data-pending:text-edit-foreground aria-selected:outline-2 aria-selected:-outline-offset-2 aria-selected:outline-ring data-conflict:ring-2 data-conflict:ring-destructive data-conflict:ring-inset data-missing:ring-1 data-missing:ring-destructive data-missing:ring-inset"
      style={{ width: p.width }}
    >
      {p.editing ? (
        <CellEditor column={p.column} value={p.value} onCommit={p.onCommit} onCancel={p.onCancel} />
      ) : (
        <span className="truncate">{text}</span>
      )}
    </div>
  );
}
```

`src/grid/data-grid.tsx` (replace the file):

```tsx
import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { CellValue, Page, Row, RowKey, Sort, TableInfo } from "../contract";
import type { TableDraft } from "../edit/draft";
import { ExpandedEditor } from "../edit/expanded-editor";
import { opensExpanded } from "../edit/values";
import { cellKey, rowIdOf } from "../studio/format";
import type { LaidOutColumn } from "../studio/prefs";
import { type HeaderSortAction, sortPosition } from "../view";
import { GridCell } from "./grid-cell";
import { HeaderCell } from "./header-cell";

const ROW_HEIGHT = 32;
const LEAD_WIDTH = 36;
const features = tableFeatures({});

export interface GridEditing {
  draft: TableDraft;
  /** cellKey(rowId, column) of every conflicted cell. */
  conflicts: ReadonlySet<string>;
  selectedRows: ReadonlySet<string>;
  onToggleRow(rowId: string): void;
  onToggleAll(rowIds: string[]): void;
  onEditExisting(rowId: string, key: RowKey, column: string, value: CellValue, original: CellValue): void;
  onEditNew(id: string, column: string, value: CellValue | undefined): void;
  onRemoveNew(id: string): void;
}

export interface DataGridProps {
  table: TableInfo;
  page: Page;
  changed: ReadonlySet<string>;
  /** Visible columns in display order, with widths (see layoutColumns). */
  columns: LaidOutColumn[];
  sort: Sort[];
  onSort(column: string, action: HeaderSortAction): void;
  onResize(column: string, width: number, commit: boolean): void;
  /** Absent: read-only. */
  editing?: GridEditing;
}

interface DisplayRow {
  id: string;
  row: Row;
  isNew: boolean;
  key: RowKey | null;
}

interface CellRef {
  rowId: string;
  column: string;
}

export function DataGrid({ table, page, changed, columns, sort, onSort, onResize, editing }: DataGridProps) {
  const inserts = editing?.draft.inserts;
  const display = useMemo<DisplayRow[]>(
    () => [
      ...(inserts ?? []).map((n) => ({ id: n.id, row: n.values, isNew: true, key: null })),
      ...page.rows.map((row, i) => ({
        id: rowIdOf(table.primaryKey, row, i),
        row,
        isNew: false,
        key: table.primaryKey.length > 0 ? Object.fromEntries(table.primaryKey.map((k) => [k, row[k] ?? null])) : null,
      })),
    ],
    [inserts, page.rows, table.primaryKey],
  );
  const defs = useMemo<ColumnDef<typeof features, DisplayRow, unknown>[]>(
    () =>
      columns.map(({ column }) => ({
        id: column.name,
        accessorFn: (d: DisplayRow) => d.row[column.name] ?? null,
        header: column.name,
      })),
    [columns],
  );
  const grid = useTable({ features, columns: defs, data: display, getRowId: (d) => d.id });
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = grid.getRowModel().rows;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [editingCell, setEditingCell] = useState<(CellRef & { expanded: boolean }) | null>(null);

  const lead = editing ? LEAD_WIDTH : 0;
  const width = lead + columns.reduce((w, c) => w + c.width, 0);
  const byId = new Map(display.map((d) => [d.id, d]));
  const existingIds = display.filter((d) => !d.isNew && d.key).map((d) => d.id);
  const allSelected = existingIds.length > 0 && existingIds.every((id) => editing?.selectedRows.has(id));

  const valueOf = (d: DisplayRow, column: string): CellValue | undefined => {
    if (d.isNew) return Object.hasOwn(d.row, column) ? (d.row[column] ?? null) : undefined;
    const pending = editing?.draft.updates[d.id]?.cells[column];
    return pending ? pending.value : (d.row[column] ?? null);
  };
  const startEditing = (ref: CellRef) => {
    const col = columns.find((c) => c.column.name === ref.column)?.column;
    if (!editing || !col) return;
    setSelected(ref);
    setEditingCell({ ...ref, expanded: opensExpanded(col) });
  };
  const commit = (ref: CellRef, value: CellValue | undefined, move?: "next") => {
    const d = byId.get(ref.rowId);
    if (!editing || !d) return;
    if (d.isNew) editing.onEditNew(d.id, ref.column, value);
    else if (d.key && value !== undefined) editing.onEditExisting(d.id, d.key, ref.column, value, d.row[ref.column] ?? null);
    setEditingCell(null);
    if (move === "next") {
      const next = columns[columns.findIndex((c) => c.column.name === ref.column) + 1];
      if (next) startEditing({ rowId: ref.rowId, column: next.column.name });
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (editingCell || !selected) return;
    if (e.key === "Enter") {
      e.preventDefault();
      startEditing(selected);
    } else if (e.key === "Escape") setSelected(null);
  };

  if (columns.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">All columns are hidden. Show some from Columns.</p>;
  }

  const expandedRow = editingCell?.expanded ? byId.get(editingCell.rowId) : undefined;
  const expandedCol = editingCell?.expanded ? columns.find((c) => c.column.name === editingCell.column)?.column : undefined;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + (editing ? 1 : 0)}
      onKeyDown={onKeyDown}
      className="relative h-full overflow-auto font-mono text-[13px] outline-none"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot */}
      <div role="row" tabIndex={-1} aria-rowindex={1} className="sticky top-0 z-10 flex border-b bg-background" style={{ width }}>
        {editing && (
          // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
          <div role="columnheader" tabIndex={-1} aria-colindex={1} className="flex shrink-0 items-center justify-center border-r" style={{ width: LEAD_WIDTH }}>
            <input type="checkbox" aria-label="Select all rows" checked={allSelected} onChange={() => editing.onToggleAll(existingIds)} />
          </div>
        )}
        {columns.map((c, i) => (
          <HeaderCell
            key={c.column.name}
            index={i + (editing ? 1 : 0)}
            column={c.column}
            width={c.width}
            sorted={sortPosition(sort, c.column.name)}
            onSort={(action) => onSort(c.column.name, action)}
            onResize={(w, done) => onResize(c.column.name, w, done)}
          />
        ))}
      </div>
      <div className="relative" style={{ height: virtual.getTotalSize(), width }}>
        {virtual.getVirtualItems().map((item) => {
          const tr = rows[item.index];
          if (!tr) return null;
          const d = tr.original;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
            <div
              key={d.id}
              role="row"
              tabIndex={-1}
              aria-rowindex={item.index + 2}
              data-new={d.isNew || undefined}
              className="absolute left-0 flex border-b hover:bg-muted/60"
              style={{ height: ROW_HEIGHT, width, transform: `translateY(${item.start}px)` }}
            >
              {editing && (
                // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
                <div role="gridcell" tabIndex={-1} aria-colindex={1} className="flex shrink-0 items-center justify-center border-r" style={{ width: LEAD_WIDTH }}>
                  {d.isNew ? (
                    <button type="button" aria-label="Remove new row" onClick={() => editing.onRemoveNew(d.id)}>
                      <X className="size-3.5" />
                    </button>
                  ) : d.key ? (
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      checked={editing.selectedRows.has(d.id)}
                      onChange={() => editing.onToggleRow(d.id)}
                    />
                  ) : null}
                </div>
              )}
              {columns.map((laid, i) => {
                const name = laid.column.name;
                const ref = { rowId: d.id, column: name };
                const k = cellKey(d.id, name);
                const isChanged = changed.has(k);
                return (
                  <GridCell
                    // A changed cell remounts on each revision so its flash animation restarts.
                    key={isChanged ? `${k}:${page.revision}` : k}
                    index={i + (editing ? 2 : 1)}
                    column={laid.column}
                    width={laid.width}
                    value={valueOf(d, name)}
                    isNew={d.isNew}
                    pending={!d.isNew && Boolean(editing?.draft.updates[d.id]?.cells[name])}
                    conflict={editing?.conflicts.has(k) ?? false}
                    changed={isChanged}
                    selected={selected?.rowId === d.id && selected.column === name}
                    editing={editingCell?.rowId === d.id && editingCell.column === name && !editingCell.expanded}
                    onSelect={() => setSelected(ref)}
                    onStartEdit={() => startEditing(ref)}
                    onCommit={(v, move) => commit(ref, v, move)}
                    onCancel={() => setEditingCell(null)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {editingCell && expandedRow && expandedCol && (
        <ExpandedEditor
          column={expandedCol}
          value={valueOf(expandedRow, expandedCol.name)}
          isNew={expandedRow.isNew}
          onSave={(v) => commit(editingCell, v)}
          onClose={() => setEditingCell(null)}
        />
      )}
    </div>
  );
}
```

(Cells are rendered from `columns` directly; TanStack still provides the row model. The data-grid tests from S2
keep passing because read-only grids render exactly as before.)

- [ ] **Step 6: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test/unit/grid-edit.test.tsx ./test/unit/data-grid.test.tsx` → all pass.
If Base UI's Dialog does not render in happy-dom, record it in the ledger and move the json test to the e2e of Task 5.

Sabotages (restore with `cp`): (1) `CellEditor` commits on Enter even when invalid (drop the `parsed.ok` guard) →
invalid-value test red; (2) the enum select always adds a NULL option → enum test red; (3) `GridCell`'s `missing`
ignores `hasDefault` → new-row test red; (4) remove the `done` guard → the Enter/Esc test records two edits
(red) — if it stays green, record why in the ledger.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): editing in the grid — cell selection, typed in-place editors, expanded editor, new rows, row selection"
```

---

### Task 4: The edit bar and `<Studio>` — save, discard, conflicts, add, delete, drafts per table

**Files:**
- Create: `packages/studio/src/edit/edit-bar.tsx`
- Modify: `packages/studio/src/studio/studio.tsx`, `src/studio/sidebar.tsx`
- Test: `test/unit/studio-edit.test.tsx`

**Interfaces:**
- Produces: `EditBar(props: EditBarProps)`, `interface SaveError { message: string; rowId: string | null }`;
  `StudioProps.onDirtyChange?(dirty: boolean): void`; `SidebarProps.dirty?: ReadonlySet<string>` (buttons of
  tables with pending edits carry `data-dirty`). DOM: region `Unsaved changes` with `Save changes` / `Discard
  changes`, conflict rows with `Keep mine` / `Use theirs`, an `alert` for a failed save with `Discard this row's
  edits`; toolbar `Add row`, `Delete <n> row(s)`; a confirmation dialog with `Delete rows`.

- [ ] **Step 1: The failing Studio tests**

`test/unit/studio-edit.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_VIEW, type Page, Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const USERS = { schema: "public", name: "users" };
const seed = demoDataset(1).tables[0]?.rows ?? [];
const idOf = (n: number) => seed[n - 1]?.["id"] ?? null;

function setup(onDirtyChange?: (dirty: boolean) => void) {
  const log = createMemoryLog();
  const ds = createMockDataSource({ dataset: demoDataset(1), log });
  const other = createMockDataSource({ dataset: demoDataset(1), log });
  render(<Studio dataSource={ds} defaultView={{ ...EMPTY_VIEW, table: "public.users" }} onDirtyChange={onDirtyChange} />);
  const seen: Page[] = [];
  other.subscribePage({ table: USERS, filters: [], sort: [], limit: 5, offset: 0, withTotal: true }, (p) => seen.push(p), () => {});
  return { ds, other, seen, nameIn: (n: number) => seen.at(-1)?.rows[n - 1]?.["name"] };
}

const cell = (text: string) => screen.getByText(text).closest("[role=gridcell]") as HTMLElement;
async function edit(text: string, to: string) {
  fireEvent.doubleClick(cell(text));
  const input = await screen.findByRole("textbox", { name: /^Edit / });
  fireEvent.change(input, { target: { value: to } });
  fireEvent.keyDown(input, { key: "Enter" });
}
const bar = () => within(screen.getByRole("region", { name: "Unsaved changes" }));
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

describe("editing in the studio", () => {
  test("an edit pends until saved; Save writes it and other tabs see it", async () => {
    const { nameIn } = setup();
    await screen.findByText("User 1");
    await edit("User 1", "Renamed");
    expect(bar().getByText("1 unsaved change")).toBeTruthy();
    await settle();
    expect(nameIn(1)).toBe("User 1");
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    await settle();
    expect(nameIn(1)).toBe("Renamed");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  test("Discard puts every value back", async () => {
    setup();
    await screen.findByText("User 1");
    await edit("User 1", "X");
    fireEvent.click(bar().getByRole("button", { name: "Discard changes" }));
    expect(screen.getByText("User 1")).toBeTruthy();
  });

  test("a failed save keeps every edit and says why", async () => {
    const { nameIn } = setup();
    await screen.findByText("User 1");
    // The mock enforces the primary key's uniqueness (not other unique constraints): user 2 takes user 1's id.
    await edit(String(idOf(2)), String(idOf(1)));
    await edit("User 3", "Would land alone");
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    expect((await screen.findByRole("alert")).textContent).toContain("already has a row");
    expect(bar().getByText("2 unsaved changes")).toBeTruthy();
    await settle();
    expect(nameIn(3)).toBe("User 3");
  });

  test("a change elsewhere to an edited cell is a conflict: blocked until resolved; keep mine wins", async () => {
    const { other, nameIn } = setup();
    await screen.findByText("User 1");
    await edit("User 1", "Mine");
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Theirs" } }]));
    expect(await bar().findByText(/changed elsewhere/)).toBeTruthy();
    expect(bar().getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    expect(cell("Mine").getAttribute("data-conflict")).toBe("true");
    fireEvent.click(bar().getByRole("button", { name: "Keep mine" }));
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    await settle();
    expect(nameIn(1)).toBe("Mine");
  });

  test("use theirs drops the edit", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    await edit("User 1", "Mine");
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Theirs" } }]));
    fireEvent.click(await bar().findByRole("button", { name: "Use theirs" }));
    expect(screen.getByText("Theirs")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  test("a row deleted elsewhere turns its save into a conflict, with a way out", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    await edit("User 2", "Edited");
    await act(() => other.deleteRows(USERS, [{ id: idOf(2) }]));
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("deleted elsewhere");
    fireEvent.click(within(alert).getByRole("button", { name: "Discard this row's edits" }));
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  test("a new row needs its required values before it can be saved", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(bar().getByText("1 required value missing")).toBeTruthy();
    expect(bar().getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    fireEvent.doubleClick(within(newRow).getAllByRole("gridcell")[2] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Edit email"), { target: { value: "new@example.com" } });
    fireEvent.keyDown(screen.getByLabelText("Edit email"), { key: "Enter" });
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    const seen: Page[] = [];
    other.subscribePage(
      { table: USERS, filters: [{ column: "email", op: "eq", value: "new@example.com" }], sort: [], limit: 1, offset: 0, withTotal: true },
      (p) => seen.push(p),
      () => {},
    );
    await settle();
    expect(seen.at(-1)?.total).toBe(1);
  });

  test("deleting asks first, then deletes for every tab", async () => {
    const { seen } = setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Select row" })[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 row" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete rows" })));
    await settle();
    expect(seen.at(-1)?.total).toBe(2999);
  });

  test("edits survive switching tables; the sidebar marks the table; the host is told", async () => {
    const dirty: boolean[] = [];
    setup((d) => dirty.push(d));
    await screen.findByText("User 1");
    await edit("User 1", "Kept");
    fireEvent.click(screen.getByRole("button", { name: "posts" }));
    await screen.findByText("Post 1");
    expect(screen.getByRole("button", { name: "users" }).getAttribute("data-dirty")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "users" }));
    expect((await screen.findByText("Kept")).closest("[role=gridcell]")?.getAttribute("data-pending")).toBe("true");
    expect(dirty).toContain(true);
  });

  test("views and tables without a key show no editing", async () => {
    setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getByRole("button", { name: "audit_log" }));
    await screen.findByText("read-only");
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select all rows" })).toBeNull();
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/studio-edit.test.tsx` → FAIL.

- [ ] **Step 2: The edit bar**

`src/edit/edit-bar.tsx`:

```tsx
import { formatCell } from "../studio/format";
import { Button } from "../ui/button";
import type { Conflict } from "./draft";

export interface SaveError {
  message: string;
  /** The row the failure is about (a conflict), when the data source says. */
  rowId: string | null;
}

export interface EditBarProps {
  changes: number;
  missing: number;
  conflicts: Conflict[];
  error: SaveError | null;
  saving: boolean;
  onSave(): void;
  onDiscard(): void;
  onResolve(conflict: Conflict, choice: "mine" | "theirs"): void;
  onDiscardRow(rowId: string): void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function EditBar(p: EditBarProps) {
  const blocked = p.saving || p.missing > 0 || p.conflicts.length > 0;
  return (
    <section aria-label="Unsaved changes" className="flex flex-col gap-1 border-b bg-edit/50 px-3 py-1.5 text-xs">
      <div className="flex items-center gap-3">
        <span className="font-medium text-edit-foreground">{plural(p.changes, "unsaved change", "unsaved changes")}</span>
        {p.missing > 0 && <span className="text-destructive">{plural(p.missing, "required value missing", "required values missing")}</span>}
        {p.conflicts.length > 0 && <span className="text-destructive">{plural(p.conflicts.length, "conflict", "conflicts")} to resolve</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={p.onDiscard}>
            Discard changes
          </Button>
          <Button type="button" size="xs" disabled={blocked} onClick={p.onSave}>
            {p.saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
      {p.conflicts.map((c) => (
        <div key={`${c.rowId}:${c.column}`} className="flex items-center gap-2">
          <span>
            “{c.column}” changed elsewhere to <code>{formatCell(c.theirs)}</code> — yours: <code>{formatCell(c.mine)}</code>
          </span>
          <Button type="button" size="xs" variant="outline" onClick={() => p.onResolve(c, "mine")}>
            Keep mine
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => p.onResolve(c, "theirs")}>
            Use theirs
          </Button>
        </div>
      ))}
      {p.error && (
        <div role="alert" className="flex items-center gap-2 text-destructive">
          <span>Not saved: {p.error.message}. Nothing was written.</span>
          {p.error.rowId !== null && (
            <Button type="button" size="xs" variant="link" onClick={() => p.onDiscardRow(p.error?.rowId ?? "")}>
              Discard this row's edits
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Sidebar dots**

In `src/studio/sidebar.tsx`: `SidebarProps` gains `dirty?: ReadonlySet<string>;`, the function destructures
`dirty`, each table button gains `data-dirty={dirty?.has(id) || undefined}` and
`title={dirty?.has(id) ? "Unsaved changes" : undefined}`, and after the name `<span>` add:

```tsx
                {dirty?.has(id) && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-edit-foreground" />}
```

- [ ] **Step 4: `<Studio>`**

In `src/studio/studio.tsx`:

a) Imports — replace the first three import lines with:

```tsx
import { ArrowUpDown, Columns3, ListFilter, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type StudioDataSource, StudioDataSourceError, type TableInfo, tableId } from "../contract";
import {
  addRow,
  changeCount,
  discardRow,
  EMPTY_DRAFT,
  findConflicts,
  isDirty,
  missingRequired,
  removeNewRow,
  resolveConflict,
  setCell,
  setNewCell,
  type TableDraft,
  toEdits,
} from "../edit/draft";
import { EditBar, type SaveError } from "../edit/edit-bar";
import { DataGrid, type GridEditing } from "../grid/data-grid";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
```

and add `import { cellKey, rowIdOf } from "./format";` next to the other `./` imports.

b) `StudioProps` gains:

```tsx
  /** Told whenever pending edits appear or are all saved/discarded (to block navigation, warn on close). */
  onDirtyChange?(dirty: boolean): void;
```

and the function signature destructures `onDirtyChange`.

c) After `const [layout, setLayoutState] = useState<ColumnLayout>(EMPTY_LAYOUT);` add:

```tsx
  // Pending edits of every table, kept while the person moves around: switching tables or Back loses nothing.
  const [drafts, setDrafts] = useState<Record<string, TableDraft>>({});
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(new Set());
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
```

d) After the step-back `useEffect`, add:

```tsx
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view (table, page, filters) clears the selection
  useEffect(() => {
    setSelectedRows(new Set());
  }, [viewKey]);

  const editable = table !== null && table.kind === "table" && table.primaryKey.length > 0;
  const draftKey = view.table ?? "";
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const updateDraft = (id: string, fn: (d: TableDraft) => TableDraft) =>
    setDrafts((all) => ({ ...all, [id]: fn(all[id] ?? EMPTY_DRAFT) }));
  const dirtyTables = new Set(Object.entries(drafts).filter(([, d]) => isDirty(d)).map(([t]) => t));
  const anyDirty = dirtyTables.size > 0;
  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);

  const pageRows = table && page ? page.rows.map((row, i) => ({ id: rowIdOf(table.primaryKey, row, i), row })) : [];
  const conflicts = editable ? findConflicts(draft, pageRows) : [];
  const missing = table ? missingRequired(draft, table.columns).length : 0;

  const save = async () => {
    if (!table) return;
    const id = tableId(table);
    setSaving(true);
    setSaveError(null);
    try {
      await dataSource.applyEdits(table, toEdits(draft));
      updateDraft(id, () => EMPTY_DRAFT);
    } catch (e) {
      const key = e instanceof StudioDataSourceError ? e.key : undefined;
      setSaveError({
        message: e instanceof Error ? e.message : String(e),
        rowId: key ? rowIdOf(table.primaryKey, key, 0) : null,
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteSelected = async () => {
    if (!table) return;
    const doomed = pageRows.filter((r) => selectedRows.has(r.id));
    try {
      await dataSource.deleteRows(
        table,
        doomed.map((r) => Object.fromEntries(table.primaryKey.map((k) => [k, r.row[k] ?? null]))),
      );
      updateDraft(tableId(table), (d) => doomed.reduce((acc, r) => discardRow(acc, r.id), d));
      setSelectedRows(new Set());
      setConfirmDelete(false);
      setDeleteError(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  };

  const gridEditing: GridEditing | undefined = editable
    ? {
        draft,
        conflicts: new Set(conflicts.map((c) => cellKey(c.rowId, c.column))),
        selectedRows,
        onToggleRow: (id) =>
          setSelectedRows((s) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
        onToggleAll: (ids) => setSelectedRows((s) => (ids.every((id) => s.has(id)) ? new Set() : new Set(ids))),
        onEditExisting: (rowId, key, column, value, original) =>
          updateDraft(draftKey, (d) => setCell(d, rowId, key, column, value, original)),
        onEditNew: (id, column, value) => updateDraft(draftKey, (d) => setNewCell(d, id, column, value)),
        onRemoveNew: (id) => updateDraft(draftKey, (d) => removeNewRow(d, id)),
      }
    : undefined;
```

e) Pass `editing={gridEditing}` to `<DataGrid … />`, and `dirty={dirtyTables}` to `<Sidebar … />`.

f) In the header, right after the Columns `</Popover>` (inside the `table && laid` fragment), add:

```tsx
              {editable && (
                <Button type="button" variant="outline" size="sm" onClick={() => updateDraft(draftKey, (d) => addRow(d).draft)}>
                  <Plus />
                  Add row
                </Button>
              )}
              {editable && selectedRows.size > 0 && (
                <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
                  <Trash2 />
                  {`Delete ${selectedRows.size} ${selectedRows.size === 1 ? "row" : "rows"}`}
                </Button>
              )}
```

g) Right after the `</header>`, add:

```tsx
        {editable && (isDirty(draft) || saveError) && (
          <EditBar
            changes={changeCount(draft)}
            missing={missing}
            conflicts={conflicts}
            error={saveError}
            saving={saving}
            onSave={() => void save()}
            onDiscard={() => {
              updateDraft(draftKey, () => EMPTY_DRAFT);
              setSaveError(null);
            }}
            onResolve={(c, choice) => updateDraft(draftKey, (d) => resolveConflict(d, c, choice))}
            onDiscardRow={(rowId) => {
              updateDraft(draftKey, (d) => discardRow(d, rowId));
              setSaveError(null);
            }}
          />
        )}
```

h) Before the closing `</main>`, add the delete confirmation:

```tsx
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent>
            <DialogTitle>{`Delete ${selectedRows.size} ${selectedRows.size === 1 ? "row" : "rows"}?`}</DialogTitle>
            <DialogDescription>They are deleted now, for every tab, and cannot be restored from here.</DialogDescription>
            {deleteError && (
              <p role="alert" className="text-sm text-destructive">
                {deleteError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={() => void deleteSelected()}>
                Delete rows
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
```

- [ ] **Step 5: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"` → all pass.

Sabotages (restore with `cp`):
1. `save` calls `updateRows` then `insertRows` instead of `applyEdits` → `a failed save keeps every edit` red (User 3
   lands).
2. `EditBar`'s `blocked` ignores conflicts → the conflict test red (Save enabled).
3. `drafts` keyed by nothing (`const draft = EMPTY_DRAFT` after a table switch: use `useState<TableDraft>` reset on
   `view.table`) → `edits survive switching tables` red.
4. `onSave` clears the draft before awaiting → `a failed save keeps every edit` red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): save, discard and conflicts in an edit bar; add and delete rows; drafts kept per table"
```

---

### Task 5: The playground warns on close; editing end to end

**Files:**
- Modify: `packages/studio/playground/main.tsx`
- Create: `packages/studio/e2e/edit.e2e.ts`

- [ ] **Step 1: The failing e2e**

`e2e/edit.e2e.ts`:

```ts
// Editing across tabs: a save reaches the other tab, a concurrent edit shows up as a conflict before anything is
// overwritten, and closing a tab with unsaved edits asks first.
import { expect, type Page as Tab, test } from "@playwright/test";

async function openUsers(tab: Tab) {
  await tab.goto("/?v=1&table=public.users");
  await expect(tab.getByRole("gridcell", { name: "User 1", exact: true })).toBeVisible();
}

async function editName(tab: Tab, from: string, to: string) {
  await tab.getByRole("gridcell", { name: from, exact: true }).dblclick();
  const input = tab.getByRole("textbox", { name: "Edit name" });
  await input.fill(to);
  await input.press("Enter");
}

test("a save in one tab reaches the other", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await editName(a, "User 1", "Saved in A");
  await a.getByRole("button", { name: "Save changes" }).click();
  await expect(b.getByRole("gridcell", { name: "Saved in A", exact: true })).toBeVisible();
});

test("a concurrent edit is a conflict, resolved without losing either side", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await editName(a, "User 1", "From A");
  await editName(b, "User 1", "From B");
  await b.getByRole("button", { name: "Save changes" }).click();
  const region = a.getByRole("region", { name: "Unsaved changes" });
  await expect(region.getByText(/changed elsewhere/)).toBeVisible();
  await expect(region.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await region.getByRole("button", { name: "Keep mine" }).click();
  await region.getByRole("button", { name: "Save changes" }).click();
  await expect(b.getByRole("gridcell", { name: "From A", exact: true })).toBeVisible();
});

test("unsaved edits warn before the tab closes", async ({ page }) => {
  await openUsers(page);
  await editName(page, "User 1", "Not saved");
  let asked = false;
  page.on("dialog", async (d) => {
    asked = d.type() === "beforeunload";
    await d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
});
```

Run: `cd packages/studio && bun run test:e2e -- e2e/edit.e2e.ts` → the first two pass already if Task 4 is right;
`unsaved edits warn` FAILS (no `beforeunload` handler yet).

- [ ] **Step 2: `beforeunload` in the playground**

In `playground/main.tsx`, inside `App` before the `return`:

```tsx
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
```

pass `onDirtyChange={setDirty}` to `<Studio>`, and import `useEffect, useState` from `react` (extend the existing
`StrictMode` import).

- [ ] **Step 3: Run, sabotage, commit**

Run: `cd packages/studio && bun run test:e2e` → `11 passed`. Three times.

Sabotage: `App` never passes `onDirtyChange` (so `dirty` stays false) → `unsaved edits warn before the tab closes`
red. Restore with `cp`. (The conflict path's sabotage is Task 1's: dropping the `expected` check.)

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "test(studio): editing end to end — save across tabs, a live conflict, the close warning"
```

---

### Task 6: Close the slice

**Files:**
- Modify: `packages/studio/NOTES.md`, `packages/studio/README.md`, `docs/specs/STUDIO-00-ui-on-mocks.md`

- [ ] **Step 1: NOTES.md — append**

```markdown
## Editing (S3a, observed 25 Sep 2026, editing the probe database)

- Save is immediate: no confirmation, no SQL preview, no toast; the pending bar disappears.
- A failed save opens a modal with the failing SQL and Postgres's message (`duplicate key … users_email_key`),
  Close / Open failed in SQL; the edit stays pending.
- **Saving is not atomic**: with one valid and one invalid edit, the valid one was written and the invalid one
  left the pending list without a word.
- Add record: a row at the top with `DEFAULT`/`NULL`; the INSERT spells `default` for defaulted columns and `null`
  for the rest; no client-side check, so NOT NULL surfaces as a server error.
- Delete: selecting rows shows "Delete N records"; a confirmation ("Confirm deletion of selected records"); one
  `DELETE … WHERE id = … OR id = …`; immediate, outside the pending edits; a foreign-key error in the same modal.
- Leaving a table with pending edits asks "Unsaved changes — discard them?" (Discard / Close).
- Expand Row opens a side form of every column (label + type; selects for enum/boolean; a code editor for
  json/array) — S3b.

## Decisions taken from this (S3a)

- A save is one atomic `applyEdits`; a failure writes nothing and keeps every edit.
- Optimistic concurrency: an update carries the values it started from; a cell changed elsewhere is shown live
  ("changed elsewhere", Keep mine / Use theirs) and a stale save is refused (`conflict`), naming the row.
- Drafts are kept per table in memory: switching tables or going Back loses nothing; the sidebar marks tables with
  pending edits; closing the tab warns; `onDirtyChange` lets a host block its own navigation.
- Required values of a new row are checked before saving; enum/boolean offer NULL only on nullable columns.
- Delete stays immediate with a confirmation, as in Drizzle Studio.
```

- [ ] **Step 2: README — in "Embedding", add a line**

```markdown
`onDirtyChange(dirty)` reports pending edits, so a host can warn before navigating away; the studio keeps
unsaved edits per table while the person moves around.
```

- [ ] **Step 3: Spec progress**

Append to the spec's **Progress** paragraph, before "Next:", then change "Next: S3 editing;" to "Next: S3b
(date/time picker, Expand Row panel, code editor decision);":

```markdown
S3a (`docs/superpowers/plans/2026-09-25-studio-00-3a-editing.md`): pending edits per table, an atomic,
conflict-aware save (`applyEdits` with `expected`), live conflicts, typed editors (text, numbers, boolean, enum,
NULL/DEFAULT, bytea, json and arrays in an expanded editor), add and delete rows.
```

- [ ] **Step 4: Verify, commit, review**

Run: `bun run check && bun run test 2>&1 | grep -E "Ran |passed|failed| fail$"` → green; record the counts.

```bash
git add packages/studio/NOTES.md packages/studio/README.md docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "docs(studio): S3a notes, embedding note, progress"
```

A fresh reviewer (most capable model) reviews the S3a scope. Before merging, check `main` against the merge base.
