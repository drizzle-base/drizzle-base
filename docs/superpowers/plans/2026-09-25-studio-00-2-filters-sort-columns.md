# STUDIO-00 S2 — Filters, sorts, columns, and a view that lives in the URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the studio Drizzle Studio's filter bar, sort panel, header sort menu, column panel (show/hide,
reorder) and column resizing, a page-size choice and a count-on-demand total. What the studio shows becomes one
serialisable `StudioView` that a host binds to its URL, so a link reopens the same table, filters, sort and page.

**Architecture:** `src/view/` is pure: the `StudioView` type, typed parsing of filter text per column kind, a
versioned PostgREST-like codec (`?table=public.users&where=role.in.(admin,editor)&order=age.desc`) and the
resolver that turns a view into a `PageRequest` while listing what it had to ignore. `<Studio>` takes the view
controlled (`view` + `onViewChange(view, { history })`) or uncontrolled (`defaultView`); it never touches
`window.location`, so it embeds under any router. The playground binds it to the URL with a small hook (no
library). Column layout (order, hidden, widths) and the last view per table live in localStorage, namespaced by
`storageKey`. The contract gains `PageRequest.withTotal` and `Page.hasMore`: a live page need not count.

**Tech Stack:** as S1 (Bun 1.4.2, React 19.3, Tailwind 4.3, shadcn on Base UI 1.8, TanStack Table 9 + Virtual,
lucide-react, happy-dom + Testing Library, Playwright). No new dependency.

**Spec:** `docs/specs/STUDIO-00-ui-on-mocks.md` §4 rows "Filtering", "Multi-column sorting", "Column reordering
(plus resize, hide)". Decisions taken with the owner on 25 Sep 2026 after studying Drizzle Studio: count on demand
(contract change); persist per table; the view in the URL through a controlled prop, no nuqs; header drag-reorder
and "Open in SQL" deferred.

## Global Constraints

- Work only in `packages/studio/` on branch `feat/studio-s2-filters-sort-columns`; outside it: the spec
  (`docs/specs/STUDIO-00-ui-on-mocks.md`), this plan. Before merging, check whether `main` moved (other sessions).
- `src/` never reads or writes `window.location`/`history`: only `playground/` does.
- Never drop a filter silently: anything the resolver or codec cannot use is listed in a visible notice.
- Filter values are typed by column kind at request time; `in` lists split on commas, trimmed, `"…"` keeps a comma,
  `""` is a quote.
- The link format is versioned (`v=1`); an unknown version is ignored as a whole, with a notice.
- History: `push` for choosing a table, applying filters, changing sort; `replace` for offset and page size.
- Biome, TS strict, `bun run check` green before every commit; English in the repo; restore sabotages with `cp`.
- Every `PageRequest` literal gains `withTotal`; every `Page` literal gains `hasMore`.

## Review Focus

1. **A link to a column that no longer exists** (renamed) must not show more rows as if nothing happened. (Task 2
   test `the resolver lists what it ignored`; Task 8 test `an unknown filter column is reported, not dropped`.)
2. **Typing is not filtering**: a half-typed value must not hit the data source, and an invalid one must say why and
   block Apply. (Task 5 tests.)
3. **A controlled host that passes an equal but new view object every render** must not resubscribe in a loop.
   (Task 8 test `an equal view object does not resubscribe`.)
4. **Commas, quotes, dots and spaces** in values and column names round-trip through the URL. (Task 2 codec tests.)
5. **A filtered page without a count** still pages correctly (`50+`, Next enabled only while `hasMore`). (Task 1
   conformance `withTotal`; Task 8 test `filters narrow the rows; the pager says 50+ until counted`.)

---

## Target layout (new and changed)

```
packages/studio/
  src/contract/index.ts              + withTotal, hasMore
  src/mock/query.ts, source.ts       hasMore; total only when asked
  src/view/  index.ts view.ts values.ts codec.ts request.ts sort.ts
  src/studio/ prefs.ts use-view.ts filter-bar.tsx sort-panel.tsx columns-panel.tsx pager.tsx studio.tsx
  src/grid/   data-grid.tsx header-cell.tsx resize-handle.tsx
  src/ui/     popover.tsx dropdown-menu.tsx
  playground/ main.tsx use-url-view.ts
  test/conformance.ts                + withTotal/hasMore, M1 gaps, accuracy note
  test/unit/  values codec request sort prefs use-view filter-bar sort-panel columns-panel (+ updates)
  e2e/view.e2e.ts
```

---

### Task 1: Count on demand — `withTotal` and `hasMore` in the contract; conformance gaps

**Files:**
- Modify: `packages/studio/src/contract/index.ts`, `src/mock/query.ts`, `src/mock/source.ts`,
  `src/studio/studio.tsx` (the request literal), `test/conformance.ts`, `test/unit/mock-source.test.ts`,
  `test/unit/use-page.test.tsx`, `test/unit/format.test.ts`, `test/unit/data-grid.test.tsx`, `test/unit/query.test.ts`,
  `e2e/two-tabs.e2e.ts`, `docs/specs/STUDIO-00-ui-on-mocks.md`

**Interfaces:**
- Produces: `PageRequest.withTotal: boolean`; `Page.hasMore: boolean`; `Page.total` is `null` whenever
  `withTotal` is false. `runPage(...)` returns `{ rows, total, hasMore }`.

- [ ] **Step 1: The failing conformance tests**

In `test/conformance.ts`:

a) Replace the header comment's last sentence and add the accuracy note, so the header reads:

```ts
// What every StudioDataSource must do, whatever sits behind it. The mock passes it now; the drizzle-base adapter
// must pass it unchanged. It runs against the relations of src/mock/datasets/conformance.ts, empty at the start of
// each test; `open()` returns another client of the same backend (another tab).
//
// The suite avoids what a real database decides differently from the mock: text order depends on the collation
// (the mock compares code points), numeric compares exactly in Postgres (the mock goes through Number), json and
// arrays compare structurally in Postgres (the mock compares JSON text). Tests sort lowercase text and small numbers.
```

b) `req` gains `withTotal: true`:

```ts
const req = (over: Partial<PageRequest> = {}): PageRequest => ({
  table: ITEMS,
  filters: [],
  sort: [],
  limit: 50,
  offset: 0,
  withTotal: true,
  ...over,
});
```

c) Before `it("unknown tables and columns are reported with their codes"`, add:

```ts
    it("without withTotal the total is null, and hasMore says whether rows follow", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      const first = watch(ds, req({ limit: 2, withTotal: false }));
      expect(await first.latest()).toMatchObject({ total: null, hasMore: true });
      first.stop();
      const last = watch(ds, req({ limit: 2, offset: 2, withTotal: false }));
      expect(await last.latest()).toMatchObject({ total: null, hasMore: false });
      last.stop();
      const counted = watch(ds, req({ limit: 2 }));
      expect(await counted.latest()).toMatchObject({ total: 4, hasMore: true });
      counted.stop();
    });

    it("eq and neq with a NULL value match nothing, as in SQL", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      for (const op of ["eq", "neq"] as const) {
        const w = watch(ds, req({ filters: [{ column: "note", op, value: null }] }));
        expect(labels(await w.latest())).toEqual([]);
        w.stop();
      }
    });

    it("an update or delete whose key names no row changes nothing", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      await ds.updateRows(ITEMS, [{ key: { id: 999 }, values: { label: "ghost" } }]);
      await ds.deleteRows(ITEMS, [{ id: 998 }]);
      const w = watch(ds, req());
      expect(labels(await w.latest())).toEqual(["alpha", "beta", "gamma", "delta"]);
      w.stop();
    });

    it("a key that does not name exactly the primary key is invalid", async (open) => {
      const ds = await open();
      await expectCode(ds.updateRows(ITEMS, [{ key: { label: "alpha" }, values: { rank: 1 } }]), "invalid_value");
      await expectCode(ds.deleteRows(ITEMS, [{}]), "invalid_value");
    });

    it("a client opened after writes sees them", async (open) => {
      const early = await open();
      await early.insertRows(ITEMS, [{ label: "before the late client" }]);
      const late = await open();
      const w = watch(late, req());
      expect(labels(await w.latest())).toEqual(["before the late client"]);
      w.stop();
    });

```

Run: `cd packages/studio && bun test ./test/unit/mock-source.test.ts 2>&1 | grep -E "^\(fail\)| pass$| fail$"`
Expected: FAIL — typecheck-free Bun still runs; `without withTotal …` fails (`total` is 4, `hasMore` undefined).
The other four new tests may pass already (they pin behaviour the mock has): that is fine, they are gap-fillers for
the adapter; record in the ledger which ones passed before the change.

- [ ] **Step 2: Contract, engine, source**

`src/contract/index.ts` — `PageRequest` and `Page` become:

```ts
export interface PageRequest {
  table: TableRef;
  filters: Filter[];
  sort: Sort[];
  limit: number;
  offset: number;
  /**
   * Ask for `Page.total`. Counting every row a filter keeps can cost far more than the page itself, and a page is a
   * subscription re-run on every change: the UI asks only when it will show the number.
   */
  withTotal: boolean;
}

/**
 * `total` counts every row the filters keep; null when `withTotal` was false (or the backend will not count).
 * `hasMore` says whether rows exist past this page, which needs no count. `revision` identifies the data the page
 * was computed from: a page pushed because of a write carries a higher revision than any page before it.
 */
export interface Page {
  rows: Row[];
  total: number | null;
  hasMore: boolean;
  revision: number;
}
```

`src/mock/query.ts` — `runPage`'s return type and last line:

```ts
): { rows: Row[]; total: number; hasMore: boolean } {
```

```ts
  return {
    rows: kept.slice(req.offset, req.offset + req.limit),
    total: kept.length,
    hasMore: req.offset + req.limit < kept.length,
  };
```

`src/mock/source.ts` — in `evaluate`, replace the three lines from `const result = runPage(...)` to the `page`
constant with:

```ts
      const result = runPage(info, rows, sub.req);
      // Only what the subscriber sees decides whether to push: without withTotal a changed count alone is no news.
      const shown = { rows: result.rows, total: sub.req.withTotal ? result.total : null, hasMore: result.hasMore };
      const json = JSON.stringify(shown);
      if (json === sub.last) return; // pushes happen when the result changes, not on every commit
      sub.last = json;
      const page: Page = { ...structuredClone(shown), revision };
```

- [ ] **Step 3: Every literal**

Add `withTotal: true` to each `PageRequest` literal and `hasMore` to each `Page` literal:
- `test/unit/mock-source.test.ts`: the `firstPage` helper's request and every inline `subscribePage({ … })` object.
- `test/unit/use-page.test.tsx`: `req = (table, offset = 0): PageRequest => ({ …, withTotal: true })`.
- `test/unit/format.test.ts`: `page = (rows, revision): Page => ({ rows, total: rows.length, hasMore: false, revision })`.
- `test/unit/data-grid.test.tsx`: `const page: Page = { rows, total: 1000, hasMore: false, revision: 3 };`.
- `e2e/two-tabs.e2e.ts`: the three `subscribePage` request objects.
- `src/studio/studio.tsx`: the `req` literal (Task 8 rewrites this file; keep it compiling now).
- `test/unit/query.test.ts`: add `expect(page.hasMore).toBe(true);` to `limit/offset slice the sorted rows; total
  ignores them` (offset 1 + limit 2 < 4).

Run: `cd packages/studio && bun run typecheck && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"`
Expected: typecheck clean; all pass.

- [ ] **Step 4: Sabotages**

1. In `source.ts`, use `total: result.total` in `shown` → `without withTotal the total is null…` goes red.
2. In `query.ts`, return `hasMore: false` → the same test goes red (first page).
Restore each with `cp`.

- [ ] **Step 5: Spec, check, commit**

In the spec's "Contract changes" list, add:

