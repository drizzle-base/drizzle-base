# STUDIO-00 S5 — Import, structure, leftovers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a JSON / CSV / SQL file as pending inserts, browse a table's columns and indexes in a Structure pane, persist unapplied filter drafts, and close STUDIO-00 with a final review.

**Architecture:** Parse is pure (`src/import/parse.ts`) and returns wire-text fields; the dialog applies `addRow` / `setNewCell` so Save stays the existing atomic `applyEdits`. Indexes live on `TableInfo` (honest: only what the mock enforces — the PK). `StudioView.pane` is `"data" | "structure"` and rides the URL codec. Filter drafts are a prefs key; `ResizeHandle` drops window listeners on unmount.

**Tech Stack:** as before. No new dependency. SQL import is the inverse of `exportSql` only.

**Spec:** [`docs/specs/STUDIO-00-ui-on-mocks.md`](docs/specs/STUDIO-00-ui-on-mocks.md) §4 Import and Schema explorer. Decisions with the owner on 26 Sep 2026: import → pending inserts; extend the contract with indexes now; SQL = our export INSERT; pane in `StudioView`.

## What Drizzle Studio does (from NOTES)

- Toolbar DATA / STRUCTURE. Structure lists columns (type, nullable, default, PK) plus indexes and FKs.
- Import is a dialog; we do not copy `.xlsx`.
- Filter rows persist per table in their store. Header resize uses window pointer listeners.

## Global Constraints

