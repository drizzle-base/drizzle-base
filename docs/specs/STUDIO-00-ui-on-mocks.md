# STUDIO-00 — the studio's UI, built on a mock data source

> A brief for a session working **in parallel** with the core (DZB-01a). It builds `@drizzle-base/studio`'s
> interface against an in-memory mock behind a data-source interface, so that switching to the real drizzle-base
> admin functions later changes the adapter, not the UI. Written 25 Sep 2026. Read `CLAUDE.md` first: its process,
> language and test rules apply here unchanged.

## 0. What and why

drizzle-base will ship a data browser with Drizzle Studio's experience — and live: an edit in one tab appears in
every other open tab, and so does an edit made in Drizzle Studio itself or in psql (the core's capture stream sees
every committed write). Standalone (`bunx @drizzle-base/studio`) or embedded as React components in an admin
(`docs/ARCHITECTURE.md`, "The studio").

The core cannot serve it yet (subscriptions land in DZB-01a-3, the client in 01a-4). The UI does not need to wait:
it is written against `StudioDataSource` (§3) and runs on a mock that already behaves live across tabs.

## 1. Rules for this session

- **Work only in `packages/studio/`**, on branch `feat/studio-ui`, in its own git worktree (§7). Root files you
  must touch (`bun.lock`, the root `package.json` if a workspace script is needed) are rebased, never force-merged.
- **Do not import `drizzle-base`** (nor anything under `packages/drizzle-base`). The studio depends only on its own
  `StudioDataSource` interface until the adapter phase. This keeps the two sessions from colliding and proves the
  interface is sufficient.
- `packages/studio/package.json`: `"name": "@drizzle-base/studio"`, `"private": true` for now, `react` and
  `react-dom` as `peerDependencies`. English in the repo, pt-BR with the owner. `bun run check` must stay green
  (Biome: 2 spaces, 120 columns, no `any`, no floating promises).