```markdown
- 25 Sep 2026 (S2): `PageRequest.withTotal` (ask for the count) and `Page.hasMore` (rows past this page, no count
  needed). A live page is re-run on every change; counting what a filter keeps can cost more than the page, so the
  UI counts on demand, as Drizzle Studio does (`50+` and a `count(*)` button).
```

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "feat(studio): count on demand — PageRequest.withTotal and Page.hasMore; conformance gaps filled"
```

---

### Task 2: The view — type, typed filter values, URL codec, resolver

**Files:**
- Create: `packages/studio/src/view/view.ts`, `src/view/values.ts`, `src/view/codec.ts`, `src/view/request.ts`,
  `src/view/sort.ts`, `src/view/index.ts`
- Test: `test/unit/values.test.ts`, `test/unit/codec.test.ts`, `test/unit/request.test.ts`, `test/unit/sort.test.ts`

**Interfaces:**
- Produces:
  - `interface ViewFilter { column: string; op: FilterOp; text: string }`
  - `interface StudioView { table: string | null; filters: ViewFilter[]; sort: Sort[]; limit: number; offset: number }`
  - `interface ViewChange { history: "push" | "replace" }`
  - `EMPTY_VIEW`, `DEFAULT_LIMIT = 50`, `PAGE_SIZES = [50, 100, 500, 1000]`, `viewOfTable(table: string, limit?: number): StudioView`, `sameView(a, b): boolean`
  - `type Parsed = { ok: true; value: CellValue | undefined } | { ok: false; error: string }`, `NO_VALUE_OPS: FilterOp[]`,
    `parseScalar(col: ColumnInfo, text: string): Parsed`, `parseFilterValue(col: ColumnInfo, op: FilterOp, text: string): Parsed`,
    `splitList(text: string): { ok: true; items: string[] } | { ok: false; error: string }`
  - `VIEW_PARAM_KEYS`, `encodeView(view: StudioView): string`, `decodeView(search: string): { view: StudioView; errors: string[] }`
  - `toPageRequest(view: StudioView, table: TableInfo, withTotal: boolean): { req: PageRequest; ignored: string[] }`
  - `type HeaderSortAction = "asc" | "desc" | "add" | "clear"`, `applyHeaderSort(sort: Sort[], column: string, action: HeaderSortAction): Sort[]`,
    `sortPosition(sort: Sort[], column: string): { dir: "asc" | "desc"; position: number } | null` (position 0 when only one sort)

- [ ] **Step 1: Write the failing tests**

`test/unit/values.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ColumnInfo } from "../../src/contract";
import { col } from "../../src/mock";
import { parseFilterValue, parseScalar, splitList } from "../../src/view";

const ok = (value: unknown) => ({ ok: true, value });
const c = (kind: ColumnInfo["kind"], extra: Partial<ColumnInfo> = {}) => col("c", kind, kind, extra);

describe("parseScalar: text becomes the column's wire value", () => {
  test("numbers", () => {
    expect(parseScalar(c("integer"), " 42 ")).toEqual(ok(42));
    expect(parseScalar(c("integer"), "4.2").ok).toBe(false);
    expect(parseScalar(c("integer"), "9007199254740993").ok).toBe(false);
    expect(parseScalar(c("float"), "0.5")).toEqual(ok(0.5));
    expect(parseScalar(c("bigint"), "9007199254740993")).toEqual(ok("9007199254740993"));
    expect(parseScalar(c("numeric"), "10.50")).toEqual(ok("10.50"));
    expect(parseScalar(c("numeric"), "1e3").ok).toBe(false);
  });
  test("booleans, enums, uuids", () => {
    expect(parseScalar(c("boolean"), "true")).toEqual(ok(true));
    expect(parseScalar(c("boolean"), "yes").ok).toBe(false);
    expect(parseScalar(c("enum", { enumValues: ["admin", "viewer"] }), "admin")).toEqual(ok("admin"));
    const bad = parseScalar(c("enum", { enumValues: ["admin", "viewer"] }), "root");
    expect(bad).toEqual({ ok: false, error: '"root" is not one of admin, viewer' });
    expect(parseScalar(c("uuid"), "019B76DA-ABE8-708F-AF41-000000000000")).toEqual(
      ok("019b76da-abe8-708f-af41-000000000000"),
    );
    expect(parseScalar(c("uuid"), "nope").ok).toBe(false);
  });
  test("text keeps its spaces; other kinds pass through as text", () => {
    expect(parseScalar(c("text"), " a ")).toEqual(ok(" a "));
    expect(parseScalar(c("timestamptz"), "2026-01-01")).toEqual(ok("2026-01-01"));
  });
});

describe("parseFilterValue", () => {
  test("is null takes no value; like keeps the pattern as typed", () => {
    expect(parseFilterValue(c("integer"), "isNull", "junk")).toEqual(ok(undefined));
    expect(parseFilterValue(c("integer"), "like", "1%")).toEqual(ok("1%"));
  });
  test("in: a typed list, trimmed; the first bad item is the error", () => {
    expect(parseFilterValue(c("integer"), "in", "1, 2,3")).toEqual(ok([1, 2, 3]));
    expect(parseFilterValue(c("integer"), "in", "1, x")).toEqual({ ok: false, error: '"x" is not an integer' });
    expect(parseFilterValue(c("integer"), "in", "  ").ok).toBe(false);
  });
});

describe("splitList", () => {
  test("commas split, spaces around items go, quotes keep commas and double quotes escape", () => {
    expect(splitList(' a , "b,c", "say ""hi""" ,d')).toEqual({ ok: true, items: ["a", "b,c", 'say "hi"', "d"] });
    expect(splitList("")).toEqual({ ok: true, items: [] });
    expect(splitList('"open').ok).toBe(false);
    expect(splitList('"a" b').ok).toBe(false);
  });
});
```

`test/unit/codec.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeView, EMPTY_VIEW, encodeView, type StudioView } from "../../src/view";

const view = (over: Partial<StudioView>): StudioView => ({ ...EMPTY_VIEW, ...over });

describe("encodeView", () => {
  test("a readable, stable link", () => {
    const v = view({
      table: "public.users",
      filters: [
        { column: "role", op: "in", text: "admin,editor" },
        { column: "name", op: "isNull", text: "" },
      ],
      sort: [
        { column: "age", dir: "desc" },
        { column: "id", dir: "asc" },
      ],
      limit: 100,
      offset: 200,
    });
    expect(decodeURIComponent(encodeView(v)).replaceAll("+", " ")).toBe(
      "v=1&table=public.users&where=role.in.admin,editor&where=name.isnull&order=age.desc,id.asc&limit=100&offset=200",
    );
  });
  test("defaults are left out; no table means an empty string", () => {
    expect(encodeView(view({ table: "public.t" }))).toBe("v=1&table=public.t");
    expect(encodeView(EMPTY_VIEW)).toBe("");
  });
});

describe("round trip", () => {
  const cases: StudioView[] = [
    view({ table: "public.users", filters: [{ column: "name", op: "ilike", text: "a.b %c, d & e=f" }] }),
    view({ table: 'odd."schema".t', filters: [{ column: 'my.col "x"', op: "eq", text: "1.5" }] }),
    view({ table: "t", filters: [{ column: "tags", op: "in", text: '"a,b", c' }], sort: [{ column: "a,b", dir: "asc" }] }),
    view({ table: "t", filters: [{ column: "n", op: "notLike", text: "" }] }),
  ];
  for (const v of cases) {
    test(JSON.stringify(v.filters), () => {
      expect(decodeView(`?${encodeView(v)}`)).toEqual({ view: v, errors: [] });
    });
  }
});

describe("decodeView", () => {
  test("a bad piece is reported and skipped; the rest is kept", () => {
    const { view: v, errors } = decodeView("?v=1&table=public.users&where=role.bogus.1&where=age.gt.3&limit=-5");
    expect(v).toEqual(view({ table: "public.users", filters: [{ column: "age", op: "gt", text: "3" }] }));
    expect(errors).toEqual(['filter "role.bogus.1": not column.operator.value', 'limit "-5": not a whole number from 1']);
  });
  test("an unknown version is ignored as a whole", () => {
    expect(decodeView("?v=2&table=public.users")).toEqual({
      view: EMPTY_VIEW,
      errors: ['link version "2" (this studio reads version 1)'],
    });
  });
  test("parameters that are not the studio's are left alone; a link without v reads as v1", () => {
    expect(decodeView("?latency=300&table=public.t").view).toEqual(view({ table: "public.t" }));
  });
});
```

`test/unit/request.test.ts`:

```ts
import { expect, test } from "bun:test";
import { demoDataset } from "../../src/mock";
import { EMPTY_VIEW, toPageRequest } from "../../src/view";

const users = demoDataset(1).tables[0]?.info;
if (!users) throw new Error("demo dataset has no users table");

test("typed filters, sort, paging and withTotal reach the request", () => {
  const { req, ignored } = toPageRequest(
    {
      ...EMPTY_VIEW,
      table: "public.users",
      filters: [
        { column: "age", op: "gte", text: "30" },
        { column: "role", op: "in", text: "admin, editor" },
        { column: "name", op: "isNull", text: "" },
      ],
      sort: [{ column: "age", dir: "desc" }],
      limit: 100,
      offset: 100,
    },
    users,
    false,
  );
  expect(ignored).toEqual([]);
  expect(req).toEqual({
    table: { schema: "public", name: "users" },
    filters: [
      { column: "age", op: "gte", value: 30 },
      { column: "role", op: "in", value: ["admin", "editor"] },
      { column: "name", op: "isNull" },
    ],
    sort: [{ column: "age", dir: "desc" }],
    limit: 100,
    offset: 100,
    withTotal: false,
  });
});

test("the resolver lists what it ignored: unknown columns and values the column cannot hold", () => {
  const { req, ignored } = toPageRequest(
    {
      ...EMPTY_VIEW,
      table: "public.users",
      filters: [
        { column: "nope", op: "eq", text: "1" },
        { column: "age", op: "eq", text: "old" },
        { column: "email", op: "ilike", text: "%@example.com" },
      ],
      sort: [{ column: "gone", dir: "asc" }],
    },
    users,
    true,
  );
  expect(req.filters).toEqual([{ column: "email", op: "ilike", value: "%@example.com" }]);
  expect(req.sort).toEqual([]);
  expect(ignored).toEqual([
    'filter on "nope": no such column',
    'filter on "age": "old" is not an integer',
    'sort by "gone": no such column',
  ]);
});
```

`test/unit/sort.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { Sort } from "../../src/contract";
import { applyHeaderSort, sortPosition } from "../../src/view";

const two: Sort[] = [
  { column: "a", dir: "asc" },
  { column: "b", dir: "desc" },
];

test("header ascending/descending replace every sort; add appends once; clear removes that column", () => {
  expect(applyHeaderSort(two, "c", "desc")).toEqual([{ column: "c", dir: "desc" }]);
  expect(applyHeaderSort(two, "c", "add")).toEqual([...two, { column: "c", dir: "asc" }]);
  expect(applyHeaderSort(two, "a", "add")).toEqual(two);
  expect(applyHeaderSort(two, "a", "clear")).toEqual([{ column: "b", dir: "desc" }]);
});

test("sortPosition numbers columns only when there is more than one sort", () => {
  expect(sortPosition(two, "b")).toEqual({ dir: "desc", position: 2 });
  expect(sortPosition([{ column: "a", dir: "asc" }], "a")).toEqual({ dir: "asc", position: 0 });
  expect(sortPosition(two, "z")).toBeNull();
});
```

Run: `cd packages/studio && bun test ./test/unit/values.test.ts ./test/unit/codec.test.ts ./test/unit/request.test.ts ./test/unit/sort.test.ts`
Expected: FAIL — cannot find module `../../src/view`.

- [ ] **Step 2: `view.ts` and `sort.ts`**

`src/view/view.ts`:

```ts
import type { FilterOp, Sort } from "../contract";

/** A filter as the person typed it: the value stays text until it meets its column (see request.ts). */
export interface ViewFilter {
  column: string;
  op: FilterOp;
  text: string;
}

/** What the studio shows. Serialisable (codec.ts), so a host can keep it in its URL. */
export interface StudioView {
  table: string | null;
  filters: ViewFilter[];
  sort: Sort[];
  limit: number;
  offset: number;
}

/** How a host should record a change: a new history entry, or in place of the current one. */
export interface ViewChange {
  history: "push" | "replace";
}

export const DEFAULT_LIMIT = 50;
export const PAGE_SIZES = [50, 100, 500, 1000] as const;
export const EMPTY_VIEW: StudioView = { table: null, filters: [], sort: [], limit: DEFAULT_LIMIT, offset: 0 };

export function viewOfTable(table: string, limit: number = DEFAULT_LIMIT): StudioView {
  return { ...EMPTY_VIEW, table, limit };
}