- Branch `feat/studio-s5-import-structure` from current `origin/main` (S4 is merged, PR #5). Isolated worktree `~/www/drizzle-base-studio` already exists — do not add another. Only `packages/studio/`, `bun.lock` if needed, the spec, `docs/STATUS.md`, `packages/studio/NOTES.md`, and this plan. If main moves, merge it in and rerun before asking to merge.
- Contract change is allowed and **must be recorded** in the spec's Contract changes list: `IndexInfo` + `TableInfo.indexes`.
- Import never calls `insertRows` / `applyEdits` itself. It is pending, saved by the same atomic Save.
- Invalid import cells are skipped; valid neighbours still apply (same as paste). Extra columns ignored; missing columns omitted (DEFAULT). SQL that names another table is an error; nothing is added to the draft.
- Indexes are honest: only the PK index the mock already enforces. Do not invent `users_email_key` without unique enforcement.
- `StudioView.pane` defaults to `"data"`. Old links without `pane` stay valid. Bad `pane` is reported and skipped.
- Biome/TS strict; `bun run check` green before every commit; sabotages restored with `cp`, never `git checkout --`.
- At Task 1 start, run `bun run check` from the repo root and record the studio unit line (`Ran N tests across M files`). Later runs keep that N/M plus only tests this plan adds. After S4 that was **243 / 36**.

## Review Focus

1. Import is pending and typed. A bad cell is skipped; a good neighbour applies. SQL round-trips `exportSql`.
2. `TableInfo.indexes` matches mock enforcement (PK only). Structure is read-only.
3. `pane=structure` is in the URL; Back returns to DATA.
4. Filter drafts survive a table switch; resize listeners do not leak after unmount.
5. No contract surprise beyond `indexes`.

## Files

- Create [`packages/studio/src/import/parse.ts`](packages/studio/src/import/parse.ts) — JSON / CSV / SQL → fields
- Create [`packages/studio/src/import/dialog.tsx`](packages/studio/src/import/dialog.tsx) — file + textarea, preview, confirm
- Create [`packages/studio/src/studio/structure.tsx`](packages/studio/src/studio/structure.tsx) — columns + indexes
- Modify [`packages/studio/src/contract/index.ts`](packages/studio/src/contract/index.ts) — `IndexInfo`, `TableInfo.indexes`
- Modify [`packages/studio/src/mock/dataset.ts`](packages/studio/src/mock/dataset.ts) — PK index from `primaryKey`
- Modify [`packages/studio/src/view/view.ts`](packages/studio/src/view/view.ts) + [`codec.ts`](packages/studio/src/view/codec.ts) — `pane`
- Modify [`packages/studio/src/studio/prefs.ts`](packages/studio/src/studio/prefs.ts) — `filterDrafts`
- Modify [`packages/studio/src/grid/resize-handle.tsx`](packages/studio/src/grid/resize-handle.tsx) — cleanup
- Modify [`packages/studio/src/studio/studio.tsx`](packages/studio/src/studio/studio.tsx) — DATA/STRUCTURE, Import
- Tests: `import.test.ts`, `studio-import.test.tsx`, `structure.test.tsx`, plus codec / prefs / datasets / resize; `e2e/import.e2e.ts`

---

### Task 1: Indexes on the contract and the mock

**Files:**

- Modify: `packages/studio/src/contract/index.ts`
- Modify: `packages/studio/src/mock/dataset.ts`
- Test: `packages/studio/test/unit/datasets.test.ts`, `packages/studio/test/conformance.ts`

**Interfaces:**

- Produces:

```ts
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}
// on TableInfo:
indexes: IndexInfo[];
```

- `mockTable`: if `primaryKey.length > 0`, `indexes: [{ name: `${name}\_pkey`, columns: primaryKey, unique: true, primary: true }]`, else `[]`. `mockView`: `indexes: []`.
- Record the contract change in the spec (date 26 Sep 2026, S5).

- [ ] **Step 1: Failing tests**

In `datasets.test.ts` add:

```ts
test("a table with a primary key lists that index; a view and a heap do not", () => {
  const d = demoDataset(1);
  const users = d.tables.find((t) => t.info.name === "users")?.info;
  expect(users?.indexes).toEqual([
    { name: "users_pkey", columns: ["id"], unique: true, primary: true },
  ]);
  expect(
    d.tables.find((t) => t.info.name === "audit_log")?.info.indexes,
  ).toEqual([]);
  expect(d.views[0]?.info.indexes).toEqual([]);
});
```

In `conformance.ts` after the `primaryKey` assert on `items`:

```ts
expect(items?.indexes).toEqual([
  { name: "items_pkey", columns: ["id"], unique: true, primary: true },
]);
```

- [ ] **Step 2: Run — fail** (`indexes` undefined)

`cd packages/studio && bun test test/unit/datasets.test.ts test/conformance.ts`

- [ ] **Step 3: Implement** `IndexInfo`, `indexes` on `TableInfo`, fill in `mockTable` / `mockView`. Spec contract-changes bullet.

- [ ] **Step 4: Tests pass.** Every existing `TableInfo` literal in tests must set `indexes: []` (or a PK index) so typecheck is green.

- [ ] **Step 5: Sabotage** — omit the PK index in `mockTable` → new test red. Restore with `cp`.

- [ ] **Step 6: Commit** `feat(studio): TableInfo lists the primary-key index`

---

### Task 2: `StudioView.pane` in the codec

**Files:**

- Modify: `packages/studio/src/view/view.ts`, `packages/studio/src/view/codec.ts`
- Test: `packages/studio/test/unit/codec.test.ts`

**Interfaces:**

- `pane: "data" | "structure"` on `StudioView`. `EMPTY_VIEW.pane = "data"`.
- `encodeView`: write `pane=structure` only when not data. `VIEW_PARAM_KEYS` gains `"pane"`.
- `decodeView`: missing → `data`; `structure` → `structure`; anything else → error `pane "…": not data or structure` and `data`.

- [ ] **Step 1: Failing test** in `codec.test.ts`:

```ts
test("pane=structure round-trips; a missing pane is data; a bad pane is skipped", () => {
  const v = view({ table: "public.users", pane: "structure" });
  expect(decodeURIComponent(encodeView(v))).toContain("pane=structure");
  expect(decodeView(`?${encodeView(v)}`)).toEqual({ view: v, errors: [] });
  expect(decodeView("?v=1&table=public.users").view.pane).toBe("data");
  expect(encodeView(view({ table: "public.t" }))).toBe("v=1&table=public.t");
  const bad = decodeView("?v=1&table=t&pane=schema");
  expect(bad.view.pane).toBe("data");
  expect(bad.errors).toEqual(['pane "schema": not data or structure']);
});
```

Existing `"a readable, stable link"` expect string stays unchanged (no `pane`).

- [ ] **Step 2–4:** fail, implement, pass. `sameView` already JSON-compares, so `pane` is included.

- [ ] **Step 5: Sabotage** — always encode `pane=data` → “defaults are left out” or the new test red.

- [ ] **Step 6: Commit** `feat(studio): StudioView.pane is data or structure in the link`

---

### Task 3: Structure pane

**Files:**

- Create: `packages/studio/src/studio/structure.tsx`
- Modify: `packages/studio/src/studio/studio.tsx`
- Test: `packages/studio/test/unit/structure.test.tsx`

**Interfaces:**

- `StructurePanel({ table: TableInfo })` — two tables, captions **Columns** and **Indexes**. Columns: name, `pgType`, nullable, default (`hasDefault` → `DEFAULT`), PK, FK (`references` as `schema.table.column`). Indexes: name, columns joined, Unique / Primary. Region `aria-label="Structure"`.
- Studio header, when a table is selected: two buttons `DATA` / `STRUCTURE` (`aria-pressed`). Click → `change({ pane }, "push")`. `view.pane === "structure"` renders `StructurePanel` instead of the grid (filters/sort/columns/add/export stay hidden or disabled — hide the grid chrome; keep the table title and the tab pair).

- [ ] **Step 1: Failing test**

```ts
test("STRUCTURE lists the primary-key index; DATA comes back on the other tab", async () => {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  render(
    <Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />,
  );
  await screen.findByText("User 1");
  fireEvent.click(screen.getByRole("button", { name: "STRUCTURE" }));
  const pane = screen.getByRole("region", { name: "Structure" });
  expect(pane.textContent).toMatch(/users_pkey/);
  expect(pane.textContent).toMatch(/uuid/);
  expect(screen.queryByRole("grid")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "DATA" }));
  expect(await screen.findByRole("grid")).toBeTruthy();
});
```

- [ ] **Step 2–4:** fail (no STRUCTURE button), implement, pass.

- [ ] **Step 5: Sabotage** — render Structure without indexes → `users_pkey` missing.

- [ ] **Step 6: Commit** `feat(studio): DATA and STRUCTURE; the structure pane lists columns and indexes`

---

### Task 4: Import parse — JSON, CSV, SQL

**Files:**

- Create: `packages/studio/src/import/parse.ts`
- Test: `packages/studio/test/unit/import.test.ts`

**Interfaces:**

```ts
export type ImportKind = "json" | "csv" | "sql";
export type ImportResult =
  | {
      ok: true;
      rows: Record<string, string>[];
      table?: { schema: string; name: string };
    }
  | { ok: false; error: string };

export function parseImport(text: string, kind: ImportKind): ImportResult;
```

- JSON: `JSON.parse` must be an array of objects. Each value: `null` → `""`; otherwise `String` (objects/arrays `JSON.stringify`).
- CSV: RFC 4180, header row required, comma, quotes, `""`. Trailing newline dropped. Empty file / no header → error.
- SQL: exactly one statement matching `exportSql`: `INSERT INTO "schema"."name" ("c", …) VALUES (…), (…);` optional trailing newline. Literals: `NULL` / `TRUE` / `FALSE` / finite number / `$tag$content$tag$` (tag `[a-z][a-z0-9]*`). Identifiers: `"` with `""` doubled. Anything else → error.

- [ ] **Step 1: Failing tests**

```ts
test("JSON / CSV / SQL of the same two rows round-trip through export", () => {
  const columns = [
    col("id", "integer", "int", { nullable: false }),
    col("name", "text", "text"),
  ];
  const rows = [
    { id: 1, name: 'say "hi"' },
    { id: 2, name: null },
  ];
  const table = { schema: "public", name: "t" };
  const json = parseImport(exportJson(columns, rows), "json");
  const csv = parseImport(exportCsv(columns, rows), "csv");
  const sql = parseImport(exportSql(table, columns, rows), "sql");
  expect(json.ok && csv.ok && sql.ok).toBe(true);
  if (json.ok && csv.ok && sql.ok) {
    expect(json.rows).toEqual([
      { id: "1", name: 'say "hi"' },
      { id: "2", name: "" },
    ]);
    expect(csv.rows).toEqual(json.rows);
    expect(sql.rows).toEqual(json.rows);
    expect(sql.table).toEqual(table);
  }
});

test("SQL that is not our INSERT is refused", () => {
  expect(parseImport("SELECT 1;", "sql").ok).toBe(false);
});
```

- [ ] **Step 2–4:** fail, implement, pass.

- [ ] **Step 5: Sabotage** — split SQL on `;` and treat `SELECT` as a row → second test red. Or JSON objects become `[object Object]`.

- [ ] **Step 6: Commit** `feat(studio): parse JSON, CSV and our INSERT SQL into field text`

---

### Task 5: Import dialog applies pending inserts

**Files:**

- Create: `packages/studio/src/import/dialog.tsx`
- Modify: `packages/studio/src/studio/studio.tsx`
- Test: `packages/studio/test/unit/studio-import.test.tsx`

**Interfaces:**

- `applyImport(draft, columns, rows: Record<string, string>[]): { draft, applied: number }` — for each row `addRow`, then for each known column `parseCellValue`; on `ok` `setNewCell`; empty → `null` if `nullable || hasDefault` else skip; unknown keys ignored.
- Dialog (role `dialog`, title **Import**): textarea, file input, kind select defaulting from extension, Preview (row count + first error), **Import** disabled when `!ok` or 0 rows. Confirm runs `applyImport` and closes.
- Studio: **Import** button next to Add row, only when `editable`. If SQL `table` is set and `tableId` ≠ current, show the error and do not apply.
- Read-only tables: no Import button.

- [ ] **Step 1: Failing test**

```ts
test("Import JSON adds pending rows; a bad enum cell is skipped", async () => {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  render(
    <Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />,
  );
  await screen.findByText("User 1");
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: JSON.stringify([{ name: "Imported", role: "not-a-role", email: "i@x.com" }]) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import" })); // the dialog confirm — use getAllBy or name "Import rows"
  await screen.findByText("Imported");
  const pending = screen.getByText("Imported").closest("[role=gridcell]");
  expect(pending?.getAttribute("data-pending")).toBe("true");
  expect(screen.queryByText("not-a-role")).toBeNull();
});
```

Use confirm name **Import rows** so it does not collide with the toolbar button.

- [ ] **Step 2–4:** fail, implement, pass. Existing `addRow` prepends; imported rows appear at the top, amber.

- [ ] **Step 5: Sabotage** — `applyImport` calls `ds.applyEdits` → pending test red (row is live, no `data-pending`) or role is written.

- [ ] **Step 6: Commit** `feat(studio): import JSON, CSV or SQL as pending inserts`

---

### Task 6: Leftovers — filter drafts and resize cleanup

**Files:**

- Modify: `packages/studio/src/studio/prefs.ts`, `packages/studio/src/studio/filter-bar.tsx`, `packages/studio/src/studio/studio.tsx`, `packages/studio/src/grid/resize-handle.tsx`
- Test: `packages/studio/test/unit/prefs.test.ts`, `packages/studio/test/unit/filter-bar.test.tsx`, `packages/studio/test/unit/resize-handle.test.tsx` (new if none)

**Interfaces:**

- `Prefs.filterDrafts(table): ViewFilter[] | null` / `setFilterDrafts(table, filters: ViewFilter[]): void`. Key `dzb-studio:${ns}:filters:${table}`, JSON array of `{column,op,text}`. Garbage → `null`.
- FilterBar: `onDraftChange?(filters: ViewFilter[]): void` on every draft edit. Studio writes `prefs.setFilterDrafts(draftKey, …)`. When opening a table, if `view.filters` is empty, initialise the bar from `prefs.filterDrafts` (unapplied leftovers). If `view.filters` is non-empty, applied (URL) wins.
- `ResizeHandle`: keep `move`/`up` in refs; `useEffect` return removes both. Unmount mid-drag must not call `onResize` after unmount.

- [ ] **Step 1: Failing tests** — prefs round-trip + garbage; filter-bar: type, remount, typed text still there via prefs; resize: unmount during pointerdown then `pointermove` does not throw / does not call `onResize`.

- [ ] **Step 2–6:** TDD, sabotage (no cleanup → move after unmount still fires), commit `fix(studio): persist filter drafts; drop resize listeners on unmount`

---

### Task 7: e2e, notes, STATUS, spec progress, review

**Files:**

- Create: `packages/studio/e2e/import.e2e.ts`
- Modify: `packages/studio/NOTES.md`, `docs/specs/STUDIO-00-ui-on-mocks.md`, `docs/STATUS.md`

- [ ] **Step 1: Playwright** — open users, Import a one-row JSON (`name` + `email`), assert pending cell; switch STRUCTURE, assert `users_pkey`; Back or DATA returns the grid. `ControlOrMeta` unused. Run `bun run test:e2e` three times; previous e2e count + 1.

- [ ] **Step 2: NOTES** — append observed import/structure (brief) and S5 decisions (pending inserts, honest PK indexes, pane in the view, leftovers).

- [ ] **Step 3: Spec Progress** — after S4, add S5 sentence + contract-change already in Task 1. `Next:` STUDIO-00 closed; core is 01a-4b then the adapter.

- [ ] **Step 4: STATUS** — S5 Done on this PR; In progress empty; Next keeps 01a-4b first; S4 row cite PR #5; numbers = actual `bun run check` / e2e counts (243 + this plan).

- [ ] **Step 5:** `bun run check && bun run test`. Commit `test(studio): import and structure end to end; S5 notes, progress`. Fresh whole-branch review; Critical/Important fixed with a failing test first. Owner merges.

## Out of scope

`.xlsx`; RLS / privileges; SQL console; bulk `importRows` API; unique indexes the mock does not enforce; xyflow diagram.
