# STUDIO-00 S4 — Selection, clipboard, export, foreign keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cell range you can copy and paste, an export of the selected rows (or the page) as JSON / CSV / SQL,
and foreign keys you can expand under the row or open as a filtered view — without changing the data-source
contract.

**Architecture:** Range, TSV, export text and reverse relations are pure functions (`src/grid/range.ts`,
`src/grid/export.ts`, `src/studio/relations.ts`). The grid owns the range (`anchor` + `focus`) and the set of
expanded FK cells; Shift+click and Shift+arrows move only `focus`. Copy writes TSV of the rectangle; paste parses
TSV at the top-left of the range and applies `setCell` / `setNewCell` for every cell that parses. Export downloads
the checkbox selection if any, otherwise `page.rows`. A foreign-key `→` (and a reverse-relation column derived
from `ColumnInfo.references`) expands a read-only preview *inside* the virtual row wrapper; TanStack Virtual's
`measureElement` reads the new height. "Open" pushes a `StudioView` (table + `eq` filter). No
`rowExpandingFeature` — Table's expanding examples are a tree or a non-virtual `<tr>`; this is Virtual + a
sub-component.

**Tech Stack:** as before. No new dependency. Clipboard is `navigator.clipboard` behind a small `ClipboardIO` so
unit tests do not need the permission. Export is a Blob download.

**Spec:** `docs/specs/STUDIO-00-ui-on-mocks.md` §4 rows "Copy & paste cell ranges; copy rows", "Export rows as
JSON / CSV / SQL", "Follow a foreign key to the referenced row". Decisions taken with the owner on 25 Sep 2026:
rectangle (click + Shift+click), not drag; TSV on the clipboard; paste becomes pending edits; export selected
rows else the current page; no `.xlsx`; FK expands inline and "Open" navigates; several expands may stay open.

## What Drizzle Studio does (observed 25 Sep 2026, drizzle-kit 0.31.11)

- A blue selected-cell border with an 8% fill; a checkbox column for rows. Its grid (react-data-grid) has **no
  range selection** — that is why we use TanStack.
- Cell context menu: Copy (C), Paste (V), Export ▸ (.json, .csv, .sql, .xlsx), Copy ▸, Expand Row.
- Toolbar `…`: refresh, export, copy.
- A foreign-key cell shows `→` on hover; it expands an inline sub-grid under the row, and "Open in sub view".
  Reverse relations are extra columns at the end (`posts`, `comments`, …), each cell a button.
- **We do not copy:** `.xlsx` (a new dependency for a mock). Filter values in localStorage and resize-listener
  leftovers stay in S5.

## Global Constraints

- Branch `feat/studio-s4-selection` from current `main`. Only `packages/studio/`, `bun.lock` if a lockfile line
  changes, the spec, `docs/STATUS.md`, `packages/studio/NOTES.md` and this plan. Before merging, compare
  `git rev-parse main` with `git merge-base main HEAD`; if main moved, merge it in and rerun everything.
- No contract change. Reverse relations are derived in the client from `references` (S1).
- A paste never writes through `updateRows` / `applyEdits`. It is pending, saved by the same atomic save.
- NULL copies as an empty TSV field. An empty paste into a nullable column is NULL; into a NOT NULL column that
  cell is skipped (the others still apply).
- Copy uses wire text (`textForEditing`), not `formatCell` (`TRUE` / `NULL`), so a paste round-trips.
- The FK preview is read-only. It does not open the row's draft on the *other* table.
- Do not add `@tanstack/react-table`'s `rowExpandingFeature`. Height is `measureElement` on the existing
  absolutely-positioned row wrapper.
- Biome/TS strict; `bun run check` green before every commit; sabotages restored with `cp`, never
  `git checkout --`.
- At the start of Task 1, run `bun run check` from the repo root and write down the studio unit line
  (`Ran N tests across M files`). Every later run must keep that N/M plus only the tests this plan adds.

## Review Focus

1. **The rectangle is the cells between anchor and focus in *display* order**, including hidden-column gaps
   skipped (only visible columns). (Task 1 + Task 2.)
2. **A paste is pending and typed.** An invalid cell is skipped; a valid neighbour still applies. (Task 3.)
3. **Export is selected-else-page**, three formats, no xlsx. (Task 4.)
4. **A `→` keeps the row on screen and shows the referenced row; Open changes the view.** Expanding must not
   collapse the virtualizer (the next row stays below the preview). (Task 5.)
5. **C/V and the context menu do the same thing.** (Task 3 + Task 6 e2e.)

## Files

| File | Owns |
|---|---|
| `src/grid/range.ts` | rectangle, TSV encode/decode |
| `src/grid/export.ts` | JSON / CSV / SQL text, `download` |
| `src/grid/clipboard.ts` | `ClipboardIO` |
| `src/studio/relations.ts` | reverse relations from `references` |
| `src/grid/fk-preview.tsx` | live mini-grid + Open |
| `src/grid/cell-menu.tsx` | context menu at the pointer |
| `src/grid/data-grid.tsx` | range, keys, expand wrappers, `measureElement` |
| `src/grid/grid-cell.tsx` | `inRange`, `→`, contextmenu |
| `src/studio/studio.tsx` | export menu, `onOpenRelation` |
| `src/studio/format.ts` | no change (copy uses `textForEditing`) |

---

### Task 1: Range and TSV — pure

**Files:**
- Create: `packages/studio/src/grid/range.ts`
- Test: `packages/studio/test/unit/range.test.ts`

**Interfaces:**
- Produces: `interface CellRef { rowId: string; column: string }`;
  `cellsInRect(anchor: CellRef, focus: CellRef, rowIds: readonly string[], columns: readonly string[]): CellRef[]`
  — every visible cell in the inclusive rectangle, row-major, `rowIds` / `columns` in display order. A corner
  whose `rowId` or `column` is missing from the lists is ignored (the other corner still defines a range if it
  is present). Empty if both corners are missing.
  `toTsv(rows: string[][]): string` — join cells with `\t`, rows with `\n`, no trailing newline on a single
  row; a cell that contains `\t` or `\n` or `"` is wrapped in `"` and internal `"` doubled.
  `parseTsv(text: string): string[][]` — the inverse, also accepting `\r\n`. A final empty line is dropped.

