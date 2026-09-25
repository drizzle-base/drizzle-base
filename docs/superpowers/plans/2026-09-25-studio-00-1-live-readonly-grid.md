# STUDIO-00 S1 — Contract, live mock, read-only grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `@drizzle-base/studio` with its `StudioDataSource` contract, an in-memory mock that is live across
browser tabs (a shared write log, BroadcastChannel, an "external write" control), a conformance suite any data
source must pass, and a read-only studio (sidebar, virtualised grid, pager, theme) that shows pushes arriving —
proved by a two-tab Playwright test with its sabotage.

**Architecture:** The UI talks only to `StudioDataSource` (`src/contract`). The mock (`src/mock`) keeps every write in
an ordered log — the mock's WAL — and every data source, in every tab, applies writes only by reading that log back,
whoever wrote them (the same shape as the core's invariant 2). In the browser the log lives in `localStorage`,
commits are serialised with Web Locks, and a BroadcastChannel tells the other tabs to catch up; in unit tests the
log is in memory. A page is a subscription: the mock re-evaluates open pages after every commit and pushes only when
the result changed, with `revision` = the log sequence number. The studio diffs consecutive pages by primary key to
flash the cells that changed.

**Tech Stack:** Bun 1.4.2, TypeScript 5.9, React 19.3, Tailwind CSS 4.3 (`@tailwindcss/vite`), shadcn components on
Base UI 1.8 (vendored, `clsx` + `tailwind-merge`), lucide-react 1.48, TanStack Table 9.2 + TanStack Virtual 3.14, Vite
8.3 (playground), `bun test` + happy-dom 20.14 + Testing Library 16.3, Playwright 1.63.

**Spec:** `docs/specs/STUDIO-00-ui-on-mocks.md` (§3 contract, §4 the "Now" features, §5 done-when). Decisions taken
with the owner on 25 Sep 2026 after studying Drizzle Studio: keep TanStack (not react-data-grid), Tailwind v4 +
shadcn on Base UI (Drizzle Studio itself runs Tailwind v3 + Radix), lucide icons, values on the wire as Postgres
text for non-JSON-native kinds, `clsx` + `tailwind-merge` instead of the `cn` package.

## Global Constraints

- Work only in `packages/studio/`, on branch `feat/studio-ui`. Outside it this plan touches exactly: the root
  `package.json` (scripts), `bun.lock`, `docs/specs/STUDIO-00-ui-on-mocks.md` (contract changes, progress) and this plan.
- **Never import `drizzle-base`** nor anything under `packages/drizzle-base`. `src/` and `playground/` import no
  `node:` builtin and no `bun`/`bun:*` (the studio runs in browsers). Enforced by `test/unit/boundaries.test.ts`.
- `packages/studio/package.json`: `"name": "@drizzle-base/studio"`, `"private": true`, `react` and `react-dom` as
  `peerDependencies`. Runtime dependencies pinned exactly; dev dependencies as listed in Task 1.
- English in the repo; comments say what the code cannot. No Drizzle logos or brand assets; no verbatim copy of
  Drizzle Studio's bundled JS/CSS. Observations go in `packages/studio/NOTES.md`, not in code comments.
- Biome: 2 spaces, 120 columns, no `any`, no floating promises (`void p.then(ok, err)` / `void p.catch(fail)` is the
  repo idiom), named exports only (config files excepted via `packages/studio/biome.json`). Row fields are read with
  brackets (`row["id"]`): `noPropertyAccessFromIndexSignature` is on.
- Before every commit: `bunx biome check --write packages/studio` then `bun run check` green.
- Tests: assert the property, give every property a sabotage (break the thing, see red, restore with `cp` from a
  backup — never `git checkout --`), compare `Ran N tests across M files` after moves.

## Review Focus

1. **A tab opened after writes happened** must show the current data, not the seed. (Task 6 test: `a source opened
   after writes replays the log`.)
2. **Switching table or page** must not show the previous request's rows under the new columns, nor flash every
   cell as "changed". (Task 8 test: `a new request starts clean`; Task 10 test: `next page, and switching table, show no changed cells`.)
3. **Tables without a primary key and views** have no row identity: no change highlighting by position (it would
   mark the wrong cells after a delete), and every write is refused. (Task 8 test: `no primary key, no diff`;
   Task 6 conformance: `read-only relations refuse writes`.)
4. **NULLs in filters and sorts follow SQL**: a comparison with NULL is never true, ASC puts NULLs last and DESC
   first. (Task 3 tests; Task 6 conformance `filters` and `sorts`.)
5. **The last page empties under you** (another tab deletes its rows) — the studio must step back to the new last
   page, not show "2951 - 2950 of 2950". (Task 10 test: `the last page emptied elsewhere steps back`.)

---

## Target layout

```
packages/studio/
  package.json  tsconfig.json  bunfig.toml  biome.json  vite.config.ts  playwright.config.ts
  NOTES.md  README.md
  src/
    index.ts                 public entry: contract + <Studio>
    contract/index.ts        StudioDataSource and its types
    lib/cn.ts                clsx + tailwind-merge
    ui/button.tsx input.tsx select.tsx      vendored shadcn (Base UI)
    styles.css               Tailwind v4 + tokens
    mock/
      index.ts               public entry "./mock"
      pgtext.ts ids.ts query.ts log.ts dataset.ts source.ts
      datasets/conformance.ts datasets/demo.ts
    studio/
      format.ts use-page.ts theme.tsx sidebar.tsx pager.tsx studio.tsx
    grid/data-grid.tsx
  playground/  index.html main.tsx dev-panel.tsx globals.d.ts
  test/
    support/dom.ts support/boundaries.ts
    conformance.ts           the suite (exported; run by test/unit/mock-source.test.ts)
    unit/*.test.ts(x)
  e2e/two-tabs.e2e.ts
```

---

### Task 1: Package skeleton, tooling, boundaries, NOTES

**Files:**
- Delete: `packages/studio/.gitkeep`
- Create: `packages/studio/package.json`, `tsconfig.json`, `bunfig.toml`, `biome.json`, `NOTES.md`,
  `test/support/dom.ts`, `test/support/boundaries.ts`, `test/unit/boundaries.test.ts`, `src/index.ts`
- Modify: root `package.json` (scripts)

**Interfaces:**
- Produces: `boundaryViolations(files: SourceFile[]): string[]`, `collectSources(dirs: string[]): SourceFile[]`,
  `interface SourceFile { path: string; source: string }` (test support only). The scripts `test:unit`, `test:e2e`,
  `test`, `typecheck`, `dev` in the studio package.

- [ ] **Step 1: Record the baseline**

Run: `bun run check 2>&1 | grep -E "^Ran "`
Expected: one line `Ran N tests across M files.` for the core. Write N and M down; the core's numbers must be the
same at the end of this plan.

- [ ] **Step 2: The package manifest**

`packages/studio/package.json`:

```json
{
  "name": "@drizzle-base/studio",
  "version": "0.0.0",
  "description": "A live data browser for drizzle-base: browse and edit tables, updated across tabs and for writes from anywhere.",
  "license": "Apache-2.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./mock": "./src/mock/index.ts"
  },
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json",
    "test:unit": "bun test --timeout 30000 ./test",
    "test:e2e": "playwright test",
    "test": "bun run test:unit && bun run test:e2e"
  },
  "dependencies": {
    "@base-ui/react": "1.8.0",
    "@tanstack/react-table": "9.2.4",
    "@tanstack/react-virtual": "3.14.13",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "lucide-react": "1.48.0",
    "tailwind-merge": "3.7.0"
  },
  "peerDependencies": {
    "react": ">=19.2 <20",
    "react-dom": ">=19.2 <20"
  },
  "devDependencies": {
    "@happy-dom/global-registrator": "20.14.5",
    "@playwright/test": "1.63.0",
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/dom": "10.4.2",
    "@testing-library/react": "16.3.3",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "bun-types": "^1.3.0",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "shadcn": "4.21.0",
    "tailwindcss": "4.3.3",
    "tw-animate-css": "1.4.0",
    "typescript": "^5.9.0",
    "vite": "8.3.1"
  }
}
```

`shadcn`, `tailwindcss` and `tw-animate-css` are dev dependencies because they are only read by the CSS build
(`@import` in `src/styles.css`); nothing imports them at runtime.

- [ ] **Step 3: TypeScript, Bun, Biome**

`packages/studio/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "test", "e2e", "playground", "vite.config.ts", "playwright.config.ts"]
}
```

`packages/studio/bunfig.toml`:

```toml
[test]
preload = ["./test/support/dom.ts"]
```

`packages/studio/biome.json` (a nested config: it extends the root one and adds only what the studio needs — Tailwind
v4 directives in CSS, and default exports for the two tool configs that require them):

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "root": false,
  "extends": "//",
  "css": { "parser": { "tailwindDirectives": true } },
  "overrides": [
    {
      "includes": ["vite.config.ts", "playwright.config.ts"],
      "linter": { "rules": { "style": { "noDefaultExport": "off" } } }
    }
  ]
}
```

- [ ] **Step 4: The DOM preload**

`packages/studio/test/support/dom.ts`:

```ts
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

// happy-dom has no layout. Give every element a viewport-sized box so the virtualiser renders a window of rows
// (it renders none in a 0×0 box).
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) }) as DOMRect;
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });

// Imported after register(): Testing Library reads `document` when it loads.
const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "";
});
```

- [ ] **Step 5: Write the failing boundary test**

`packages/studio/test/unit/boundaries.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boundaryViolations, collectSources } from "../support/boundaries";

const root = join(import.meta.dir, "..", "..");

describe("boundaries", () => {
  test("the checker sees every import form", () => {
    const files = [
      { path: "src/a.ts", source: 'import { x } from "drizzle-base/server";' },
      { path: "src/b.ts", source: 'export * from "../../drizzle-base/src/sql";' },
      { path: "src/c.ts", source: 'const m = await import("node:fs");' },
      { path: "src/d.ts", source: 'import "bun:test";' },
      { path: "src/e.ts", source: 'import { t } from "../test/support/dom";' },
      { path: "src/ok.ts", source: '// import "drizzle-base"\nimport { useState } from "react";' },
    ];
    expect(boundaryViolations(files)).toEqual([
      'src/a.ts imports "drizzle-base/server"',
      'src/b.ts imports "../../drizzle-base/src/sql"',
      'src/c.ts imports "node:fs"',
      'src/d.ts imports "bun:test"',
      'src/e.ts imports "../test/support/dom"',
    ]);
  });

  test("src/ and playground/ respect them", () => {
    const files = collectSources([join(root, "src"), join(root, "playground")]).map((f) => ({
      ...f,
      path: f.path.slice(root.length + 1),
    }));
    expect(files.length).toBeGreaterThan(0);
    expect(boundaryViolations(files)).toEqual([]);
  });
});
```

`packages/studio/src/index.ts` (so `src/` exists; later tasks fill it):

```ts
export {};
```

Run: `cd packages/studio && bun test ./test/unit/boundaries.test.ts`
Expected: FAIL — `Cannot find module '../support/boundaries'`.

- [ ] **Step 6: The checker**

`packages/studio/test/support/boundaries.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceFile {
  path: string;
  source: string;
}

// The studio is a browser package that must work against its own contract only: no core import, no server runtime.
const FORBIDDEN: RegExp[] = [
  /^drizzle-base(\/|$)/,
  /(^|\/)drizzle-base\//,
  /^node:/,
  /^bun(:|$)/,
  /(^|\/)(test|e2e)\//,
];

const IMPORT_FORMS: RegExp[] = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

export function importsOf(source: string): string[] {
  const code = stripComments(source);
  return IMPORT_FORMS.flatMap((re) => [...code.matchAll(re)].map((m) => m[1] ?? ""));
}

export function boundaryViolations(files: SourceFile[]): string[] {
  return files.flatMap((f) =>
    importsOf(f.source)
      .filter((spec) => FORBIDDEN.some((re) => re.test(spec)))
      .map((spec) => `${f.path} imports "${spec}"`),
  );
}