export function sameView(a: StudioView, b: StudioView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

`src/view/sort.ts`:

```ts
import type { Sort } from "../contract";

export type HeaderSortAction = "asc" | "desc" | "add" | "clear";

/** What a column header's menu does: ascending/descending replace every sort, as in Drizzle Studio. */
export function applyHeaderSort(sort: Sort[], column: string, action: HeaderSortAction): Sort[] {
  switch (action) {
    case "asc":
    case "desc":
      return [{ column, dir: action }];
    case "add":
      return sort.some((s) => s.column === column) ? sort : [...sort, { column, dir: "asc" }];
    case "clear":
      return sort.filter((s) => s.column !== column);
  }
}

export function sortPosition(sort: Sort[], column: string): { dir: "asc" | "desc"; position: number } | null {
  const i = sort.findIndex((s) => s.column === column);
  const s = sort[i];
  if (!s) return null;
  return { dir: s.dir, position: sort.length > 1 ? i + 1 : 0 };
}
```

- [ ] **Step 3: `values.ts`**

```ts
import type { CellValue, ColumnInfo, FilterOp } from "../contract";

export type Parsed = { ok: true; value: CellValue | undefined } | { ok: false; error: string };

export const NO_VALUE_OPS: FilterOp[] = ["isNull", "isNotNull"];

const INT = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (value: CellValue | undefined): Parsed => ({ ok: true, value });
const fail = (error: string): Parsed => ({ ok: false, error });

/** One value typed as its column carries it on the wire (see CellValue). Text kinds keep their spaces. */
export function parseScalar(col: ColumnInfo, text: string): Parsed {
  const t = text.trim();
  switch (col.kind) {
    case "integer":
      return INT.test(t) && Number.isSafeInteger(Number(t)) ? ok(Number(t)) : fail(`"${t}" is not an integer`);
    case "float":
      return t !== "" && Number.isFinite(Number(t)) ? ok(Number(t)) : fail(`"${t}" is not a number`);
    case "bigint":
      return INT.test(t) ? ok(BigInt(t).toString()) : fail(`"${t}" is not an integer`);
    case "numeric":
      return DECIMAL.test(t) ? ok(t) : fail(`"${t}" is not a number`);
    case "boolean":
      return t === "true" ? ok(true) : t === "false" ? ok(false) : fail(`"${t}" is not true or false`);
    case "enum": {
      const values = col.enumValues ?? [];
      return values.includes(t) ? ok(t) : fail(`"${t}" is not one of ${values.join(", ")}`);
    }
    case "uuid":
      return UUID.test(t) ? ok(t.toLowerCase()) : fail(`"${t}" is not a uuid`);
    default:
      return ok(text);
  }
}

/** Comma-separated items, trimmed. `"…"` keeps commas and spaces inside an item; `""` inside it is a quote. */
export function splitList(text: string): { ok: true; items: string[] } | { ok: false; error: string } {
  const items: string[] = [];
  let i = 0;
  const skipSpaces = () => {
    while (text[i] === " ") i++;
  };
  skipSpaces();
  if (i >= text.length) return { ok: true, items };
  for (;;) {
    skipSpaces();
    let item = "";
    if (text[i] === '"') {
      i++;
      for (;;) {
        if (i >= text.length) return { ok: false, error: "a quote is not closed" };
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            item += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        item += text[i];
        i++;
      }
      skipSpaces();
      if (i < text.length && text[i] !== ",") return { ok: false, error: "text after a quoted value" };
    } else {
      const comma = text.indexOf(",", i);
      const end = comma === -1 ? text.length : comma;
      item = text.slice(i, end).trim();
      i = end;
    }
    items.push(item);
    if (i >= text.length) return { ok: true, items };
    i++; // the comma
  }
}

export function parseFilterValue(col: ColumnInfo, op: FilterOp, text: string): Parsed {
  if (NO_VALUE_OPS.includes(op)) return ok(undefined);
  if (op === "like" || op === "ilike" || op === "notLike") return ok(text);
  if (op !== "in") return parseScalar(col, text);
  const list = splitList(text);
  if (!list.ok) return fail(list.error);
  if (list.items.length === 0) return fail("list at least one value");
  const values: CellValue[] = [];
  for (const item of list.items) {
    const p = parseScalar(col, item);
    if (!p.ok) return p;
    values.push(p.value ?? null);
  }
  return ok(values);
}
```

- [ ] **Step 4: `codec.ts`**

```ts
import type { FilterOp, Sort } from "../contract";
import { EMPTY_VIEW, type StudioView, type ViewFilter } from "./view";

// Link format, version 1 (PostgREST-like, readable in the address bar):
//   ?v=1&table=public.users&where=role.in.admin,editor&where=name.isnull&order=age.desc,id.asc&limit=100&offset=200
// A column name that is not a plain identifier is double-quoted, "" being a quote inside it. A filter keeps the
// text the person typed; typing it happens against the column (request.ts).

export const VIEW_PARAM_KEYS = ["v", "table", "where", "order", "limit", "offset"] as const;

const VERSION = "1";
const OP_TOKENS: Record<FilterOp, string> = {
  eq: "eq",
  neq: "neq",
  lt: "lt",
  lte: "lte",
  gt: "gt",
  gte: "gte",
  like: "like",
  ilike: "ilike",
  notLike: "notlike",
  in: "in",
  isNull: "isnull",
  isNotNull: "notnull",
};
const TOKEN_OPS = new Map(Object.entries(OP_TOKENS).map(([op, token]) => [token, op as FilterOp]));
const NO_VALUE: ReadonlySet<FilterOp> = new Set(["isNull", "isNotNull"]);
const BARE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const quoteName = (name: string): string => (BARE.test(name) ? name : `"${name.replaceAll('"', '""')}"`);

/** A column name starting at `i`: bare up to the next ".", or double-quoted. */
function readName(s: string, i: number): { name: string; next: number } | null {
  if (s[i] !== '"') {
    const dot = s.indexOf(".", i);
    const end = dot === -1 ? s.length : dot;
    const name = s.slice(i, end);
    return BARE.test(name) ? { name, next: end } : null;
  }
  let name = "";
  let j = i + 1;
  for (;;) {
    if (j >= s.length) return null;
    if (s[j] === '"') {
      if (s[j + 1] === '"') {
        name += '"';
        j += 2;
        continue;
      }
      return { name, next: j + 1 };
    }
    name += s[j];
    j++;
  }
}

function parseWhere(raw: string): ViewFilter | null {
  const n = readName(raw, 0);
  if (!n || raw[n.next] !== ".") return null;
  const rest = raw.slice(n.next + 1);
  const dot = rest.indexOf(".");
  const op = TOKEN_OPS.get(dot === -1 ? rest : rest.slice(0, dot));
  if (!op) return null;
  if (NO_VALUE.has(op)) return dot === -1 ? { column: n.name, op, text: "" } : null;
  if (dot === -1) return null;
  return { column: n.name, op, text: rest.slice(dot + 1) };
}

function parseOrder(raw: string): Sort[] | null {
  const out: Sort[] = [];
  let i = 0;
  while (i < raw.length) {
    const n = readName(raw, i);
    if (!n || raw[n.next] !== ".") return null;
    const comma = raw.indexOf(",", n.next + 1);
    const end = comma === -1 ? raw.length : comma;
    const dir = raw.slice(n.next + 1, end);
    if (dir !== "asc" && dir !== "desc") return null;
    out.push({ column: n.name, dir });
    i = comma === -1 ? raw.length : comma + 1;
  }
  return out;
}

function parseCount(raw: string | null, fallback: number, min: number, name: string, errors: string[]): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n >= min) return n;
  errors.push(`${name} "${raw}": not a whole number from ${min}`);
  return fallback;
}

export function encodeView(view: StudioView): string {
  if (view.table === null) return "";
  const p = new URLSearchParams();
  p.set("v", VERSION);
  p.set("table", view.table);
  for (const f of view.filters) {
    p.append("where", `${quoteName(f.column)}.${OP_TOKENS[f.op]}${NO_VALUE.has(f.op) ? "" : `.${f.text}`}`);
  }
  if (view.sort.length > 0) p.set("order", view.sort.map((s) => `${quoteName(s.column)}.${s.dir}`).join(","));
  if (view.limit !== EMPTY_VIEW.limit) p.set("limit", String(view.limit));
  if (view.offset !== 0) p.set("offset", String(view.offset));
  return p.toString();
}

/** Never throws: what it cannot read is skipped and described in `errors`, for the studio to show. */
export function decodeView(search: string): { view: StudioView; errors: string[] } {
  const p = new URLSearchParams(search);
  const version = p.get("v");
  if (version !== null && version !== VERSION) {
    return { view: EMPTY_VIEW, errors: [`link version "${version}" (this studio reads version ${VERSION})`] };
  }
  const errors: string[] = [];
  const filters: ViewFilter[] = [];
  for (const raw of p.getAll("where")) {
    const f = parseWhere(raw);
    if (f) filters.push(f);
    else errors.push(`filter "${raw}": not column.operator.value`);
  }
  const order = p.get("order");
  const sort = order ? parseOrder(order) : [];
  if (sort === null) errors.push(`order "${order}": not column.asc or column.desc, comma-separated`);
  const table = p.get("table");
  return {
    view: {
      table: table ? table : null,
      filters,
      sort: sort ?? [],
      limit: parseCount(p.get("limit"), EMPTY_VIEW.limit, 1, "limit", errors),
      offset: parseCount(p.get("offset"), 0, 0, "offset", errors),
    },
    errors,
  };
}
```

- [ ] **Step 5: `request.ts` and `index.ts`**

`src/view/request.ts`:

```ts
import type { Filter, PageRequest, TableInfo } from "../contract";
import { parseFilterValue } from "./values";
import type { StudioView } from "./view";

/**
 * The page request a view asks for, and what it had to leave out. Nothing is dropped silently: a filter that
 * cannot apply would show more rows than the person asked for, so the studio shows `ignored`.
 */
export function toPageRequest(
  view: StudioView,
  table: TableInfo,
  withTotal: boolean,
): { req: PageRequest; ignored: string[] } {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const ignored: string[] = [];
  const filters: Filter[] = [];
  for (const f of view.filters) {
    const col = byName.get(f.column);
    if (!col) {
      ignored.push(`filter on "${f.column}": no such column`);
      continue;
    }
    const p = parseFilterValue(col, f.op, f.text);
    if (!p.ok) {
      ignored.push(`filter on "${f.column}": ${p.error}`);
      continue;
    }
    filters.push(p.value === undefined ? { column: f.column, op: f.op } : { column: f.column, op: f.op, value: p.value });
  }
  const sort = view.sort.filter((s) => {
    if (byName.has(s.column)) return true;
    ignored.push(`sort by "${s.column}": no such column`);
    return false;
  });
  return {
    req: { table: { schema: table.schema, name: table.name }, filters, sort, limit: view.limit, offset: view.offset, withTotal },
    ignored,
  };
}
```

`src/view/index.ts`:

```ts
export { decodeView, encodeView, VIEW_PARAM_KEYS } from "./codec";
export { toPageRequest } from "./request";
export { applyHeaderSort, type HeaderSortAction, sortPosition } from "./sort";
export { NO_VALUE_OPS, type Parsed, parseFilterValue, parseScalar, splitList } from "./values";
export {
  DEFAULT_LIMIT,
  EMPTY_VIEW,
  PAGE_SIZES,
  type StudioView,
  sameView,
  type ViewChange,
  type ViewFilter,
  viewOfTable,
} from "./view";
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/studio && bun test ./test/unit/values.test.ts ./test/unit/codec.test.ts ./test/unit/request.test.ts ./test/unit/sort.test.ts`
Expected: all pass (`6 pass`, `9 pass`, `2 pass`, `2 pass`).

- [ ] **Step 7: Sabotages**

1. `quoteName` returns `name` unconditionally → the round trip with `my.col "x"` goes red.
2. In `splitList`, drop `.trim()` on bare items → `commas split, spaces around items go…` goes red.
3. In `toPageRequest`, skip `ignored.push` for unknown columns → `the resolver lists what it ignored` goes red.
4. In `decodeView`, accept any version → `an unknown version is ignored as a whole` goes red.
Restore each with `cp`.

- [ ] **Step 8: Check and commit**

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): StudioView — typed filter values, a versioned PostgREST-like link codec, the request resolver"
```

---

### Task 3: Per-table preferences and the controllable view hook

**Files:**
- Create: `packages/studio/src/studio/prefs.ts`, `packages/studio/src/studio/use-view.ts`
- Test: `test/unit/prefs.test.ts`, `test/unit/use-view.test.tsx`

**Interfaces:**
- Consumes: `StudioView`, `ViewChange`, `encodeView`, `decodeView`, `sameView`, `EMPTY_VIEW` (Task 2).
- Produces:
  - `interface ColumnLayout { order: string[]; hidden: string[]; widths: Record<string, number> }`, `EMPTY_LAYOUT`,
    `DEFAULT_WIDTH = 200`, `MIN_WIDTH = 60`, `interface LaidOutColumn { column: ColumnInfo; width: number }`
  - `layoutColumns(columns: ColumnInfo[], layout: ColumnLayout): { ordered: ColumnInfo[]; visible: LaidOutColumn[] }`
  - `moveItem<T>(list: readonly T[], from: number, to: number): T[]`
  - `interface Prefs { layout(table: string): ColumnLayout; setLayout(table: string, layout: ColumnLayout): void; lastView(table: string): StudioView | null; setLastView(table: string, view: StudioView): void }`
  - `createPrefs(namespace: string, storage?: Storage | null): Prefs`
  - `useControllableView(controlled: StudioView | undefined, defaultView: StudioView | undefined, onViewChange: ((view: StudioView, change: ViewChange) => void) | undefined): [StudioView, (next: StudioView, change: ViewChange) => void]`