- **Reverse engineering, within these limits** (the owner's call, 25 Sep 2026): Drizzle Studio is closed source
  but built on open-source parts (Tailwind v4, shadcn, an open icon set). You may run it, inspect it, read its
  shipped bundle and styles to understand layout, spacing, interactions, keyboard behaviour and edge cases, and use
  the **same open-source libraries and icon set**. You write **our own code**: no verbatim copy of their bundled
  JS/CSS, no Drizzle logos or brand assets. Where a behaviour is non-obvious, write down what you observed in
  `packages/studio/NOTES.md` (the source of each design decision), not in code comments.
- Drizzle sells an embeddable "Drizzle Studio Component" (B2B). Ours is open source and embeddable too; keep the
  README factual and never present it as theirs.

## 2. Stack (decided)

| Concern | Choice | Why |
|---|---|---|
| UI | React 19 | the core's `drizzle-base/react` targets React |
| Components | **shadcn/ui on Base UI** (the current shadcn default primitives) | same family Drizzle Studio uses; we own the component code |
| Styling | Tailwind CSS v4 | same as Drizzle Studio |
| Grid | TanStack Table + TanStack Virtual | headless, virtualised: thousands of rows without jank |
| Icons | the icon set Drizzle Studio ships (identify it in its bundle; if it is not open source, lucide) | visual parity |
| Dev playground | Vite, inside `packages/studio` (`bun run dev`) | the mock app to click through |
| Tests | `bun test` + happy-dom for logic and components; Playwright for the two-tab check | the realtime promise is tested in a real browser |

## 3. The contract — `StudioDataSource`

The page of rows is a **subscription**, not a fetch: drizzle-base re-pushes a query when its data changes, and the
UI must be built around that from day one. Draft (refine it in the first plan; every change to it is recorded in
this file):

```ts
export type ColumnKind =
  | "text" | "integer" | "numeric" | "boolean" | "uuid" | "date" | "timestamp" | "timestamptz"
  | "json" | "enum" | "bytea" | "array" | "unknown";

export interface ColumnInfo {
  name: string;
  kind: ColumnKind;
  pgType: string;                 // e.g. "timestamp with time zone", "varchar(255)"
  nullable: boolean;
  hasDefault: boolean;            // insert may omit it (uuidv7(), now(), serial…)
  isPrimaryKey: boolean;
  enumValues?: string[];
  references?: { schema: string; table: string; column: string };
}

export interface TableRef { schema: string; name: string }
export interface TableInfo extends TableRef {
  kind: "table" | "view";
  columns: ColumnInfo[];
  primaryKey: string[];           // empty for views and tables without one: those are read-only
  estimatedRows: number | null;
}

export type Row = Record<string, unknown>;
export type RowKey = Record<string, unknown>;   // primary-key column → value

export type FilterOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "like" | "ilike" | "in" | "isNull" | "isNotNull";
export interface Filter { column: string; op: FilterOp; value?: unknown }
export interface Sort { column: string; dir: "asc" | "desc" }

export interface PageRequest { table: TableRef; filters: Filter[]; sort: Sort[]; limit: number; offset: number }
export interface Page { rows: Row[]; total: number | null; revision: number }  // revision grows on every push

export interface Unsubscribe { (): void }

export interface StudioDataSource {
  listTables(): Promise<TableInfo[]>;
  subscribePage(req: PageRequest, onPage: (page: Page) => void, onError: (e: Error) => void): Unsubscribe;
  updateRows(table: TableRef, changes: { key: RowKey; values: Row }[]): Promise<void>;
  insertRows(table: TableRef, rows: Row[]): Promise<RowKey[]>;
  deleteRows(table: TableRef, keys: RowKey[]): Promise<void>;
}
```

**Contract changes** (the live version is `packages/studio/src/contract/index.ts`):

- 25 Sep 2026 (S1, after studying Drizzle Studio): `ColumnKind` gains `bigint` and `float`; `ColumnInfo` gains
  `elementKind` for arrays. Values are typed `CellValue` and travel as Postgres text for every kind JSON cannot
  carry exactly (bigint, numeric, uuid, dates and times, json, bytea); integer/float are numbers, boolean a boolean,
  arrays arrays. `FilterOp` gains `notLike` (Drizzle Studio has `NOT LIKE`). Errors are `StudioDataSourceError` with a
  `code` (`read_only`, `unknown_table`, `unknown_column`, `not_null`, `invalid_value`). Rows are ordered by `sort` and
  then by the primary key; `subscribePage` never calls back synchronously nor after unsubscribing. Reverse relations
  are derived in the client from `references`: no contract change.
- 25 Sep 2026 (S1 final review): `StudioErrorCode` gains `unique_violation` (a primary key already taken, on insert or
  on update — Postgres's 23505), with a conformance test. A page's `revision` only grows, across a mock reset too.

**The mock** (`createMockDataSource(seed)`): in-memory tables seeded with a realistic dataset (users, posts,
comments, an enum, a json column, a view, a table without a primary key, a few thousand rows); a
`BroadcastChannel` so a write in one tab re-pushes the pages open in every tab; an optional artificial latency; and
a dev-only "external write" control that mutates rows as if psql or Drizzle Studio had — the UI must show those
arriving without a refresh.

**A conformance suite** (`test/conformance.ts`): the behaviours any `StudioDataSource` must satisfy (a write
re-pushes affected pages with a higher `revision`; filters and sorts apply; deleting a row removes it from open
pages; a read-only table rejects writes). The mock passes it now; the real adapter passes the same suite later.

## 4. Drizzle Studio's features, and what to build now

From Drizzle Studio's documentation (orm.drizzle.team/drizzle-studio/overview), sorted by whether the mock can
serve them:

| Drizzle Studio feature | Now (mock) | Later (needs the core) | Notes |
|---|---|---|---|
| Table/view list with search | ✅ | | sidebar, grouped by schema |
| Pagination | ✅ | | offset now; cursor pages later (01d boundary tier) |
| Filtering | ✅ | | per-column operator builder, combined with AND |
| Multi-column sorting | ✅ | | |
| Column reordering (plus resize, hide) | ✅ | | persisted per table in localStorage |
| Inline editing — add, update, delete rows | ✅ | | pending-changes bar (save / discard), as in Drizzle Studio |
| Editors: text/number, **boolean, enum, in-place JSON**, date/time, NULL | ✅ | | one editor per `ColumnKind` |
| Copy & paste cell ranges; copy rows | ✅ | | clipboard in the browser |
| Export rows as JSON / CSV / SQL | ✅ | | client-side, from the loaded page or the filtered set |
| **Live updates across tabs and from outside writes** | ✅ (BroadcastChannel + "external write") | real stream | drizzle-base's differentiator: highlight changed cells; handle a remote change to a cell being edited |
| Keyboard navigation and shortcuts | ✅ | | observe Drizzle Studio's and match them |
| Light/dark theme | ✅ | | |
| Follow a foreign key to the referenced row | ✅ | | `ColumnInfo.references` |
| Import JSON / CSV / SQL | UI only | bulk mutation path | the dialog and parsing now; the write path later |
| Schema explorer — columns, indexes, foreign keys, views | read-only UI on mock metadata | admin metadata functions | extend the contract when it starts |
| Schema explorer — policies (RLS), privileges | | ✓ | |
| SQL console (autocomplete, explain/analyze, telemetry) | | ✓ | an admin-only raw-SQL path, outside the function gate: security spec first |
| Drizzle runner (run Drizzle queries) | | ✓ | server-side evaluation: its own spec |
| Multiple databases / Gateway, desktop app, browser extension | | ✗ | out of scope |

## 5. Done when

- The playground (`bun run dev`) browses the mock: sidebar, virtualised grid, filters, sorts, column
  order/size/visibility, every editor, add/delete, copy/paste, export, foreign-key navigation, theme.
- **Two tabs**: an edit in one appears in the other without a refresh, and an "external write" appears in both —
  proved by a Playwright test, with its sabotage (disable the BroadcastChannel → the test goes red).
- The conformance suite passes on the mock; component tests cover each editor and the pending-changes bar.
- `packages/studio/NOTES.md` records what was observed in Drizzle Studio and the decisions taken from it.
- `bun run check` green; a fresh reviewer on the branch; the owner merges.

**Progress.** S1 (25 Sep 2026, `docs/superpowers/plans/2026-09-25-studio-00-1-live-readonly-grid.md`): contract,
live mock, conformance suite, read-only studio (sidebar, virtualised grid, pager, theme), two-tab Playwright test
with its BroadcastChannel sabotage. The mock's log lives in IndexedDB, and each committed entry travels in the
BroadcastChannel message: with localStorage, Chromium showed another tab's write later than the message and a push
was lost. Next: S2 filters, sorts, columns; S3 editing; S4 selection, clipboard, export, foreign keys; S5 import UI,
structure tab, final review.

## 6. What happens later (not this session)

When DZB-01a-4 ships the client, a separate phase writes the admin functions (a spec: what an admin key may read
and write, how pages map to subscriptions) and `createDrizzleBaseDataSource(client)`, which must pass the same
conformance suite. The UI does not change.

## 7. Starting the session

```bash
cd ~/www/drizzlebase
git worktree add ../drizzle-base-studio -b feat/studio-ui main
cd ../drizzle-base-studio && bun install
```

Open Claude Code in `~/www/drizzle-base-studio` and start with:

> Read `CLAUDE.md` and `docs/specs/STUDIO-00-ui-on-mocks.md`. We are doing STUDIO-00. Start by studying Drizzle
> Studio (run `bunx drizzle-kit studio` against a local database, inspect it, identify its icon set and component
> patterns), then propose the plan for the first slice before writing code.