- [ ] **Step 1: The failing tests**

`test/unit/range.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { cellsInRect, parseTsv, toTsv } from "../../src/grid/range";

const rows = ["r1", "r2", "r3"];
const cols = ["a", "b", "c"];

describe("cellsInRect", () => {
  test("a single cell", () => {
    expect(cellsInRect({ rowId: "r2", column: "b" }, { rowId: "r2", column: "b" }, rows, cols)).toEqual([
      { rowId: "r2", column: "b" },
    ]);
  });

  test("a rectangle is inclusive and follows display order, not click order", () => {
    expect(cellsInRect({ rowId: "r3", column: "c" }, { rowId: "r2", column: "a" }, rows, cols)).toEqual([
      { rowId: "r2", column: "a" },
      { rowId: "r2", column: "b" },
      { rowId: "r2", column: "c" },
      { rowId: "r3", column: "a" },
      { rowId: "r3", column: "b" },
      { rowId: "r3", column: "c" },
    ]);
  });

  test("a corner that left the page does not empty the range", () => {
    expect(cellsInRect({ rowId: "gone", column: "a" }, { rowId: "r1", column: "b" }, rows, cols)).toEqual([
      { rowId: "r1", column: "a" },
      { rowId: "r1", column: "b" },
    ]);
  });
});

describe("TSV", () => {
  test("a rectangle round-trips, including an empty cell and a quote", () => {
    const grid = [
      ["hello", ""],
      ['say "hi"', "x\ty"],
    ];
    expect(parseTsv(toTsv(grid))).toEqual(grid);
  });

  test("a trailing newline does not invent an empty row", () => {
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]]);
  });
});
```

- [ ] **Step 2: Run the tests — they fail**

Run: `cd packages/studio && bun test test/unit/range.test.ts`

Expected: FAIL — cannot find `../../src/grid/range`.

- [ ] **Step 3: Implement**

`src/grid/range.ts`:

```ts
export interface CellRef {
  rowId: string;
  column: string;
}

export function cellsInRect(
  anchor: CellRef,
  focus: CellRef,
  rowIds: readonly string[],
  columns: readonly string[],
): CellRef[] {
  const ri = (id: string) => rowIds.indexOf(id);
  const ci = (name: string) => columns.indexOf(name);
  const rs = [ri(anchor.rowId), ri(focus.rowId)].filter((i) => i >= 0);
  const cs = [ci(anchor.column), ci(focus.column)].filter((i) => i >= 0);
  if (rs.length === 0 || cs.length === 0) return [];
  const r0 = Math.min(...rs);
  const r1 = Math.max(...rs);
  const c0 = Math.min(...cs);
  const c1 = Math.max(...cs);
  const out: CellRef[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const rowId = rowIds[r];
      const column = columns[c];
      if (rowId !== undefined && column !== undefined) out.push({ rowId, column });
    }
  }
  return out;
}

const needsQuote = (s: string) => /[\t\n\r"]/.test(s);
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

export function toTsv(rows: string[][]): string {
  return rows.map((row) => row.map((c) => (needsQuote(c) ? quote(c) : c)).join("\t")).join("\n");
}

/** RFC-ish TSV: quotes wrap a field; `""` inside a quoted field is `"`. */
export function parseTsv(text: string): string[][] {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = src.endsWith("\n") ? src.slice(0, -1) : src;
  if (trimmed === "") return [];
  const rows: string[][] = [];
  for (const line of trimmed.split("\n")) {
    const cells: string[] = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let s = "";
        i += 1;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          if (line[i] === '"') {
            i += 1;
            break;
          }
          s += line[i];
          i += 1;
        }
        cells.push(s);
        if (line[i] === "\t") i += 1;
        else if (i >= line.length) break;
      } else {
        const tab = line.indexOf("\t", i);
        if (tab < 0) {
          cells.push(line.slice(i));
          break;
        }
        cells.push(line.slice(i, tab));
        i = tab + 1;
      }
    }
    rows.push(cells);
  }
  return rows;
}
```

- [ ] **Step 4: Tests pass**

Run: `cd packages/studio && bun test test/unit/range.test.ts`

Expected: `4 pass`, `0 fail`.

- [ ] **Step 5: Sabotage**

`cellsInRect` uses click order (`[anchor…focus]` without min/max) → `follows display order` red. Restore with
`cp` from a `*.bak`.

- [ ] **Step 6: Commit**

```bash
git add packages/studio/src/grid/range.ts packages/studio/test/unit/range.test.ts
git commit -m "feat(studio): a cell rectangle and TSV that round-trips quotes"
```

---

### Task 2: The grid selects a rectangle

**Files:**
- Modify: `packages/studio/src/grid/grid-cell.tsx`
- Modify: `packages/studio/src/grid/data-grid.tsx`
- Test: `packages/studio/test/unit/grid-range.test.tsx`

**Interfaces:**
- Consumes: `cellsInRect`, `CellRef` from Task 1.
- Produces: a focused cell (`aria-selected`) and a range (`data-range`). `onSelect(ref, { extend })`. Arrow keys
  move focus (and the anchor unless Shift). Enter still edits the focus.

- [ ] **Step 1: The failing tests**

`test/unit/grid-range.test.tsx` — reuse the tiny table from `data-grid.test.tsx` (id + label, 20 rows so every
row is in the window):

```ts
import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Page, TableInfo } from "../../src/contract";
import { DataGrid } from "../../src/grid/data-grid";
import { col } from "../../src/mock";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const table: TableInfo = {
  schema: "public",
  name: "t",
  kind: "table",
  columns: [
    col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }),
    col("label", "text", "text"),
  ],
  primaryKey: ["id"],
  estimatedRows: 20,
};
const page: Page = {
  rows: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` })),
  total: 20,
  hasMore: false,
  revision: 1,
};

function renderGrid() {
  render(
    <DataGrid
      table={table}
      page={page}
      changed={new Set()}
      columns={layoutColumns(table.columns, EMPTY_LAYOUT).visible}
      sort={[]}
      onSort={() => {}}
      onResize={() => {}}
    />,
  );
  return screen.getByRole("grid");
}
const cell = (text: string) => screen.getByText(text).closest("[role=gridcell]") as HTMLElement;

test("click selects one cell; Shift+click extends a rectangle", () => {
  const grid = renderGrid();
  fireEvent.click(cell("row 1"));
  expect(cell("row 1").getAttribute("aria-selected")).toBe("true");
  expect(cell("row 2").hasAttribute("data-range")).toBe(false);
  fireEvent.click(cell("row 3"), { shiftKey: true });
  expect(cell("row 1").hasAttribute("data-range")).toBe(true);
  expect(cell("row 2").hasAttribute("data-range")).toBe(true);
  expect(cell("row 3").hasAttribute("data-range")).toBe(true);
  expect(cell("row 3").getAttribute("aria-selected")).toBe("true");
  expect(cell("row 4").hasAttribute("data-range")).toBe(false);
  fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
  expect(cell("row 4").hasAttribute("data-range")).toBe(true);
});
```

- [ ] **Step 2: Run — fail**

Run: `cd packages/studio && bun test test/unit/grid-range.test.tsx`

Expected: FAIL — `data-range` is not set (or `aria-selected` never appears on Shift+click of a second cell).

- [ ] **Step 3: Implement**

`grid-cell.tsx`: add `inRange: boolean` and `onSelect(extend: boolean)`. `data-range={p.inRange || undefined}`.
`onClick={(e) => p.onSelect(e.shiftKey)}`. Add to the className:
`data-range:bg-primary/10` (the 8% fill; the focus cell keeps `aria-selected:outline-…`).

`data-grid.tsx`: replace `const [selected, setSelected] = useState<CellRef | null>(null)` with

```ts
const [anchor, setAnchor] = useState<CellRef | null>(null);
const [focus, setFocus] = useState<CellRef | null>(null);
```

`display` row ids: `const rowIds = display.map((d) => d.id)`.
`const colNames = columns.map((c) => c.column.name)`.
`const range = anchor && focus ? new Set(cellsInRect(anchor, focus, rowIds, colNames).map((c) => cellKey(c.rowId, c.column))) : new Set<string>()`.

`select(ref, extend)`: `setFocus(ref)`; `setAnchor((a) => (extend && a ? a : ref))`; `editing?.onFocusRow(ref.rowId)`.

Click on `GridCell`: `onSelect={(extend) => select(ref, extend)}`.
`selected={focus?.rowId === d.id && focus.column === name}`.
`inRange={range.has(k)}`.

`onKeyDown` on the grid (when not editing):

```ts
const move = (dr: number, dc: number, extend: boolean) => {
  if (!focus) return;
  const r = rowIds.indexOf(focus.rowId);
  const c = colNames.indexOf(focus.column);
  const nr = Math.max(0, Math.min(rowIds.length - 1, r + dr));
  const nc = Math.max(0, Math.min(colNames.length - 1, c + dc));
  const next = { rowId: rowIds[nr] ?? focus.rowId, column: colNames[nc] ?? focus.column };
  select(next, extend);
};
if (e.key === "ArrowDown") { e.preventDefault(); move(1, 0, e.shiftKey); }
if (e.key === "ArrowUp") { e.preventDefault(); move(-1, 0, e.shiftKey); }
if (e.key === "ArrowRight") { e.preventDefault(); move(0, 1, e.shiftKey); }
if (e.key === "ArrowLeft") { e.preventDefault(); move(0, -1, e.shiftKey); }
```

Keep Enter / Escape as they are (Enter edits `focus`; Escape clears `anchor` and `focus`).

`startEditing` sets both corners to `ref`.

- [ ] **Step 4: Tests pass**

Run: `cd packages/studio && bun test test/unit/grid-range.test.tsx test/unit/data-grid.test.tsx test/unit/grid-edit.test.tsx`

Expected: all pass. Existing click-to-select behaviour is unchanged for a plain click.

- [ ] **Step 5: Sabotage**

`select` always sets the anchor (`extend` ignored) → Shift+click test red (`row 1` not in range, or `row 3` is
the only cell). Restore with `cp`.

- [ ] **Step 6: Commit**

```bash
git add packages/studio/src/grid/data-grid.tsx packages/studio/src/grid/grid-cell.tsx packages/studio/test/unit/grid-range.test.tsx
git commit -m "feat(studio): Shift+click and Shift+arrows select a cell rectangle"
```

---

### Task 3: Copy, paste, context menu

**Files:**
- Create: `packages/studio/src/grid/clipboard.ts`
- Create: `packages/studio/src/grid/cell-menu.tsx`
- Modify: `packages/studio/src/grid/data-grid.tsx`
- Modify: `packages/studio/src/grid/grid-cell.tsx`
- Test: `packages/studio/test/unit/grid-clipboard.test.tsx`

**Interfaces:**
- Consumes: `cellsInRect`, `toTsv`, `parseTsv`; `textForEditing`, `parseCellValue`; `setCell` / `setNewCell` via
  existing `GridEditing`.
- Produces: `interface ClipboardIO { write(text: string): Promise<void>; read(): Promise<string> }`;
  `browserClipboard: ClipboardIO`;
  `valuesToTsv(cells: CellRef[], valueOf: (c: CellRef) => { col: ColumnInfo; value: CellValue | undefined }): string`
  — one TSV row per distinct `rowId` in `cells` order, one column per distinct `column` in `cells` order; empty
  string for NULL / DEFAULT.
  `applyTsv(text, origin: CellRef, rowIds, columns, …): number` lives in the grid as a closure (it needs the
  draft callbacks). Returns how many cells were applied.
  `DataGrid` gains optional `clipboard?: ClipboardIO` (default `browserClipboard`).
  Context menu (role `menu`) at the pointer: Copy, Paste, Expand Row (when `editing` is set). Export items arrive
  in Task 4 — leave a comment `// Task 4: Export ▸` or add disabled stubs; prefer adding them in Task 4 so this
  task's menu is only Copy / Paste / Expand Row.

- [ ] **Step 1: The failing tests**

`test/unit/grid-clipboard.test.tsx` — Harness like `grid-edit.test.tsx` (demo users, 5 rows, textarea
`codeEditor` is irrelevant here). Inject a memory clipboard:

```ts
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { Page, TableInfo } from "../../src/contract";
import { EMPTY_DRAFT, setCell, setNewCell, type TableDraft } from "../../src/edit/draft";
import type { ClipboardIO } from "../../src/grid/clipboard";
import { DataGrid } from "../../src/grid/data-grid";
import { demoDataset } from "../../src/mock";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const users = demoDataset(1).tables[0]?.info as TableInfo;
const rows = (demoDataset(1).tables[0]?.rows ?? []).slice(0, 5);
const page: Page = { rows, total: 5, hasMore: false, revision: 1 };

function memory(): ClipboardIO & { text: string } {
  const io = { text: "" };
  return {
    get text() {
      return io.text;
    },
    set text(v: string) {
      io.text = v;
    },
    write: async (t) => {
      io.text = t;
    },
    read: async () => io.text,
  };
}

function Harness({ clip }: { clip: ClipboardIO }) {
  const [draft, setDraft] = useState<TableDraft>(EMPTY_DRAFT);
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
        clipboard={clip}
        editing={{
          draft,
          conflicts: new Set(),
          selectedRows: new Set(),
          onToggleRow: () => {},
          onToggleAll: () => {},
          onEditExisting: (rowId, key, column, value, original) =>
            setDraft((d) => setCell(d, rowId, key, column, value, original)),
          onEditNew: (id, column, value) => setDraft((d) => setNewCell(d, id, column, value)),
          onRemoveNew: () => {},
          onExpandRow: () => {},
          onFocusRow: () => {},
        }}
      />
    </>
  );
}

describe("clipboard", () => {
  test("copy writes TSV of the rectangle; paste applies it as pending edits", async () => {
    const clip = memory();
    render(<Harness clip={clip} />);
    fireEvent.click(screen.getByText("User 1").closest("[role=gridcell]") as HTMLElement);
    fireEvent.click(screen.getByText("User 2").closest("[role=gridcell]") as HTMLElement, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", metaKey: true });
    await act(() => Promise.resolve());
    expect(clip.text).toBe("User 1\nUser 2");
    fireEvent.click(screen.getByText("User 3").closest("[role=gridcell]") as HTMLElement);
    await act(async () => {
      clip.text = "From TSV\nAlso";
      fireEvent.keyDown(screen.getByRole("grid"), { key: "v", metaKey: true });
      await Promise.resolve();
    });
    const draft = JSON.parse(screen.getByTestId("draft").textContent ?? "");
    const names = Object.values(draft.updates as Record<string, { cells: Record<string, { value: unknown }> }>).map(
      (u) => u.cells["name"]?.value,
    );
    expect(names).toContain("From TSV");
    expect(names).toContain("Also");
  });

  test("an unparsable paste cell is skipped; a valid neighbour still applies", async () => {
    const clip = memory();
    render(<Harness clip={clip} />);
    fireEvent.click(screen.getByText("User 1").closest("[role=gridcell]") as HTMLElement);
    await act(async () => {
      // One row, two columns: name (text) then role (enum). Tab, not newline.
      clip.text = "Pasted\tnot-a-role";
      fireEvent.keyDown(screen.getByRole("grid"), { key: "v", metaKey: true });
      await Promise.resolve();
    });
    const draft = JSON.parse(screen.getByTestId("draft").textContent ?? "");
    const cells = Object.values(draft.updates as Record<string, { cells: Record<string, { value: unknown }> }>)[0]
      ?.cells;
    expect(cells?.["name"]?.value).toBe("Pasted");
    expect(cells?.["role"]).toBeUndefined();
  });

  test("the context menu copies the same TSV as ⌘C", async () => {
    const clip = memory();
    render(<Harness clip={clip} />);
    const name = screen.getByText("User 1").closest("[role=gridcell]") as HTMLElement;
    fireEvent.contextMenu(name);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
      await Promise.resolve();
    });
    expect(clip.text).toBe("User 1");
  });
});
```

- [ ] **Step 2: Run — fail**

Expected: FAIL — `clipboard` prop unused, ⌘C does not write, or no menuitem Copy.

- [ ] **Step 3: Implement**

`src/grid/clipboard.ts`:

```ts
export interface ClipboardIO {
  write(text: string): Promise<void>;
  read(): Promise<string>;
}

export const browserClipboard: ClipboardIO = {
  write: (text) => navigator.clipboard.writeText(text),
  read: () => navigator.clipboard.readText(),
};
```

`src/grid/cell-menu.tsx` — a controlled menu, no trigger, positioned at `(x, y)`:

```ts
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";

export function CellMenu({
  x,
  y,
  onCopy,
  onPaste,
  onExpand,
  onClose,
}: {
  x: number;
  y: number;
  onCopy(): void;
  onPaste(): void;
  onExpand?: () => void;
  onClose(): void;
}) {
  return (
    <DropdownMenu open onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuContent
        align="start"
        className="min-w-40"
        style={{ position: "fixed", left: x, top: y }}
      >
        <DropdownMenuItem onClick={onCopy}>Copy</DropdownMenuItem>
        <DropdownMenuItem onClick={onPaste}>Paste</DropdownMenuItem>
        {onExpand && <DropdownMenuItem onClick={onExpand}>Expand Row</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

If Base UI's `DropdownMenuContent` ignores `style` left/top, wrap it in a `div` with `position:fixed; left; top;
width:0; height:0` as the positioner parent and put the menu inside. The test only needs `getByRole("menuitem")`.

In `data-grid.tsx`:

- `clipboard = browserClipboard` default.
- `valueOf(ref)` uses existing `cellValue` + `columns`.
- `copy()`: `cells = cellsInRect(anchor ?? focus, focus, rowIds, colNames)` (no-op if no focus). Group into a
  matrix by walking unique rowIds × unique columns of `cells` (already row-major). Each field is
  `textForEditing(col, value)` or `""` when `value` is `null` or `undefined`. `void clipboard.write(toTsv(matrix))`.
- `paste()`: `clipboard.read()` then for `r, c` of `parseTsv(text)`, target
  `rowIds[rowIndex(focus) + r]`, `colNames[colIndex(focus) + c]`. Look up the display row and column. Parse with
  `parseCellValue`. On `ok`, call `onEditNew` / `onEditExisting` as `commit` already does (same `original` =
  live row value). Skip `!ok`. Empty string → `null` if `column.nullable || isNew`, else skip.
- Keys: `c`/`v` with `metaKey || ctrlKey`, only when `!editingCell`. `e.preventDefault()`.
- `onContextMenu` on `GridCell`: `preventDefault`, `select(ref, false)` unless the cell is already in the range,
  then open `CellMenu` at `clientX/Y`. Expand Row calls `editing.onExpandRow(ref.rowId)`.

Do not copy while an input is focused (the cell editor): `onKeyDown` already returns early when `editingCell` is
set.

- [ ] **Step 4: Tests pass**

Run: `cd packages/studio && bun test test/unit/grid-clipboard.test.tsx test/unit/grid-range.test.tsx test/unit/grid-edit.test.tsx`

Expected: all pass.

- [ ] **Step 5: Sabotage**

`paste` writes through a fake `updateRows` or applies `!ok` values → second test red. Or copy uses `formatCell`
(`User 1` is fine; sabotage with a boolean: copy `TRUE` then paste fails). Add a boolean assertion if needed:
copy of `active` on User 1 is `true` / `false`, not `TRUE`. Restore with `cp`.

- [ ] **Step 6: Commit**

```bash
git add packages/studio/src/grid/clipboard.ts packages/studio/src/grid/cell-menu.tsx packages/studio/src/grid/data-grid.tsx packages/studio/src/grid/grid-cell.tsx packages/studio/test/unit/grid-clipboard.test.tsx
git commit -m "feat(studio): copy and paste a TSV rectangle as pending edits"
```

---

### Task 4: Export JSON / CSV / SQL

**Files:**
- Create: `packages/studio/src/grid/export.ts`
- Modify: `packages/studio/src/studio/studio.tsx` (toolbar `…` menu)
- Modify: `packages/studio/src/grid/cell-menu.tsx` (Export ▸)
- Test: `packages/studio/test/unit/export.test.ts`
- Test: `packages/studio/test/unit/studio-export.test.tsx`

**Interfaces:**
- Consumes: `ColumnInfo`, `Row`, `TableRef`.
- Produces:
  `exportJson(columns: ColumnInfo[], rows: Row[]): string` — `JSON.stringify` of objects keyed by column name,
  `null` for missing, 2-space indent, trailing newline.
  `exportCsv(columns, rows): string` — header + RFC 4180 rows; `textForEditing` for values; empty for null.
  `exportSql(table: TableRef, columns, rows): string` — one
  `INSERT INTO "schema"."name" ("c", …) VALUES (…), (…);\n`. Identifiers: `"` doubled. NULL / TRUE / FALSE /
  finite numbers bare; everything else dollar-quoted (`$dzb$…$dzb$`, bump the tag if the value contains it).
  `download(filename: string, text: string, mime: string): void` — `<a download>` + `URL.createObjectURL`.
  `rowsToExport(selectedIds: ReadonlySet<string>, pageRows: { id: string; row: Row }[]): Row[]` — selected rows
  in page order if `selectedIds.size > 0`, else every page row.

- [ ] **Step 1: The failing tests**

`test/unit/export.test.ts`:

```ts
import { expect, test } from "bun:test";
import { exportCsv, exportJson, exportSql, rowsToExport } from "../../src/grid/export";
import { col } from "../../src/mock";

const columns = [
  col("id", "integer", "int", { nullable: false }),
  col("name", "text", "text"),
  col("ok", "boolean", "boolean"),
];
const rows = [
  { id: 1, name: 'say "hi"', ok: true },
  { id: 2, name: null, ok: false },
];

test("JSON is an array of row objects", () => {
  expect(JSON.parse(exportJson(columns, rows))).toEqual([
    { id: 1, name: 'say "hi"', ok: true },
    { id: 2, name: null, ok: false },
  ]);
});

test("CSV quotes commas, quotes and newlines; NULL is empty", () => {
  expect(exportCsv(columns, rows)).toBe('id,name,ok\n1,"say ""hi""",true\n2,,false\n');
});

test("SQL inserts dollar-quote text and keeps NULL / TRUE", () => {
  const sql = exportSql({ schema: "public", name: "t" }, columns, rows);
  expect(sql).toContain('INSERT INTO "public"."t" ("id", "name", "ok") VALUES');
  expect(sql).toContain("1, $dzb$say \"hi\"$dzb$, TRUE");
  expect(sql).toContain("2, NULL, FALSE");
});

test("rowsToExport prefers the selection, in page order", () => {
  const page = [
    { id: "b", row: rows[1]! },
    { id: "a", row: rows[0]! },
  ];
  expect(rowsToExport(new Set(["a"]), page)).toEqual([rows[0]]);
  expect(rowsToExport(new Set(), page)).toEqual(rows.slice().reverse());
});
```

`test/unit/studio-export.test.tsx`: render `<Studio>` on users, select one row's checkbox, spy `download` by
exporting a hook — **simpler:** export `download` from `export.ts` and replace it in the test module:

```ts
import { expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_VIEW, Studio } from "../../src";
import * as exp from "../../src/grid/export";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

test("Export JSON downloads the selected row, not the whole page", async () => {
  const calls: string[] = [];
  const orig = exp.download;
  (exp as { download: typeof exp.download }).download = (name, text) => {
    calls.push(name, text);
  };
  try {
    const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
    render(
      <Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />,
    );
    await screen.findByText("User 1");
    fireEvent.click(screen.getAllByLabelText("Select row")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "JSON" }));
    expect(calls[0]).toMatch(/users\.json$/);
    const parsed = JSON.parse(calls[1] ?? "[]");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.email).toBe("user1@example.com");
  } finally {
    (exp as { download: typeof orig }).download = orig;
  }
});
```

Re-assigning a named export may not stick under Bun. **Prefer passing `download` as a Studio/DataGrid prop only
if the spy fails**; otherwise test the toolbar by making `export.ts` read:

```ts
export let download = (filename: string, text: string, mime: string) => { … };
export const setDownloadForTests = (fn: typeof download) => {
  download = fn;
};
```

YAGNI: keep `download` a plain function and **only unit-test `exportJson` / `rowsToExport`**. The studio test
clicks Export → JSON and asserts a `<a download>` was created:

```ts
const created: string[] = [];
const real = document.createElement.bind(document);
document.createElement = ((tag: string) => {
  const el = real(tag);
  if (tag === "a") {
    Object.defineProperty(el, "click", { value: () => created.push(el.getAttribute("download") ?? "", el.href) });
  }
  return el;
}) as typeof document.createElement;
```

Restore `document.createElement` in `finally`. This is enough.

- [ ] **Step 2: Run — fail**

Expected: FAIL — cannot find `../../src/grid/export`.

- [ ] **Step 3: Implement**

`src/grid/export.ts` as specified. `download`:

```ts
export function download(filename: string, text: string, mime: string): void {
  const a = document.createElement("a");
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

`textOf(col, v)`: `v == null ? "" : textForEditing(col, v)` (import from `../edit/values`).

Toolbar in `studio.tsx`, right side, `…` (`MoreHorizontal` from lucide), `aria-label="Export"`:
Copy (TSV with a header row — the spec's "copy rows"), JSON / CSV / SQL. File name `{table.name}.{json|csv|sql}`.
Mime `application/json` / `text/csv` / `text/plain`. Rows: `rowsToExport(selectedRows, pageRows)`. Copy uses
`browserClipboard.write(exportCsv(…))` but tab-separated (or `toTsv` of header + `textForEditing` rows).

Cell menu: submenu or three items "Export JSON", "Export CSV", "Export SQL" that export **the rows touched by
the current range** (unique `rowId`s in `cellsInRect`, in display order), not the checkbox selection. If the
range is empty, same as toolbar (selected-else-page). Pass `onExport(kind)` from the grid up, or call `download`
inside the grid with columns + those rows. **Do it inside the grid** so the menu does not need the page. Toolbar
stays in `Studio`.

- [ ] **Step 4: Tests pass + check**

Run: `cd packages/studio && bun test test/unit/export.test.ts test/unit/studio-export.test.tsx`

Then from repo root: `bun run check`.

- [ ] **Step 5: Sabotage**

`rowsToExport` ignores the set and always returns every page row → studio test red (`parsed` length 50). Restore
with `cp`.

- [ ] **Step 6: Commit**

```bash
git add packages/studio/src/grid/export.ts packages/studio/src/grid/cell-menu.tsx packages/studio/src/studio/studio.tsx packages/studio/test/unit/export.test.ts packages/studio/test/unit/studio-export.test.tsx
git commit -m "feat(studio): export the selection, or the page, as JSON, CSV or SQL"
```

---

### Task 5: Foreign keys — expand under the row, Open navigates

**Files:**
- Create: `packages/studio/src/studio/relations.ts`
- Create: `packages/studio/src/grid/fk-preview.tsx`
- Modify: `packages/studio/src/grid/data-grid.tsx`
- Modify: `packages/studio/src/grid/grid-cell.tsx`
- Modify: `packages/studio/src/studio/studio.tsx`
- Test: `packages/studio/test/unit/relations.test.ts`
- Test: `packages/studio/test/unit/fk-preview.test.tsx`

**Interfaces:**
- Consumes: `ColumnInfo.references`; `usePage` / `subscribePage`; `StudioView` / `ViewFilter`.
- Produces:
  `interface Relation { kind: "forward" | "reverse"; name: string; table: TableRef; column: string; local: string }`
  — `forward`: this column `references` `table.column`, `local` is this column's name, `name` is `table.name`.
  `reverse`: some other table's column references this table's `local` (a PK or unique we only know as
  `isPrimaryKey`), `name` is the other table's name (if two columns from the same table point here, `name` is
  `{table}_{column}`).
  `relationsOf(table: TableInfo, all: TableInfo[]): Relation[]` — forwards in column order, then reverses in
  `all` order.
  `FkPreview` props: `{ ds, table, column, value, onOpen }` where `table`+`column` are the *target*, `value` is
  the local cell. Subscribes `limit: 5`, `filters: [{ column, op: "eq", value }]`, `withTotal: true`. Shows a
  compact read-only grid of the page (column names + `formatCell`) and a button "Open" that calls
  `onOpen()`. Empty: "No matching row."
  `DataGrid` props: `tables?: TableInfo[]`, `dataSource?: StudioDataSource`,
  `onOpenRelation?(view: Pick<StudioView, "table" | "filters">): void`.
  Reverse columns are **appended after** `columns` (the laid-out data columns), width 140, not in `layout`
  prefs, not hideable in S4. A reverse cell shows a count button (the preview's `total`, or `→`). A forward
  cell (`references`) shows the value plus a `→` button (`aria-label="Open {table}"`).
  Expanded set: `Set<string>` keyed by `cellKey(rowId, column)` where `column` is the **local** column name or
  the reverse relation `name`. Several may be open. The preview is rendered **inside** the virtual row
  wrapper, under the cells, full grid width.
  Virtualizer: `estimateSize: (i) => (rowHasExpand(display[i]) ? 32 + 160 : 32)`,
  `measureElement` as the row wrapper `ref`, `data-index={item.index}` required by TanStack Virtual. Do not
  give the wrapper a fixed `height: 32` when expanded — `minHeight: 32` and let the preview grow.
  Open: `onOpenRelation({ table: tableId(target), filters: [{ column: targetColumn, op: "eq", text: wireText }] })`.
  `Studio` `change`s that with `offset: 0`, same `limit`, `history: "push"`.

- [ ] **Step 1: The failing tests**

`test/unit/relations.test.ts`:

```ts
import { expect, test } from "bun:test";
import { demoDataset } from "../../src/mock";
import { relationsOf } from "../../src/studio/relations";

test("posts.author_id is a forward relation to users; users has reverse posts", () => {
  const tables = demoDataset(1).tables.map((t) => t.info);
  const posts = tables.find((t) => t.name === "posts");
  const users = tables.find((t) => t.name === "users");
  if (!posts || !users) throw new Error("demo");
  expect(relationsOf(posts, tables)).toContainEqual({
    kind: "forward",
    name: "users",
    table: { schema: "public", name: "users" },
    column: "id",
    local: "author_id",
  });
  expect(relationsOf(users, tables).some((r) => r.kind === "reverse" && r.table.name === "posts")).toBe(true);
});
```

`test/unit/fk-preview.test.tsx`:

```ts
import { expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_VIEW, Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

test("→ under a posts row shows the author; Open filters users to that id", async () => {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  const views: string[] = [];
  render(
    <Studio
      dataSource={ds}
      codeEditor="textarea"
      defaultView={{ ...EMPTY_VIEW, table: "public.posts" }}
      onViewChange={(v) => views.push(v.table ?? "")}
    />,
  );
  await screen.findByText("Post 1");
  const row = screen.getByText("Post 1").closest("[role=row]") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /users/i }));
  await settle();
  const preview = screen.getByRole("region", { name: "Related users" });
  expect(preview.textContent).toMatch(/user\d+@example\.com/);
  // The next data row is still below the preview (virtualizer did not overlap it).
  const post1 = screen.getByText("Post 1").closest("[role=row]") as HTMLElement;
  const post2 = screen.getByText("Post 2").closest("[role=row]") as HTMLElement;
  expect(post2.getBoundingClientRect().top).toBeGreaterThan(post1.getBoundingClientRect().bottom);
  fireEvent.click(within(preview).getByRole("button", { name: "Open" }));
  expect(views.at(-1)).toBe("public.users");
  await settle();
  expect(screen.getByLabelText("Value").getAttribute("value") ?? screen.getByLabelText("Value").textContent).toBeTruthy();
});
```

The last assertion is weak. After Open, the filter bar is open (S2 opens it when `filters.length > 0`) and the
grid shows **one** user (the author of Post 1). Assert:

```ts
  await screen.findByText(/1 - 1 of 1/);
  expect(screen.getByText(/@example\.com/).textContent).toMatch(/@example\.com/);