- [ ] **Step 1: Write the failing tests**

`test/unit/prefs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { col } from "../../src/mock";
import { createPrefs, EMPTY_LAYOUT, layoutColumns, moveItem } from "../../src/studio/prefs";
import { EMPTY_VIEW } from "../../src/view";

const columns = ["id", "email", "name"].map((n) => col(n, "text", "text"));

describe("layoutColumns", () => {
  test("saved order first, new columns after in table order; hidden are left out; widths clamp", () => {
    const { ordered, visible } = layoutColumns(columns, {
      order: ["name", "gone", "id"],
      hidden: ["id"],
      widths: { name: 320, email: 10 },
    });
    expect(ordered.map((c) => c.name)).toEqual(["name", "id", "email"]);
    expect(visible.map((v) => [v.column.name, v.width])).toEqual([
      ["name", 320],
      ["email", 60],
    ]);
  });
  test("an empty layout is the table's order at the default width", () => {
    expect(layoutColumns(columns, EMPTY_LAYOUT).visible.map((v) => v.width)).toEqual([200, 200, 200]);
  });
});

test("moveItem", () => {
  expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
});

describe("createPrefs", () => {
  test("layouts and last views round-trip per table and per namespace", () => {
    const a = createPrefs("db-a");
    const b = createPrefs("db-b");
    const layout = { order: ["name"], hidden: ["id"], widths: { name: 300 } };
    a.setLayout("public.users", layout);
    expect(a.layout("public.users")).toEqual(layout);
    expect(b.layout("public.users")).toEqual(EMPTY_LAYOUT);
    expect(a.layout("public.posts")).toEqual(EMPTY_LAYOUT);
    const view = { ...EMPTY_VIEW, table: "public.users", filters: [{ column: "age", op: "gt" as const, text: "3" }] };
    a.setLastView("public.users", view);
    expect(a.lastView("public.users")).toEqual(view);
    expect(a.lastView("public.posts")).toBeNull();
  });
  test("garbage in storage reads as nothing saved", () => {
    localStorage.setItem("dzb-studio:x:layout:t", "{not json");
    localStorage.setItem("dzb-studio:x:view:t", "v=9&table=t");
    const p = createPrefs("x");
    expect(p.layout("t")).toEqual(EMPTY_LAYOUT);
    expect(p.lastView("t")).toBeNull();
  });
  test("no storage (blocked or absent): nothing is saved and nothing throws", () => {
    const p = createPrefs("x", null);
    p.setLayout("t", { order: ["a"], hidden: [], widths: {} });
    expect(p.layout("t")).toEqual(EMPTY_LAYOUT);
  });
});
```

`test/unit/use-view.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useControllableView } from "../../src/studio/use-view";
import { EMPTY_VIEW, type StudioView, type ViewChange } from "../../src/view";

const users: StudioView = { ...EMPTY_VIEW, table: "public.users" };

test("uncontrolled: the hook keeps the view and still reports changes", () => {
  const seen: [StudioView, ViewChange][] = [];
  const { result } = renderHook(() => useControllableView(undefined, EMPTY_VIEW, (v, c) => seen.push([v, c])));
  act(() => result.current[1](users, { history: "push" }));
  expect(result.current[0]).toEqual(users);
  expect(seen).toEqual([[users, { history: "push" }]]);
});

test("controlled: only the host's view counts, and an equal view is not reported", () => {
  const seen: StudioView[] = [];
  const { result, rerender } = renderHook(({ view }) => useControllableView(view, undefined, (v) => seen.push(v)), {
    initialProps: { view: EMPTY_VIEW },
  });
  act(() => result.current[1](users, { history: "push" }));
  expect(result.current[0]).toEqual(EMPTY_VIEW);
  rerender({ view: users });
  act(() => result.current[1]({ ...users }, { history: "replace" }));
  expect(seen).toEqual([users]);
});
```

Run: `cd packages/studio && bun test ./test/unit/prefs.test.ts ./test/unit/use-view.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 2: `prefs.ts`**

```ts
import type { ColumnInfo } from "../contract";
import { decodeView, encodeView, type StudioView } from "../view";

export interface ColumnLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

export const EMPTY_LAYOUT: ColumnLayout = { order: [], hidden: [], widths: {} };
export const DEFAULT_WIDTH = 200;
export const MIN_WIDTH = 60;

export interface LaidOutColumn {
  column: ColumnInfo;
  width: number;
}

/** Display order: the saved order for columns that still exist, then new columns in table order. */
export function layoutColumns(
  columns: ColumnInfo[],
  layout: ColumnLayout,
): { ordered: ColumnInfo[]; visible: LaidOutColumn[] } {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const saved = layout.order.filter((n) => byName.has(n));
  const names = [...saved, ...columns.map((c) => c.name).filter((n) => !saved.includes(n))];
  const ordered = names.map((n) => byName.get(n)).filter((c): c is ColumnInfo => c !== undefined);
  const hidden = new Set(layout.hidden);
  const visible = ordered
    .filter((c) => !hidden.has(c.name))
    .map((column) => ({ column, width: Math.max(MIN_WIDTH, layout.widths[column.name] ?? DEFAULT_WIDTH) }));
  return { ordered, visible };
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item === undefined) return out;
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

export interface Prefs {
  layout(table: string): ColumnLayout;
  setLayout(table: string, layout: ColumnLayout): void;
  lastView(table: string): StudioView | null;
  setLastView(table: string, view: StudioView): void;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked (sandboxed iframe, privacy settings)
  }
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function asLayout(v: unknown): ColumnLayout | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const order = o["order"];
  const hidden = o["hidden"];
  const widths = o["widths"];
  if (!isStrings(order) || !isStrings(hidden) || typeof widths !== "object" || widths === null) return null;
  const clean: Record<string, number> = {};
  for (const [k, x] of Object.entries(widths)) if (typeof x === "number" && Number.isFinite(x)) clean[k] = x;
  return { order, hidden, widths: clean };
}

/** Per-table layouts and last views in localStorage. A convenience: unreadable or blocked storage is "nothing saved". */
export function createPrefs(namespace: string, storage: Storage | null = browserStorage()): Prefs {
  const key = (kind: string, table: string) => `dzb-studio:${namespace}:${kind}:${table}`;
  const read = (k: string): string | null => {
    try {
      return storage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  const write = (k: string, value: string) => {
    try {
      storage?.setItem(k, value);
    } catch {
      // quota or blocked storage: the layout still applies for this session
    }
  };
  return {
    layout(table) {
      const raw = read(key("layout", table));
      if (raw === null) return EMPTY_LAYOUT;
      try {
        return asLayout(JSON.parse(raw)) ?? EMPTY_LAYOUT;
      } catch {
        return EMPTY_LAYOUT;
      }
    },
    setLayout: (table, layout) => write(key("layout", table), JSON.stringify(layout)),
    lastView(table) {
      const raw = read(key("view", table));
      if (raw === null) return null;
      const { view, errors } = decodeView(raw);
      return errors.length === 0 && view.table === table ? view : null;
    },
    setLastView: (table, view) => write(key("view", table), encodeView(view)),
  };
}
```

- [ ] **Step 3: `use-view.ts`**

```ts
import { useCallback, useState } from "react";
import { EMPTY_VIEW, type StudioView, sameView, type ViewChange } from "../view";

/**
 * The view, controlled by a host (`controlled` + `onViewChange`, e.g. bound to its URL) or kept here. A change equal
 * to the current view is not reported, so a host that re-renders with an equal object cannot loop.
 */
export function useControllableView(
  controlled: StudioView | undefined,
  defaultView: StudioView | undefined,
  onViewChange: ((view: StudioView, change: ViewChange) => void) | undefined,
): [StudioView, (next: StudioView, change: ViewChange) => void] {
  const [inner, setInner] = useState<StudioView>(defaultView ?? EMPTY_VIEW);
  const current = controlled ?? inner;
  const setView = useCallback(
    (next: StudioView, change: ViewChange) => {
      if (sameView(next, current)) return;
      if (controlled === undefined) setInner(next);
      onViewChange?.(next, change);
    },
    [controlled, current, onViewChange],
  );
  return [current, setView];
}
```

- [ ] **Step 4: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test/unit/prefs.test.ts ./test/unit/use-view.test.tsx` → `6 pass` + `2 pass`.

Sabotages (restore with `cp`): (1) `layoutColumns` ignores `layout.order` → first test red; (2) `lastView` drops
`errors.length === 0 &&` → `garbage in storage reads as nothing saved` red (the `v=9` view is returned);
(3) `setView` drops the `sameView` guard → `controlled: … an equal view is not reported` red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): per-table layout and last-view preferences, and the controllable view hook"
```

---

### Task 4: The filter bar

**Files:**
- Create: `packages/studio/src/studio/filter-bar.tsx`
- Test: `test/unit/filter-bar.test.tsx`

**Interfaces:**
- Consumes: `ViewFilter`, `NO_VALUE_OPS`, `parseFilterValue` (Task 2).
- Produces: `FilterBar({ table, applied, onApply }: { table: TableInfo; applied: ViewFilter[]; onApply(filters: ViewFilter[]): void })`,
  `OPERATORS: { op: FilterOp; label: string }[]`. DOM: each row is `role="group"` named `Filter <n>` with controls
  labelled `Column`, `Operator`, `Value` (a `<select>` for boolean/enum with eq/neq, otherwise an input; none for
  is null / is not null) and a `Remove filter <n>` button; footer buttons `Add filter`, `Apply`, `Clear filters`.

- [ ] **Step 1: Write the failing test**

`test/unit/filter-bar.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TableInfo } from "../../src/contract";
import { demoDataset } from "../../src/mock";
import { FilterBar } from "../../src/studio/filter-bar";
import type { ViewFilter } from "../../src/view";

const users = demoDataset(1).tables[0]?.info as TableInfo;

function setup(applied: ViewFilter[] = []) {
  const calls: ViewFilter[][] = [];
  const view = render(<FilterBar table={users} applied={applied} onApply={(f) => calls.push(f)} />);
  const row = (n: number) => within(screen.getByRole("group", { name: `Filter ${n}` }));
  const set = (n: number, label: string, value: string) => fireEvent.change(row(n).getByLabelText(label), { target: { value } });
  return { calls, view, row, set };
}