export function collectSources(dirs: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push({ path, source: readFileSync(path, "utf8") });
    }
  };
  for (const dir of dirs) {
    try {
      walk(dir);
    } catch (e) {
      // playground/ appears in Task 11; a missing folder has nothing to check.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return out;
}
```

- [ ] **Step 7: Root scripts, install, green**

Root `package.json` — replace the three scripts:

```json
    "check": "biome check . && bun run --filter drizzle-base typecheck && bun run --filter drizzle-base test:unit && bun run --filter @drizzle-base/studio typecheck && bun run --filter @drizzle-base/studio test:unit",
    "test": "bun run --filter drizzle-base test && bun run --filter @drizzle-base/studio test",
    "typecheck": "bun run --filter drizzle-base typecheck && bun run --filter @drizzle-base/studio typecheck"
```

Run: `git rm -q packages/studio/.gitkeep && bun install && cd packages/studio && bun test ./test/unit/boundaries.test.ts`
Expected: `2 pass`, `0 fail`.

- [ ] **Step 8: Sabotage**

Run: `cp packages/studio/src/index.ts "${TMPDIR:-/tmp}/index.ts.bak" && echo 'import "drizzle-base/server";' >> packages/studio/src/index.ts && (cd packages/studio && bun test ./test/unit/boundaries.test.ts); cp "${TMPDIR:-/tmp}/index.ts.bak" packages/studio/src/index.ts`
Expected: `src/ and playground/ respect them` FAILS listing `src/index.ts imports "drizzle-base/server"`; after the
`cp`, re-running is green.

- [ ] **Step 9: NOTES.md — the study, written down**

`packages/studio/NOTES.md`:

```markdown
# What we observed in Drizzle Studio, and what we took from it

Observed 25 Sep 2026 on drizzle-kit 0.31.11 (`bunx drizzle-kit studio`, UI served from local.drizzle.studio) against
a probe database with an enum, jsonb/json, text[], bytea, date/timestamp/timestamptz, a view, a table without a
primary key and a second schema. We read its running UI, DOM and computed styles; we copy none of its code or assets.

## Its stack (from the shipped bundle and styles)

| Concern | Drizzle Studio | Ours | Why ours differs |
|---|---|---|---|
| Grid | react-data-grid 7.0.0-beta.59 | TanStack Table 9 + Virtual 3 | we must own selection and cell identity across live pushes (a row moves or vanishes under the cursor); rdg has no range selection and has been beta for years |
| Primitives | Radix (shadcn) | Base UI (shadcn) | the current shadcn default; invisible to users |
| CSS | Tailwind v3 | Tailwind v4 | current; parity comes from tokens, not the version |
| Icons | Lucide (plus a few Radix Icons 15×15 and one MingCute) | Lucide only | same look; one set |
| Editors | CodeMirror 6 (text/JSON), react-day-picker | same libraries, later slices | open source |
| Other | cmdk (⌘K spotlight), sonner (toasts), xyflow (schema diagram), zustand, i18next | as needed | |

UI font is system-ui; grid cells are monospace (Menlo). Tokens it defines beyond shadcn's: an amber "edit" colour for
pending cells, a blue selected-cell border with a 8% fill, a row-hover colour, and a dark variant of each.

## Layout

- Sidebar (~256 px): Spotlight search (⌘K), SQL console, Drizzle runner, Schema; a schema selector; a table search
  with filter and refresh buttons; the list — table icon `table-2`, view icon `view`, name, and a row-count estimate
  formatted `50`, `2.00K`, `3.00K`. Settings, tools and notifications at the bottom.
- Toolbar: sidebar toggle, DATA/STRUCTURE tabs, back/forward, history, Filters, Sort, Columns, Add record (dark
  primary); on the right the query time (`38ms`), a pager `1 - 50 of 3000` with prev/next, refresh, and a `…` menu
  (refresh rows, refresh schema, export, copy).
- Grid: a checkbox column; each header shows the column name, its Postgres type in small muted monospace
  (`varchar(255)`, `timestamp with time zone`) and a sort button (menu: Sort Ascending / Sort Descending). Reverse
  relations appear as extra virtual columns at the end (`comments`, `posts`, `invoices`), each cell a button.
  NULL renders as muted `NULL`; booleans as `TRUE`/`FALSE`; json as compact text; arrays as `["t0","x"]`.

## Editing

- Double-click (or Enter) opens an inline input; Enter commits, Esc cancels. A committed cell turns amber and the
  toolbar swaps Filters/Sort/Columns for **Save changes** (green) and **Discard changes** — nothing is written until
  Save.
- An edited cell has a button that opens a larger editor (CodeMirror, line numbers, resizable) with a footer
  `Set NULL · Cancel (Esc) · Save (⌘↵)`. Shift+Enter inserts a newline in the inline text editor; Tab inserts a tab.
- Boolean and enum open a dropdown with a check mark on the current value. **Defect we will not copy:** the enum
  dropdown offers `NULL` even on a `NOT NULL` column.
- Date/timestamp open the text input plus a popover: shortcuts `NULL / now / today / tomorrow / yesterday`, a month
  calendar, and (timestamps) hour/minute/second columns.
- JSON opens CodeMirror with folding.
- Add record inserts an amber row at the top whose cells show `DEFAULT` (column has a default) or `NULL`, with an ×
  to drop it.

## Filters, relations, menus

- Filters open a bar of rows `where [column] [operator] [value]` with Add filter, Open in SQL, Clear filters.
  Operators: `= <> > >= < <= LIKE ILIKE NOT LIKE IN IS NULL IS NOT NULL`, combined with AND.
- A foreign-key cell shows a `→` button on hover; it expands an inline sub-grid under the row with the referenced
  row, and "Open in sub view".
- Cell context menu: Copy (C), Paste (V), Export ▸ (.json, .csv, .sql, .xlsx), Copy ▸, Expand Row.
- Settings: table rows count (warns that `count(*)` scans), expand subviews, flat schemas, bytea shown as HEX or
  UTF8, editor font size, editor keybindings, theme.

## Decisions taken from this (STUDIO-00)

- Values on the wire: Postgres text for every kind JSON cannot carry exactly (see `src/contract`). Drizzle Studio
  shows exactly that text (`2026-09-25 12:43:35.257072+00`).
- `notLike` joins the filter operators; `bigint` and `float` join the column kinds (a bigint must stay a string).
- Row counts in the sidebar come from `TableInfo.estimatedRows`; the exact count is `Page.total`, which may be null
  (a backend may refuse to `count(*)`).
- Live pushes are ours alone: a changed cell flashes; the pending-edit colour (amber) stays reserved for edits.
```

- [ ] **Step 10: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: the core's `Ran N tests across M files` unchanged, a studio line `Ran 2 tests across 1 file`, `0 fail`.

```bash
git add -A packages/studio package.json bun.lock
git commit -m "chore(studio): package skeleton, tooling, boundary test, notes from Drizzle Studio"
```

---

### Task 2: The contract

**Files:**
- Create: `packages/studio/src/contract/index.ts`, `packages/studio/test/unit/contract.test.ts`
- Modify: `packages/studio/src/index.ts`, `docs/specs/STUDIO-00-ui-on-mocks.md` (§3)

**Interfaces:**
- Produces (every later task uses these names): `ColumnKind`, `ColumnInfo`, `TableRef`, `TableInfo`, `CellValue`,
  `Row`, `RowKey`, `FilterOp`, `Filter`, `Sort`, `PageRequest`, `Page`, `Unsubscribe`, `StudioErrorCode`,
  `StudioDataSourceError` (class, `.code`), `StudioDataSource`, `tableId(t: TableRef): string` (`"schema.name"`).

- [ ] **Step 1: Write the failing test**

`packages/studio/test/unit/contract.test.ts`:

```ts
import { expect, test } from "bun:test";
import { StudioDataSourceError, tableId } from "../../src/contract";

test("a data-source error is an Error that carries its code", () => {
  const e = new StudioDataSourceError("read_only", '"public.v" is a view');
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("StudioDataSourceError");
  expect(e.code).toBe("read_only");
  expect(e.message).toBe('"public.v" is a view');
});

test("tableId names a relation by schema and name", () => {
  expect(tableId({ schema: "billing", name: "invoices" })).toBe("billing.invoices");
});
```

Run: `cd packages/studio && bun test ./test/unit/contract.test.ts`
Expected: FAIL — cannot find module `../../src/contract`.

- [ ] **Step 2: The contract**

`packages/studio/src/contract/index.ts`:

```ts
// The studio's only view of a database. The UI is written against this interface; the in-memory mock implements it
// now and the drizzle-base admin functions later. Every change is recorded in docs/specs/STUDIO-00-ui-on-mocks.md.

export type ColumnKind =
  | "text"
  | "integer"
  | "bigint"
  | "float"
  | "numeric"
  | "boolean"
  | "uuid"
  | "date"
  | "timestamp"
  | "timestamptz"
  | "json"
  | "enum"
  | "bytea"
  | "array"
  | "unknown";

export interface ColumnInfo {
  name: string;
  kind: ColumnKind;
  /** As Postgres names it: "timestamp with time zone", "varchar(255)", "text[]", or the enum's type name. */
  pgType: string;
  nullable: boolean;
  /** An insert may omit it (uuidv7(), now(), serial…). */
  hasDefault: boolean;
  isPrimaryKey: boolean;
  enumValues?: string[];
  /** For kind "array": the kind of its elements. */
  elementKind?: ColumnKind;
  references?: { schema: string; table: string; column: string };
}

export interface TableRef {
  schema: string;
  name: string;
}

export interface TableInfo extends TableRef {
  kind: "table" | "view";
  columns: ColumnInfo[];
  /** Empty for views and for tables without one: those are read-only. */
  primaryKey: string[];
  estimatedRows: number | null;
}

/**
 * A cell value on the wire. SQL NULL is `null`. `integer` and `float` are numbers, `boolean` is a boolean, an `array`
 * is an array of its elements' values. Every other kind — `bigint` and `numeric` included, so no precision is lost —
 * is the text Postgres prints for it with `TimeZone=UTC`, `DateStyle=ISO`: `2026-09-25 12:43:35.257072+00`,
 * `\x6964`, `{"a": 1}`.
 */
export type CellValue = null | string | number | boolean | CellValue[];
export type Row = Record<string, CellValue>;
/** Primary-key column → value. */
export type RowKey = Record<string, CellValue>;

export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "like"
  | "ilike"
  | "notLike"
  | "in"
  | "isNull"
  | "isNotNull";

/** `value` is absent for isNull/isNotNull and an array for `in`. SQL semantics: a comparison with NULL is never true. */
export interface Filter {
  column: string;
  op: FilterOp;
  value?: CellValue;
}

export interface Sort {
  column: string;
  dir: "asc" | "desc";
}

/**
 * Filters combine with AND. Rows are ordered by `sort` (ASC puts NULLs last, DESC first, as Postgres does), then by
 * the primary key ascending, so pages are stable.
 */
export interface PageRequest {
  table: TableRef;
  filters: Filter[];
  sort: Sort[];
  limit: number;
  offset: number;
}

/**
 * `total` counts every row the filters keep (null when the backend will not count). `revision` identifies the data
 * the page was computed from: a page pushed because of a write carries a higher revision than any page before it.
 */
export interface Page {
  rows: Row[];
  total: number | null;
  revision: number;
}

export type Unsubscribe = () => void;

export type StudioErrorCode = "read_only" | "unknown_table" | "unknown_column" | "not_null" | "invalid_value";

export class StudioDataSourceError extends Error {
  override readonly name = "StudioDataSourceError";

  constructor(
    readonly code: StudioErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StudioDataSource {
  listTables(): Promise<TableInfo[]>;
  /**
   * A page is a subscription: pushed once, then again whenever its result changes, whoever changed the data. Never
   * calls back synchronously from inside `subscribePage`, and never after the returned function has been called.
   */
  subscribePage(req: PageRequest, onPage: (page: Page) => void, onError: (e: Error) => void): Unsubscribe;
  /** Rejects with a StudioDataSourceError; a key naming no row changes nothing, as UPDATE does. */
  updateRows(table: TableRef, changes: { key: RowKey; values: Row }[]): Promise<void>;
  /** Omitted columns take their default (or NULL). Resolves with each new row's key, in order. */
  insertRows(table: TableRef, rows: Row[]): Promise<RowKey[]>;
  deleteRows(table: TableRef, keys: RowKey[]): Promise<void>;
}

export function tableId(t: TableRef): string {
  return `${t.schema}.${t.name}`;
}
```

`packages/studio/src/index.ts` becomes:

```ts
export * from "./contract";
```

- [ ] **Step 3: Run the test**

Run: `cd packages/studio && bun test ./test/unit/contract.test.ts`
Expected: `2 pass`.

- [ ] **Step 4: Record the contract changes in the spec**

In `docs/specs/STUDIO-00-ui-on-mocks.md`, directly after the §3 code block (before "**The mock**"), insert:

```markdown
**Contract changes** (the live version is `packages/studio/src/contract/index.ts`):

- 25 Sep 2026 (S1, after studying Drizzle Studio): `ColumnKind` gains `bigint` and `float`; `ColumnInfo` gains
  `elementKind` for arrays. Values are typed `CellValue` and travel as Postgres text for every kind JSON cannot
  carry exactly (bigint, numeric, uuid, dates and times, json, bytea); integer/float are numbers, boolean a boolean,
  arrays arrays. `FilterOp` gains `notLike` (Drizzle Studio has `NOT LIKE`). Errors are `StudioDataSourceError` with a
  `code` (`read_only`, `unknown_table`, `unknown_column`, `not_null`, `invalid_value`). Rows are ordered by `sort` and
  then by the primary key; `subscribePage` never calls back synchronously nor after unsubscribing. Reverse relations
  are derived in the client from `references`: no contract change.
```

- [ ] **Step 5: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: studio `Ran 4 tests across 2 files`, `0 fail`.

```bash
git add packages/studio docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "feat(studio): the StudioDataSource contract, with the changes the Drizzle Studio study asked for"
```

---

### Task 3: Postgres text, seeded ids, the query engine

**Files:**
- Create: `packages/studio/src/mock/pgtext.ts`, `src/mock/ids.ts`, `src/mock/query.ts`
- Test: `packages/studio/test/unit/pgtext.test.ts`, `test/unit/query.test.ts`

**Interfaces:**
- Consumes: the contract (Task 2).
- Produces: `pgDate(d: Date): string`, `pgTimestamp(d: Date, micros?: number): string`,
  `pgTimestamptz(d: Date, micros?: number): string`, `pgBytea(bytes: Uint8Array): string`;
  `mulberry32(seed: number): () => number`, `uuidv7(ms: number, rand: () => number): string`;
  `compareNonNull(kind: ColumnKind, a: CellValue, b: CellValue): number`, `likeToRegExp(pattern: string,
  caseInsensitive: boolean): RegExp`, `matchesFilter(f: Filter, col: ColumnInfo, v: CellValue): boolean`,
  `interface QueryTable { columns: ColumnInfo[]; primaryKey: string[] }`,
  `runPage(table: QueryTable, rows: readonly Row[], req: Pick<PageRequest, "filters" | "sort" | "limit" | "offset">):
  { rows: Row[]; total: number }` (throws `StudioDataSourceError` `unknown_column` / `invalid_value`).

- [ ] **Step 1: Write the failing tests**

`packages/studio/test/unit/pgtext.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mulberry32, uuidv7 } from "../../src/mock/ids";
import { pgBytea, pgDate, pgTimestamp, pgTimestamptz } from "../../src/mock/pgtext";

test("timestamps print as Postgres prints them: trailing fraction zeros dropped", () => {
  const d = new Date(Date.UTC(2026, 8, 25, 12, 43, 35, 257));
  expect(pgTimestamptz(d, 72)).toBe("2026-09-25 12:43:35.257072+00");
  expect(pgTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 250)))).toBe("2026-01-01 00:00:00.25");
  expect(pgTimestamptz(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01 00:00:00+00");
});

test("dates pad the year; bytea is hex with a \\x prefix", () => {
  expect(pgDate(new Date(Date.UTC(987, 1, 3)))).toBe("0987-02-03");
  expect(pgBytea(new TextEncoder().encode("id"))).toBe("\\x6964");
});

test("the seeded generator is deterministic and uuidv7 has the v7 shape", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = [a(), a(), a()];
  expect([b(), b(), b()]).toEqual(xs);
  expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  expect(mulberry32(43)()).not.toBe(xs[0]);
  const id = uuidv7(Date.UTC(2026, 0, 1), mulberry32(1));
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(id.startsWith(Date.UTC(2026, 0, 1).toString(16).padStart(12, "0").slice(0, 8))).toBe(true);
});
```

`packages/studio/test/unit/query.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ColumnInfo, Filter, Row, Sort } from "../../src/contract";
import { StudioDataSourceError } from "../../src/contract";
import { likeToRegExp, type QueryTable, runPage } from "../../src/mock/query";

const c = (name: string, kind: ColumnInfo["kind"], isPrimaryKey = false): ColumnInfo => ({
  name,
  kind,
  pgType: kind,
  nullable: !isPrimaryKey,
  hasDefault: false,
  isPrimaryKey,
});

const T: QueryTable = {
  columns: [c("id", "integer", true), c("label", "text"), c("price", "numeric"), c("big", "bigint"), c("n", "integer")],
  primaryKey: ["id"],
};
const ROWS: Row[] = [
  { id: 1, label: "alpha", price: "10.00", big: "9007199254740993", n: 3 },
  { id: 2, label: "beta", price: "9.50", big: "9007199254740992", n: null },
  { id: 3, label: "50%_off", price: null, big: "1", n: 1 },
  { id: 4, label: "gamma", price: "100.00", big: null, n: 2 },
];

const ids = (filters: Filter[], sort: Sort[] = [], limit = 50, offset = 0) =>
  runPage(T, ROWS, { filters, sort, limit, offset }).rows.map((r) => r["id"]);

describe("filters", () => {
  test("numeric compares as a number, not as text", () => {
    expect(ids([{ column: "price", op: "lt", value: "10.00" }])).toEqual([2]);
  });
  test("bigint compares exactly beyond 2^53", () => {
    expect(ids([{ column: "big", op: "gt", value: "9007199254740992" }])).toEqual([1]);
  });
  test("a comparison with NULL is never true", () => {
    expect(ids([{ column: "n", op: "neq", value: 3 }])).toEqual([3, 4]);
    expect(ids([{ column: "n", op: "eq", value: null }])).toEqual([]);
  });
  test("isNull / isNotNull / in", () => {
    expect(ids([{ column: "price", op: "isNull" }])).toEqual([3]);
    expect(ids([{ column: "price", op: "isNotNull" }])).toEqual([1, 2, 4]);
    expect(ids([{ column: "n", op: "in", value: [1, 3, null] }])).toEqual([1, 3]);
  });
  test("like / ilike / notLike, with backslash escapes", () => {
    expect(ids([{ column: "label", op: "like", value: "%a" }])).toEqual([1, 2, 4]);
    expect(ids([{ column: "label", op: "ilike", value: "ALP%" }])).toEqual([1]);
    expect(ids([{ column: "label", op: "notLike", value: "%a" }])).toEqual([3]);
    expect(ids([{ column: "label", op: "like", value: "50\\%\\_off" }])).toEqual([3]);
    expect(likeToRegExp("a_c", false).test("abc")).toBe(true);
    expect(likeToRegExp("a.c", false).test("abc")).toBe(false);
  });
  test("filters combine with AND", () => {
    expect(ids([{ column: "n", op: "isNotNull" }, { column: "label", op: "like", value: "%a" }])).toEqual([1, 4]);
  });
});

describe("sort and pages", () => {
  test("no sort: primary key order", () => {
    expect(ids([], [])).toEqual([1, 2, 3, 4]);
  });
  test("ASC puts NULLs last, DESC first", () => {
    expect(ids([], [{ column: "n", dir: "asc" }])).toEqual([3, 4, 1, 2]);
    expect(ids([], [{ column: "n", dir: "desc" }])).toEqual([2, 1, 4, 3]);
  });
  test("numeric sorts as a number", () => {
    expect(ids([], [{ column: "price", dir: "asc" }])).toEqual([2, 1, 4, 3]);
  });
  test("limit/offset slice the sorted rows; total ignores them", () => {
    const page = runPage(T, ROWS, { filters: [], sort: [], limit: 2, offset: 1 });
    expect(page.rows.map((r) => r["id"])).toEqual([2, 3]);
    expect(page.total).toBe(4);
  });
});