```

Post 1's `author_id` is `users[(1-1) % 3000]` = User 1, email `user1@example.com`.

- [ ] **Step 2: Run — fail**

Expected: FAIL — no `relationsOf`, no `→` button, or Open does not change the view.

- [ ] **Step 3: Implement**

`src/studio/relations.ts` — walk `table.columns` for `references`; walk `all` for incoming. Skip a reverse onto
a view if you want (include them: a view with `references` is unlikely in the mock).

`src/grid/fk-preview.tsx` — `usePage(ds, req, targetTable)` with `req` memoised on `table/column/value`.
`aria-label={`Related ${table.name}`}`. Table of visible columns (skip virtual ones). Button Open.

`grid-cell.tsx` — if `column.references`, render a button after the text:

```tsx
<button type="button" aria-label={`Open ${column.references.table}`} onClick={(e) => { e.stopPropagation(); onToggleRelation(); }}>→</button>
```

New optional props: `onToggleRelation?`, `relationOpen?: boolean`.

`data-grid.tsx`:
- Build `forward` from `table.columns`.
- Build reverse `LaidOutColumn`-like entries: `{ column: { name: rel.name, kind: "text", pgType: "relation", … }, width: 140 }` — **do not** invent a fake `ColumnInfo` that `parseCellValue` could see. Render reverse cells as their own branch (not `GridCell` editor): a button that toggles expand.
- State `expanded: Set<string>`.
- Row wrapper:

```tsx
<div
  ref={virtual.measureElement}
  data-index={item.index}
  role="row"
  style={{
    position: "absolute",
    left: 0,
    transform: `translateY(${item.start}px)`,
    width,
    minHeight: ROW_HEIGHT,
  }}