describe("<FilterBar>", () => {
  test("typing does not filter; Apply and Enter do", () => {
    const { calls, row, set } = setup();
    set(1, "Column", "name");
    set(1, "Value", "User 1");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.keyDown(row(1).getByLabelText("Value"), { key: "Enter" });
    expect(calls).toEqual([
      [{ column: "name", op: "eq", text: "User 1" }],
      [{ column: "name", op: "eq", text: "User 1" }],
    ]);
  });

  test("an invalid value blocks Apply and says why", () => {
    const { calls, row, set } = setup();
    set(1, "Column", "age");
    set(1, "Value", "old");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    expect(row(1).getByText('"old" is not an integer')).toBeTruthy();
    expect(row(1).getByLabelText("Value").getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(row(1).getByLabelText("Value"), { key: "Enter" });
    expect(calls).toEqual([]);
    set(1, "Value", "30");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false);
  });

  test("boolean and enum offer their values; is null asks for none", () => {
    const { calls, row, set } = setup();
    set(1, "Column", "active");
    expect(row(1).getByLabelText("Value").tagName).toBe("SELECT");
    set(1, "Column", "role");
    const options = [...row(1).getByLabelText("Value").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["choose…", "admin", "editor", "viewer"]);
    set(1, "Operator", "isNull");
    expect(row(1).queryByLabelText("Value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(calls).toEqual([[{ column: "role", op: "isNull", text: "" }]]);
  });

  test("in takes a typed list; a bad item is named", () => {
    const { row, set } = setup();
    set(1, "Column", "role");
    set(1, "Operator", "in");
    set(1, "Value", "admin, nope");
    expect(row(1).getByText(/"nope" is not one of/)).toBeTruthy();
  });

  test("blank rows are not applied; rows can be removed; Clear filters applies nothing", () => {
    const { calls, row, set } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    set(2, "Column", "email");
    set(2, "Operator", "ilike");
    set(2, "Value", "%@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(calls.at(-1)).toEqual([{ column: "email", op: "ilike", text: "%@example.com" }]);
    fireEvent.click(row(1).getByRole("button", { name: "Remove filter 1" }));
    expect(screen.queryByRole("group", { name: "Filter 2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(calls.at(-1)).toEqual([]);
  });

  test("what is applied changing from outside (a link, Back) replaces the drafts", () => {
    const { view, row } = setup([{ column: "name", op: "eq", text: "a" }]);
    view.rerender(<FilterBar table={users} applied={[{ column: "email", op: "ilike", text: "b%" }]} onApply={() => {}} />);
    expect((row(1).getByLabelText("Value") as HTMLInputElement).value).toBe("b%");
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/filter-bar.test.tsx` → FAIL, module missing.

- [ ] **Step 2: The component**

`src/studio/filter-bar.tsx`:

```tsx
import { Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ColumnInfo, FilterOp, TableInfo } from "../contract";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NO_VALUE_OPS, parseFilterValue, type ViewFilter } from "../view";

export const OPERATORS: { op: FilterOp; label: string }[] = [
  { op: "eq", label: "equals" },
  { op: "neq", label: "not equals" },
  { op: "gt", label: "greater" },
  { op: "gte", label: "greater or equals" },
  { op: "lt", label: "less" },
  { op: "lte", label: "less or equals" },
  { op: "like", label: "like" },
  { op: "ilike", label: "ilike" },
  { op: "notLike", label: "not like" },
  { op: "in", label: "in" },
  { op: "isNull", label: "is null" },
  { op: "isNotNull", label: "is not null" },
];

const SELECT =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30";

interface Draft extends ViewFilter {
  key: number;
}

let nextKey = 0;
const draft = (f: ViewFilter): Draft => ({ ...f, key: nextKey++ });
const blank = (table: TableInfo): Draft => draft({ column: table.columns[0]?.name ?? "", op: "eq", text: "" });
const draftsOf = (table: TableInfo, filters: ViewFilter[]): Draft[] =>
  filters.length > 0 ? filters.map(draft) : [blank(table)];
const isBlank = (f: ViewFilter) => !NO_VALUE_OPS.includes(f.op) && f.text.trim() === "";
const plain = ({ column, op, text }: Draft): ViewFilter => ({ column, op, text });

/** Values a column offers as a list instead of free text. */
function choicesFor(col: ColumnInfo | undefined, op: FilterOp): string[] | null {
  if (!col || (op !== "eq" && op !== "neq")) return null;
  if (col.kind === "boolean") return ["true", "false"];
  if (col.kind === "enum") return col.enumValues ?? [];
  return null;
}

export interface FilterBarProps {
  table: TableInfo;
  applied: ViewFilter[];
  onApply(filters: ViewFilter[]): void;
}

/** Filters are drafts until applied (Apply or Enter), as in Drizzle Studio: typing never queries. */
export function FilterBar({ table, applied, onApply }: FilterBarProps) {
  const id = useId();
  const appliedKey = JSON.stringify(applied);
  const [drafts, setDrafts] = useState<Draft[]>(() => draftsOf(table, applied));
  // What is applied changed from outside the bar (a link, Back, another table): show that instead.
  useEffect(() => {
    setDrafts(draftsOf(table, JSON.parse(appliedKey) as ViewFilter[]));
  }, [appliedKey, table]);

  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const errors = drafts.map((d) => {
    const col = byName.get(d.column);
    if (!col) return `no column "${d.column}"`;
    if (isBlank(d)) return null;
    const p = parseFilterValue(col, d.op, d.text);
    return p.ok ? null : p.error;
  });
  const canApply = errors.every((e) => e === null);
  const apply = () => {
    if (canApply) onApply(drafts.filter((d) => !isBlank(d)).map(plain));
  };
  const update = (key: number, patch: Partial<ViewFilter>) =>
    setDrafts(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const remove = (key: number) => {
    const rest = drafts.filter((d) => d.key !== key);
    setDrafts(rest.length > 0 ? rest : [blank(table)]);
  };

  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2">
      {drafts.map((d, i) => {
        const col = byName.get(d.column);
        const choices = choicesFor(col, d.op);
        const error = errors[i] ?? null;
        const errorId = `${id}-${d.key}-error`;
        return (
          <div key={d.key} role="group" aria-label={`Filter ${i + 1}`} className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove filter ${i + 1}`} onClick={() => remove(d.key)}>
              <X />
            </Button>
            <span className="w-10 text-xs text-muted-foreground">{i === 0 ? "where" : "and"}</span>
            <select aria-label="Column" className={SELECT} value={d.column} onChange={(e) => update(d.key, { column: e.target.value })}>
              {table.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Operator"
              className={SELECT}
              value={d.op}
              onChange={(e) => update(d.key, { op: e.target.value as FilterOp })}
            >
              {OPERATORS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {NO_VALUE_OPS.includes(d.op) ? null : choices ? (
              <select
                aria-label="Value"
                className={SELECT}
                value={d.text}
                aria-invalid={error !== null || undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => update(d.key, { text: e.target.value })}
              >
                <option value="">choose…</option>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                aria-label="Value"
                className="h-8 w-56"
                value={d.text}
                placeholder={d.op === "in" ? 'a, b, "c,d"' : "value"}
                aria-invalid={error !== null || undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => update(d.key, { text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") apply();
                }}
              />
            )}
            {error && (
              <span id={errorId} className="text-xs text-destructive">
                {error}
              </span>
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={() => setDrafts([...drafts, blank(table)])}>
          <Plus />
          Add filter
        </Button>
        <Button type="button" size="sm" disabled={!canApply} onClick={apply}>
          Apply
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setDrafts([blank(table)]);
            onApply([]);
          }}
        >
          Clear filters
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test/unit/filter-bar.test.tsx` → `6 pass`.

Sabotages (restore with `cp`): (1) call `onApply` inside `update` → `typing does not filter` red; (2) make
`canApply` always true → `an invalid value blocks Apply` red; (3) drop the `useEffect` → `what is applied changing
from outside` red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): filter bar — drafts until applied, typed values, lists, is null"
```

---

### Task 5: Sort panel, columns panel, and the popover/menu primitives

**Files:**
- Create: `packages/studio/src/ui/popover.tsx`, `src/ui/dropdown-menu.tsx`, `src/studio/sort-panel.tsx`,
  `src/studio/columns-panel.tsx`
- Test: `test/unit/sort-panel.test.tsx`, `test/unit/columns-panel.test.tsx`

**Interfaces:**
- Consumes: `ColumnLayout`, `moveItem` (Task 3).
- Produces: `Popover, PopoverTrigger, PopoverContent`; `DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator`; `SortPanel({ columns: ColumnInfo[]; sort: Sort[]; onChange(sort: Sort[]): void })`;
  `ColumnsPanel({ columns: ColumnInfo[] /* display order */; layout: ColumnLayout; onChange(layout: ColumnLayout): void })`.

- [ ] **Step 1: Write the failing tests**

`test/unit/sort-panel.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Sort } from "../../src/contract";
import { col } from "../../src/mock";
import { SortPanel } from "../../src/studio/sort-panel";

const columns = ["id", "email", "age"].map((n) => col(n, "text", "text"));

function setup(sort: Sort[]) {
  const calls: Sort[][] = [];
  render(<SortPanel columns={columns} sort={sort} onChange={(s) => calls.push(s)} />);
  return calls;
}

test("columns not yet sorted are offered, searchable; picking one appends it ascending", () => {
  const calls = setup([{ column: "id", dir: "asc" }]);
  const offered = within(screen.getByRole("list", { name: "Columns" }));
  expect(offered.getAllByRole("button").map((b) => b.textContent)).toEqual(["email", "age"]);
  fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "ag" } });
  expect(offered.getAllByRole("button").map((b) => b.textContent)).toEqual(["age"]);
  fireEvent.click(offered.getByRole("button", { name: "age" }));
  expect(calls).toEqual([
    [
      { column: "id", dir: "asc" },
      { column: "age", dir: "asc" },
    ],
  ]);
});

test("an active sort flips direction, is removed, and all are cleared", () => {
  const calls = setup([
    { column: "id", dir: "asc" },
    { column: "age", dir: "desc" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Direction of age: desc" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove sort by id" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear sorting" }));
  expect(calls).toEqual([
    [
      { column: "id", dir: "asc" },
      { column: "age", dir: "asc" },
    ],
    [{ column: "age", dir: "desc" }],
    [],
  ]);
});
```

`test/unit/columns-panel.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { col } from "../../src/mock";
import { ColumnsPanel } from "../../src/studio/columns-panel";
import { type ColumnLayout, EMPTY_LAYOUT } from "../../src/studio/prefs";

const columns = ["id", "email", "name"].map((n) => col(n, "text", "text"));

function setup(layout: ColumnLayout = EMPTY_LAYOUT) {
  const calls: ColumnLayout[] = [];
  render(<ColumnsPanel columns={columns} layout={layout} onChange={(l) => calls.push(l)} />);
  const item = (name: string) => within(screen.getByRole("list", { name: "Columns" })).getByRole("button", { name });
  return { calls, item };
}

test("clicking a column toggles it; its state is announced", () => {
  const { calls, item } = setup({ ...EMPTY_LAYOUT, hidden: ["name"] });
  expect(item("email").getAttribute("aria-pressed")).toBe("true");
  expect(item("name").getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(item("email"));
  fireEvent.click(item("name"));
  expect(calls.map((l) => l.hidden)).toEqual([["name", "email"], []]);
});

test("hide all, then show all", () => {
  const first = setup();
  fireEvent.click(screen.getByRole("button", { name: "Hide all columns" }));
  expect(first.calls.at(-1)?.hidden).toEqual(["id", "email", "name"]);
});

test("Alt+Arrow moves a column; so does dropping one onto another", () => {
  const { calls, item } = setup();
  fireEvent.keyDown(item("name"), { key: "ArrowUp", altKey: true });
  expect(calls.at(-1)?.order).toEqual(["id", "name", "email"]);
  fireEvent.dragStart(item("id").closest("li") as HTMLElement);
  fireEvent.drop(item("name").closest("li") as HTMLElement);
  expect(calls.at(-1)?.order).toEqual(["email", "name", "id"]);
});

test("search narrows the list", () => {
  setup();
  fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "em" } });
  const names = within(screen.getByRole("list", { name: "Columns" }))
    .getAllByRole("button")
    .map((b) => b.textContent);
  expect(names).toEqual(["email"]);
});
```

Run: `cd packages/studio && bun test ./test/unit/sort-panel.test.tsx ./test/unit/columns-panel.test.tsx` → FAIL, modules missing.

- [ ] **Step 2: The primitives (vendored shadcn base-nova, `cn` from `../lib/cn`)**

`src/ui/popover.tsx`:

```tsx
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "../lib/cn";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
```

`src/ui/dropdown-menu.tsx`:

```tsx
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "../lib/cn";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
  );
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger };
```

- [ ] **Step 3: The panels**

`src/studio/sort-panel.tsx`:

```tsx
import { X } from "lucide-react";
import { useState } from "react";
import type { ColumnInfo, Sort } from "../contract";
import { Input } from "../ui/input";

export interface SortPanelProps {
  columns: ColumnInfo[];
  sort: Sort[];
  onChange(sort: Sort[]): void;
}

const ROW = "flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted";

export function SortPanel({ columns, sort, onChange }: SortPanelProps) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const offered = columns.filter((c) => !sort.some((s) => s.column === c.name) && c.name.toLowerCase().includes(needle));
  return (
    <div className="flex w-[28rem] gap-2 text-sm">
      <div className="flex w-1/2 flex-col gap-1.5 border-r pr-2">
        <Input aria-label="Search columns" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <ul aria-label="Columns" className="max-h-64 overflow-auto">
          {offered.map((c) => (
            <li key={c.name}>
              <button type="button" className={ROW} onClick={() => onChange([...sort, { column: c.name, dir: "asc" }])}>
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex w-1/2 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Sort by</span>
          {sort.length > 0 && (
            <button type="button" className="text-xs underline underline-offset-2" onClick={() => onChange([])}>
              Clear sorting
            </button>
          )}
        </div>
        {sort.length === 0 ? (
          <p className="text-xs text-muted-foreground">Rows follow the primary key.</p>
        ) : (
          <ol aria-label="Active sorts" className="flex flex-col gap-0.5">
            {sort.map((s, i) => (
              <li key={s.column} className="flex items-center gap-1.5 rounded-md bg-muted/60 px-1.5 py-1">
                <span className="w-3 text-xs text-muted-foreground">{i + 1}</span>
                <span className="flex-1 truncate">{s.column}</span>
                <button
                  type="button"
                  aria-label={`Direction of ${s.column}: ${s.dir}`}
                  className="text-xs uppercase underline underline-offset-2"
                  onClick={() =>
                    onChange(sort.map((x) => (x.column === s.column ? { ...x, dir: x.dir === "asc" ? "desc" : "asc" } : x)))
                  }
                >
                  {s.dir}
                </button>
                <button
                  type="button"
                  aria-label={`Remove sort by ${s.column}`}
                  onClick={() => onChange(sort.filter((x) => x.column !== s.column))}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
```

`src/studio/columns-panel.tsx`:

```tsx
import { Eye, EyeOff, GripVertical } from "lucide-react";
import { useState } from "react";
import type { ColumnInfo } from "../contract";
import { Input } from "../ui/input";
import { type ColumnLayout, moveItem } from "./prefs";

export interface ColumnsPanelProps {
  /** In display order. */
  columns: ColumnInfo[];
  layout: ColumnLayout;
  onChange(layout: ColumnLayout): void;
}

export function ColumnsPanel({ columns, layout, onChange }: ColumnsPanelProps) {
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const names = columns.map((c) => c.name);
  const hidden = new Set(layout.hidden);
  const allHidden = names.every((n) => hidden.has(n));
  const needle = search.trim().toLowerCase();
  const shown = columns.filter((c) => c.name.toLowerCase().includes(needle));
  const toggle = (name: string) =>
    onChange({ ...layout, hidden: hidden.has(name) ? layout.hidden.filter((h) => h !== name) : [...layout.hidden, name] });
  const move = (name: string, to: number) => onChange({ ...layout, order: moveItem(names, names.indexOf(name), to) });

  return (
    <div className="flex w-64 flex-col gap-1.5 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Columns</span>
        <button
          type="button"
          aria-label={allHidden ? "Show all columns" : "Hide all columns"}
          className="rounded p-1 hover:bg-muted"
          onClick={() => onChange({ ...layout, hidden: allHidden ? [] : names })}
        >
          {allHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </button>
      </div>
      <Input aria-label="Search columns" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <p className="text-[11px] text-muted-foreground">Drag, or Alt+↑/↓, to reorder.</p>
      <ul aria-label="Columns" className="max-h-72 overflow-auto">
        {shown.map((c) => {
          const at = names.indexOf(c.name);
          return (
            <li
              key={c.name}
              draggable
              onDragStart={() => setDragging(c.name)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging && dragging !== c.name) move(dragging, at);
                setDragging(null);
              }}
            >
              <button
                type="button"
                aria-pressed={!hidden.has(c.name)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted aria-[pressed=false]:text-muted-foreground"
                onClick={() => toggle(c.name)}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  move(c.name, e.key === "ArrowUp" ? Math.max(0, at - 1) : at + 1);
                }}
              >
                {hidden.has(c.name) ? (
                  <EyeOff aria-hidden="true" className="size-3.5" />
                ) : (
                  <Eye aria-hidden="true" className="size-3.5" />
                )}
                <span className="flex-1 truncate">{c.name}</span>
                <GripVertical aria-hidden="true" className="size-3.5 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

Note for the columns test: the button's accessible name is its text (`email`) because the icons are
`aria-hidden`; `getByRole("button", { name })` in the test relies on that.

- [ ] **Step 4: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test/unit/sort-panel.test.tsx ./test/unit/columns-panel.test.tsx` → `2 pass` + `4 pass`.

Sabotages (restore with `cp`): (1) the direction toggle keeps `x.dir` → sort test 2 red; (2) `onDrop` ignores
`dragging` → columns test 3 red; (3) `allHidden` inverted → `hide all` red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): sort panel, columns panel (toggle, search, drag and Alt+Arrow reorder), popover and menu"
```

---

### Task 6: The grid — layout, header sort menu, resizing

**Files:**
- Create: `packages/studio/src/grid/header-cell.tsx`, `src/grid/resize-handle.tsx`
- Modify (rewrite): `packages/studio/src/grid/data-grid.tsx`
- Modify: `test/unit/data-grid.test.tsx`

**Interfaces:**
- Consumes: `LaidOutColumn`, `MIN_WIDTH` (Task 3); `HeaderSortAction`, `sortPosition` (Task 2); dropdown menu (Task 5).
- Produces: `DataGrid({ table, page, changed, columns, sort, onSort, onResize })` with
  `columns: LaidOutColumn[]` (visible, in order), `sort: Sort[]`, `onSort(column: string, action: HeaderSortAction): void`,
  `onResize(column: string, width: number, commit: boolean): void`. Header cells carry `aria-sort`; each has a
  `separator` named `Resize <column>` (drag, or ←/→ by 16 px).

- [ ] **Step 1: Update the grid test first**

Replace `test/unit/data-grid.test.tsx` with:

```tsx
import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Page, Sort, TableInfo } from "../../src/contract";
import { DataGrid, type DataGridProps } from "../../src/grid/data-grid";
import { col } from "../../src/mock";
import { cellKey, rowIdOf } from "../../src/studio/format";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const table: TableInfo = {
  schema: "public",
  name: "t",
  kind: "table",
  columns: [col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }), col("label", "text", "varchar(255)")],
  primaryKey: ["id"],
  estimatedRows: null,
};
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, label: i === 1 ? null : `row ${i + 1}` }));
const page: Page = { rows, total: 1000, hasMore: false, revision: 3 };

function grid(over: Partial<DataGridProps> = {}) {
  const calls: unknown[][] = [];
  const props: DataGridProps = {
    table,
    page,
    changed: new Set(),
    columns: layoutColumns(table.columns, EMPTY_LAYOUT).visible,
    sort: [],
    onSort: (...a) => calls.push(["sort", ...a]),
    onResize: (...a) => calls.push(["resize", ...a]),
    ...over,
  };
  render(<DataGrid {...props} />);
  return calls;
}

test("headers show the column name and its Postgres type", () => {
  grid();
  const header = screen.getAllByRole("columnheader")[1];
  expect(header?.textContent).toContain("label");
  expect(header?.textContent).toContain("varchar(255)");
});

test("NULL renders muted, as NULL", () => {
  grid();
  const cell = screen.getAllByRole("gridcell").find((c) => c.textContent === "NULL");
  expect(cell).toBeTruthy();
  expect(cell?.hasAttribute("data-null")).toBe(true);
});

test("only a window of the rows is in the DOM", () => {
  grid();
  expect(screen.queryByText("row 1")).toBeTruthy();
  expect(screen.queryByText("row 1000")).toBeNull();
  expect(screen.getAllByRole("row").length).toBeLessThan(100);
});

test("changed cells carry data-changed, the others do not", () => {
  grid({ changed: new Set([cellKey(rowIdOf(["id"], { id: 3 }, 2), "label")]) });
  const cellOf = (text: string) => screen.getByText(text).closest("[role=gridcell]");
  expect(cellOf("row 3")?.getAttribute("data-changed")).toBe("true");
  expect(cellOf("row 4")?.hasAttribute("data-changed")).toBe(false);
});

test("only the laid-out columns render, in their order and width", () => {
  grid({ columns: layoutColumns(table.columns, { order: ["label", "id"], hidden: ["id"], widths: { label: 333 } }).visible });
  const headers = screen.getAllByRole("columnheader");
  expect(headers.map((h) => h.textContent?.startsWith("label"))).toEqual([true]);
  expect((headers[0] as HTMLElement).style.width).toBe("333px");
});

test("a sorted column says so, with its position when there are several", () => {
  const sort: Sort[] = [
    { column: "label", dir: "desc" },
    { column: "id", dir: "asc" },
  ];
  grid({ sort });
  const [id, label] = screen.getAllByRole("columnheader");
  expect(label?.getAttribute("aria-sort")).toBe("descending");
  expect(id?.getAttribute("aria-sort")).toBe("ascending");
  expect(label?.textContent).toContain("1");
});

test("dragging a header's edge resizes it (live, then committed); arrows do too", () => {
  const calls = grid();
  const handle = screen.getByRole("separator", { name: "Resize label" });
  fireEvent.pointerDown(handle, { clientX: 100 });
  fireEvent.pointerMove(window, { clientX: 150 });
  fireEvent.pointerUp(window, { clientX: 160 });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(calls).toEqual([
    ["resize", "label", 250, false],
    ["resize", "label", 260, true],
    ["resize", "label", 184, true],
  ]);
});

test("no visible column says so instead of an empty grid", () => {
  grid({ columns: [] });
  expect(screen.getByText(/All columns are hidden/)).toBeTruthy();
});
```

Run: `cd packages/studio && bun test ./test/unit/data-grid.test.tsx` → FAIL (typecheck-free: `columns` ignored,
new tests red).

- [ ] **Step 2: Resize handle and header cell**

`src/grid/resize-handle.tsx`:

```tsx
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { MIN_WIDTH } from "../studio/prefs";

export interface ResizeHandleProps {
  name: string;
  width: number;
  /** `commit` is false while dragging (render only) and true when the width should be saved. */
  onResize(width: number, commit: boolean): void;
}

const STEP = 16;

export function ResizeHandle({ name, width, onResize }: ResizeHandleProps) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const at = (x: number) => Math.max(MIN_WIDTH, Math.round(width + x - startX));
    const move = (ev: PointerEvent) => onResize(at(ev.clientX), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResize(at(ev.clientX), true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onResize(Math.max(MIN_WIDTH, width + (e.key === "ArrowRight" ? STEP : -STEP)), true);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator has no native element
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${name}`}
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none outline-none hover:bg-ring/60 focus-visible:bg-ring"
    />
  );
}
```

`src/grid/header-cell.tsx`:

```tsx
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ColumnInfo } from "../contract";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import type { HeaderSortAction } from "../view";
import { ResizeHandle } from "./resize-handle";

export interface HeaderCellProps {
  index: number;
  column: ColumnInfo;
  width: number;
  sorted: { dir: "asc" | "desc"; position: number } | null;
  onSort(action: HeaderSortAction): void;
  onResize(width: number, commit: boolean): void;
}

export function HeaderCell({ index, column, width, sorted, onSort, onResize }: HeaderCellProps) {
  const Arrow = sorted?.dir === "desc" ? ArrowDown : ArrowUp;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      role="columnheader"
      tabIndex={-1}
      aria-colindex={index + 1}
      aria-sort={sorted ? (sorted.dir === "asc" ? "ascending" : "descending") : undefined}
      className="relative flex h-8 shrink-0 items-center border-r"
      style={{ width }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted">
          <span className="truncate font-semibold">{column.name}</span>
          <span className="truncate text-[11px] text-muted-foreground">{column.pgType}</span>
          {sorted && (
            <span aria-hidden="true" className="ml-auto flex shrink-0 items-center text-muted-foreground">
              <Arrow className="size-3.5" />
              {sorted.position > 0 && <span className="text-[10px]">{sorted.position}</span>}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => onSort("asc")}>Sort ascending</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSort("desc")}>Sort descending</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSort("add")}>Add to sort</DropdownMenuItem>
          {sorted && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onSort("clear")}>Clear sort</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ResizeHandle name={column.name} width={width} onResize={onResize} />
    </div>
  );
}
```

Note: the `sorted` test expects the position digit inside the header's text; `aria-hidden` hides it from the
accessible name but not from `textContent`.

- [ ] **Step 3: The grid**

`src/grid/data-grid.tsx`:

```tsx
import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { CellValue, Page, Row, Sort, TableInfo } from "../contract";
import { cellKey, formatCell, rowIdOf } from "../studio/format";
import type { LaidOutColumn } from "../studio/prefs";
import { type HeaderSortAction, sortPosition } from "../view";
import { HeaderCell } from "./header-cell";

const ROW_HEIGHT = 32;
const features = tableFeatures({});

export interface DataGridProps {
  table: TableInfo;
  page: Page;
  changed: ReadonlySet<string>;
  /** Visible columns in display order, with widths (see layoutColumns). */
  columns: LaidOutColumn[];
  sort: Sort[];
  onSort(column: string, action: HeaderSortAction): void;
  onResize(column: string, width: number, commit: boolean): void;
}

export function DataGrid({ table, page, changed, columns, sort, onSort, onResize }: DataGridProps) {
  const defs = useMemo<ColumnDef<typeof features, Row, unknown>[]>(
    () => columns.map(({ column }) => ({ id: column.name, accessorFn: (r: Row) => r[column.name] ?? null, header: column.name })),
    [columns],
  );
  const grid = useTable({ features, columns: defs, data: page.rows, getRowId: (r, i) => rowIdOf(table.primaryKey, r, i) });
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = grid.getRowModel().rows;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const width = columns.reduce((w, c) => w + c.width, 0);

  if (columns.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">All columns are hidden. Show some from Columns.</p>;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      className="relative h-full overflow-auto font-mono text-[13px] outline-none"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot */}
      <div role="row" tabIndex={-1} aria-rowindex={1} className="sticky top-0 z-10 flex border-b bg-background" style={{ width }}>
        {columns.map((c, i) => (
          <HeaderCell
            key={c.column.name}
            index={i}
            column={c.column}
            width={c.width}
            sorted={sortPosition(sort, c.column.name)}
            onSort={(action) => onSort(c.column.name, action)}
            onResize={(w, commit) => onResize(c.column.name, w, commit)}
          />
        ))}
      </div>
      <div className="relative" style={{ height: virtual.getTotalSize(), width }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
            <div
              key={row.id}
              role="row"
              tabIndex={-1}
              aria-rowindex={item.index + 2}
              className="absolute left-0 flex border-b hover:bg-muted/60"
              style={{ height: ROW_HEIGHT, width, transform: `translateY(${item.start}px)` }}
            >
              {row.getAllCells().map((cell, i) => {
                const value = cell.getValue() as CellValue;
                const isChanged = changed.has(cellKey(row.id, cell.column.id));
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
                  <div
                    // A changed cell remounts on each revision so its flash animation restarts.
                    key={isChanged ? `${cell.id}:${page.revision}` : cell.id}
                    role="gridcell"
                    tabIndex={-1}
                    aria-colindex={i + 1}
                    data-null={value === null || undefined}
                    data-changed={isChanged || undefined}
                    className="flex shrink-0 items-center overflow-hidden border-r px-2 whitespace-nowrap data-changed:animate-cell-flash data-null:text-muted-foreground"
                    style={{ width: columns[i]?.width }}
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

(Hooks run before the early `return` for no columns, as the rules of hooks require.)

- [ ] **Step 4: Run, sabotage, commit**

Keep `studio.tsx` compiling until Task 7 rewrites it: pass the new props with today's behaviour —

```tsx
      <DataGrid
        table={table}
        page={page}
        changed={changed}
        columns={layoutColumns(table.columns, EMPTY_LAYOUT).visible}
        sort={[]}
        onSort={() => {}}
        onResize={() => {}}
      />
```

with `import { EMPTY_LAYOUT, layoutColumns } from "./prefs";`.

Run: `cd packages/studio && bun test ./test/unit/data-grid.test.tsx` → `8 pass`; `bun test ./test` all green.

Sabotages (restore with `cp`): (1) `ResizeHandle` passes `commit: true` on move → resize test red; (2) `aria-sort`
always `ascending` → sorted test red; (3) render `table.columns` instead of `columns` → layout test red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): grid takes laid-out columns; header sort menu with aria-sort; drag and keyboard resize"
```

---

### Task 7: `<Studio>` on the view — toolbar, filters, sort, columns, page size, count, notices

**Files:**
- Modify (rewrite): `packages/studio/src/studio/studio.tsx`, `src/studio/pager.tsx`
- Modify: `packages/studio/src/index.ts`, `test/unit/studio.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: `Studio(props: StudioProps)` with
  `interface StudioProps { dataSource: StudioDataSource; view?: StudioView; defaultView?: StudioView; onViewChange?(view: StudioView, change: ViewChange): void; notices?: string[]; storageKey?: string }`.
  `src/index.ts` also exports `StudioView`, `ViewFilter`, `ViewChange`, `EMPTY_VIEW`, `encodeView`, `decodeView`,
  `VIEW_PARAM_KEYS` (a host needs them to bind the URL). DOM: toolbar buttons named `Filters`, `Sort`, `Columns`
  (each followed by its count when active); `Count rows`; select `Rows per page`; notices in `role="status"`.

- [ ] **Step 1: The failing Studio tests**

In `test/unit/studio.test.tsx`:

a) Imports and `setup`:

```tsx
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { EMPTY_VIEW, Studio, type StudioView, type ViewChange } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";
import { createPrefs } from "../../src/studio/prefs";

const USERS = { schema: "public", name: "users" };
const FIRST_USER_ID = demoDataset(1).tables[0]?.rows[0]?.["id"] ?? null;

function sources() {
  const log = createMemoryLog();
  return {
    ds: createMockDataSource({ dataset: demoDataset(1), log }),
    otherTab: createMockDataSource({ dataset: demoDataset(1), log }),
  };
}

function setup(limit?: number) {
  const { ds, otherTab } = sources();
  render(<Studio dataSource={ds} defaultView={{ ...EMPTY_VIEW, limit: limit ?? EMPTY_VIEW.limit }} />);
  return { ds, otherTab };
}
```

b) Keep every existing test body unchanged. Then add, inside the `describe`:

```tsx
  test("filters narrow the rows; the pager says 50+ until counted", async () => {
    setup();
    await openTable("users");
    await screen.findByText("1 - 50 of 3000");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const row = within(screen.getByRole("group", { name: "Filter 1" }));
    fireEvent.change(row.getByLabelText("Column"), { target: { value: "role" } });
    fireEvent.change(row.getByLabelText("Value"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("1 - 50 of 50+")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Count rows" }));
    expect(await screen.findByText("1 - 50 of 1000")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Filters/ }).textContent).toContain("1");
  });

  test("controlled: the host gets push for tables and filters, replace for pages", async () => {
    const { ds } = sources();
    const changes: [StudioView, ViewChange][] = [];
    function Host() {
      const [view, setView] = useState<StudioView>(EMPTY_VIEW);
      return (
        <Studio
          dataSource={ds}
          view={view}
          onViewChange={(v, c) => {
            changes.push([v, c]);
            setView(v);
          }}
        />
      );
    }
    render(<Host />);
    await openTable("users");
    await screen.findByText("1 - 50 of 3000");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("51 - 100 of 3000");
    expect(changes.map(([v, c]) => [v.table, v.offset, c.history])).toEqual([
      ["public.users", 0, "push"],
      ["public.users", 50, "replace"],
    ]);
  });

  test("an equal view object does not resubscribe", async () => {
    const { ds } = sources();
    let subscriptions = 0;
    const counting = {
      ...ds,
      subscribePage: (...a: Parameters<typeof ds.subscribePage>) => {
        subscriptions++;
        return ds.subscribePage(...a);
      },
    };
    const view: StudioView = { ...EMPTY_VIEW, table: "public.users" };
    const r = render(<Studio dataSource={counting} view={{ ...view }} />);
    await screen.findByText("1 - 50 of 3000");
    r.rerender(<Studio dataSource={counting} view={{ ...view }} />);
    r.rerender(<Studio dataSource={counting} view={{ ...view }} />);
    await screen.findByText("1 - 50 of 3000");
    expect(subscriptions).toBe(1);
  });

  test("coming back to a table restores its last view", async () => {
    setup();
    await openTable("users");
    await screen.findByText("1 - 50 of 3000");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("51 - 100 of 3000");
    await openTable("posts");
    await screen.findByText("1 - 50 of 1500");
    await openTable("users");
    expect(await screen.findByText("51 - 100 of 3000")).toBeTruthy();
  });

  test("the column layout saved for a table is applied", async () => {
    createPrefs("default").setLayout("public.users", { order: ["email", "id"], hidden: ["name"], widths: {} });
    setup();
    await openTable("users");
    await screen.findByText("user1@example.com");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(headers[0]?.startsWith("email")).toBe(true);
    expect(headers[1]?.startsWith("id")).toBe(true);
    expect(headers.some((h) => h.startsWith("name"))).toBe(false);
  });

  test("an unknown filter column is reported, not dropped silently", async () => {
    const { ds } = sources();
    render(
      <Studio
        dataSource={ds}
        defaultView={{ ...EMPTY_VIEW, table: "public.users", filters: [{ column: "nope", op: "eq", text: "1" }] }}
        notices={['order "x": not column.asc or column.desc, comma-separated']}
      />,
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain('filter on "nope": no such column');
    expect(status.textContent).toContain('order "x"');
  });

  test("a view naming a table this database lacks says so", async () => {
    const { ds } = sources();
    render(<Studio dataSource={ds} defaultView={{ ...EMPTY_VIEW, table: "public.gone" }} />);
    expect((await screen.findByRole("status")).textContent).toContain('table "public.gone"');
  });
```

c) The existing "last page" test uses `setup(1000)` — unchanged (now a `limit`).

Run: `cd packages/studio && bun test ./test/unit/studio.test.tsx` → FAIL.

- [ ] **Step 2: Pager**

`src/studio/pager.tsx`:

```tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";

export interface PagerProps {
  offset: number;
  limit: number;
  shown: number;
  total: number | null;
  hasMore: boolean;
  onOffsetChange(offset: number): void;
}

export function Pager({ offset, limit, shown, total, hasMore, onOffsetChange }: PagerProps) {
  const upto = offset + shown;
  const of = total !== null ? String(total) : hasMore ? `${upto}+` : String(upto);
  const label = shown === 0 ? `0 of ${of}` : `${offset + 1} - ${upto} of ${of}`;
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
        disabled={!hasMore}
        onClick={() => onOffsetChange(offset + limit)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: `<Studio>`**

`src/studio/studio.tsx`:

```tsx
import { ArrowUpDown, Columns3, ListFilter } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type StudioDataSource, type TableInfo, tableId } from "../contract";
import { DataGrid } from "../grid/data-grid";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { applyHeaderSort, PAGE_SIZES, type StudioView, toPageRequest, type ViewChange, viewOfTable } from "../view";
import { ColumnsPanel } from "./columns-panel";
import { FilterBar } from "./filter-bar";
import { Pager } from "./pager";
import { type ColumnLayout, createPrefs, EMPTY_LAYOUT, layoutColumns } from "./prefs";
import { Sidebar } from "./sidebar";
import { SortPanel } from "./sort-panel";
import { ThemeToggle } from "./theme";
import { usePage } from "./use-page";
import { useControllableView } from "./use-view";

export interface StudioProps {
  dataSource: StudioDataSource;
  /** Controlled view: a host keeps it (e.g. in its URL) and gets every change through onViewChange. */
  view?: StudioView;
  defaultView?: StudioView;
  onViewChange?(view: StudioView, change: ViewChange): void;
  /** Problems the host met reading the view (a bad link), shown with the studio's own. */
  notices?: string[];
  /** Separates saved layouts of different databases on one origin. */
  storageKey?: string;
}

const SELECT = "h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30";

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{n}</span> : null;
}

export function Studio({
  dataSource,
  view: controlledView,
  defaultView,
  onViewChange,
  notices = [],
  storageKey = "default",
}: StudioProps) {
  const [view, setView] = useControllableView(controlledView, defaultView, onViewChange);
  const prefs = useMemo(() => createPrefs(storageKey), [storageKey]);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(view.filters.length > 0);
  const [countedFor, setCountedFor] = useState<string | null>(null);
  const [layout, setLayoutState] = useState<ColumnLayout>(EMPTY_LAYOUT);

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

  const table = tables?.find((t) => tableId(t) === view.table) ?? null;
  // Keyed by content: a controlled host may hand an equal but new view object on every render.
  const viewKey = JSON.stringify(view);
  const filtersKey = JSON.stringify([view.table, view.filters]);
  const withTotal = view.filters.length === 0 || countedFor === filtersKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey stands for view's content
  const resolved = useMemo(() => (table ? toPageRequest(view, table, withTotal) : null), [table, viewKey, withTotal]);
  const { page, error, changed } = usePage(dataSource, resolved?.req ?? null, table);

  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey stands for view's content
  useEffect(() => {
    if (view.table) prefs.setLastView(view.table, view);
  }, [prefs, viewKey]);

  useEffect(() => {
    setLayoutState(view.table ? prefs.layout(view.table) : EMPTY_LAYOUT);
  }, [prefs, view.table]);
  const setLayout = (next: ColumnLayout, persist = true) => {
    setLayoutState(next);
    if (persist && view.table) prefs.setLayout(view.table, next);
  };

  // Rows deleted elsewhere can leave the page past the end: step back.
  useEffect(() => {
    if (!page || page.rows.length > 0 || view.offset === 0) return;
    const offset =
      page.total !== null
        ? Math.max(0, Math.floor((page.total - 1) / view.limit) * view.limit)
        : Math.max(0, view.offset - view.limit);
    setView({ ...view, offset }, { history: "replace" });
  }, [page, view, setView]);

  const selectTable = (id: string) => {
    const next = prefs.lastView(id) ?? viewOfTable(id, view.limit);
    setCountedFor(null);
    setFiltersOpen(next.filters.length > 0);
    setView(next, { history: "push" });
  };
  const change = (patch: Partial<StudioView>, history: ViewChange["history"]) =>
    setView({ ...view, ...patch }, { history });

  const laid = table ? layoutColumns(table.columns, layout) : null;
  const warnings = [
    ...notices,
    ...(resolved?.ignored ?? []),
    ...(tables && view.table && !table ? [`table "${view.table}": not in this database`] : []),
  ];
  const sizes = [...new Set([...PAGE_SIZES, view.limit])].sort((a, b) => a - b);

  let body: ReactNode;
  if (error) body = <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
  else if (table && page && laid && resolved)
    body = (
      <DataGrid
        table={table}
        page={page}
        changed={changed}
        columns={laid.visible}
        sort={resolved.req.sort}
        onSort={(column, action) => change({ sort: applyHeaderSort(view.sort, column, action), offset: 0 }, "push")}
        onResize={(column, width, commit) => setLayout({ ...layout, widths: { ...layout.widths, [column]: width } }, commit)}
      />
    );
  else if (table) body = <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  else body = <p className="p-4 text-sm text-muted-foreground">Pick a table on the left.</p>;

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {tables ? (
        <Sidebar tables={tables} selected={view.table} onSelect={selectTable} />
      ) : (
        <div className="w-64 shrink-0 border-r p-3 text-sm text-muted-foreground">{loadError ? loadError.message : "Loading…"}</div>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <span className="truncate text-sm font-medium">{table ? tableId(table) : "No table selected"}</span>
          {table && table.primaryKey.length === 0 && (
            <span className="rounded border px-1.5 text-xs text-muted-foreground">read-only</span>
          )}
          {table && laid && (
            <>
              <Button type="button" variant="outline" size="sm" aria-pressed={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
                <ListFilter />
                Filters
                <Count n={view.filters.length} />
              </Button>
              <Popover>
                <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
                  <ArrowUpDown />
                  Sort
                  <Count n={view.sort.length} />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto">
                  <SortPanel columns={laid.ordered} sort={view.sort} onChange={(sort) => change({ sort, offset: 0 }, "push")} />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
                  <Columns3 />
                  Columns
                  <Count n={layout.hidden.filter((h) => table.columns.some((c) => c.name === h)).length} />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto">
                  <ColumnsPanel columns={laid.ordered} layout={layout} onChange={(l) => setLayout(l)} />
                </PopoverContent>
              </Popover>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {page && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`revision ${page.revision}`}>
                <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500" />
                Live
              </span>
            )}
            {page && page.total === null && (
              <Button type="button" variant="ghost" size="xs" onClick={() => setCountedFor(filtersKey)}>
                Count rows
              </Button>
            )}
            {table && (
              <select
                aria-label="Rows per page"
                className={SELECT}
                value={view.limit}
                onChange={(e) => change({ limit: Number(e.target.value), offset: 0 }, "replace")}
              >
                {sizes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
            {page && (
              <Pager
                offset={view.offset}
                limit={view.limit}
                shown={page.rows.length}
                total={page.total}
                hasMore={page.hasMore}
                onOffsetChange={(offset) => change({ offset }, "replace")}
              />
            )}
            <ThemeToggle />
          </div>
        </header>
        {table && filtersOpen && (
          <FilterBar table={table} applied={view.filters} onApply={(filters) => change({ filters, offset: 0 }, "push")} />
        )}
        {warnings.length > 0 && (
          <div role="status" className="border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">
            {warnings.map((w) => (
              <p key={w}>Ignored {w}.</p>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">{body}</div>
      </main>
    </div>
  );
}
```

`src/index.ts`:

```ts
export * from "./contract";
export { Studio, type StudioProps } from "./studio/studio";
export {
  decodeView,
  EMPTY_VIEW,
  encodeView,
  type StudioView,
  VIEW_PARAM_KEYS,
  type ViewChange,
  type ViewFilter,
} from "./view";
```

Note on the sidebar: `Sidebar`'s `selected` prop already takes `string | null` (`view.table`).

- [ ] **Step 4: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"` → all pass.

Sabotages (restore with `cp`):
1. `withTotal` always true → `filters narrow the rows; the pager says 50+` red.
2. `resolved` memo keyed by `view` instead of `viewKey` → `an equal view object does not resubscribe` red.
3. `selectTable` ignores `prefs.lastView` → `coming back to a table restores its last view` red.
4. `warnings` leaves out `resolved.ignored` → `an unknown filter column is reported` red.
5. Page changes use `"push"` → `controlled: the host gets push…` red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): the studio on StudioView — filters, sort and columns in the toolbar, page size, count on demand, notices"
```

---

### Task 8: The view in the playground's URL; the S2 end-to-end tests; boundary checker

**Files:**
- Create: `packages/studio/playground/use-url-view.ts`, `packages/studio/e2e/view.e2e.ts`
- Modify: `packages/studio/playground/main.tsx`, `test/support/boundaries.ts`, `test/unit/boundaries.test.ts`

**Interfaces:**
- Consumes: `decodeView`, `encodeView`, `VIEW_PARAM_KEYS`, `StudioView`, `ViewChange` (from `../src`).
- Produces: `useUrlView(): { view: StudioView; notices: string[]; onViewChange(view: StudioView, change: ViewChange): void }`.

- [ ] **Step 1: The failing e2e**

`e2e/view.e2e.ts`:

```ts
// The view lives in the URL: a link or a reload reopens the same table, filters, sort and page, Back undoes a
// filter, and a link the studio cannot fully read says what it ignored. Layout lives in localStorage.
import { expect, type Page as Tab, test } from "@playwright/test";

const firstEmails = (tab: Tab) =>
  tab.getByRole("gridcell").filter({ hasText: /@example\.com$/ }).evaluateAll((cells) => cells.slice(0, 5).map((c) => c.textContent));

async function openUsers(tab: Tab) {
  await tab.getByRole("button", { name: "users", exact: true }).click();
  await expect(tab.getByText("1 - 50 of 3000")).toBeVisible();
}

test("filters and sort go to the URL; a reload shows the same rows", async ({ page }) => {
  await page.goto("/");
  await openUsers(page);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const row = page.getByRole("group", { name: "Filter 1" });
  await row.getByLabel("Column").selectOption("role");
  await row.getByLabel("Value").selectOption("admin");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("1 - 50 of 50+")).toBeVisible();
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("list", { name: "Columns" }).getByRole("button", { name: "age" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/where=role\.eq\.admin/);
  await expect(page).toHaveURL(/order=age\.asc/);
  const before = await firstEmails(page);
  await page.reload();
  await expect(page.getByText("1 - 50 of 50+")).toBeVisible();
  expect(await firstEmails(page)).toEqual(before);
  await expect(page.getByRole("group", { name: "Filter 1" }).getByLabel("Column")).toHaveValue("role");
});

test("Back undoes the last applied filter", async ({ page }) => {
  await page.goto("/");
  await openUsers(page);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const row = page.getByRole("group", { name: "Filter 1" });
  await row.getByLabel("Column").selectOption("role");
  await row.getByLabel("Value").selectOption("viewer");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/where=role\.eq\.viewer/);
  await page.goBack();
  await expect(page).not.toHaveURL(/where=/);
  await expect(page.getByText("1 - 50 of 3000")).toBeVisible();
});

test("a link the studio cannot fully read shows the rows it can, and says what it ignored", async ({ page }) => {
  await page.goto("/?v=1&table=public.users&where=nope.eq.1&where=age.bogus.1");
  const status = page.getByRole("status");
  await expect(status).toContainText('filter on "nope": no such column');
  await expect(status).toContainText('filter "age.bogus.1"');
  await expect(page.getByText("1 - 50 of 3000")).toBeVisible();
});

test("the header menu sorts; hidden columns and widths survive a reload", async ({ page }) => {
  await page.goto("/");
  await openUsers(page);
  await page.getByRole("columnheader", { name: /^age/ }).getByRole("button").click();
  await page.getByRole("menuitem", { name: "Sort descending" }).click();
  await expect(page).toHaveURL(/order=age\.desc/);
  await page.getByRole("button", { name: /^Columns/ }).click();
  await page.getByRole("list", { name: "Columns" }).getByRole("button", { name: "email" }).click();
  await page.keyboard.press("Escape");
  const handle = page.getByRole("separator", { name: "Resize name" });
  const box = await handle.boundingBox();
  if (!box) throw new Error("no resize handle");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 122, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.reload();
  await expect(page.getByRole("columnheader", { name: /^email/ })).toHaveCount(0);
  const width = await page.getByRole("columnheader", { name: /^name/ }).evaluate((h) => h.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(300);
});
```

Run: `cd packages/studio && bun run test:e2e -- e2e/view.e2e.ts` → FAIL (the URL never changes; reloads lose the view).

- [ ] **Step 2: The URL hook and the playground**

`playground/use-url-view.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { decodeView, encodeView, type StudioView, VIEW_PARAM_KEYS, type ViewChange } from "../src";

// The playground's binding of the studio's view to the address bar. A host app does the same with its router;
// the studio itself never touches the URL. Other query parameters (e.g. ?latency) are kept.
export function useUrlView(): { view: StudioView; notices: string[]; onViewChange(view: StudioView, change: ViewChange): void } {
  const [state, setState] = useState(() => decodeView(location.search));
  useEffect(() => {
    const onPop = () => setState(decodeView(location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const onViewChange = useCallback((view: StudioView, change: ViewChange) => {
    const params = new URLSearchParams(location.search);
    for (const key of VIEW_PARAM_KEYS) params.delete(key);
    for (const [key, value] of new URLSearchParams(encodeView(view))) params.append(key, value);
    const query = params.toString();
    const url = `${location.pathname}${query ? `?${query}` : ""}`;
    if (change.history === "push") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    setState({ view, errors: [] });
  }, []);
  return { view: state.view, notices: state.errors, onViewChange };
}
```

`playground/main.tsx` — replace the `<Studio dataSource={dataSource} />` element with `<App />`, and add above
`const root = …`:

```tsx
function App() {
  const { view, notices, onViewChange } = useUrlView();
  return <Studio dataSource={dataSource} view={view} onViewChange={onViewChange} notices={notices} />;
}
```

plus `import { useUrlView } from "./use-url-view";`.

- [ ] **Step 3: Boundary checker (S1 minor M4)**

In `test/support/boundaries.ts`, replace `collectSources`'s loop body so a missing directory is an error:

```ts
  for (const dir of dirs) walk(dir);
  return out;
```

(remove the `try/catch` and its ENOENT comment). In `test/unit/boundaries.test.ts`, replace the scan test's
`expect(files.length).toBeGreaterThan(0);` with:

```ts
    for (const dir of ["src", "playground"]) expect(collectSources([join(root, dir)]).length).toBeGreaterThan(0);
```

- [ ] **Step 4: Run all, sabotage, commit**

Run: `cd packages/studio && bun run test:e2e` → `8 passed` (4 two-tab + 4 view). Run it three times; all green.

Sabotages (restore with `cp`): (1) `useUrlView` always `replaceState` → `Back undoes…` red; (2) `onViewChange`
does not write the URL → `filters and sort go to the URL` red.

Run: `bunx biome check --write packages/studio && bun run check && bun run test 2>&1 | grep -E "Ran |passed|failed| fail$"`
→ green (the core needs `.env`, present in this worktree).

```bash
git add packages/studio
git commit -m "feat(studio): the playground keeps the view in its URL — reload, links and Back; e2e for S2"
```

---

### Task 9: Close the slice

**Files:**
- Modify: `packages/studio/NOTES.md`, `packages/studio/README.md`, `docs/specs/STUDIO-00-ui-on-mocks.md`

- [ ] **Step 1: NOTES.md — append**

```markdown
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
```

- [ ] **Step 2: README — add a section before the last paragraph**

```markdown
## Embedding

    <Studio dataSource={ds} />                                     // keeps its own view
    <Studio dataSource={ds} view={view} onViewChange={setView} />  // controlled: bind it to your router

`encodeView(view)` / `decodeView(search)` turn a view into query parameters (`?v=1&table=public.users&where=role.eq.admin&order=age.desc`)
and back; `change.history` says whether to push or replace. Filter values in a URL end up in history and server
logs: leave `where` out of the URL if that matters for your data. `storageKey` separates saved layouts of different
databases on one origin.
```

- [ ] **Step 3: Spec progress**

Append to the spec's **Progress** paragraph (after the S1 text):

```markdown
S2 (`docs/superpowers/plans/2026-09-25-studio-00-2-filters-sort-columns.md`): filter bar, sort panel and header
menu, columns panel and resizing, page size, count on demand (`withTotal`/`hasMore`), and the view as a serialisable
`StudioView` a host binds to its URL (the playground does; the studio never touches the URL).
```

- [ ] **Step 4: Verify and commit**

Run: `bun run check && bun run test 2>&1 | grep -E "Ran |passed|failed| fail$"` → green; record the counts.

```bash
git add packages/studio/NOTES.md packages/studio/README.md docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "docs(studio): S2 notes, embedding section, progress"
```

- [ ] **Step 5: Hand-off**

A fresh reviewer (most capable model) reviews the branch against this plan and the spec. Before merging, check
`main` against the merge base (other sessions work in parallel); the merge is the owner's call.