describe("errors", () => {
  test("an unknown column is refused with its code", () => {
    try {
      ids([{ column: "nope", op: "isNull" }]);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StudioDataSourceError);
      expect((e as StudioDataSourceError).code).toBe("unknown_column");
    }
  });
  test("`in` without an array and a negative limit are invalid values", () => {
    expect(() => ids([{ column: "n", op: "in", value: 1 }])).toThrow(StudioDataSourceError);
    expect(() => ids([], [], -1)).toThrow(StudioDataSourceError);
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/pgtext.test.ts ./test/unit/query.test.ts`
Expected: FAIL — cannot find the three modules.

- [ ] **Step 2: Postgres text and ids**

`packages/studio/src/mock/pgtext.ts`:

```ts
// Postgres's text output for the kinds the contract carries as strings (TimeZone=UTC, DateStyle=ISO).

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function fraction(ms: number, micros: number): string {
  const us = ms * 1000 + micros;
  return us === 0 ? "" : `.${String(us).padStart(6, "0").replace(/0+$/, "")}`;
}

export function pgDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `micros` adds the sub-millisecond digits a JS Date cannot hold (0–999). */
export function pgTimestamp(d: Date, micros = 0): string {
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${pgDate(d)} ${time}${fraction(d.getUTCMilliseconds(), micros)}`;
}

export function pgTimestamptz(d: Date, micros = 0): string {
  return `${pgTimestamp(d, micros)}+00`;
}

export function pgBytea(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
```

`packages/studio/src/mock/ids.ts`:

```ts
/** mulberry32: a tiny seeded PRNG, so every tab builds the same dataset from the same seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UUIDv7-shaped id: 48-bit millisecond timestamp, version 7, RFC 4122 variant, the rest from `rand`. */
export function uuidv7(ms: number, rand: () => number): string {
  const hex = ms.toString(16).padStart(12, "0");
  const digits = (n: number): string => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  const variant = (8 + Math.floor(rand() * 4)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${digits(3)}-${variant}${digits(3)}-${digits(12)}`;
}
```

- [ ] **Step 3: The query engine**

`packages/studio/src/mock/query.ts`:

```ts
import {
  type CellValue,
  type ColumnInfo,
  type ColumnKind,
  type Filter,
  type PageRequest,
  type Row,
  StudioDataSourceError,
} from "../contract";

export interface QueryTable {
  columns: ColumnInfo[];
  primaryKey: string[];
}

const textOf = (v: CellValue): string => (typeof v === "string" ? v : JSON.stringify(v));

/** Orders two non-NULL values of one column the way Postgres would (text: by code point, like the C collation). */
export function compareNonNull(kind: ColumnKind, a: CellValue, b: CellValue): number {
  switch (kind) {
    case "integer":
    case "float":
      return Number(a) - Number(b);
    case "numeric":
      return Number(a) - Number(b);
    case "bigint": {
      const x = BigInt(textOf(a));
      const y = BigInt(textOf(b));
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "boolean":
      return a === b ? 0 : a ? 1 : -1;
    default: {
      const x = textOf(a);
      const y = textOf(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }
}

function compareForSort(kind: ColumnKind, dir: "asc" | "desc", a: CellValue, b: CellValue): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    // Postgres defaults: ASC NULLS LAST, DESC NULLS FIRST.
    const nullsFirst = dir === "desc";
    return a === null ? (nullsFirst ? -1 : 1) : nullsFirst ? 1 : -1;
  }
  const d = compareNonNull(kind, a, b);
  return dir === "asc" ? d : -d;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** LIKE: `%` any run, `_` one character, backslash escapes the next character. */
export function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (ch === "\\" && i + 1 < pattern.length) {
      i++;
      out += escapeRegExp(pattern[i] ?? "");
    } else if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += escapeRegExp(ch);
  }
  return new RegExp(`^${out}$`, caseInsensitive ? "iu" : "u");
}

export function matchesFilter(f: Filter, col: ColumnInfo, v: CellValue): boolean {
  if (f.op === "isNull") return v === null;
  if (f.op === "isNotNull") return v !== null;
  if (f.op === "in") {
    if (!Array.isArray(f.value)) throw new StudioDataSourceError("invalid_value", `"in" on "${col.name}" needs an array`);
    return v !== null && f.value.some((x) => x !== null && compareNonNull(col.kind, v, x) === 0);
  }
  const x = f.value;
  // SQL three-valued logic: a comparison with NULL is never true.
  if (v === null || x === undefined || x === null) return false;
  switch (f.op) {
    case "eq":
      return compareNonNull(col.kind, v, x) === 0;
    case "neq":
      return compareNonNull(col.kind, v, x) !== 0;
    case "lt":
      return compareNonNull(col.kind, v, x) < 0;
    case "lte":
      return compareNonNull(col.kind, v, x) <= 0;
    case "gt":
      return compareNonNull(col.kind, v, x) > 0;
    case "gte":
      return compareNonNull(col.kind, v, x) >= 0;
    case "like":
      return likeToRegExp(textOf(x), false).test(textOf(v));
    case "ilike":
      return likeToRegExp(textOf(x), true).test(textOf(v));
    case "notLike":
      return !likeToRegExp(textOf(x), false).test(textOf(v));
  }
}

export function runPage(
  table: QueryTable,
  rows: readonly Row[],
  req: Pick<PageRequest, "filters" | "sort" | "limit" | "offset">,
): { rows: Row[]; total: number } {
  if (!Number.isInteger(req.limit) || req.limit < 0 || !Number.isInteger(req.offset) || req.offset < 0) {
    throw new StudioDataSourceError("invalid_value", "limit and offset must be non-negative integers");
  }
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const column = (name: string): ColumnInfo => {
    const c = byName.get(name);
    if (!c) throw new StudioDataSourceError("unknown_column", `unknown column "${name}"`);
    return c;
  };
  const filters = req.filters.map((f) => ({ f, c: column(f.column) }));
  const order = [
    ...req.sort.map((s) => ({ c: column(s.column), dir: s.dir })),
    ...table.primaryKey
      .filter((k) => !req.sort.some((s) => s.column === k))
      .map((k) => ({ c: column(k), dir: "asc" as const })),
  ];
  const kept = rows.filter((r) => filters.every(({ f, c }) => matchesFilter(f, c, r[c.name] ?? null)));
  kept.sort((a, b) => {
    for (const o of order) {
      const d = compareForSort(o.c.kind, o.dir, a[o.c.name] ?? null, b[o.c.name] ?? null);
      if (d !== 0) return d;
    }
    return 0;
  });
  return { rows: kept.slice(req.offset, req.offset + req.limit), total: kept.length };
}
```

(`kept` is the fresh array `filter` returned, so sorting it in place is safe; `Array.prototype.sort` is stable, so a
table without a primary key keeps its insertion order.)

- [ ] **Step 4: Run the tests**

Run: `cd packages/studio && bun test ./test/unit/pgtext.test.ts ./test/unit/query.test.ts`
Expected: all pass (`3 pass` + `12 pass`).

- [ ] **Step 5: Sabotages**

Each one separately, restoring with `cp` from a `${TMPDIR:-/tmp}` backup after:
1. In `compareNonNull`, make `case "numeric"` fall to `default` (text compare) → `numeric compares as a number` and
   `numeric sorts as a number` go red.
2. In `compareForSort`, set `const nullsFirst = dir === "asc";` → `ASC puts NULLs last, DESC first` goes red.
3. In `matchesFilter`, delete the three-valued-logic line → `a comparison with NULL is never true` goes red.

- [ ] **Step 6: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): mock query engine with Postgres semantics (NULLs, numeric, bigint, LIKE)"
```

---

### Task 4: The mock's write log (memory and browser)

**Files:**
- Create: `packages/studio/src/mock/log.ts`
- Test: `packages/studio/test/unit/log.test.ts`

**Interfaces:**
- Consumes: `Row`, `RowKey`, `TableRef`, `Unsubscribe` (Task 2).
- Produces:
  - `type Op = { kind: "insert"; table: TableRef; rows: Row[] } | { kind: "update"; table: TableRef; changes: { key:
    RowKey; values: Row }[] } | { kind: "delete"; table: TableRef; keys: RowKey[] }`
  - `interface LogEntry { seq: number; op: Op; origin: "studio" | "external" }`
  - `interface MockLog { epoch(): string; readSince(seq: number): LogEntry[]; commit(build: () => Omit<LogEntry,
    "seq"> | null): Promise<number | null>; onCommit(listener: () => void): Unsubscribe; reset(): Promise<void>;
    close(): void }`
  - `interface LockLike { request<T>(name: string, callback: () => T | Promise<T>): Promise<T> }`
  - `createLocalLocks(): LockLike`, `createMemoryLog(): MockLog`,
    `createBrowserLog(name: string, deps?: Partial<BrowserLogDeps>): MockLog`,
    `interface BrowserLogDeps { storage: Storage; openChannel(name: string): BroadcastChannel; locks: LockLike }`

- [ ] **Step 1: Write the failing test**

`packages/studio/test/unit/log.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createBrowserLog, createLocalLocks, createMemoryLog, type LogEntry, type MockLog } from "../../src/mock/log";

const T = { schema: "public", name: "t" };
const entry = (label: string): Omit<LogEntry, "seq"> => ({
  op: { kind: "insert", table: T, rows: [{ label }] },
  origin: "studio",
});
const labels = (log: MockLog, since = 0) =>
  log.readSince(since).map((e) => (e.op.kind === "insert" ? e.op.rows[0]?.["label"] : null));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("memory log", () => {
  test("commits get consecutive sequence numbers; readSince returns what came after", async () => {
    const log = createMemoryLog();
    expect(await log.commit(() => entry("a"))).toBe(1);
    expect(await log.commit(() => entry("b"))).toBe(2);
    expect(labels(log)).toEqual(["a", "b"]);
    expect(labels(log, 1)).toEqual(["b"]);
  });

  test("builds run one at a time, each seeing the commits before it", async () => {
    const log = createMemoryLog();
    const seen: number[] = [];
    const seqs = await Promise.all(
      ["a", "b", "c"].map((l) =>
        log.commit(() => {
          seen.push(log.readSince(0).length);
          return entry(l);
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2]);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test("a build that throws appends nothing and does not jam the log", async () => {
    const log = createMemoryLog();
    await expect(
      log.commit(() => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await log.commit(() => entry("a"))).toBe(1);
    expect(await log.commit(() => null)).toBeNull();
    expect(labels(log)).toEqual(["a"]);
  });

  test("every listener hears a commit, after the commit, never inside it", async () => {
    const log = createMemoryLog();
    const heard: string[] = [];
    log.onCommit(() => heard.push("x"));
    const stop = log.onCommit(() => heard.push("y"));
    const p = log.commit(() => entry("a"));
    expect(heard).toEqual([]);
    await p;
    await tick();
    expect(heard.sort()).toEqual(["x", "y"]);
    stop();
    await log.commit(() => entry("b"));
    await tick();
    expect(heard.sort()).toEqual(["x", "x", "y"]);
  });

  test("reset empties the log and changes the epoch", async () => {
    const log = createMemoryLog();
    await log.commit(() => entry("a"));
    const before = log.epoch();
    await log.reset();
    expect(log.readSince(0)).toEqual([]);
    expect(log.epoch()).not.toBe(before);
  });
});

describe("browser log", () => {
  // Two instances on one storage and one channel name are two tabs; happy-dom has no navigator.locks, so the tabs
  // share an in-process lock (the real Web Locks path runs in the Playwright test).
  const twoTabs = () => {
    const name = `t${crypto.randomUUID().replaceAll("-", "")}`;
    const locks = createLocalLocks();
    const a = createBrowserLog(name, { locks });
    const b = createBrowserLog(name, { locks });
    return { a, b };
  };

  test("a commit in one tab is announced to the other, which reads it from storage", async () => {
    const { a, b } = twoTabs();
    let heard = 0;
    b.onCommit(() => heard++);
    expect(await a.commit(() => entry("a"))).toBe(1);
    for (let i = 0; i < 50 && heard === 0; i++) await tick();
    expect(heard).toBe(1);
    expect(labels(b)).toEqual(["a"]);
    a.close();
    b.close();
  });

  test("sequence numbers continue across tabs", async () => {
    const { a, b } = twoTabs();
    expect(await a.commit(() => entry("a"))).toBe(1);
    expect(await b.commit(() => entry("b"))).toBe(2);
    expect(labels(a)).toEqual(["a", "b"]);
    a.close();
    b.close();
  });

  test("a reset in one tab empties the log for both and changes the epoch", async () => {
    const { a, b } = twoTabs();
    await a.commit(() => entry("a"));
    const before = b.epoch();
    await a.reset();
    expect(b.readSince(0)).toEqual([]);
    expect(b.epoch()).not.toBe(before);
    a.close();
    b.close();
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/log.test.ts`
Expected: FAIL — cannot find module `../../src/mock/log`.

- [ ] **Step 2: The log**

`packages/studio/src/mock/log.ts`:

```ts
import type { Row, RowKey, TableRef, Unsubscribe } from "../contract";

export type Op =
  | { kind: "insert"; table: TableRef; rows: Row[] }
  | { kind: "update"; table: TableRef; changes: { key: RowKey; values: Row }[] }
  | { kind: "delete"; table: TableRef; keys: RowKey[] };

export interface LogEntry {
  seq: number;
  op: Op;
  origin: "studio" | "external";
}

/**
 * The mock's WAL: an ordered, shared record of every committed write. A data source applies writes only by reading
 * this log back — its own included — so every tab converges on the same state in the same order.
 */
export interface MockLog {
  /** Changes on reset(): a data source that sees a new epoch rebuilds from its dataset. */
  epoch(): string;
  readSince(seq: number): LogEntry[];
  /** Runs `build` under an exclusive lock across every tab; its entry, if any, gets the next sequence number. */
  commit(build: () => Omit<LogEntry, "seq"> | null): Promise<number | null>;
  /** Fires in every tab after a commit (the writer's included), never synchronously inside commit(). */
  onCommit(listener: () => void): Unsubscribe;
  reset(): Promise<void>;
  close(): void;
}

export interface LockLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

/** One lock per name, in this process: callbacks run strictly one after another, whatever they throw. */
export function createLocalLocks(): LockLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

export function createMemoryLog(): MockLog {
  let entries: LogEntry[] = [];
  let epoch = 0;
  const listeners = new Set<() => void>();
  const locks = createLocalLocks();
  const announce = () =>
    queueMicrotask(() => {
      for (const l of [...listeners]) l();
    });
  return {
    epoch: () => String(epoch),
    readSince: (seq) => entries.slice(seq),
    commit: (build) =>
      locks.request("commit", () => {
        const e = build();
        if (!e) return null;
        const seq = entries.length + 1;
        entries.push({ ...e, seq });
        announce();
        return seq;
      }),
    onCommit(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () =>
      locks.request("commit", () => {
        entries = [];
        epoch++;
        announce();
      }),
    close() {
      listeners.clear();
    },
  };
}

export interface BrowserLogDeps {
  storage: Storage;
  openChannel(name: string): BroadcastChannel;
  locks: LockLike;
}

function browserDeps(): BrowserLogDeps {
  return {
    storage: localStorage,
    openChannel: (name) => new BroadcastChannel(name),
    locks: { request: (name, callback) => navigator.locks.request(name, () => callback()) },
  };
}

/**
 * The log shared by every tab of one origin: entries in localStorage, commits serialised by a Web Lock, and a
 * BroadcastChannel message telling the other tabs to read what is new. A tab opened later replays the stored log.
 */
export function createBrowserLog(name: string, deps: Partial<BrowserLogDeps> = {}): MockLog {
  const { storage, openChannel, locks } = { ...browserDeps(), ...deps };
  const prefix = `dzb-studio-mock:${name}:`;
  const channel = openChannel(`${prefix}commits`);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  channel.onmessage = notify;
  const head = () => Number(storage.getItem(`${prefix}head`) ?? "0");
  const epoch = () => storage.getItem(`${prefix}epoch`) ?? "0";
  const announce = () => {
    channel.postMessage("commit");
    // BroadcastChannel never delivers to its sender: this tab hears its own commit here.
    queueMicrotask(notify);
  };
  return {
    epoch,
    readSince(seq) {
      const out: LogEntry[] = [];
      for (let s = seq + 1, h = head(); s <= h; s++) {
        const raw = storage.getItem(`${prefix}entry:${s}`);
        if (raw === null) break;
        out.push(JSON.parse(raw) as LogEntry);
      }
      return out;
    },
    commit: (build) =>
      locks.request(`${prefix}lock`, () => {
        const e = build();
        if (!e) return null;
        const seq = head() + 1;
        storage.setItem(`${prefix}entry:${seq}`, JSON.stringify({ ...e, seq }));
        storage.setItem(`${prefix}head`, String(seq));
        announce();
        return seq;
      }),
    onCommit(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () =>
      locks.request(`${prefix}lock`, () => {
        for (let s = 1, h = head(); s <= h; s++) storage.removeItem(`${prefix}entry:${s}`);
        storage.setItem(`${prefix}head`, "0");
        storage.setItem(`${prefix}epoch`, String(Number(epoch()) + 1));
        announce();
      }),
    close() {
      listeners.clear();
      channel.close();
    },
  };
}
```

- [ ] **Step 3: Run the test**

Run: `cd packages/studio && bun test ./test/unit/log.test.ts`
Expected: `8 pass`.

- [ ] **Step 4: Sabotages**

1. In `createBrowserLog`, delete `channel.postMessage("commit");` → `a commit in one tab is announced to the other`
   goes red (heard stays 0). Restore with `cp`.
2. Replace `createMemoryLog`'s `commit` with an unlocked version that reads the sequence number before yielding:
   `commit: async (build) => { const seq = entries.length + 1; await Promise.resolve(); const e = build(); if (!e) return null; entries.push({ ...e, seq }); announce(); return seq; }`
   → `builds run one at a time, each seeing the commits before it` goes red (`seqs` is `[1, 1, 1]`). Restore with `cp`.

- [ ] **Step 5: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): the mock's write log — memory, and localStorage + Web Locks + BroadcastChannel across tabs"
```

---

### Task 5: Datasets (conformance and demo)

**Files:**
- Create: `packages/studio/src/mock/dataset.ts`, `src/mock/datasets/conformance.ts`, `src/mock/datasets/demo.ts`
- Test: `packages/studio/test/unit/datasets.test.ts`

**Interfaces:**
- Consumes: contract (Task 2), `pgtext`/`ids` (Task 3).
- Produces:
  - `type MockDefault = "serial" | "uuidv7" | "now" | { value: CellValue }`
  - `interface MockTable { info: TableInfo; rows: Row[]; defaults: Record<string, MockDefault> }`
  - `interface MockView { info: TableInfo; compute(read: (tableId: string) => readonly Row[]): Row[] }`
  - `interface MockDataset { tables: MockTable[]; views: MockView[] }`
  - `col(name, kind, pgType, extra?): ColumnInfo`, `mockTable(schema, name, columns, rows, defaults?): MockTable`,
    `mockView(schema, name, columns, compute): MockView`
  - `conformanceDataset(): MockDataset` — `conformance.items` (id serial PK, label text NOT NULL, rank integer, note
    text), `conformance.log` (at timestamptz NOT NULL default now, msg text; no PK), `conformance.items_view`
  - `demoDataset(seed: number): MockDataset` — public.users (3000), posts (1500), comments (2000), audit_log (50, no
    PK), view published_posts; billing.invoices (100)

- [ ] **Step 1: Write the failing test**

`packages/studio/test/unit/datasets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type ColumnKind, type Row, tableId } from "../../src/contract";
import { conformanceDataset } from "../../src/mock/datasets/conformance";
import { demoDataset } from "../../src/mock/datasets/demo";

describe("demo dataset", () => {
  test("the same seed builds the same rows; another seed does not", () => {
    expect(JSON.stringify(demoDataset(1))).toBe(JSON.stringify(demoDataset(1)));
    expect(JSON.stringify(demoDataset(1))).not.toBe(JSON.stringify(demoDataset(2)));
  });

  test("its relations and sizes", () => {
    const d = demoDataset(1);
    const sizes = Object.fromEntries(d.tables.map((t) => [tableId(t.info), t.rows.length]));
    expect(sizes).toEqual({
      "public.users": 3000,
      "public.posts": 1500,
      "public.comments": 2000,
      "public.audit_log": 50,
      "billing.invoices": 100,
    });
    expect(d.views.map((v) => tableId(v.info))).toEqual(["public.published_posts"]);
    expect(d.tables.find((t) => t.info.name === "audit_log")?.info.primaryKey).toEqual([]);
  });

  test("every column kind appears, so every editor has a column to edit", () => {
    const kinds = new Set<ColumnKind>(demoDataset(1).tables.flatMap((t) => t.info.columns.map((c) => c.kind)));
    const all: ColumnKind[] = [
      "text", "integer", "bigint", "float", "numeric", "boolean", "uuid", "date", "timestamp", "timestamptz",
      "json", "enum", "bytea", "array", "unknown",
    ];
    expect(all.filter((k) => !kinds.has(k))).toEqual([]);
  });

  test("every foreign key points at an existing row, and NOT NULL columns hold no NULL", () => {
    const d = demoDataset(1);
    const byId = new Map(d.tables.map((t) => [tableId(t.info), t]));
    for (const t of d.tables) {
      for (const c of t.info.columns) {
        const values = t.rows.map((r) => r[c.name] ?? null);
        if (!c.nullable) expect(values.filter((v) => v === null).length).toBe(0);
        const ref = c.references;
        if (!ref) continue;
        const target = byId.get(`${ref.schema}.${ref.table}`);
        const keys = new Set(target?.rows.map((r: Row) => JSON.stringify(r[ref.column] ?? null)));
        const dangling = values.filter((v) => v !== null && !keys.has(JSON.stringify(v)));
        expect(dangling).toEqual([]);
      }
    }
  });

  test("hasDefault mirrors the defaults and the primary key mirrors isPrimaryKey", () => {
    for (const t of demoDataset(1).tables) {
      for (const c of t.info.columns) expect(c.hasDefault).toBe(t.defaults[c.name] !== undefined);
      expect(t.info.primaryKey).toEqual(t.info.columns.filter((c) => c.isPrimaryKey).map((c) => c.name));
    }
  });

  test("the view derives its rows from its base tables", () => {
    const d = demoDataset(1);
    const rows = (id: string) => d.tables.find((t) => tableId(t.info) === id)?.rows ?? [];
    const published = d.views[0]?.compute(rows) ?? [];
    expect(published.length).toBe(rows("public.posts").filter((p) => p["published"] === true).length);
    expect(published[0]).toEqual({ id: expect.any(Number), title: expect.any(String), email: expect.any(String) });
  });
});

test("conformance dataset: the shape the conformance suite relies on", () => {
  const d = conformanceDataset();
  const items = d.tables.find((t) => t.info.name === "items");
  expect(items?.info.primaryKey).toEqual(["id"]);
  expect(items?.rows).toEqual([]);
  expect(items?.info.columns.map((c) => [c.name, c.kind, c.nullable, c.hasDefault])).toEqual([
    ["id", "integer", false, true],
    ["label", "text", false, false],
    ["rank", "integer", true, false],
    ["note", "text", true, false],
  ]);
  expect(d.tables.find((t) => t.info.name === "log")?.info.primaryKey).toEqual([]);
  expect(d.views.map((v) => [v.info.name, v.info.kind, v.info.primaryKey])).toEqual([["items_view", "view", []]]);
});
```

Run: `cd packages/studio && bun test ./test/unit/datasets.test.ts`
Expected: FAIL — cannot find the dataset modules.

- [ ] **Step 2: Dataset helpers**

`packages/studio/src/mock/dataset.ts`:

```ts
import type { CellValue, ColumnInfo, ColumnKind, Row, TableInfo } from "../contract";

/** How the mock fills an omitted column on insert. Not part of the contract, which only says `hasDefault`. */
export type MockDefault = "serial" | "uuidv7" | "now" | { value: CellValue };

export interface MockTable {
  info: TableInfo;
  rows: Row[];
  defaults: Record<string, MockDefault>;
}

export interface MockView {
  info: TableInfo;
  compute(read: (tableId: string) => readonly Row[]): Row[];
}

export interface MockDataset {
  tables: MockTable[];
  views: MockView[];
}

export function col(
  name: string,
  kind: ColumnKind,
  pgType: string,
  extra: Partial<Omit<ColumnInfo, "name" | "kind" | "pgType">> = {},
): ColumnInfo {
  return { nullable: true, hasDefault: false, isPrimaryKey: false, ...extra, name, kind, pgType };
}

export function mockTable(
  schema: string,
  name: string,
  columns: ColumnInfo[],
  rows: Row[],
  defaults: Record<string, MockDefault> = {},
): MockTable {
  const cols = columns.map((c) => ({ ...c, hasDefault: defaults[c.name] !== undefined }));
  return {
    info: {
      schema,
      name,
      kind: "table",
      columns: cols,
      primaryKey: cols.filter((c) => c.isPrimaryKey).map((c) => c.name),
      estimatedRows: rows.length,
    },
    rows,
    defaults,
  };
}

export function mockView(
  schema: string,
  name: string,
  columns: ColumnInfo[],
  compute: MockView["compute"],
): MockView {
  return {
    info: {
      schema,
      name,
      kind: "view",
      columns: columns.map((c) => ({ ...c, isPrimaryKey: false, hasDefault: false })),
      primaryKey: [],
      estimatedRows: null,
    },
    compute,
  };
}
```

- [ ] **Step 3: The conformance dataset**

`packages/studio/src/mock/datasets/conformance.ts`:

```ts
import { col, type MockDataset, mockTable, mockView } from "../dataset";

/**
 * The relations the conformance suite (test/conformance.ts) runs against, empty. A real backend creates them as:
 *
 *   create schema conformance;
 *   create table conformance.items (id serial primary key, label text not null, rank integer, note text);
 *   create table conformance.log (at timestamptz not null default now(), msg text);
 *   create view conformance.items_view as select * from conformance.items;
 */
export function conformanceDataset(): MockDataset {
  const columns = [
    col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }),
    col("label", "text", "text", { nullable: false }),
    col("rank", "integer", "integer"),
    col("note", "text", "text"),
  ];
  return {
    tables: [
      mockTable("conformance", "items", columns, [], { id: "serial" }),
      mockTable(
        "conformance",
        "log",
        [col("at", "timestamptz", "timestamp with time zone", { nullable: false }), col("msg", "text", "text")],
        [],
        { at: "now" },
      ),
    ],
    views: [
      mockView("conformance", "items_view", columns, (read) => read("conformance.items").map((r) => ({ ...r }))),
    ],
  };
}
```

- [ ] **Step 4: The demo dataset**

`packages/studio/src/mock/datasets/demo.ts`:

```ts
import type { CellValue, Row } from "../../contract";
import { col, type MockDataset, mockTable, mockView } from "../dataset";
import { mulberry32, uuidv7 } from "../ids";
import { pgBytea, pgDate, pgTimestamp, pgTimestamptz } from "../pgtext";