>
  <div className="flex" style={{ height: ROW_HEIGHT, width }}>{/* cells as today */}</div>
  {openRels.map((rel) => (
    <FkPreview key={rel.name} … />
  ))}
</div>
```

Remove the old `style={{ height: ROW_HEIGHT, … }}` that **fixes** the row at 32px — that is what would overlap
the next row.

`estimateSize: (index) => { const d = display[index]; return d && expandedFor(d.id).length ? 32 + 160 : 32 }`.

`studio.tsx`:

```ts
onOpenRelation: (next) =>
  change({ table: next.table, filters: next.filters, sort: [], offset: 0 }, "push"),
```

Pass `dataSource`, `tables`, `onOpenRelation` into `DataGrid`.

- [ ] **Step 4: Tests pass**

Run: `cd packages/studio && bun test test/unit/relations.test.ts test/unit/fk-preview.test.tsx test/unit/data-grid.test.tsx`

Expected: all pass. If `getBoundingClientRect` in happy-dom is all zeros, **assert the wrapper's
`offsetHeight` (or computed `minHeight` / child count) instead**:
`expect(post1.querySelector("[aria-label='Related users']")).toBeTruthy()` and
`expect((post1 as HTMLElement).style.height).not.toBe("32px")`. The overlap check is the property — keep it if
happy-dom gives real layout (it often does after `measureElement`). If the rects are all 0, assert
`virtual.getTotalSize()` grew after expand (expose nothing — instead `expect(post1.childElementCount).toBeGreaterThan(1)`).
**Do not ship a vacuous overlap test.** If rects are 0, drop that expect and keep "preview is a descendant of
the same role=row as Post 1".

- [ ] **Step 5: Sabotage**

Leave `height: ROW_HEIGHT` on the wrapper → if the overlap assert exists it goes red; if not, sabotage
`onOpenRelation` so it `replace`s without filters → `1 - 1 of 1` missing. Restore with `cp`.

- [ ] **Step 6: Commit**

```bash
git add packages/studio/src/studio/relations.ts packages/studio/src/grid/fk-preview.tsx packages/studio/src/grid/data-grid.tsx packages/studio/src/grid/grid-cell.tsx packages/studio/src/studio/studio.tsx packages/studio/test/unit/relations.test.ts packages/studio/test/unit/fk-preview.test.tsx
git commit -m "feat(studio): foreign keys expand under the row; Open is a filtered view"
```

---

### Task 6: e2e, notes, STATUS, spec progress, review

**Files:**
- Create: `packages/studio/e2e/selection.e2e.ts`
- Modify: `packages/studio/NOTES.md`
- Modify: `docs/specs/STUDIO-00-ui-on-mocks.md` (Progress)
- Modify: `docs/STATUS.md` (S3b done, S4 in progress → done at the end of this task)

**Interfaces:** none.

- [ ] **Step 1: Playwright**

`e2e/selection.e2e.ts`:

```ts
import { expect, test } from "@playwright/test";

