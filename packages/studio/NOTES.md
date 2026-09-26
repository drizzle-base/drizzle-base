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

## Filters, sorting, columns (S2, observed 25 Sep 2026)

- Filters apply on Enter or **Apply**, never while typing. Rows read `where` then `and` (AND only). The value is
  always free text, even for enum and boolean; it disappears for is null. `in` splits on commas **without
  trimming** (`admin, editor` sends `' editor'` and the enum cast fails) — we trim, type each item, and allow quotes.
- With a filter the query asks `limit 51` and the pager reads `1 - 50 of 50+`; a `count(*)` button counts on
  demand. A failed query shows inside the grid with its SQL.
- Sorting applies at once. The panel lists unused columns (searchable) on the left and active sorts (ASC/DESC toggle,
  ×, Clear sorting) on the right. Clicking a header opens Clear Sort / Sort Ascending / Sort Descending /
  Multicolumn sort; Ascending/Descending **replace** every sort. **Ties are not broken by the primary key**, so
  pages overlap under a sort with duplicates — ours always ends with the key.
- The columns panel toggles a column by clicking its row, hides all from its header, has a search and drag handles.
  Header edges resize. Widths survive switching tables but not a reload; hidden columns come back when switching
  tables. Its store (zustand, persisted) keeps filter rows per table.
- Toolbar buttons carry a `!` badge when active; the pager's `1 - 50` opens a Limit/Offset editor.

## Decisions taken from this (S2)

- A live page need not count: `withTotal` / `hasMore` in the contract, `50+` and **Count rows** in the UI.
- The view (table, filters, sort, page) is one serialisable `StudioView`, controlled by the host; the playground
  keeps it in the URL (versioned, PostgREST-like), push for tables/filters/sort and replace for paging. Layout
  (order, hidden, widths) and the last view per table stay in localStorage. The studio never touches the URL.
- Filter values are typed by column: select lists for boolean and enum, validation for numbers and uuids; an invalid
  value blocks Apply and says why; a link's unusable filter is shown as ignored, never dropped silently.

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

## Editors (S3b, observed 25 Sep 2026)

- A date/timestamp cell opens its input plus a popover: `NULL / now / today / tomorrow / yesterday`, a
  react-day-picker month and, for timestamps, hour/minute/second columns. A shortcut writes the literal word
  (`now`), which Postgres resolves at save time.
- **Defects we do not copy:** picking a day on a timestamptz drops the time, the microseconds and the offset
  (`2026-09-10 00:00:00`, read in the session's zone); the calendar neither shows the current value nor follows
  what is typed; `NULL` is offered on NOT NULL columns.
- Expand Row is a non-modal, resizable side panel of every column; its edits are the grid's pending edits (Save
  and Discard in the toolbar and in its footer); an edited field gets an amber border and a ↺; the panel follows
  the selected row.
- CodeMirror (line numbers, folding, highlighting) for json and arrays, in the panel and the cell editor.

## Decisions taken from this (S3b)

- Date/time text is edited by parts (`src/lib/pgtime.ts`): a picked day or hour keeps everything else.
- Shortcuts resolve on the client to concrete text in the browser's zone (`now` = the click), so the pending cell
  shows the real value and every data source receives plain values; data sources read timestamptz back in UTC.
- The panel feeds the same draft; it adds conflict and required markers, says when its row left the page, and
  opens new rows too. It opens from a button in the row's lead cell until the context menu (S4). After a save, a
  new row that sorted off the current page is still shown from the inserted key and the values we wrote — not
  the "deleted / moved" empty state.
- `new Date(year, …)` and `Date.UTC(year, …)` fold years 0–99 into 1900–1999. Calendar days and `parseScalar` go
  through `calendarDay` / `parsePgTime` (`setFullYear` / `setUTCFullYear`).
- CodeMirror 6 is its own chunk, fetched on first use (entry: 201 kB gzip; CodeMirror chunk: 102 kB gzip);
  `codeEditor="textarea"` keeps it from ever loading.

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