// Seed data never reads the clock: the same seed must give the same rows in every tab and every run.
const BASE = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const ROLES = ["admin", "editor", "viewer"];
const CITIES = ["Recife", "Lisboa", "Berlin"];
const EVENTS = ["login", "logout", "export"];
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

export function demoDataset(seed: number): MockDataset {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const users: Row[] = [];
  for (let i = 1; i <= 3000; i++) {
    users.push({
      id: uuidv7(BASE + i * 1000, rand),
      email: `user${i}@example.com`,
      name: i % 7 === 0 ? null : `User ${i}`,
      role: ROLES[i % 3] ?? "viewer",
      active: i % 5 !== 0,
      score: (((i * 13) % 1000) / 10).toFixed(2),
      age: i % 11 === 0 ? null : 18 + Math.floor(rand() * 60),
      profile: JSON.stringify({ city: pick(CITIES), n: i, nested: { a: i % 2 === 0 } }),
      tags: [`t${i % 4}`, "x"],
      avatar: i % 10 === 0 ? pgBytea(new TextEncoder().encode(`id:${i}`)) : null,
      birthday: pgDate(new Date(Date.UTC(1970, 0, 1) + Math.floor(rand() * 15_000) * DAY)),
      created_at: pgTimestamptz(new Date(BASE + i * 60_000), Math.floor(rand() * 1000)),
      updated_at: i % 3 === 0 ? null : pgTimestamp(new Date(BASE + i * 3_600_000)),
    });
  }
  const userId = (n: number): CellValue => users[n % users.length]?.["id"] ?? null;

  const posts: Row[] = [];
  for (let i = 1; i <= 1500; i++) {
    posts.push({
      id: i,
      author_id: userId(i - 1),
      title: `Post ${i}`,
      body: LOREM,
      published: rand() < 0.5,
      meta: JSON.stringify({ views: Math.floor(rand() * 1000) }),
      created_at: pgTimestamptz(new Date(BASE + i * 90_000)),
    });
  }

  const comments: Row[] = [];
  for (let i = 1; i <= 2000; i++) {
    comments.push({
      id: String(i),
      post_id: 1 + (i % 1500),
      user_id: i % 13 === 0 ? null : userId(i * 7),
      body: `Comment ${i}`,
      created_at: pgTimestamptz(new Date(BASE + i * 45_000)),
    });
  }

  const audit: Row[] = [];
  for (let i = 1; i <= 50; i++) {
    audit.push({
      at: pgTimestamptz(new Date(BASE + i * 600_000)),
      event: `event.${pick(EVENTS)}`,
      ip: `10.0.${i % 4}.${i}`,
      payload: JSON.stringify({ i }),
    });
  }

  const invoices: Row[] = [];
  for (let i = 1; i <= 100; i++) {
    invoices.push({
      id: i,
      user_id: userId(i),
      amount_cents: 1000 + i * 37,
      tax_rate: [0, 0.1, 0.23][i % 3] ?? 0,
      status: i % 4 === 0 ? "refunded" : "paid",
      issued_on: pgDate(new Date(BASE + i * DAY)),
    });
  }

  const toUsers = { schema: "public", table: "users", column: "id" };
  return {
    tables: [
      mockTable(
        "public",
        "users",
        [
          col("id", "uuid", "uuid", { isPrimaryKey: true, nullable: false }),
          col("email", "text", "varchar(255)", { nullable: false }),
          col("name", "text", "text"),
          col("role", "enum", "role", { nullable: false, enumValues: ROLES }),
          col("active", "boolean", "boolean", { nullable: false }),
          col("score", "numeric", "numeric(10, 2)"),
          col("age", "integer", "integer"),
          col("profile", "json", "jsonb"),
          col("tags", "array", "text[]", { elementKind: "text" }),
          col("avatar", "bytea", "bytea"),
          col("birthday", "date", "date"),
          col("created_at", "timestamptz", "timestamp with time zone", { nullable: false }),
          col("updated_at", "timestamp", "timestamp"),
        ],
        users,
        { id: "uuidv7", role: { value: "viewer" }, active: { value: true }, created_at: "now" },
      ),
      mockTable(
        "public",
        "posts",
        [
          col("id", "integer", "serial", { isPrimaryKey: true, nullable: false }),
          col("author_id", "uuid", "uuid", { nullable: false, references: toUsers }),
          col("title", "text", "text", { nullable: false }),
          col("body", "text", "text"),
          col("published", "boolean", "boolean"),
          col("meta", "json", "json"),
          col("created_at", "timestamptz", "timestamp with time zone"),
        ],
        posts,
        { id: "serial", published: { value: false }, created_at: "now" },
      ),
      mockTable(
        "public",
        "comments",
        [
          col("id", "bigint", "bigserial", { isPrimaryKey: true, nullable: false }),
          col("post_id", "integer", "integer", {
            nullable: false,
            references: { schema: "public", table: "posts", column: "id" },
          }),
          col("user_id", "uuid", "uuid", { references: toUsers }),
          col("body", "text", "text", { nullable: false }),
          col("created_at", "timestamptz", "timestamp with time zone"),
        ],
        comments,
        { id: "serial", created_at: "now" },
      ),
      mockTable(
        "public",
        "audit_log",
        [
          col("at", "timestamptz", "timestamp with time zone"),
          col("event", "text", "text"),
          col("ip", "unknown", "inet"),
          col("payload", "json", "jsonb"),
        ],
        audit,
        { at: "now" },
      ),
      mockTable(
        "billing",
        "invoices",
        [
          col("id", "integer", "serial", { isPrimaryKey: true, nullable: false }),
          col("user_id", "uuid", "uuid", { references: toUsers }),
          col("amount_cents", "integer", "integer", { nullable: false }),
          col("tax_rate", "float", "double precision"),
          col("status", "text", "text"),
          col("issued_on", "date", "date"),
        ],
        invoices,
        { id: "serial" },
      ),
    ],
    views: [
      mockView(
        "public",
        "published_posts",
        [col("id", "integer", "integer"), col("title", "text", "text"), col("email", "text", "varchar(255)")],
        (read) => {
          const emails = new Map(read("public.users").map((u) => [u["id"] ?? null, u["email"] ?? null]));
          return read("public.posts")
            .filter((p) => p["published"] === true)
            .map((p) => ({ id: p["id"] ?? null, title: p["title"] ?? null, email: emails.get(p["author_id"] ?? null) ?? null }));
        },
      ),
    ],
  };
}
```

- [ ] **Step 5: Run the test**

Run: `cd packages/studio && bun test ./test/unit/datasets.test.ts`
Expected: `7 pass`.

- [ ] **Step 6: Sabotages**

1. In `demo.ts`, replace `BASE + i * 1000` in the users' `id` by `Date.now() + i * 1000` → `the same seed builds the
   same rows` goes red.
2. In `demo.ts`, make `author_id: userId(i - 1)` be `author_id: "nope"` → `every foreign key points at an existing
   row` goes red.

Restore each with `cp`.

- [ ] **Step 7: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): seeded demo dataset (every column kind, a view, a table without a key) and the conformance dataset"
```

---

### Task 6: The mock data source and the conformance suite

**Files:**
- Create: `packages/studio/src/mock/source.ts`, `packages/studio/src/mock/index.ts`, `packages/studio/test/conformance.ts`
- Test: `packages/studio/test/unit/mock-source.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `interface MockOptions { dataset: MockDataset; log: MockLog; latencyMs?: number; now?: () => Date; seed?: number }`
  - `interface MockDataSource extends StudioDataSource { externalWrite(op?: Op): Promise<void>; close(): void }`
  - `createMockDataSource(opts: MockOptions): MockDataSource`
  - `src/mock/index.ts` re-exports: `createMockDataSource`, `MockDataSource`, `MockOptions`, `createMemoryLog`,
    `createBrowserLog`, `createLocalLocks`, `MockLog`, `LogEntry`, `Op`, `demoDataset`, `conformanceDataset`,
    `MockDataset`
  - `describeConformance(name: string, makeBackend: () => Promise<ConformanceBackend>): void`,
    `interface ConformanceBackend { open(): Promise<StudioDataSource>; close(): Promise<void> }` (test/conformance.ts)

- [ ] **Step 1: Write the conformance suite**

`packages/studio/test/conformance.ts`:

```ts
// What every StudioDataSource must do, whatever sits behind it. The mock passes it now; the drizzle-base adapter
// must pass it unchanged. It runs against the relations of src/mock/datasets/conformance.ts, empty at the start of
// each test; `open()` returns another client of the same backend (another tab).
import { describe, expect, test } from "bun:test";
import {
  type Page,
  type PageRequest,
  type Row,
  type StudioDataSource,
  StudioDataSourceError,
  type StudioErrorCode,
} from "../src/contract";

export interface ConformanceBackend {
  open(): Promise<StudioDataSource>;
  close(): Promise<void>;
}

const ITEMS = { schema: "conformance", name: "items" };
const VIEW = { schema: "conformance", name: "items_view" };
const LOG = { schema: "conformance", name: "log" };

const req = (over: Partial<PageRequest> = {}): PageRequest => ({
  table: ITEMS,
  filters: [],
  sort: [],
  limit: 50,
  offset: 0,
  ...over,
});

async function until<T>(get: () => T | undefined, what: string, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function watch(ds: StudioDataSource, r: PageRequest) {
  const pages: Page[] = [];
  const errors: Error[] = [];
  const stop = ds.subscribePage(
    r,
    (p) => pages.push(p),
    (e) => errors.push(e),
  );
  return {
    pages,
    errors,
    stop,
    latest: (pred: (p: Page) => boolean = () => true, what = "a page") =>
      until(() => pages.findLast(pred), what),
  };
}

const labels = (p: Page) => p.rows.map((r) => r["label"]);

async function expectCode(p: Promise<unknown>, code: StudioErrorCode): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StudioDataSourceError);
    expect((e as StudioDataSourceError).code).toBe(code);
    return;
  }
  throw new Error(`expected a StudioDataSourceError "${code}"`);
}