test("a copied name pastes as a pending edit; a foreign key opens the user", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?v=1&table=public.posts");
  await expect(page.getByRole("gridcell", { name: "Post 1", exact: true })).toBeVisible();
  const row = page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: "Post 1", exact: true }) });
  await row.getByRole("button", { name: /users/i }).click();
  const preview = page.getByRole("region", { name: "Related users" });
  await expect(preview.getByText(/@example\.com/)).toBeVisible();
  await preview.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/table=public\.users/);
  await expect(page.getByText(/1 - 1 of 1/)).toBeVisible();

  await page.goto("/?v=1&table=public.users");
  await expect(page.getByRole("gridcell", { name: "User 1", exact: true })).toBeVisible();
  await page.getByRole("gridcell", { name: "User 1", exact: true }).click();
  await page.keyboard.press("Meta+c");
  await page.getByRole("gridcell", { name: "User 2", exact: true }).click();
  await page.keyboard.press("Meta+v");
  await expect(page.getByRole("gridcell", { name: "User 1", exact: true })).toHaveCount(2);
  await expect(page.getByRole("gridcell", { name: "User 1", exact: true }).nth(1)).toHaveAttribute(
    "data-pending",
    "true",
  );
});
```

On Linux CI the modifier is `Control`. Use `page.keyboard.press("ControlOrMeta+c")` (Playwright supports it, as
`editors.e2e.ts` does).

Run: `cd packages/studio && bun run test:e2e` three times. Expected: previous e2e count + 1.

Sabotage: `Open` does `history: "replace"` without filters → URL has `table=public.users` but not one row.
Restore with `cp`.

- [ ] **Step 2: NOTES.md — append**

```markdown
## Selection, export, relations (S4, observed 25 Sep 2026)