// alpha(rank 3, note NULL), beta(1, "n"), gamma(NULL, "x"), delta(2, NULL), inserted in this order (ids ascending).
const SEED: Row[] = [
  { label: "alpha", rank: 3, note: null },
  { label: "beta", rank: 1, note: "n" },
  { label: "gamma", rank: null, note: "x" },
  { label: "delta", rank: 2, note: null },
];

export function describeConformance(name: string, makeBackend: () => Promise<ConformanceBackend>): void {
  const it = (title: string, body: (open: () => Promise<StudioDataSource>) => Promise<void>) =>
    test(title, async () => {
      const backend = await makeBackend();
      try {
        await body(() => backend.open());
      } finally {
        await backend.close();
      }
    });

  describe(`StudioDataSource conformance: ${name}`, () => {
    it("lists tables and views with their shape", async (open) => {
      const tables = await (await open()).listTables();
      const items = tables.find((t) => t.schema === "conformance" && t.name === "items");
      expect(items?.kind).toBe("table");
      expect(items?.primaryKey).toEqual(["id"]);
      expect(items?.columns.find((c) => c.name === "id")).toMatchObject({ isPrimaryKey: true, hasDefault: true });
      expect(items?.columns.find((c) => c.name === "label")).toMatchObject({ kind: "text", nullable: false });
      expect(tables.find((t) => t.name === "items_view")).toMatchObject({ kind: "view", primaryKey: [] });
      expect(tables.find((t) => t.name === "log")).toMatchObject({ kind: "table", primaryKey: [] });
    });

    it("pushes the first page asynchronously, never inside subscribePage", async (open) => {
      const ds = await open();
      let called = false;
      const stop = ds.subscribePage(
        req(),
        () => {
          called = true;
        },
        () => {},
      );
      expect(called).toBe(false);
      await until(() => (called ? true : undefined), "the first page");
      stop();
    });

    it("an insert re-pushes the page with a higher revision; defaults fill omitted columns", async (open) => {
      const ds = await open();
      const w = watch(ds, req());
      const first = await w.latest();
      const keys = await ds.insertRows(ITEMS, [{ label: "new" }]);
      expect(keys).toEqual([{ id: expect.any(Number) }]);
      const p = await w.latest((x) => labels(x).includes("new"), "the inserted row");
      expect(p.revision).toBeGreaterThan(first.revision);
      expect(p.total).toBe((first.total ?? 0) + 1);
      expect(p.rows.find((r) => r["label"] === "new")).toEqual({ id: keys[0]?.["id"] ?? -1, label: "new", rank: null, note: null });
      w.stop();
    });

    it("an update re-pushes the changed row", async (open) => {
      const ds = await open();
      const [key] = await ds.insertRows(ITEMS, [{ label: "before" }]);
      const w = watch(ds, req());
      await w.latest((p) => labels(p).includes("before"));
      await ds.updateRows(ITEMS, [{ key: key ?? {}, values: { label: "after", rank: 7 } }]);
      const p = await w.latest((x) => labels(x).includes("after"), "the updated row");
      expect(p.rows.find((r) => r["label"] === "after")?.["rank"]).toBe(7);
      w.stop();
    });

    it("a delete removes the row from open pages and from the total", async (open) => {
      const ds = await open();
      const keys = await ds.insertRows(ITEMS, SEED);
      const w = watch(ds, req());
      await w.latest((p) => p.total === 4);
      await ds.deleteRows(ITEMS, [keys[1] ?? {}]);
      const p = await w.latest((x) => x.total === 3, "the page without the deleted row");
      expect(labels(p)).toEqual(["alpha", "gamma", "delta"]);
      w.stop();
    });

    it("a write through one client re-pushes a page open on another", async (open) => {
      const tabA = await open();
      const tabB = await open();
      const w = watch(tabB, req());
      await w.latest();
      await tabA.insertRows(ITEMS, [{ label: "from A" }]);
      await w.latest((p) => labels(p).includes("from A"), "tab A's row in tab B");
      w.stop();
    });

    it("a view re-pushes when its base table changes", async (open) => {
      const ds = await open();
      const w = watch(ds, req({ table: VIEW }));
      await w.latest();
      await ds.insertRows(ITEMS, [{ label: "seen through the view" }]);
      await w.latest((p) => labels(p).includes("seen through the view"), "the row in the view");
      w.stop();
    });

    it("unsubscribing stops pushes", async (open) => {
      const ds = await open();
      const w = watch(ds, req());
      await w.latest();
      w.stop();
      const count = w.pages.length;
      await ds.insertRows(ITEMS, [{ label: "unseen" }]);
      await new Promise((r) => setTimeout(r, 100));
      expect(w.pages.length).toBe(count);
    });

    it("filters, with SQL NULL semantics, combined with AND", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      const cases: [PageRequest["filters"], string[]][] = [
        [[{ column: "label", op: "eq", value: "alpha" }], ["alpha"]],
        [[{ column: "rank", op: "neq", value: 3 }], ["beta", "delta"]],
        [[{ column: "rank", op: "lt", value: 3 }], ["beta", "delta"]],
        [[{ column: "rank", op: "lte", value: 2 }], ["beta", "delta"]],
        [[{ column: "rank", op: "gt", value: 1 }], ["alpha", "delta"]],
        [[{ column: "rank", op: "gte", value: 3 }], ["alpha"]],
        [[{ column: "label", op: "like", value: "_e%" }], ["beta", "delta"]],
        [[{ column: "label", op: "ilike", value: "B%" }], ["beta"]],
        [[{ column: "label", op: "notLike", value: "%ta" }], ["alpha", "gamma"]],
        [[{ column: "rank", op: "in", value: [1, 3] }], ["alpha", "beta"]],
        [[{ column: "note", op: "isNull" }], ["alpha", "delta"]],
        [[{ column: "note", op: "isNotNull" }], ["beta", "gamma"]],
        [[{ column: "rank", op: "gte", value: 1 }, { column: "note", op: "isNull" }], ["alpha", "delta"]],
      ];
      for (const [filters, expected] of cases) {
        const w = watch(ds, req({ filters }));
        expect({ filters, labels: labels(await w.latest()) }).toEqual({ filters, labels: expected });
        w.stop();
      }
    });

    it("sorts: multi-column, ASC NULLS LAST, DESC NULLS FIRST, ties by primary key", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      const cases: [PageRequest["sort"], string[]][] = [
        [[{ column: "rank", dir: "asc" }], ["beta", "delta", "alpha", "gamma"]],
        [[{ column: "rank", dir: "desc" }], ["gamma", "alpha", "delta", "beta"]],
        [[{ column: "note", dir: "asc" }], ["beta", "gamma", "alpha", "delta"]],
        [
          [
            { column: "note", dir: "asc" },
            { column: "label", dir: "desc" },
          ],
          ["beta", "gamma", "delta", "alpha"],
        ],
      ];
      for (const [sort, expected] of cases) {
        const w = watch(ds, req({ sort }));
        expect({ sort, labels: labels(await w.latest()) }).toEqual({ sort, labels: expected });
        w.stop();
      }
    });

    it("limit and offset page the ordered rows; total counts them all", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      const w = watch(ds, req({ limit: 2, offset: 1 }));
      const p = await w.latest();
      expect(labels(p)).toEqual(["beta", "gamma"]);
      expect(p.total).toBe(4);
      w.stop();
    });

    it("read-only relations refuse writes: views and tables without a primary key", async (open) => {
      const ds = await open();
      for (const t of [VIEW, LOG]) {
        await expectCode(ds.insertRows(t, [{ label: "x", msg: "x" }]), "read_only");
        await expectCode(ds.updateRows(t, [{ key: { id: 1 }, values: { label: "x" } }]), "read_only");
        await expectCode(ds.deleteRows(t, [{ id: 1 }]), "read_only");
      }
    });

    it("an insert missing a NOT NULL column without default is refused and commits nothing", async (open) => {
      const ds = await open();
      await expectCode(ds.insertRows(ITEMS, [{ label: "ok" }, { rank: 1 }]), "not_null");
      const w = watch(ds, req());
      expect((await w.latest()).total).toBe(0);
      w.stop();
    });

    it("unknown tables and columns are reported with their codes", async (open) => {
      const ds = await open();
      const bad = watch(ds, req({ filters: [{ column: "nope", op: "isNull" }] }));
      const e1 = await until(() => bad.errors[0], "an unknown_column error");
      expect((e1 as StudioDataSourceError).code).toBe("unknown_column");
      bad.stop();
      const missing = watch(ds, req({ table: { schema: "conformance", name: "nope" } }));
      const e2 = await until(() => missing.errors[0], "an unknown_table error");
      expect((e2 as StudioDataSourceError).code).toBe("unknown_table");
      missing.stop();
      await expectCode(ds.insertRows({ schema: "conformance", name: "nope" }, [{}]), "unknown_table");
      await expectCode(ds.updateRows(ITEMS, [{ key: { id: 1 }, values: { nope: 1 } }]), "unknown_column");
    });
  });
}
```

- [ ] **Step 2: Write the failing mock test**

`packages/studio/test/unit/mock-source.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Page, PageRequest, StudioDataSource } from "../../src/contract";
import {
  conformanceDataset,
  createMemoryLog,
  createMockDataSource,
  demoDataset,
  type MockDataSource,
} from "../../src/mock";
import { describeConformance } from "../conformance";

describeConformance("mock", async () => {
  const log = createMemoryLog();
  const opened: MockDataSource[] = [];
  return {
    open: async () => {
      const ds = createMockDataSource({ dataset: conformanceDataset(), log });
      opened.push(ds);
      return ds;
    },
    close: async () => {
      for (const ds of opened) ds.close();
    },
  };
});

const USERS = { schema: "public", name: "users" };
const firstPage = (ds: StudioDataSource, r: Partial<PageRequest> = {}) =>
  new Promise<Page>((resolve, reject) => {
    const stop = ds.subscribePage(
      { table: USERS, filters: [], sort: [], limit: 50, offset: 0, ...r },
      (p) => {
        stop();
        resolve(p);
      },
      reject,
    );
  });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("mock data source", () => {
  test("an external write reaches pages open on other sources, marked external in the log", async () => {
    const log = createMemoryLog();
    const tab = createMockDataSource({ dataset: demoDataset(1), log });
    const psql = createMockDataSource({ dataset: demoDataset(1), log });
    const pages: Page[] = [];
    tab.subscribePage({ table: USERS, filters: [], sort: [], limit: 5, offset: 0 }, (p) => pages.push(p), () => {});
    await tick();
    const id = pages[0]?.rows[0]?.["id"] ?? null;
    await psql.externalWrite({ kind: "update", table: USERS, changes: [{ key: { id }, values: { name: "from psql" } }] });
    await tick();
    expect(pages.at(-1)?.rows[0]?.["name"]).toBe("from psql");
    expect(log.readSince(0).map((e) => e.origin)).toEqual(["external"]);
  });

  test("externalWrite() with no argument changes some row and pushes", async () => {
    const log = createMemoryLog();
    const ds = createMockDataSource({ dataset: demoDataset(1), log, seed: 7 });
    await ds.externalWrite();
    expect(log.readSince(0)).toHaveLength(1);
    expect(log.readSince(0)[0]?.op.kind).toBe("update");
  });

  test("a source opened after writes replays the log", async () => {
    const log = createMemoryLog();
    const early = createMockDataSource({ dataset: demoDataset(1), log });
    const [key] = await early.insertRows(USERS, [{ email: "late@example.com" }]);
    const late = createMockDataSource({ dataset: demoDataset(1), log });
    const p = await firstPage(late, { filters: [{ column: "email", op: "eq", value: "late@example.com" }] });
    expect(p.rows.map((r) => r["id"])).toEqual([key?.["id"] ?? "missing"]);
    expect(p.revision).toBe(1);
  });

  test("concurrent inserts from two sources get distinct serial ids", async () => {
    const log = createMemoryLog();
    const a = createMockDataSource({ dataset: demoDataset(1), log });
    const b = createMockDataSource({ dataset: demoDataset(1), log });
    const posts = { schema: "public", name: "posts" };
    const author = demoDataset(1).tables[0]?.rows[0]?.["id"] ?? null;
    const keys = await Promise.all([
      a.insertRows(posts, [{ author_id: author, title: "a" }]),
      b.insertRows(posts, [{ author_id: author, title: "b" }]),
    ]);
    const ids = keys.flat().map((k) => k["id"]);
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort()).toEqual([1501, 1502]);
  });

  test("a reset returns every source to the dataset and re-pushes", async () => {
    const log = createMemoryLog();
    const ds = createMockDataSource({ dataset: demoDataset(1), log });
    const other = createMockDataSource({ dataset: demoDataset(1), log });
    const pages: Page[] = [];
    other.subscribePage({ table: USERS, filters: [], sort: [], limit: 1, offset: 0 }, (p) => pages.push(p), () => {});
    await ds.insertRows(USERS, [{ email: "x@example.com" }]);
    await tick();
    expect(pages.at(-1)?.total).toBe(3001);
    await log.reset();
    await tick();
    expect(pages.at(-1)?.total).toBe(3000);
  });

  test("latency delays the first page", async () => {
    const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog(), latencyMs: 40 });
    const t0 = performance.now();
    await firstPage(ds);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(35);
  });

  test("an unchanged result is not pushed again", async () => {
    const log = createMemoryLog();
    const ds = createMockDataSource({ dataset: demoDataset(1), log });
    const pages: Page[] = [];
    ds.subscribePage({ table: USERS, filters: [], sort: [], limit: 5, offset: 0 }, (p) => pages.push(p), () => {});
    await tick();
    await ds.insertRows({ schema: "billing", name: "invoices" }, [{ amount_cents: 1 }]);
    await tick();
    expect(pages).toHaveLength(1);
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/mock-source.test.ts`
Expected: FAIL — cannot find module `../../src/mock`.

- [ ] **Step 3: The data source**

`packages/studio/src/mock/source.ts`:

```ts
import {
  type CellValue,
  type ColumnKind,
  type Page,
  type PageRequest,
  type Row,
  type RowKey,
  type StudioDataSource,
  StudioDataSourceError,
  type TableInfo,
  type TableRef,
  tableId,
} from "../contract";
import type { MockDataset, MockDefault, MockTable } from "./dataset";
import { mulberry32, uuidv7 } from "./ids";
import type { LogEntry, MockLog, Op } from "./log";
import { pgDate, pgTimestamp, pgTimestamptz } from "./pgtext";
import { runPage } from "./query";

export interface MockOptions {
  dataset: MockDataset;
  log: MockLog;
  /** Delay before every push and every write resolves, to see loading states. */
  latencyMs?: number;
  now?: () => Date;
  /** Seeds the ids generated on insert and the rows externalWrite() picks. */
  seed?: number;
}

export interface MockDataSource extends StudioDataSource {
  /**
   * A write as psql or Drizzle Studio would make it: straight into the log, marked external, bypassing the studio.
   * With no argument, changes a text cell of a random row.
   */
  externalWrite(op?: Op): Promise<void>;
  close(): void;
}

interface Subscription {
  req: PageRequest;
  onPage: (page: Page) => void;
  onError: (e: Error) => void;
  last: string | null;
  closed: boolean;
}

interface LiveTable {
  def: MockTable;
  rows: Row[];
  serial: number;
}

const same = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const matchesKey = (row: Row, key: RowKey): boolean => Object.entries(key).every(([k, v]) => same(row[k], v));
const refOf = (t: TableRef): TableRef => ({ schema: t.schema, name: t.name });

function maxSerial(def: MockTable, rows: readonly Row[], current: number): number {
  const cols = Object.entries(def.defaults)
    .filter(([, d]) => d === "serial")
    .map(([c]) => c);
  let max = current;
  for (const r of rows) {
    for (const c of cols) {
      const v = Number(r[c]);
      if (Number.isFinite(v) && v > max) max = v;
    }
  }
  return max;
}

export function createMockDataSource(opts: MockOptions): MockDataSource {
  const { dataset, log } = opts;
  const latency = opts.latencyMs ?? 0;
  const now = opts.now ?? (() => new Date());
  const rand = mulberry32(opts.seed ?? 1);
  const views = new Map(dataset.views.map((v) => [tableId(v.info), v]));
  const subs = new Set<Subscription>();
  let tables = new Map<string, LiveTable>();
  let seq = 0;
  let epoch: string | null = null;

  const rebuild = () => {
    tables = new Map(
      dataset.tables.map((t) => [
        tableId(t.info),
        { def: t, rows: structuredClone(t.rows), serial: maxSerial(t, t.rows, 0) },
      ]),
    );
    seq = 0;
    epoch = log.epoch();
  };

  const apply = (e: LogEntry) => {
    const op = e.op;
    const t = tables.get(tableId(op.table));
    if (!t) return; // an external write to a relation this dataset lacks: nothing to apply, as in Postgres
    switch (op.kind) {
      case "insert":
        t.rows.push(...structuredClone(op.rows));
        t.serial = maxSerial(t.def, op.rows, t.serial);
        break;
      case "update":
        for (const c of op.changes) for (const r of t.rows) if (matchesKey(r, c.key)) Object.assign(r, structuredClone(c.values));
        break;
      case "delete":
        t.rows = t.rows.filter((r) => !op.keys.some((k) => matchesKey(r, k)));
        break;
    }
  };

  const catchUp = () => {
    if (log.epoch() !== epoch) rebuild();
    for (const e of log.readSince(seq)) {
      apply(e);
      seq = e.seq;
    }
  };

  const deliver = (sub: Subscription, fn: () => void) => {
    const run = () => {
      if (!sub.closed) fn();
    };
    if (latency > 0) setTimeout(run, latency);
    else queueMicrotask(run);
  };

  const relation = (ref: TableRef): { info: TableInfo; rows: readonly Row[] } => {
    const id = tableId(ref);
    const t = tables.get(id);
    if (t) return { info: t.def.info, rows: t.rows };
    const v = views.get(id);
    if (v) return { info: v.info, rows: v.compute((dep) => tables.get(dep)?.rows ?? []) };
    throw new StudioDataSourceError("unknown_table", `unknown table "${id}"`);
  };

  const evaluate = (sub: Subscription) => {
    try {
      const { info, rows } = relation(sub.req.table);
      const result = runPage(info, rows, sub.req);
      const json = JSON.stringify(result);
      if (json === sub.last) return; // pushes happen when the result changes, not on every commit
      sub.last = json;
      const page: Page = { rows: structuredClone(result.rows), total: result.total, revision: seq };
      deliver(sub, () => sub.onPage(page));
    } catch (e) {
      if (sub.last === "error") return;
      sub.last = "error";
      const err = e instanceof Error ? e : new Error(String(e));
      deliver(sub, () => sub.onError(err));
    }
  };

  const stopListening = log.onCommit(() => {
    catchUp();
    for (const s of subs) evaluate(s);
  });

  const settle = () => new Promise<void>((resolve) => (latency > 0 ? setTimeout(resolve, latency) : resolve()));

  const writable = (ref: TableRef): LiveTable => {
    const id = tableId(ref);
    const t = tables.get(id);
    if (!t) {
      if (views.has(id)) throw new StudioDataSourceError("read_only", `"${id}" is a view`);
      throw new StudioDataSourceError("unknown_table", `unknown table "${id}"`);
    }
    if (t.def.info.primaryKey.length === 0) throw new StudioDataSourceError("read_only", `"${id}" has no primary key`);
    return t;
  };

  const checkValues = (t: LiveTable, values: Row) => {
    for (const [name, v] of Object.entries(values)) {
      const c = t.def.info.columns.find((x) => x.name === name);
      if (!c) throw new StudioDataSourceError("unknown_column", `unknown column "${name}"`);
      if (v === null && !c.nullable) throw new StudioDataSourceError("not_null", `"${name}" is NOT NULL`);
    }
  };

  const checkKey = (t: LiveTable, key: RowKey) => {
    const pk = t.def.info.primaryKey;
    const names = Object.keys(key);
    if (names.length !== pk.length || !pk.every((k) => names.includes(k))) {
      throw new StudioDataSourceError("invalid_value", `a key of "${tableId(t.def.info)}" names exactly ${pk.join(", ")}`);
    }
  };

  const defaultValue = (d: MockDefault, kind: ColumnKind, serial: { next: number }): CellValue => {
    if (typeof d === "object") return structuredClone(d.value);
    switch (d) {
      case "serial": {
        serial.next += 1;
        return kind === "bigint" ? String(serial.next) : serial.next;
      }
      case "uuidv7":
        return uuidv7(now().getTime(), rand);
      case "now":
        return kind === "timestamptz" ? pgTimestamptz(now()) : kind === "date" ? pgDate(now()) : pgTimestamp(now());
    }
  };

  const materialize = (t: LiveTable, input: Row, serial: { next: number }): Row => {
    checkValues(t, input);
    const row: Row = {};
    for (const c of t.def.info.columns) {
      if (Object.hasOwn(input, c.name)) {
        row[c.name] = input[c.name] ?? null;
        continue;
      }
      const d = t.def.defaults[c.name];
      if (d !== undefined) row[c.name] = defaultValue(d, c.kind, serial);
      else if (c.nullable) row[c.name] = null;
      else throw new StudioDataSourceError("not_null", `"${c.name}" is NOT NULL and has no default`);
    }
    return row;
  };

  /** `make` runs under the log's lock, after catching up: it sees every commit before it, from every tab. */
  const commit = async (make: () => Op | null, origin: LogEntry["origin"]) => {
    await log.commit(() => {
      catchUp();
      const op = make();
      return op ? { op, origin } : null;
    });
    await settle();
  };

  const randomExternalOp = (): Op | null => {
    const candidates = [...tables.values()].filter(
      (t) => t.def.info.primaryKey.length > 0 && t.rows.length > 0 && t.def.info.columns.some((c) => c.kind === "text" && !c.isPrimaryKey),
    );
    const t = candidates[Math.floor(rand() * candidates.length)];
    const row = t?.rows[Math.floor(rand() * t.rows.length)];
    const column = t?.def.info.columns.find((c) => c.kind === "text" && !c.isPrimaryKey);
    if (!t || !row || !column) return null;
    const key = Object.fromEntries(t.def.info.primaryKey.map((k) => [k, row[k] ?? null]));
    const values = { [column.name]: `external write ${Math.floor(rand() * 1_000_000)}` };
    return { kind: "update", table: refOf(t.def.info), changes: [{ key, values }] };
  };

  catchUp();

  return {
    async listTables() {
      catchUp();
      await settle();
      return [
        ...[...tables.values()].map((t) => ({ ...structuredClone(t.def.info), estimatedRows: t.rows.length })),
        ...[...views.values()].map((v) => structuredClone(v.info)),
      ];
    },

    subscribePage(req, onPage, onError) {
      const sub: Subscription = { req: structuredClone(req), onPage, onError, last: null, closed: false };
      subs.add(sub);
      queueMicrotask(() => {
        if (sub.closed) return;
        catchUp();
        evaluate(sub);
      });
      return () => {
        sub.closed = true;
        subs.delete(sub);
      };
    },

    async updateRows(ref, changes) {
      await commit(() => {
        const t = writable(ref);
        for (const c of changes) {
          checkKey(t, c.key);
          checkValues(t, c.values);
        }
        return changes.length === 0 ? null : { kind: "update", table: refOf(ref), changes: structuredClone(changes) };
      }, "studio");
    },

    async insertRows(ref, rows) {
      let keys: RowKey[] = [];
      await commit(() => {
        const t = writable(ref);
        const serial = { next: t.serial };
        const full = rows.map((r) => materialize(t, r, serial));
        keys = full.map((r) => Object.fromEntries(t.def.info.primaryKey.map((k) => [k, r[k] ?? null])));
        return full.length === 0 ? null : { kind: "insert", table: refOf(ref), rows: full };
      }, "studio");
      return keys;
    },

    async deleteRows(ref, keys) {
      await commit(() => {
        const t = writable(ref);
        for (const k of keys) checkKey(t, k);
        return keys.length === 0 ? null : { kind: "delete", table: refOf(ref), keys: structuredClone(keys) };
      }, "studio");
    },

    async externalWrite(op) {
      await commit(() => op ?? randomExternalOp(), "external");
    },

    close() {
      stopListening();
      for (const s of subs) s.closed = true;
      subs.clear();
    },
  };
}
```

`packages/studio/src/mock/index.ts`:

```ts
export { col, type MockDataset, type MockDefault, type MockTable, type MockView, mockTable, mockView } from "./dataset";
export { conformanceDataset } from "./datasets/conformance";
export { demoDataset } from "./datasets/demo";
export {
  createBrowserLog,
  createLocalLocks,
  createMemoryLog,
  type LockLike,
  type LogEntry,
  type MockLog,
  type Op,
} from "./log";
export { createMockDataSource, type MockDataSource, type MockOptions } from "./source";
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/studio && bun test ./test/unit/mock-source.test.ts`
Expected: the 14 conformance tests and the 7 mock tests pass (`21 pass`).

- [ ] **Step 5: Sabotages**

Each separately, restore with `cp`:
1. In `source.ts`'s `log.onCommit` listener, delete `for (const s of subs) evaluate(s);` → conformance `an insert
   re-pushes…`, `a write through one client re-pushes…`, `a view re-pushes…`, `a delete removes…` go red.
2. In `evaluate`, replace `revision: seq` by `revision: 0` → `an insert re-pushes the page with a higher revision`
   goes red.
3. In `commit`, delete the `catchUp();` inside the build → `concurrent inserts from two sources get distinct serial
   ids` goes red (both get 1501).
4. In `writable`, delete the `primaryKey.length === 0` line → `read-only relations refuse writes` goes red.
5. In `subscribePage`, call `catchUp(); evaluate(sub);` directly instead of inside `queueMicrotask` → `pushes the first
   page asynchronously` goes red.

- [ ] **Step 6: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): live mock data source over the shared log, and the StudioDataSource conformance suite"
```

---

### Task 7: UI foundation — cn, vendored shadcn components, styles, theme

**Files:**
- Create: `packages/studio/src/lib/cn.ts`, `src/ui/button.tsx`, `src/ui/input.tsx`, `src/ui/select.tsx`,
  `src/styles.css`, `src/studio/theme.tsx`
- Test: `packages/studio/test/unit/theme.test.tsx`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string`; `Button` (variants `default | outline | secondary | ghost |
  destructive | link`, sizes `default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`); `Input`; `Select,
  SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator`;
  `type Theme = "system" | "light" | "dark"`; `useTheme(): { theme: Theme; resolved: "light" | "dark"; setTheme(t:
  Theme): void; next(): Theme }`; `ThemeToggle` (a button, `aria-label="Theme: <theme>"`). Tokens and utilities:
  `bg-background`, `text-muted-foreground`, `border`, `animate-cell-flash` (keyframes over `--cell-live`),
  `font-mono`.

- [ ] **Step 1: Write the failing test**

`packages/studio/test/unit/theme.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "../../src/studio/theme";

test("the toggle cycles system → light → dark, applies the class and remembers it", () => {
  const first = render(<ThemeToggle />);
  const button = () => screen.getByRole("button", { name: /^Theme:/ });
  expect(button().getAttribute("aria-label")).toBe("Theme: system");
  fireEvent.click(button());
  expect(button().getAttribute("aria-label")).toBe("Theme: light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  fireEvent.click(button());
  expect(button().getAttribute("aria-label")).toBe("Theme: dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  first.unmount();
  document.documentElement.className = "";

  render(<ThemeToggle />);
  expect(button().getAttribute("aria-label")).toBe("Theme: dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
```

Run: `cd packages/studio && bun test ./test/unit/theme.test.tsx`
Expected: FAIL — cannot find module `../../src/studio/theme`.

- [ ] **Step 2: cn and the vendored components**

The components are shadcn's `base-nova` style (`bunx shadcn@4.21.0 add button input select` in a Vite + Base UI
project), with one change: `cn` comes from our `src/lib/cn.ts` (clsx + tailwind-merge — the owner's call) instead of
the `cn` npm package the CLI now emits.

`packages/studio/src/lib/cn.ts`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

`packages/studio/src/ui/button.tsx`:

```tsx
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
```

`packages/studio/src/ui/input.tsx`:

```tsx
import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";
import { cn } from "../lib/cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
```

`packages/studio/src/ui/select.tsx`:

```tsx
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/cn";

const Select = SelectPrimitive.Root;

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn("scroll-my-1 p-1", className)} {...props} />;
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" className={cn("flex flex-1 text-left", className)} {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon render={<ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />} />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger">) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />}
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
```

- [ ] **Step 3: Styles**

`packages/studio/src/styles.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@source "./";
@source "../playground";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, Menlo, Consolas, monospace;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-cell-live: var(--cell-live);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
}

@theme {
  --animate-cell-flash: cell-flash 1.6s ease-out;

  @keyframes cell-flash {
    from {
      background-color: var(--cell-live);
    }
    to {
      background-color: transparent;
    }
  }
}

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.2 0.005 85);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.2 0.005 85);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.2 0.005 85);
  --primary: oklch(0.3 0.008 85);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.3 0.008 85);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.6 0.005 285);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.3 0.008 85);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.93 0 0);
  --input: oklch(0.93 0 0);
  --ring: oklch(0.8 0.005 285);
  --radius: 0.5rem;
  /* A push landed here: green, so it is never confused with a pending edit (amber, later slices). */
  --cell-live: oklch(0.93 0.08 155);
}

.dark {
  --background: oklch(0.17 0 0);
  --foreground: oklch(0.87 0 0);
  --card: oklch(0.2 0 0);
  --card-foreground: oklch(0.87 0 0);
  --popover: oklch(0.2 0 0);
  --popover-foreground: oklch(0.87 0 0);
  --primary: oklch(0.87 0 0);
  --primary-foreground: oklch(0.17 0 0);
  --secondary: oklch(0.24 0 0);
  --secondary-foreground: oklch(0.87 0 0);
  --muted: oklch(0.22 0 0);
  --muted-foreground: oklch(0.62 0.005 285);
  --accent: oklch(0.24 0 0);
  --accent-foreground: oklch(0.87 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(0.3 0 0);
  --input: oklch(0.3 0 0);
  --ring: oklch(0.45 0 0);
  --cell-live: oklch(0.36 0.07 155);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background font-sans text-foreground;
  }
}
```

- [ ] **Step 4: The theme**

`packages/studio/src/studio/theme.tsx`:

```tsx
import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";

export type Theme = "system" | "light" | "dark";

const KEY = "dzb-studio-theme";
const ORDER: Theme[] = ["system", "light", "dark"];

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system"; // storage blocked (private mode, sandboxed iframe): fall back to the system theme
  }
}

const systemDark = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function useTheme(): { theme: Theme; resolved: "light" | "dark"; setTheme(t: Theme): void; next(): Theme } {
  const [theme, setThemeState] = useState<Theme>(stored);
  const resolved = theme === "system" ? (systemDark() ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // not persisted; the theme still applies for this session
    }
  }, []);
  const next = () => ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "system";
  return { theme, resolved, setTheme, next };
}