- One selected cell (blue outline, 8% fill). Checkboxes select rows for delete. No cell range in their grid
  (react-data-grid). Context menu: Copy (C), Paste (V), Export ▸ (.json .csv .sql .xlsx), Expand Row.
- Toolbar `…` exports / copies. Export is the current result, not a server cursor.
- FK: `→` on hover expands a sub-grid; "Open in sub view" goes to that table. Reverse relations are extra
  columns (`posts`, `comments`, …).

## Decisions taken from this (S4)

- We own a rectangle (click + Shift+click / Shift+arrows). Copy is TSV of wire text; paste is pending edits;
  an invalid cell is skipped.
- Export is `.json` / `.csv` / `.sql` of the checkbox selection, or the page. No `.xlsx`.
- FK preview is a measured block inside the virtual row, not Table's expanding model. Open pushes a
  `StudioView`. Reverse columns are derived from `references` and are not in the layout prefs.
```

- [ ] **Step 3: Spec Progress**

After the S3b sentence, add:
`S4 (\`docs/superpowers/plans/2026-09-25-studio-00-4-selection.md\`): cell range, TSV clipboard, export of the
selection or page, foreign-key preview and Open.`
Change `Next: S4 …` to `Next: S5 import UI, structure tab, final review.`

- [ ] **Step 4: STATUS.md**

Move STUDIO-00 S3b into **Done** (plan `…studio-00-3b-editors`, PR #3 / #4). Replace **In progress** S3b with
nothing after this task lands (S4 is this PR). Under **Next**, studio work is S5; keep 01a-4b first for the
core. Numbers: replace the stale "178 (studio)" line with the count `bun run check` prints.

- [ ] **Step 5: Verify, commit, review**

Run from the repo root: `bun run check && bun run test`. Record the studio unit `Ran N tests across M files`
and the Playwright `N passed`.

```bash
git add packages/studio docs/specs/STUDIO-00-ui-on-mocks.md docs/STATUS.md
git commit -m "test(studio): selection and foreign keys end to end; S4 notes, progress"
```

A fresh reviewer (most capable model) reviews the branch. Critical/Important are fixed with a failing test
first; minors are recorded. Before merging, compare `git rev-parse main` with `git merge-base main HEAD`.