export function ThemeToggle() {
  const { theme, setTheme, next } = useTheme();
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Theme: ${theme}`} onClick={() => setTheme(next())}>
      <Icon />
    </Button>
  );
}
```

- [ ] **Step 5: Run the test and sabotage it**

Run: `cd packages/studio && bun test ./test/unit/theme.test.tsx`
Expected: `1 pass`.
Sabotage: in `setTheme`, delete the `localStorage.setItem` line → the test goes red at the second render
(`Theme: system`). Restore with `cp`.

- [ ] **Step 6: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`. (If Biome reports lint errors in the vendored `src/ui/*` files beyond formatting and import
order, fix them in place; record any rule you had to suppress, with its reason, in the commit message.)

```bash
git add packages/studio
git commit -m "feat(studio): UI foundation — vendored shadcn (Base UI) with clsx + tailwind-merge, tokens, theme toggle"
```

---

### Task 8: Formatting, page diffing, the page subscription hook

**Files:**
- Create: `packages/studio/src/studio/format.ts`, `packages/studio/src/studio/use-page.ts`
- Test: `packages/studio/test/unit/format.test.ts`, `packages/studio/test/unit/use-page.test.tsx`

**Interfaces:**
- Consumes: contract (Task 2); `createMockDataSource`, `createMemoryLog`, `conformanceDataset` for the hook test (Task 6).
- Produces: `formatCell(v: CellValue): string`, `formatCount(n: number | null): string`,
  `rowIdOf(primaryKey: string[], row: Row, index: number): string`, `cellKey(rowId: string, column: string): string`,
  `diffPages(prev: Page | null, next: Page, primaryKey: string[], columns: string[]): Set<string>`,
  `interface PageState { page: Page | null; error: Error | null; changed: ReadonlySet<string> }`,
  `usePage(ds: StudioDataSource, req: PageRequest | null, table: TableInfo | null): PageState`.

- [ ] **Step 1: Write the failing tests**

`packages/studio/test/unit/format.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Page } from "../../src/contract";
import { cellKey, diffPages, formatCell, formatCount, rowIdOf } from "../../src/studio/format";

describe("formatCell", () => {
  test("NULL, booleans, arrays, numbers and text", () => {
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell(true)).toBe("TRUE");
    expect(formatCell(false)).toBe("FALSE");
    expect(formatCell(["t0", "x"])).toBe('["t0","x"]');
    expect(formatCell(42)).toBe("42");
    expect(formatCell("2026-09-25 12:43:35.257072+00")).toBe("2026-09-25 12:43:35.257072+00");
  });
});

test("formatCount: sidebar row estimates", () => {
  expect(formatCount(null)).toBe("");
  expect(formatCount(50)).toBe("50");
  expect(formatCount(2000)).toBe("2.00K");
  expect(formatCount(1_500_000)).toBe("1.50M");
});

describe("diffPages", () => {
  const page = (rows: Page["rows"], revision: number): Page => ({ rows, total: rows.length, revision });
  const cols = ["id", "name", "n"];

  test("marks exactly the cells whose value changed, by primary key", () => {
    const prev = page([{ id: 1, name: "a", n: 1 }, { id: 2, name: "b", n: 2 }], 1);
    const next = page([{ id: 2, name: "B", n: 2 }, { id: 1, name: "a", n: 1 }], 2);
    expect(diffPages(prev, next, ["id"], cols)).toEqual(new Set([cellKey(rowIdOf(["id"], { id: 2 }, 0), "name")]));
  });

  test("a row new to the page is marked whole", () => {
    const prev = page([{ id: 1, name: "a", n: 1 }], 1);
    const next = page([{ id: 1, name: "a", n: 1 }, { id: 3, name: "c", n: null }], 2);
    const id3 = rowIdOf(["id"], { id: 3 }, 1);
    expect(diffPages(prev, next, ["id"], cols)).toEqual(new Set(cols.map((c) => cellKey(id3, c))));
  });

  test("the first page marks nothing", () => {
    expect(diffPages(null, page([{ id: 1, name: "a", n: 1 }], 1), ["id"], cols).size).toBe(0);
  });

  test("no primary key, no diff: positions are not identities", () => {
    const prev = page([{ name: "a" }, { name: "b" }], 1);
    const next = page([{ name: "b" }], 2);
    expect(diffPages(prev, next, [], ["name"]).size).toBe(0);
  });
});
```

`packages/studio/test/unit/use-page.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import type { PageRequest, TableInfo } from "../../src/contract";
import { conformanceDataset, createMemoryLog, createMockDataSource } from "../../src/mock";
import { usePage } from "../../src/studio/use-page";

const ITEMS = { schema: "conformance", name: "items" };
const info = conformanceDataset().tables[0]?.info as TableInfo;
const LOG_INFO = conformanceDataset().tables[1]?.info as TableInfo;

function Probe({ ds, req, table }: { ds: ReturnType<typeof createMockDataSource>; req: PageRequest; table: TableInfo }) {
  const { page, changed } = usePage(ds, req, table);
  return (
    <output>
      {page ? `${req.table.name}:${page.rows.length}:${[...changed].length}` : "none"}
    </output>
  );
}

test("a new request starts clean: no rows from the old one, nothing marked changed", async () => {
  const ds = createMockDataSource({ dataset: conformanceDataset(), log: createMemoryLog() });
  await ds.insertRows(ITEMS, [{ label: "a" }, { label: "b" }]);
  const req = (table: typeof ITEMS, offset = 0): PageRequest => ({ table, filters: [], sort: [], limit: 50, offset });
  const view = render(<Probe ds={ds} req={req(ITEMS)} table={info} />);
  expect(await screen.findByText("items:2:0")).toBeTruthy();

  await act(async () => {
    await ds.updateRows(ITEMS, [{ key: { id: 1 }, values: { label: "A" } }]);
  });
  expect(await screen.findByText("items:2:1")).toBeTruthy();

  const logRef = { schema: "conformance", name: "log" };
  view.rerender(<Probe ds={ds} req={req(logRef)} table={LOG_INFO} />);
  expect(screen.getByText("none")).toBeTruthy();
  expect(await screen.findByText("log:0:0")).toBeTruthy();
});
```

Run: `cd packages/studio && bun test ./test/unit/format.test.ts ./test/unit/use-page.test.tsx`
Expected: FAIL — cannot find `format` / `use-page`.

- [ ] **Step 2: format.ts**

`packages/studio/src/studio/format.ts`:

```ts
import type { CellValue, Page, Row } from "../contract";

export function formatCell(v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

export function formatCount(n: number | null): string {
  if (n === null) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(2)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** A row's identity: its primary key when it has one; otherwise its position, which identifies nothing across pushes. */
export function rowIdOf(primaryKey: string[], row: Row, index: number): string {
  return primaryKey.length > 0 ? JSON.stringify(primaryKey.map((k) => row[k] ?? null)) : `#${index}`;
}

export const cellKey = (rowId: string, column: string): string => `${rowId}\u0000${column}`;

/** The cells of `next` that differ from `prev`, matched by primary key. Without one there is nothing to match. */
export function diffPages(prev: Page | null, next: Page, primaryKey: string[], columns: string[]): Set<string> {
  const changed = new Set<string>();
  if (!prev || primaryKey.length === 0) return changed;
  const before = new Map(prev.rows.map((r, i) => [rowIdOf(primaryKey, r, i), r]));
  next.rows.forEach((row, i) => {
    const id = rowIdOf(primaryKey, row, i);
    const old = before.get(id);
    for (const c of columns) {
      if (!old || JSON.stringify(old[c] ?? null) !== JSON.stringify(row[c] ?? null)) changed.add(cellKey(id, c));
    }
  });
  return changed;
}
```

- [ ] **Step 3: use-page.ts**

`packages/studio/src/studio/use-page.ts`:

```ts
import { useEffect, useState } from "react";
import type { Page, PageRequest, StudioDataSource, TableInfo } from "../contract";
import { diffPages } from "./format";

export interface PageState {
  page: Page | null;
  error: Error | null;
  changed: ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();
const EMPTY: PageState = { page: null, error: null, changed: NOTHING };

/**
 * The live page for `req`. The state remembers which request it belongs to, so the render right after the request
 * changes shows nothing rather than the old request's rows under the new columns.
 */
export function usePage(ds: StudioDataSource, req: PageRequest | null, table: TableInfo | null): PageState {
  const [state, setState] = useState<PageState & { req: PageRequest | null }>({ ...EMPTY, req: null });
  useEffect(() => {
    if (!req || !table) return;
    const columns = table.columns.map((c) => c.name);
    setState({ ...EMPTY, req });
    return ds.subscribePage(
      req,
      (page) =>
        setState((prev) => ({
          req,
          page,
          error: null,
          changed: prev.req === req ? diffPages(prev.page, page, table.primaryKey, columns) : NOTHING,
        })),
      (error) => setState({ req, page: null, error, changed: NOTHING }),
    );
  }, [ds, req, table]);
  return state.req === req ? state : EMPTY;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/studio && bun test ./test/unit/format.test.ts ./test/unit/use-page.test.tsx`
Expected: `6 pass` + `1 pass`. (If React warns that the update was not wrapped in `act(...)`, the assertion still
holds; wrap only if the test fails.)

- [ ] **Step 5: Sabotages**

1. In `diffPages`, delete `|| primaryKey.length === 0` → `no primary key, no diff` goes red.
2. In `usePage`, return `state` instead of `state.req === req ? state : EMPTY` → `a new request starts clean` goes red
   (`getByText("none")` fails because the old `items:2:1` is still shown).
Restore each with `cp`.

- [ ] **Step 6: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): cell formatting, page diffing by primary key, and the live page hook"
```

---

### Task 9: The virtualised read-only grid

**Files:**
- Create: `packages/studio/src/grid/data-grid.tsx`
- Test: `packages/studio/test/unit/data-grid.test.tsx`

**Interfaces:**
- Consumes: contract; `formatCell`, `rowIdOf`, `cellKey` (Task 8).
- Produces: `DataGrid({ table, page, changed }: { table: TableInfo; page: Page; changed: ReadonlySet<string> })`.
  DOM contract used by later tests: `role="grid"`; header cells `role="columnheader"` containing the name and the
  pgType; body cells `role="gridcell"` with `data-null` on NULL and `data-changed` on changed cells.

- [ ] **Step 1: Write the failing test**

`packages/studio/test/unit/data-grid.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { Page, TableInfo } from "../../src/contract";
import { DataGrid } from "../../src/grid/data-grid";
import { col } from "../../src/mock";
import { cellKey, rowIdOf } from "../../src/studio/format";

const table: TableInfo = {
  schema: "public",
  name: "t",
  kind: "table",
  columns: [
    col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }),
    col("label", "text", "varchar(255)"),
  ],
  primaryKey: ["id"],
  estimatedRows: null,
};
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, label: i === 1 ? null : `row ${i + 1}` }));
const page: Page = { rows, total: 1000, revision: 3 };

test("headers show the column name and its Postgres type", () => {
  render(<DataGrid table={table} page={page} changed={new Set()} />);
  const header = screen.getAllByRole("columnheader")[1];
  expect(header?.textContent).toContain("label");
  expect(header?.textContent).toContain("varchar(255)");
});

test("NULL renders muted, as NULL", () => {
  render(<DataGrid table={table} page={page} changed={new Set()} />);
  const cell = screen.getAllByRole("gridcell").find((c) => c.textContent === "NULL");
  expect(cell).toBeTruthy();
  expect(cell?.hasAttribute("data-null")).toBe(true);
});

test("only a window of the rows is in the DOM", () => {
  render(<DataGrid table={table} page={page} changed={new Set()} />);
  expect(screen.queryByText("row 1")).toBeTruthy();
  expect(screen.queryByText("row 1000")).toBeNull();
  expect(screen.getAllByRole("row").length).toBeLessThan(100);
});

test("changed cells carry data-changed, the others do not", () => {
  const changed = new Set([cellKey(rowIdOf(["id"], { id: 3 }, 2), "label")]);
  render(<DataGrid table={table} page={page} changed={changed} />);
  const cellOf = (text: string) => screen.getByText(text).closest("[role=gridcell]");
  expect(cellOf("row 3")?.getAttribute("data-changed")).toBe("true");
  expect(cellOf("row 4")?.hasAttribute("data-changed")).toBe(false);
});
```

Run: `cd packages/studio && bun test ./test/unit/data-grid.test.tsx`
Expected: FAIL — cannot find module `../../src/grid/data-grid`.

- [ ] **Step 2: The grid**

`packages/studio/src/grid/data-grid.tsx`:

```tsx
import { type ColumnDef, columnSizingFeature, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { CellValue, ColumnInfo, Page, Row, TableInfo } from "../contract";
import { cellKey, formatCell, rowIdOf } from "../studio/format";

const ROW_HEIGHT = 32;
const COLUMN_WIDTH = 200;
const features = tableFeatures({ columnSizingFeature });

export interface DataGridProps {
  table: TableInfo;
  page: Page;
  changed: ReadonlySet<string>;
}

export function DataGrid({ table, page, changed }: DataGridProps) {
  const byName = useMemo(() => new Map<string, ColumnInfo>(table.columns.map((c) => [c.name, c])), [table]);
  const columns = useMemo<ColumnDef<typeof features, Row, CellValue>[]>(
    () =>
      table.columns.map((c) => ({
        id: c.name,
        accessorFn: (r: Row) => r[c.name] ?? null,
        header: c.name,
        size: COLUMN_WIDTH,
      })),
    [table],
  );
  const grid = useTable({
    features,
    columns,
    data: page.rows,
    getRowId: (r, i) => rowIdOf(table.primaryKey, r, i),
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = grid.getRowModel().rows;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const width = grid.getVisibleLeafColumns().reduce((w, c) => w + c.getSize(), 0);

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length + 1}
      aria-colcount={table.columns.length}
      className="relative h-full overflow-auto font-mono text-[13px] outline-none"
    >
      <div role="row" aria-rowindex={1} className="sticky top-0 z-10 flex border-b bg-background" style={{ width }}>
        {grid.getHeaderGroups()[0]?.headers.map((h, i) => (
          <div
            key={h.id}
            role="columnheader"
            aria-colindex={i + 1}
            className="flex h-8 shrink-0 items-center gap-1.5 overflow-hidden border-r px-2"
            style={{ width: h.column.getSize() }}
          >
            <span className="truncate font-semibold">{h.column.id}</span>
            <span className="truncate text-[11px] text-muted-foreground">{byName.get(h.column.id)?.pgType}</span>
          </div>
        ))}
      </div>
      <div className="relative" style={{ height: virtual.getTotalSize(), width }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={row.id}
              role="row"
              aria-rowindex={item.index + 2}
              className="absolute left-0 flex border-b hover:bg-muted/60"
              style={{ height: ROW_HEIGHT, width, transform: `translateY(${item.start}px)` }}
            >
              {row.getVisibleCells().map((cell, i) => {
                const value = cell.getValue() as CellValue;
                const isChanged = changed.has(cellKey(row.id, cell.column.id));
                return (
                  <div
                    // A changed cell remounts on each revision so its flash animation restarts.
                    key={isChanged ? `${cell.id}:${page.revision}` : cell.id}
                    role="gridcell"
                    aria-colindex={i + 1}
                    data-null={value === null || undefined}
                    data-changed={isChanged || undefined}
                    className="flex shrink-0 items-center overflow-hidden border-r px-2 whitespace-nowrap data-changed:animate-cell-flash data-null:text-muted-foreground"
                    style={{ width: cell.column.getSize() }}
                  >
                    <span className="truncate">{formatCell(value)}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run the test**

Run: `cd packages/studio && bun test ./test/unit/data-grid.test.tsx`
Expected: `4 pass`.

- [ ] **Step 4: Sabotages**

1. Set `overscan: 2000` → `only a window of the rows is in the DOM` goes red.
2. Replace `data-changed={isChanged || undefined}` with `data-changed={true}` → `changed cells carry data-changed, the
   others do not` goes red.
Restore each with `cp`.

- [ ] **Step 5: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`. If Biome's `a11y/useSemanticElements` flags the ARIA grid roles, suppress each occurrence with
`// biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> cannot`.

```bash
git add packages/studio
git commit -m "feat(studio): virtualised read-only grid (TanStack Table + Virtual) with live cell flashes"
```

---

### Task 10: The studio shell — sidebar, pager, `<Studio>`

**Files:**
- Create: `packages/studio/src/studio/sidebar.tsx`, `src/studio/pager.tsx`, `src/studio/studio.tsx`
- Modify: `packages/studio/src/index.ts`
- Test: `packages/studio/test/unit/studio.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: `Studio({ dataSource, pageSize }: StudioProps)`, `interface StudioProps { dataSource: StudioDataSource;
  pageSize?: number }` (default 50), exported from `src/index.ts`. Sidebar buttons: accessible name = the table
  name (`aria-label`; the count is visible text only), `data-kind="table" | "view"`, `aria-current="page"` when selected; search input `aria-label="Search
  tables"`; schema select trigger `aria-label="Schema"` (only when there is more than one schema). Pager buttons
  `aria-label="Previous page"` / `"Next page"`, label text `"<from> - <to> of <total>"`.

- [ ] **Step 1: Write the failing test**

`packages/studio/test/unit/studio.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const USERS = { schema: "public", name: "users" };
const FIRST_USER_ID = demoDataset(1).tables[0]?.rows[0]?.["id"] ?? null;

function setup(pageSize?: number) {
  const log = createMemoryLog();
  const ds = createMockDataSource({ dataset: demoDataset(1), log });
  const otherTab = createMockDataSource({ dataset: demoDataset(1), log });
  render(<Studio dataSource={ds} pageSize={pageSize} />);
  return { ds, otherTab };
}

async function openTable(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

const changedCells = () => screen.queryAllByRole("gridcell").filter((c) => c.hasAttribute("data-changed"));

describe("<Studio>", () => {
  test("lists the default schema's tables, then views, with row estimates", async () => {
    setup();
    const nav = await screen.findByRole("navigation", { name: "Tables" });
    const names = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["audit_log50", "comments2.00K", "posts1.50K", "users3.00K", "published_posts"]);
    expect(within(nav).getByRole("button", { name: "published_posts" }).getAttribute("data-kind")).toBe("view");
  });

  test("searching filters the list", async () => {
    setup();
    fireEvent.change(await screen.findByLabelText("Search tables"), { target: { value: "po" } });
    const nav = screen.getByRole("navigation", { name: "Tables" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["posts1.50K", "published_posts"]);
  });

  test("opening a table shows its first page and the pager", async () => {
    setup();
    await openTable("users");
    expect(await screen.findByText("user1@example.com")).toBeTruthy();
    expect(screen.getByText("1 - 50 of 3000")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(true);
  });

  test("a write from another tab appears without a refresh, and only its cell flashes", async () => {
    const { otherTab } = setup();
    await openTable("users");
    await screen.findByText("user1@example.com");
    expect(changedCells()).toEqual([]);
    await act(async () => {
      await otherTab.externalWrite({
        kind: "update",
        table: USERS,
        changes: [{ key: { id: FIRST_USER_ID }, values: { name: "Changed in psql" } }],
      });
    });
    const cell = (await screen.findByText("Changed in psql")).closest("[role=gridcell]");
    expect(cell?.getAttribute("data-changed")).toBe("true");
    expect(changedCells()).toHaveLength(1);
  });

  test("next page, and switching table, show no changed cells", async () => {
    setup();
    await openTable("users");
    await screen.findByText("user1@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("51 - 100 of 3000")).toBeTruthy();
    expect(await screen.findByText("user51@example.com")).toBeTruthy();
    expect(changedCells()).toEqual([]);
    await openTable("posts");
    expect(await screen.findByText("1 - 50 of 1500")).toBeTruthy();
    expect(changedCells()).toEqual([]);
  });

  test("the last page emptied elsewhere steps back to the new last page", async () => {
    const { otherTab } = setup(1000);
    await openTable("users");
    expect(await screen.findByText("1 - 1000 of 3000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("1001 - 2000 of 3000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("2001 - 3000 of 3000")).toBeTruthy();
    const last = demoDataset(1).tables[0]?.rows.slice(2000).map((r) => ({ id: r["id"] ?? null })) ?? [];
    await act(async () => {
      await otherTab.deleteRows(USERS, last);
    });
    expect(await screen.findByText("1001 - 2000 of 2000")).toBeTruthy();
  });

  test("a table without a primary key is marked read-only", async () => {
    setup();
    await openTable("audit_log");
    expect(await screen.findByText("read-only")).toBeTruthy();
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/studio.test.tsx`
Expected: FAIL — `Studio` is not exported from `../../src`.

- [ ] **Step 2: Sidebar and pager**

`packages/studio/src/studio/sidebar.tsx`:

```tsx
import { Table2, View } from "lucide-react";
import { useMemo, useState } from "react";
import { type TableInfo, tableId } from "../contract";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { formatCount } from "./format";

export interface SidebarProps {
  tables: TableInfo[];
  selected: string | null;
  onSelect(id: string): void;
}

export function Sidebar({ tables, selected, onSelect }: SidebarProps) {
  const schemas = useMemo(() => [...new Set(tables.map((t) => t.schema))].sort(), [tables]);
  const [schema, setSchema] = useState(() => (schemas.includes("public") ? "public" : (schemas[0] ?? "")));
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const visible = tables
    .filter((t) => t.schema === schema && t.name.toLowerCase().includes(needle))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "table" ? -1 : 1));

  return (
    <nav aria-label="Tables" className="flex h-full w-64 shrink-0 flex-col gap-2 border-r p-3">
      {schemas.length > 1 && (
        <Select
          value={schema}
          onValueChange={(v) => {
            if (typeof v === "string") setSchema(v);
          }}
        >
          <SelectTrigger aria-label="Schema" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schemas.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Input
        type="search"
        aria-label="Search tables"
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto">
        {visible.map((t) => {
          const id = tableId(t);
          const Icon = t.kind === "view" ? View : Table2;
          return (
            <li key={id}>
              <button
                type="button"
                data-kind={t.kind}
                aria-label={t.name}
                aria-current={id === selected ? "page" : undefined}
                onClick={() => onSelect(id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{t.name}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatCount(t.estimatedRows)}</span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No tables</li>}
      </ul>
    </nav>
  );
}
```

`packages/studio/src/studio/pager.tsx`:

```tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";

export interface PagerProps {
  offset: number;
  limit: number;
  shown: number;
  total: number | null;
  onOffsetChange(offset: number): void;
}

export function Pager({ offset, limit, shown, total, onOffsetChange }: PagerProps) {
  const of = total ?? "?";
  const label = shown === 0 ? `0 of ${of}` : `${offset + 1} - ${offset + shown} of ${of}`;
  const hasNext = total === null ? shown === limit : offset + limit < total;
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Previous page"
        disabled={offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft />
      </Button>
      <span className="px-2 text-sm tabular-nums">{label}</span>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Next page"
        disabled={!hasNext}
        onClick={() => onOffsetChange(offset + limit)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: `<Studio>`**

`packages/studio/src/studio/studio.tsx`:

```tsx
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type PageRequest, type StudioDataSource, type TableInfo, tableId } from "../contract";
import { DataGrid } from "../grid/data-grid";
import { Pager } from "./pager";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme";
import { usePage } from "./use-page";

export interface StudioProps {
  dataSource: StudioDataSource;
  pageSize?: number;
}

export function Studio({ dataSource, pageSize = 50 }: StudioProps) {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let live = true;
    void dataSource.listTables().then(
      (t) => {
        if (live) setTables(t);
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => {
      live = false;
    };
  }, [dataSource]);

  const table = tables?.find((t) => tableId(t) === selected) ?? null;
  const req = useMemo<PageRequest | null>(
    () =>
      table
        ? { table: { schema: table.schema, name: table.name }, filters: [], sort: [], limit: pageSize, offset }
        : null,
    [table, pageSize, offset],
  );
  const { page, error, changed } = usePage(dataSource, req, table);

  // Rows deleted elsewhere can leave us past the end: step back to the new last page.
  const total = page?.total ?? null;
  useEffect(() => {
    if (total !== null && offset > 0 && offset >= total) setOffset(Math.max(0, Math.floor((total - 1) / pageSize) * pageSize));
  }, [total, offset, pageSize]);

  const select = (id: string) => {
    setSelected(id);
    setOffset(0);
  };

  let body: ReactNode;
  if (error) body = <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
  else if (table && page) body = <DataGrid table={table} page={page} changed={changed} />;
  else if (table) body = <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  else body = <p className="p-4 text-sm text-muted-foreground">Pick a table on the left.</p>;

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {tables ? (
        <Sidebar tables={tables} selected={selected} onSelect={select} />
      ) : (
        <div className="w-64 shrink-0 border-r p-3 text-sm text-muted-foreground">
          {loadError ? loadError.message : "Loading…"}
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <span className="truncate text-sm font-medium">{table ? tableId(table) : "No table selected"}</span>
          {table && table.primaryKey.length === 0 && (
            <span className="rounded border px-1.5 text-xs text-muted-foreground">read-only</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {page && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`revision ${page.revision}`}>
                <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500" />
                Live
              </span>
            )}
            {page && (
              <Pager offset={offset} limit={pageSize} shown={page.rows.length} total={page.total} onOffsetChange={setOffset} />
            )}
            <ThemeToggle />
          </div>
        </header>
        <div className="min-h-0 flex-1">{body}</div>
      </main>
    </div>
  );
}
```

`packages/studio/src/index.ts`:

```ts
export * from "./contract";
export { Studio, type StudioProps } from "./studio/studio";
```

- [ ] **Step 4: Run the test**

Run: `cd packages/studio && bun test ./test/unit/studio.test.tsx`
Expected: `7 pass`.

- [ ] **Step 5: Sabotages**

1. Delete the step-back `useEffect` in `studio.tsx` → `the last page emptied elsewhere steps back` goes red (the pager
   reads `0 of 2000`).
2. In `sidebar.tsx`, drop the `.sort(...)` → `lists the default schema's tables, then views` goes red.
3. In `studio.tsx`, pass `changed={new Set()}` to `DataGrid` → `a write from another tab appears … only its cell
   flashes` goes red.
Restore each with `cp`.

- [ ] **Step 6: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): the studio shell — sidebar by schema, pager, live badge, read-only marker"
```

---

### Task 11: The playground

**Files:**
- Create: `packages/studio/vite.config.ts`, `packages/studio/playground/index.html`, `playground/main.tsx`,
  `playground/dev-panel.tsx`, `playground/globals.d.ts`

**Interfaces:**
- Consumes: `Studio` (Task 10), `createBrowserLog`, `createMockDataSource`, `demoDataset`, `MockDataSource`,
  `MockLog` (Task 6).
- Produces: `bun run dev` serves the playground on `http://127.0.0.1:5488`; `?latency=<ms>` sets the mock latency;
  `window.__dzbMock` is the page's `MockDataSource` (used by the Playwright test).

- [ ] **Step 1: Vite config and the HTML shell**

`packages/studio/vite.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./playground", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5488, strictPort: true },
});
```

`packages/studio/playground/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>drizzle-base studio — mock playground</title>
  </head>
  <body>
    <div id="root" class="h-screen"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`packages/studio/playground/globals.d.ts`:

```ts
import type { MockDataSource } from "../src/mock";

declare global {
  interface Window {
    __dzbMock?: MockDataSource;
  }
}

declare module "*.css";
```

- [ ] **Step 2: The dev panel and the entry**

`packages/studio/playground/dev-panel.tsx`:

```tsx
import type { MockDataSource, MockLog } from "../src/mock";
import { Button } from "../src/ui/button";

/** Mock-only controls: writes "from outside" (as psql or Drizzle Studio would), and a reset for every tab. */
export function DevPanel({ source, log, latencyMs }: { source: MockDataSource; log: MockLog; latencyMs: number }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/50 px-3 text-xs text-muted-foreground">
      <span className="font-medium">Mock</span>
      <span>latency {latencyMs} ms</span>
      <Button type="button" size="xs" variant="outline" onClick={() => void source.externalWrite()}>
        External write
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => void log.reset()}>
        Reset data
      </Button>
    </div>
  );
}
```

`packages/studio/playground/main.tsx`:

```tsx
import "../src/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Studio } from "../src";
import { createBrowserLog, createMockDataSource, demoDataset } from "../src/mock";
import { DevPanel } from "./dev-panel";

const latencyMs = Number(new URLSearchParams(location.search).get("latency") ?? "0");
const log = createBrowserLog("playground");
const dataSource = createMockDataSource({ dataset: demoDataset(1), log, latencyMs, seed: Date.now() });
window.__dzbMock = dataSource;

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <div className="flex h-full flex-col">
      <DevPanel source={dataSource} log={log} latencyMs={latencyMs} />
      <div className="min-h-0 flex-1">
        <Studio dataSource={dataSource} />
      </div>
    </div>
  </StrictMode>,
);
```

(`seed: Date.now()` only seeds ids generated on insert and the rows `externalWrite()` picks, so two tabs do not
generate the same uuid; the dataset itself is `demoDataset(1)` in every tab.)

- [ ] **Step 3: Boundaries still hold; typecheck**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail` (the boundary test now also scans `playground/`).

- [ ] **Step 4: See it**

Run: `cd packages/studio && bun run dev` (background), open `http://127.0.0.1:5488` in two tabs, open `users` in both,
press **External write** a few times in one, and **Reset data**. Expected: the changed cells flash green in both tabs
without a refresh; after the reset both tabs show the seed data. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add packages/studio
git commit -m "feat(studio): Vite playground on the live mock, with external-write and reset controls"
```

---

### Task 12: The two-tab Playwright test, and its sabotage

**Files:**
- Create: `packages/studio/playwright.config.ts`, `packages/studio/e2e/two-tabs.e2e.ts`

**Interfaces:**
- Consumes: the playground (Task 11), `window.__dzbMock`.

- [ ] **Step 1: Install the browser**

Run: `cd packages/studio && bunx playwright install chromium`
Expected: Chromium downloaded (or "already installed").

- [ ] **Step 2: Config and the test**

`packages/studio/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5488" },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:5488",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
```

`packages/studio/e2e/two-tabs.e2e.ts`:

```ts
// The realtime promise in a real browser: tabs of one origin share the mock's log, and a write from any of them —
// or from "outside" — reaches every open page without a refresh. Each test gets a fresh context: empty storage.
import { expect, type Page as Tab, test } from "@playwright/test";
import type { Page } from "../src/contract";

const USERS = { schema: "public", name: "users" };

async function openUsers(tab: Tab) {
  await tab.goto("/");
  await tab.getByRole("button", { name: "users", exact: true }).click();
  await expect(tab.getByRole("gridcell", { name: "user1@example.com", exact: true })).toBeVisible();
}

/** The id of user1, read through the data source like any client would. */
function user1Id(tab: Tab) {
  return tab.evaluate(async (users) => {
    const ds = window.__dzbMock;
    if (!ds) throw new Error("the playground did not expose __dzbMock");
    const page = await new Promise<Page>((resolve, reject) => {
      const stop = ds.subscribePage(
        { table: users, filters: [{ column: "email", op: "eq", value: "user1@example.com" }], sort: [], limit: 1, offset: 0 },
        (p) => {
          stop();
          resolve(p);
        },
        reject,
      );
    });
    return page.rows[0]?.["id"] ?? null;
  }, USERS);
}

test("an external write appears in every open tab without a refresh", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const psql = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await psql.goto("/");
  const id = await user1Id(psql);
  await psql.evaluate(
    async ({ users, id }) => {
      await window.__dzbMock?.externalWrite({
        kind: "update",
        table: users,
        changes: [{ key: { id }, values: { name: "Set by psql" } }],
      });
    },
    { users: USERS, id },
  );
  for (const tab of [a, b]) {
    const cell = tab.getByRole("gridcell", { name: "Set by psql", exact: true });
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute("data-changed", "true");
  }
});

test("a write in one tab appears in the other", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  const id = await user1Id(a);
  await a.evaluate(
    async ({ users, id }) => {
      await window.__dzbMock?.updateRows(users, [{ key: { id }, values: { name: "Set in tab A" } }]);
    },
    { users: USERS, id },
  );
  await expect(b.getByRole("gridcell", { name: "Set in tab A", exact: true })).toBeVisible();
});

test("writes from two tabs at once converge: every tab ends with all of them", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/");
  await b.goto("/");
  const insertTen = (tab: Tab, who: string) =>
    tab.evaluate(async (who) => {
      const invoices = { schema: "billing", name: "invoices" };
      for (let i = 0; i < 10; i++) {
        await window.__dzbMock?.insertRows(invoices, [{ amount_cents: 1, status: `concurrent-${who}-${i}` }]);
      }
    }, who);
  await Promise.all([insertTen(a, "a"), insertTen(b, "b")]);
  const idsIn = (tab: Tab) =>
    tab.evaluate(async () => {
      const ds = window.__dzbMock;
      if (!ds) throw new Error("no __dzbMock");
      const page = await new Promise<Page>((resolve, reject) => {
        const stop = ds.subscribePage(
          {
            table: { schema: "billing", name: "invoices" },
            filters: [{ column: "status", op: "like", value: "concurrent-%" }],
            sort: [],
            limit: 100,
            offset: 0,
          },
          (p) => {
            stop();
            resolve(p);
          },
          reject,
        );
      });
      return page.rows.map((r) => r["id"]);
    });
  await expect.poll(async () => (await idsIn(a)).length).toBe(20);
  await expect.poll(async () => (await idsIn(b)).length).toBe(20);
  expect(await idsIn(a)).toEqual(await idsIn(b));
  expect(new Set(await idsIn(a)).size).toBe(20);
});

test("the schema selector switches the sidebar to another schema", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Schema" }).click();
  await page.getByRole("option", { name: "billing" }).click();
  await page.getByRole("button", { name: "invoices", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: /amount_cents/ })).toBeVisible();
});
```

- [ ] **Step 3: Run it**

Run: `cd packages/studio && bun run test:e2e`
Expected: `4 passed`.

- [ ] **Step 4: The sabotage the spec asks for — disable the BroadcastChannel**

Run:
```bash
cp packages/studio/src/mock/log.ts "${TMPDIR:-/tmp}/log.ts.bak"
sed -i '' 's/    channel.postMessage("commit");/    \/\/ sabotage: channel.postMessage("commit");/' packages/studio/src/mock/log.ts
grep -n 'sabotage' packages/studio/src/mock/log.ts
(cd packages/studio && bun run test:e2e); cp "${TMPDIR:-/tmp}/log.ts.bak" packages/studio/src/mock/log.ts
```
Expected: the `grep` shows the commented line (the sabotage really happened); `an external write appears in every
open tab`, `a write in one tab appears in the other` and `writes from two tabs at once converge` FAIL (timeouts
waiting for the cell / the count); the schema test still passes. After the `cp`, `bun run test:e2e` is `4 passed`
again.

- [ ] **Step 5: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"`
Expected: `0 fail`.

```bash
git add packages/studio
git commit -m "test(studio): two-tab Playwright test — external writes and tab writes reach every tab (sabotage: no BroadcastChannel)"
```

---

### Task 13: Close the slice

**Files:**
- Create: `packages/studio/README.md`
- Modify: `docs/specs/STUDIO-00-ui-on-mocks.md` (a progress line)

- [ ] **Step 1: README**

`packages/studio/README.md`:

```markdown
# @drizzle-base/studio

A data browser for drizzle-base: browse Postgres tables, and see every committed write — from another tab, from
psql, from Drizzle Studio — arrive without a refresh. Private and in development (STUDIO-00).

The UI is written against `StudioDataSource` (`src/contract`). Today it runs on an in-memory mock (`./mock`) that is
live across browser tabs; later on drizzle-base's admin functions, which must pass the same conformance suite
(`test/conformance.ts`).

    bun run dev        # the playground on http://127.0.0.1:5488 (?latency=300 to slow the mock down)
    bun run test:unit  # bun test + happy-dom
    bun run test:e2e   # Playwright: the two-tab test

It is not Drizzle Studio and not affiliated with Drizzle; `NOTES.md` records what we observed in Drizzle Studio and
which decisions we took from it.
```

- [ ] **Step 2: Progress in the spec**

At the end of §5 of `docs/specs/STUDIO-00-ui-on-mocks.md`, add:

```markdown
**Progress.** S1 (25 Sep 2026, `docs/superpowers/plans/2026-09-25-studio-00-1-live-readonly-grid.md`): contract,
live mock (shared log across tabs), conformance suite, read-only studio (sidebar, virtualised grid, pager, theme),
two-tab Playwright test with its BroadcastChannel sabotage. Next: S2 filters, sorts, columns; S3 editing; S4
selection, clipboard, export, foreign keys; S5 import UI, structure tab, final review.
```

- [ ] **Step 3: Full verification**

Run: `bun run check 2>&1 | grep -E "^Ran |fail"` and `bun run test 2>&1 | grep -E "^Ran |passed|failed|fail"`
Expected: the core's `Ran N tests across M files` equals the Task 1 baseline; the studio's unit line reads
`Ran 74 tests across 12 files`; Playwright `4 passed`; `0 fail`.

- [ ] **Step 4: Commit**

```bash
git add packages/studio/README.md docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "docs(studio): README and S1 progress"
```

- [ ] **Step 5: Hand-off**

A fresh reviewer (most capable model) reviews the branch against this plan and the spec (process step 5):
Critical/Important findings are fixed test-first; minors are recorded in the spec. The merge into `main` is the
owner's call.
```
