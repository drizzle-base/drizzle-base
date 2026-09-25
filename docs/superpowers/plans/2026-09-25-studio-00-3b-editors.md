# STUDIO-00 S3b — Date/time picker, Expand Row panel, code editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the editors: a date/time picker (input, shortcuts, calendar, time columns) that never loses what
it does not touch, an Expand Row side panel that edits a whole row into the same pending draft, and CodeMirror 6
for json and arrays, loaded only when someone opens one. Plus two S3a leftovers: the save error is per table, and
the delete confirmation counts only rows that are still there.

**Architecture:** Dates travel as Postgres text and are edited as text: `src/lib/pgtime.ts` parses Postgres's
date/time text into parts, replaces a day or an hour while keeping the fraction and the offset, resolves the
shortcuts on the client (the owner's call: concrete text, `now` = the instant of the click, timestamptz in the
browser's offset) and gives the canonical form a data source reads back (timestamptz in UTC, `+00`). The mock uses
the same module to store what Postgres would store and to compare instants, so an offset typed in the browser
sorts and filters correctly. The picker is presentational (`src/edit/datetime-picker.tsx`) and shared by the cell
editor and the panel. The row panel (`src/edit/row-panel.tsx`) is docked beside the grid, not modal: it follows
the selected row, and every field writes through `setCell`/`setNewCell`, so save, conflicts and required values
work as in the grid. `CodeEditor` renders a textarea and swaps in CodeMirror once its chunk has loaded
(`import()`); the mode comes from a context the `<Studio>` provides (`codeEditor`, default `"codemirror"`), and
outside it (unit tests of the grid) it stays a textarea.

**Tech Stack:** as before, plus `react-day-picker` 10.0.1 (the shadcn Calendar, vendored on Base UI) and
CodeMirror 6: `@codemirror/state` 6.7.6, `@codemirror/view` 6.43.13, `@codemirror/commands` 6.11.1,
`@codemirror/language` 6.12.4, `@codemirror/lang-json` 6.0.2 (not the `codemirror` meta package: it pulls
autocomplete, search and lint).

**Spec:** `docs/specs/STUDIO-00-ui-on-mocks.md` §4 row "Editors" (date/time) and the Expand Row panel of
`packages/studio/NOTES.md`. Decisions taken with the owner on 25 Sep 2026: react-day-picker (shadcn Calendar);
CodeMirror 6 lazy-loaded behind `CodeEditor` with the textarea as fallback; Expand Row decided after studying
Drizzle Studio (it feeds the pending edits — adopted); shortcuts resolved on the client; the two editing leftovers
in this slice, the other two (filter values in localStorage, resize listeners) in S5.

## What Drizzle Studio does (observed 25 Sep 2026, drizzle-kit 0.31.11, probe database)

- A date/timestamp cell opens its text input plus a popover: shortcuts `NULL / now / today / tomorrow / yesterday`,
  a react-day-picker month and, for timestamps, three scrolling columns hour/minute/second (listed 23 → 00).
- A shortcut writes the **literal word** into the input (`now`); Enter makes the cell pending with the text `now`,
  which Postgres resolves when the save runs. The calendar still highlights today.
- **Defects we do not copy:** picking a day on a timestamptz gives `2026-09-10 00:00:00` — the time, the
  microseconds and the offset (`+00`) are dropped, so the value is read in the session's time zone; the calendar
  does not show the current value (it cannot parse microseconds) and does not follow what is typed; `NULL` is
  offered on NOT NULL columns.
- Esc cancels, Enter commits, as for every cell.
- Expand Row (cell context menu) opens a **non-modal**, resizable side panel: one field per column (name and type),
  selects for enum/boolean, CodeMirror for json and arrays (a text field becomes one when edited), the same date
  popover. An edit there is a pending edit like the grid's: the toolbar shows Save/Discard, the panel repeats them
  in its footer, and the grid cell changes with it. An edited field gets an amber border and a ↺ to revert that
  field. The panel **follows the selected row**; the previous row's pending edit stays.
- Its CodeMirror has line numbers, folding and syntax highlighting (json and arrays).

## Global Constraints

- Branch `feat/studio-s3b-editors`; only `packages/studio/`, `bun.lock`, the spec and this plan. Before merging,
  compare `git rev-parse main` with `git merge-base main HEAD`; if main moved, merge it in and rerun everything.
- A date/time edit changes only what the person picked: a day keeps the time, the fraction and the offset; an hour
  keeps the day, the minutes, the seconds, the fraction and the offset.
- NULL is offered only on nullable columns (picker, panel, selects).
- The panel writes only through the draft: no second write path, no save of its own.
- A field being edited keeps what the person typed across pushes; its expected value is the one it had when
  editing began (the S3a rule for cells).
- CodeMirror is never in the initial chunk: only `src/edit/codemirror.tsx` imports `@codemirror/*`, and only
  `CodeEditor` imports it, dynamically.
- Biome/TS strict; `bun run check` green before every commit; sabotages restored with `cp`, never `git checkout --`.
- Baseline before this plan: `Ran 178 tests across 25 files` (unit), 11 e2e.

## Review Focus

1. **A picked day or hour never changes anything else** (fraction, offset, the other parts). (Task 1
   `withDay keeps…`, `withTime keeps…`; Task 3 `picking a day on a timestamptz keeps its time…`; Task 7 e2e.)
2. **A timestamptz written with an offset is stored, sorted and filtered as the instant it names.** (Task 2
   conformance `a timestamptz written with an offset reads back in UTC`, `filters compare instants`.)
3. **The panel is the grid's draft seen differently**: an edit in it is pending in the grid, saved by the same
   atomic save, and a change elsewhere to a field being edited becomes a conflict, not an overwrite. (Task 5.)
4. **CodeMirror loads lazily and the fallback works** when it does not. (Task 4 unit + Task 7 build check.)
5. **The leftovers**: a failed save in one table does not show in another; the delete count ignores rows that
   left the page. (Task 6.)

---

### Task 1: `pgtime` — Postgres date/time text, edited by parts

**Files:**
- Create: `packages/studio/src/lib/pgtime.ts`
- Test: `packages/studio/test/unit/pgtime.test.ts`

**Interfaces:**
- Produces: `type TimeKind = "date" | "timestamp" | "timestamptz"`; `interface PgTime { kind; year; month; day;
  hour; minute; second; fraction: string; offset: number | null }`; `isTimeKind(kind): kind is TimeKind`;
  `parsePgTime(kind, text): PgTime | null`; `formatPgTime(t): string`; `toUtc(t): PgTime`; `instantOf(t): number`
  (microseconds since the epoch, wall time for date/timestamp); `canonicalPgTime(kind, text): string | null`;
  `withDay(t, year, month, day)`; `withTime(t, part: "hour" | "minute" | "second", value)`;
  `type Shortcut = "now" | "today" | "tomorrow" | "yesterday"`; `shortcut(kind, name, now: Date, offset: number)`;
  `browserOffset(now: Date): number`.

- [ ] **Step 1: The failing tests**

`test/unit/pgtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  canonicalPgTime,
  formatPgTime,
  instantOf,
  parsePgTime,
  shortcut,
  toUtc,
  withDay,
  withTime,
} from "../../src/lib/pgtime";

const p = (kind: "date" | "timestamp" | "timestamptz", text: string) => {
  const t = parsePgTime(kind, text);
  if (!t) throw new Error(`did not parse ${text}`);
  return t;
};

describe("parse and format", () => {
  test("Postgres's own output round-trips exactly", () => {
    for (const [kind, text] of [
      ["timestamptz", "2026-09-25 12:43:35.257072+00"],
      ["timestamptz", "2026-01-01 00:00:00+05:30"],
      ["timestamptz", "2026-01-01 00:00:00-03"],
      ["timestamptz", "0099-01-01 00:00:00+00"],
      ["timestamp", "2026-09-25 11:43:35.257072"],
      ["timestamp", "2026-09-25 11:43:35"],
      ["date", "1980-02-07"],
    ] as const) {
      expect(formatPgTime(p(kind, text))).toBe(text);
    }
  });

  test("accepts what Postgres accepts on input, and writes it as Postgres would", () => {
    expect(formatPgTime(p("timestamptz", "2026-09-25T12:43Z"))).toBe("2026-09-25 12:43:00+00");
    expect(formatPgTime(p("timestamptz", "2026-09-25 12:43:00.500-0330"))).toBe("2026-09-25 12:43:00.5-03:30");
    expect(formatPgTime(p("timestamptz", "2026-09-25"))).toBe("2026-09-25 00:00:00+00");
    expect(formatPgTime(p("timestamp", "2026-09-25 12:43"))).toBe("2026-09-25 12:43:00");
  });

  test("refuses what is not a real date or time of its kind", () => {
    expect(parsePgTime("date", "2026-02-30")).toBeNull();
    expect(parsePgTime("date", "2026-02-03 10:00")).toBeNull();
    expect(parsePgTime("timestamp", "2026-09-25 24:00:00")).toBeNull();
    expect(parsePgTime("timestamp", "2026-09-25 10:00:00+00")).toBeNull();
    expect(parsePgTime("timestamptz", "2026-09-25 10:00:00+16")).toBeNull();
    expect(parsePgTime("timestamptz", "now")).toBeNull();
  });
});

describe("editing by parts", () => {
  test("withDay keeps the time, the fraction and the offset", () => {
    const t = p("timestamptz", "2026-09-25 12:43:35.257072+00");
    expect(formatPgTime(withDay(t, 2026, 9, 10))).toBe("2026-09-10 12:43:35.257072+00");
    expect(formatPgTime(withDay(p("timestamp", "2026-09-25 11:43:35.5"), 2025, 1, 31))).toBe("2025-01-31 11:43:35.5");
  });

  test("withTime keeps the day, the other parts, the fraction and the offset", () => {
    const t = p("timestamptz", "2026-09-25 12:43:35.257072-03");
    expect(formatPgTime(withTime(t, "hour", 8))).toBe("2026-09-25 08:43:35.257072-03");
    expect(formatPgTime(withTime(t, "second", 0))).toBe("2026-09-25 12:43:00.257072-03");
  });
});

describe("instants", () => {
  test("toUtc moves the wall time by the offset, across days and centuries", () => {
    expect(formatPgTime(toUtc(p("timestamptz", "2026-01-01 00:30:00-03")))).toBe("2026-01-01 03:30:00+00");
    expect(formatPgTime(toUtc(p("timestamptz", "2026-01-01 01:00:00.5+02")))).toBe("2025-12-31 23:00:00.5+00");
    expect(formatPgTime(toUtc(p("timestamptz", "0099-12-31 23:00:00-02")))).toBe("0100-01-01 01:00:00+00");
  });

  test("the same instant in two offsets is equal; a fraction orders after the whole second", () => {
    expect(instantOf(p("timestamptz", "2026-01-01 10:00:00+02"))).toBe(instantOf(p("timestamptz", "2026-01-01 08:00:00+00")));
    expect(instantOf(p("timestamptz", "2026-01-01 08:00:00.000001+00"))).toBeGreaterThan(
      instantOf(p("timestamptz", "2026-01-01 08:00:00+00")),
    );
  });

  test("canonicalPgTime is what a data source reads back", () => {
    expect(canonicalPgTime("timestamptz", "2026-01-01T00:30-03:00")).toBe("2026-01-01 03:30:00+00");
    expect(canonicalPgTime("timestamp", "2026-01-01T00:30:00.100")).toBe("2026-01-01 00:30:00.1");
    expect(canonicalPgTime("date", "2026-1-1")).toBeNull();
  });
});

describe("shortcuts, in the browser's time zone", () => {
  // 02:30:15.25 UTC on the 25th is 23:30:15.25 on the 24th in São Paulo (UTC-3).
  const now = new Date(Date.UTC(2026, 8, 25, 2, 30, 15, 250));
  const sp = -180;
  test("date: the local day", () => {
    expect(formatPgTime(shortcut("date", "today", now, sp))).toBe("2026-09-24");
    expect(formatPgTime(shortcut("date", "tomorrow", now, sp))).toBe("2026-09-25");
    expect(formatPgTime(shortcut("date", "yesterday", now, sp))).toBe("2026-09-23");
    expect(formatPgTime(shortcut("date", "now", now, sp))).toBe("2026-09-24");
  });
  test("timestamptz: the local wall time with its offset; days start at local midnight", () => {
    expect(formatPgTime(shortcut("timestamptz", "now", now, sp))).toBe("2026-09-24 23:30:15.25-03");
    expect(formatPgTime(shortcut("timestamptz", "today", now, sp))).toBe("2026-09-24 00:00:00-03");
    expect(formatPgTime(shortcut("timestamptz", "tomorrow", now, 330))).toBe("2026-09-26 00:00:00+05:30");
  });
  test("timestamp: the local wall time, no offset", () => {
    expect(formatPgTime(shortcut("timestamp", "now", now, sp))).toBe("2026-09-24 23:30:15.25");
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/pgtime.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/pgtime'`.

- [ ] **Step 2: `src/lib/pgtime.ts`**

```ts
import type { ColumnKind } from "../contract";

// Postgres's date/time text (DateStyle=ISO), edited by parts. A JS Date cannot hold microseconds nor an offset, so
// values are never round-tripped through one: parts are replaced and the rest is written back as it was.

export type TimeKind = "date" | "timestamp" | "timestamptz";

export interface PgTime {
  kind: TimeKind;
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Digits of the fraction of a second, 0–6 of them, trailing zeros dropped (as Postgres prints them). */
  fraction: string;
  /** Minutes east of UTC; timestamptz only. Text without one is in the data source's zone, which is UTC. */
  offset: number | null;
}

export type Shortcut = "now" | "today" | "tomorrow" | "yesterday";

const RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const MAX_OFFSET = 15 * 60 + 59;
const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export const isTimeKind = (kind: ColumnKind): kind is TimeKind =>
  kind === "date" || kind === "timestamp" || kind === "timestamptz";

function parseOffset(text: string | undefined): number {
  if (text === undefined || text === "Z") return 0;
  const sign = text.startsWith("-") ? -1 : 1;
  const digits = text.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
}

/** A Date on the UTC calendar; setUTCFullYear because Date.UTC reads years 0–99 as 1900–1999. */
function utcDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d;
}

function fromUtcDate(kind: TimeKind, d: Date, fraction: string, offset: number | null): PgTime {
  return {
    kind,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    fraction,
    offset,
  };
}

export function parsePgTime(kind: TimeKind, text: string): PgTime | null {
  const m = RE.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, frac, off] = m;
  if (kind === "date" && (hh !== undefined || off !== undefined)) return null;
  if (kind === "timestamp" && off !== undefined) return null;
  const t: PgTime = {
    kind,
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(hh ?? 0),
    minute: Number(mi ?? 0),
    second: Number(ss ?? 0),
    fraction: (frac ?? "").replace(/0+$/, ""),
    offset: kind === "timestamptz" ? parseOffset(off) : null,
  };
  const check = utcDate(t.year, t.month, t.day);
  if (check.getUTCFullYear() !== t.year || check.getUTCMonth() !== t.month - 1 || check.getUTCDate() !== t.day) {
    return null;
  }
  if (t.hour > 23 || t.minute > 59 || t.second > 59) return null;
  if (t.offset !== null && Math.abs(t.offset) > MAX_OFFSET) return null;
  return t;
}

function formatOffset(minutes: number): string {
  const a = Math.abs(minutes);
  const rest = a % 60;
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}${rest ? `:${pad(rest)}` : ""}`;
}

export function formatPgTime(t: PgTime): string {
  const date = `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
  if (t.kind === "date") return date;
  const time = `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}${t.fraction ? `.${t.fraction}` : ""}`;
  return t.kind === "timestamp" ? `${date} ${time}` : `${date} ${time}${formatOffset(t.offset ?? 0)}`;
}

const wallMillis = (t: PgTime): number => utcDate(t.year, t.month, t.day, t.hour, t.minute, t.second).getTime();

/** The same instant at offset 0 (what a data source running with TimeZone=UTC prints). */
export function toUtc(t: PgTime): PgTime {
  if (t.kind !== "timestamptz") return t;
  return fromUtcDate("timestamptz", new Date(wallMillis(t) - (t.offset ?? 0) * 60_000), t.fraction, 0);
}

/** Microseconds since the epoch: the instant for timestamptz, the wall time for date and timestamp. */
export function instantOf(t: PgTime): number {
  const utc = toUtc(t);
  return wallMillis(utc) * 1000 + Number(utc.fraction.padEnd(6, "0"));
}

/** The text a data source reads back for `text`, or null when it is not a value of that kind. */
export function canonicalPgTime(kind: TimeKind, text: string): string | null {
  const t = parsePgTime(kind, text);
  return t ? formatPgTime(toUtc(t)) : null;
}

export const withDay = (t: PgTime, year: number, month: number, day: number): PgTime => ({ ...t, year, month, day });

export const withTime = (t: PgTime, part: "hour" | "minute" | "second", value: number): PgTime => ({
  ...t,
  [part]: value,
});

/** Minutes east of UTC in the browser's zone at `now` (getTimezoneOffset counts the other way). */
export const browserOffset = (now: Date): number => -now.getTimezoneOffset();

const SHIFT: Record<Shortcut, number> = { now: 0, today: 0, tomorrow: 1, yesterday: -1 };

/** A shortcut resolved on the client, in the zone `offset` names: `now` is this instant, the others midnight. */
export function shortcut(kind: TimeKind, name: Shortcut, now: Date, offset: number): PgTime {
  const wall = new Date(now.getTime() + offset * 60_000);
  const zone = kind === "timestamptz" ? offset : null;
  if (name === "now") {
    return fromUtcDate(kind, wall, pad(wall.getUTCMilliseconds(), 3).replace(/0+$/, ""), zone);
  }
  const day = utcDate(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate() + SHIFT[name]);
  return fromUtcDate(kind, day, "", zone);
}
```

(`fromUtcDate` for kind `date` still fills hour/minute/second; `formatPgTime` ignores them for dates.)

- [ ] **Step 3: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test/unit/pgtime.test.ts` → `11 pass`.

Sabotages (restore each with `cp src/lib/pgtime.ts.bak src/lib/pgtime.ts`):
1. `withDay` returns `{ ...t, year, month, day, hour: 0, minute: 0, second: 0, fraction: "", offset: t.kind === "timestamptz" ? 0 : null }` (Drizzle Studio's behaviour) → `withDay keeps…` red.
2. `utcDate` uses `new Date(Date.UTC(year, month - 1, day, hour, minute, second))` → round-trip (`0099-…`) and the
   century case of `toUtc` red.
3. `shortcut` ignores `offset` (`const wall = now`) → every shortcut test red.
4. `formatPgTime` drops the fraction → round-trip red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio/src/lib/pgtime.ts packages/studio/test/unit/pgtime.test.ts
git commit -m "feat(studio): pgtime — Postgres date/time text edited by parts, shortcuts in the browser's zone"
```

---

### Task 2: The mock stores and compares date/time values as Postgres does

**Files:**
- Modify: `packages/studio/src/mock/datasets/conformance.ts`, `src/mock/source.ts`, `src/mock/query.ts`,
  `test/conformance.ts`, `docs/specs/STUDIO-00-ui-on-mocks.md`

**Interfaces:**
- Consumes: Task 1 (`canonicalPgTime`, `instantOf`, `parsePgTime`, `isTimeKind`).
- Produces: a conformance relation `conformance.events (id serial primary key, at timestamptz, on_day date)`;
  the mock refuses a bad date/time with `invalid_value` and stores the canonical text.

- [ ] **Step 1: The failing conformance tests**

In `src/mock/datasets/conformance.ts`, the doc comment gains
`create table conformance.events (id serial primary key, at timestamptz, on_day date);` and `tables` gains:

```ts
      mockTable(
        "conformance",
        "events",
        [
          col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }),
          col("at", "timestamptz", "timestamp with time zone"),
          col("on_day", "date", "date"),
        ],
        [],
        { id: "serial" },
      ),
```

In `test/conformance.ts`, next to the other refs add `const EVENTS = { schema: "conformance", name: "events" };`,
and before `it("unknown tables and columns are reported with their codes"` add:

```ts
    it("a timestamptz written with an offset reads back in UTC, fraction kept", async (open) => {
      const ds = await open();
      await ds.insertRows(EVENTS, [{ at: "2026-01-01 00:30:00.25-03", on_day: "2026-01-01" }]);
      const w = watch(ds, req({ table: EVENTS }));
      const row = (await w.latest((p) => p.rows.length === 1)).rows[0];
      expect(row?.["at"]).toBe("2026-01-01 03:30:00.25+00");
      expect(row?.["on_day"]).toBe("2026-01-01");
      w.stop();
    });

    it("filters and sorts on timestamptz compare instants, whatever the offset", async (open) => {
      const ds = await open();
      await ds.insertRows(EVENTS, [{ at: "2026-01-01 10:00:00+00" }, { at: "2026-01-01 09:00:00-03" }]);
      const w = watch(
        ds,
        req({
          table: EVENTS,
          // 09:30 UTC: both rows (10:00 UTC and 12:00 UTC) are later; as text, "09:00-03" would not be.
          filters: [{ column: "at", op: "gt", value: "2026-01-01 11:30:00+02" }],
          sort: [{ column: "at", dir: "desc" }],
        }),
      );
      const page = await w.latest((p) => p.total !== null);
      expect(page.rows.map((r) => r["at"])).toEqual(["2026-01-01 12:00:00+00", "2026-01-01 10:00:00+00"]);
      w.stop();
    });

    it("a date or time that is not one is refused as invalid_value", async (open) => {
      const ds = await open();
      await expectCode(ds.insertRows(EVENTS, [{ on_day: "2026-02-30" }]), "invalid_value");
      const [k] = await ds.insertRows(EVENTS, [{}]);
      await expectCode(ds.updateRows(EVENTS, [{ key: k ?? {}, values: { at: "tomorrow-ish" } }]), "invalid_value");
    });
```

Run: `cd packages/studio && bun test ./test/unit/mock-source.test.ts 2>&1 | grep -E "^\(fail\)| pass$| fail$"`
Expected: the three new tests FAIL (the offset is stored as typed; `09:00-03` sorts before `10:00+00` as text;
`2026-02-30` is accepted).

- [ ] **Step 2: The mock**

`src/mock/source.ts`:

a) Import `import { canonicalPgTime, isTimeKind } from "../lib/pgtime";`.

b) Replace `checkValues` with a function that validates and returns what is stored:

```ts
  /** Validates values (columns, NOT NULL, date/time text) and returns them as Postgres would store them. */
  const normalize = (t: LiveTable, values: Row): Row => {
    const out: Row = {};
    for (const [name, v] of Object.entries(values)) {
      const c = t.def.info.columns.find((x) => x.name === name);
      if (!c) throw new StudioDataSourceError("unknown_column", `unknown column "${name}"`);
      if (v === null && !c.nullable) throw new StudioDataSourceError("not_null", `"${name}" is NOT NULL`);
      if (v !== null && isTimeKind(c.kind)) {
        const text = typeof v === "string" ? canonicalPgTime(c.kind, v) : null;
        if (text === null) throw new StudioDataSourceError("invalid_value", `"${name}": ${JSON.stringify(v)} is not a ${c.pgType}`);
        out[name] = text;
      } else out[name] = v;
    }
    return out;
  };
```

c) `checkUpdate` becomes `normalizeUpdate(t, c): RowUpdate` — same checks, but `const values = normalize(t, c.values)`
and `const expected = c.expected ? normalize(t, c.expected) : undefined` are used for the comparisons and returned
as `{ key: c.key, values, ...(expected ? { expected } : {}) }`. `materialize` starts with
`const given = normalize(t, input);` and reads `given` instead of `input`.

d) `updateRows` and `applyEdits` build their op from the normalized updates:

```ts
    async updateRows(ref, changes) {
      await commit(() => {
        const t = writable(ref);
        const ok = changes.map((c) => normalizeUpdate(t, c));
        return ok.length === 0
          ? null
          : { kind: "update", table: refOf(ref), changes: ok.map(({ key, values }) => structuredClone({ key, values })) };
      }, "studio");
    },
```

and in `applyEdits`: `const updates = edits.updates.map((u) => normalizeUpdate(t, u));` before `materializeAll`, and
`changes` maps `updates` instead of `edits.updates`.

`src/mock/query.ts` — in `compareNonNull`, before `default:`:

```ts
    case "date":
    case "timestamp":
    case "timestamptz": {
      const x = parsePgTime(kind, textOf(a));
      const y = parsePgTime(kind, textOf(b));
      if (x && y) return Math.sign(instantOf(x) - instantOf(y));
      return textOf(a) < textOf(b) ? -1 : textOf(a) > textOf(b) ? 1 : 0;
    }
```

with `import { instantOf, parsePgTime } from "../lib/pgtime";`.

- [ ] **Step 3: Run, sabotage, spec, commit**

Run: `cd packages/studio && bun run typecheck && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"` → all pass.

Sabotages (restore with `cp`): (1) `normalize` stores `v` as given for time kinds → first test red;
(2) `compareNonNull` loses the time case → second test red; (3) `normalize` skips the `invalid_value` throw → third red.

Spec, "Contract changes", add:

```markdown
- 25 Sep 2026 (S3b): date, timestamp and timestamptz values are read back as the data source stores them —
  timestamptz in UTC (`+00`, the data source runs with TimeZone=UTC), fractions without trailing zeros — whatever
  offset or form they were written in; comparisons are by instant. Text that is not a value of the column's kind
  is `invalid_value`. The conformance suite gains `conformance.events`.
```

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "feat(studio): the mock stores date/time values as Postgres does and compares instants"
```

---

### Task 3: The date/time picker, in the cell editor

**Files:**
- Create: `packages/studio/src/ui/calendar.tsx`, `src/edit/datetime-picker.tsx`
- Modify: `packages/studio/package.json` (`react-day-picker`), `bun.lock`, `src/ui/popover.tsx` (pass `anchor`),
  `src/edit/cell-editor.tsx`
- Test: `packages/studio/test/unit/datetime-editor.test.tsx`

**Interfaces:**
- Consumes: Task 1.
- Produces: `DateTimePicker(props: { kind: TimeKind; text: string; nullable: boolean; now?: () => Date;
  onPick(text: string | null): void })` — `onPick(null)` is NULL. DOM: a group labelled `Pick a date`, buttons
  `NULL` (nullable only), `now`, `today`, `tomorrow`, `yesterday`; react-day-picker's day buttons; for timestamps
  three groups `Hour`, `Minute`, `Second` of buttons `00`…, the current one `aria-pressed`. Every button keeps focus
  where it was (`onMouseDown` prevents default). `PopoverContent` accepts `anchor`.

- [ ] **Step 1: Dependency and Calendar**

Run: `cd packages/studio && bun add react-day-picker@10.0.1` (pinned, as every dependency here).

`src/ui/calendar.tsx`: the shadcn base-nova Calendar (`https://ui.shadcn.com/r/styles/base-nova/calendar.json`),
vendored as the other `src/ui` files are: `cn` from `../lib/cn`, `Button`/`buttonVariants` from `./button`, and
the registry's `IconPlaceholder` replaced by lucide's `ChevronLeftIcon` / `ChevronRightIcon` / `ChevronDownIcon`
(same `className` handling as the registry's `Chevron` component). No other change; record in the ledger if the
typecheck needs any.

- [ ] **Step 2: The failing tests**

`test/unit/datetime-editor.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { CellValue } from "../../src/contract";
import { CellEditor } from "../../src/edit/cell-editor";
import { DateTimePicker } from "../../src/edit/datetime-picker";
import { col } from "../../src/mock";

const TSTZ = col("created_at", "timestamptz", "timestamp with time zone", { nullable: false });
const DATE = col("birthday", "date", "date");
const NOW = () => new Date(Date.UTC(2026, 8, 25, 15, 0, 0));

function Picker({ start, kind = "timestamptz" as const, nullable = false }: { start: string; kind?: "date" | "timestamptz"; nullable?: boolean }) {
  const [text, setText] = useState<string | null>(start);
  return (
    <>
      <output data-testid="text">{String(text)}</output>
      <DateTimePicker kind={kind} text={text ?? ""} nullable={nullable} now={NOW} onPick={setText} />
    </>
  );
}
const text = () => screen.getByTestId("text").textContent;
const day = (n: number) =>
  within(screen.getByRole("group", { name: "Pick a date" })).getAllByRole("button", { name: new RegExp(`\\b${n}(st|nd|rd|th)?\\b`) })[0] as HTMLElement;

describe("the date/time picker", () => {
  test("picking a day on a timestamptz keeps its time, fraction and offset", () => {
    render(<Picker start="2026-09-25 12:43:35.257072+00" />);
    fireEvent.click(day(10));
    expect(text()).toBe("2026-09-10 12:43:35.257072+00");
  });

  test("picking an hour keeps everything else", () => {
    render(<Picker start="2026-09-25 12:43:35.257072-03" />);
    fireEvent.click(within(screen.getByRole("group", { name: "Hour" })).getByRole("button", { name: "08" }));
    expect(text()).toBe("2026-09-25 08:43:35.257072-03");
  });

  test("the current value is shown: its day selected, its hour pressed", () => {
    render(<Picker start="2026-09-25 12:43:35.257072+00" />);
    expect(screen.getByRole("group", { name: "Pick a date" }).querySelector("[aria-selected=true]")?.textContent).toBe("25");
    expect(within(screen.getByRole("group", { name: "Hour" })).getByRole("button", { name: "12" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("shortcuts write concrete text; NULL only on nullable columns", () => {
    render(<Picker start="1980-02-07" kind="date" />);
    expect(screen.queryByRole("button", { name: "NULL" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "tomorrow" }));
    expect(text()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.queryByRole("group", { name: "Hour" })).toBeNull();
  });

  test("NULL is offered on nullable columns and picks NULL", () => {
    render(<Picker start="2026-09-25 12:00:00+00" nullable />);
    fireEvent.click(screen.getByRole("button", { name: "NULL" }));
    expect(text()).toBe("null");
  });

  test("an empty or unparsable value starts from today", () => {
    render(<Picker start="" />);
    fireEvent.click(within(screen.getByRole("group", { name: "Hour" })).getByRole("button", { name: "08" }));
    expect(text()).toMatch(/^\d{4}-\d{2}-\d{2} 08:00:00[+-]\d{2}(:\d{2})?$/);
  });
});

describe("the cell editor of a date/time column", () => {
  function Editor({ value }: { value: CellValue }) {
    const [out, setOut] = useState<string>("");
    return (
      <>
        <output data-testid="out">{out}</output>
        <CellEditor column={TSTZ} value={value} onCommit={(v) => setOut(`commit:${String(v)}`)} onCancel={() => setOut("cancel")} />
      </>
    );
  }
  const out = () => screen.getByTestId("out").textContent;

  test("opens the picker; a picked day goes to the input, Enter commits it", () => {
    render(<Editor value="2026-09-25 12:43:35.257072+00" />);
    const input = screen.getByLabelText("Edit created_at") as HTMLInputElement;
    fireEvent.mouseDown(day(10));
    fireEvent.click(day(10));
    expect(input.value).toBe("2026-09-10 12:43:35.257072+00");
    expect(out()).toBe("");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(out()).toBe("commit:2026-09-10 12:43:35.257072+00");
  });

  test("the calendar follows what is typed", () => {
    render(<Editor value="2026-09-25 12:43:35+00" />);
    fireEvent.change(screen.getByLabelText("Edit created_at"), { target: { value: "2025-01-15 10:20:30+02" } });
    expect(screen.getByRole("group", { name: "Pick a date" }).querySelector("[aria-selected=true]")?.textContent).toBe("15");
  });

  test("Esc cancels", () => {
    render(<Editor value="2026-09-25 12:43:35+00" />);
    fireEvent.keyDown(screen.getByLabelText("Edit created_at"), { key: "Escape" });
    expect(out()).toBe("cancel");
  });
});
```

(`day()` matches react-day-picker's accessible day names, which spell the date; adjust the matcher to what
version 10 renders if needed — the property stays "the button for day N". `DATE` is used by the shortcut test via
`kind="date"`; drop the constant if Biome flags it.)

Run: `cd packages/studio && bun test ./test/unit/datetime-editor.test.tsx` → FAIL (module missing).

- [ ] **Step 3: `PopoverContent` passes `anchor`**

In `src/ui/popover.tsx`, add `"anchor"` to the `Pick<PopoverPrimitive.Positioner.Props, …>` list, destructure
`anchor`, and pass `anchor={anchor}` to `<PopoverPrimitive.Positioner>`.

- [ ] **Step 4: `src/edit/datetime-picker.tsx`**

```tsx
import type { MouseEvent } from "react";
import { cn } from "../lib/cn";
import {
  browserOffset,
  formatPgTime,
  type PgTime,
  parsePgTime,
  type Shortcut,
  shortcut,
  type TimeKind,
  withDay,
  withTime,
} from "../lib/pgtime";
import { Calendar } from "../ui/calendar";

export interface DateTimePickerProps {
  kind: TimeKind;
  /** The text being edited; what does not parse is replaced by today when a part is picked. */
  text: string;
  nullable: boolean;
  now?: () => Date;
  /** null: NULL. */
  onPick(text: string | null): void;
}

const SHORTCUTS: Shortcut[] = ["now", "today", "tomorrow", "yesterday"];
const ITEM = "h-7 rounded-md px-2 text-left font-mono text-xs hover:bg-muted aria-pressed:bg-primary aria-pressed:text-primary-foreground";
// A pick must not take focus from the editor's input: its blur would commit.
const keepFocus = (e: MouseEvent) => e.preventDefault();

function TimeColumn({ label, max, value, onPick }: { label: string; max: number; value: number; onPick(n: number): void }) {
  return (
    <div role="group" aria-label={label} className="flex h-64 flex-col overflow-y-auto border-l px-1 py-1">
      {Array.from({ length: max }, (_, n) => (
        <button
          key={n}
          type="button"
          aria-pressed={n === value}
          onMouseDown={keepFocus}
          onClick={() => onPick(n)}
          className={cn(ITEM, "shrink-0 text-center")}
        >
          {String(n).padStart(2, "0")}
        </button>
      ))}
    </div>
  );
}

export function DateTimePicker({ kind, text, nullable, now = () => new Date(), onPick }: DateTimePickerProps) {
  const current = parsePgTime(kind, text);
  const base = (): PgTime => current ?? shortcut(kind, "today", now(), browserOffset(now()));
  const pick = (t: PgTime) => onPick(formatPgTime(t));
  const selected = current ? new Date(current.year, current.month - 1, current.day) : undefined;
  return (
    <div className="flex rounded-lg border bg-popover text-popover-foreground shadow-md">
      <div className="flex min-w-24 flex-col gap-0.5 border-r p-1.5">
        {nullable && (
          <button type="button" className={ITEM} onMouseDown={keepFocus} onClick={() => onPick(null)}>
            NULL
          </button>
        )}
        {SHORTCUTS.map((s) => (
          <button
            key={s}
            type="button"
            className={ITEM}
            onMouseDown={keepFocus}
            onClick={() => pick(shortcut(kind, s, now(), browserOffset(now())))}
          >
            {s}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Pick a date" onMouseDown={keepFocus}>
        <Calendar
          mode="single"
          // Keyed by month: the calendar shows the month of what is typed, not the one it opened on.
          key={current ? `${current.year}-${current.month}` : "today"}
          defaultMonth={selected}
          selected={selected}
          onSelect={(d) => {
            if (d) pick(withDay(base(), d.getFullYear(), d.getMonth() + 1, d.getDate()));
          }}
        />
      </div>
      {kind !== "date" && (
        <>
          <TimeColumn label="Hour" max={24} value={current?.hour ?? -1} onPick={(n) => pick(withTime(base(), "hour", n))} />
          <TimeColumn label="Minute" max={60} value={current?.minute ?? -1} onPick={(n) => pick(withTime(base(), "minute", n))} />
          <TimeColumn label="Second" max={60} value={current?.second ?? -1} onPick={(n) => pick(withTime(base(), "second", n))} />
        </>
      )}
    </div>
  );
}
```

(The calendar's `Date` is a local calendar day: only its year/month/day are read, never its instant.)

- [ ] **Step 5: The cell editor opens the picker for date kinds**

In `src/edit/cell-editor.tsx`:
- imports: `isTimeKind` from `../lib/pgtime`, `DateTimePicker` from `./datetime-picker`, `Popover`/`PopoverContent`
  from `../ui/popover`, and `useRef` is already there — add an `anchor` ref: `const inputRef = useRef<HTMLInputElement | null>(null);`
  and set it in the input's ref callback together with `focusOnMount`.
- after the `<input …/>` (inside the fragment), add:

```tsx
      {isTimeKind(column.kind) && (
        <Popover open modal={false}>
          <PopoverContent anchor={inputRef} align="start" initialFocus={false} finalFocus={false} className="w-auto p-0">
            <DateTimePicker
              kind={column.kind}
              text={text}
              nullable={column.nullable}
              onPick={(t) => (t === null ? finish(() => onCommit(null)) : setText(t))}
            />
          </PopoverContent>
        </Popover>
      )}
```

- `onBlur` must ignore a blur towards the popover: `onBlur={(e) => { if (e.relatedTarget instanceof Node && document.querySelector("[data-slot=popover-content]")?.contains(e.relatedTarget)) return; … }}` — keep the existing body after the guard. (Buttons prevent the focus move already; this guards keyboard focus into the popover.)

- [ ] **Step 6: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test/unit/datetime-editor.test.tsx ./test/unit/grid-edit.test.tsx` → all pass.
If Base UI's Popover does not position in happy-dom it still renders its content; if it does not render at all,
record it in the ledger and move the two cell-editor tests to the e2e of Task 7.

Sabotages (restore with `cp`): (1) `DateTimePicker`'s day pick uses `shortcut(kind, "today", …)` as base
instead of `base()` → first test red; (2) drop the `key` on `Calendar` → `the calendar follows what is typed` red;
(3) show `NULL` unconditionally → shortcut test red; (4) the pick commits instead of setting the text
(`finish(() => onCommit(t))`) → `Enter commits it` red on `expect(out()).toBe("")`.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio bun.lock
git commit -m "feat(studio): a date/time picker — shortcuts, calendar and time columns that keep what they do not touch"
```

---

### Task 4: `CodeEditor` — CodeMirror 6, loaded when first needed

**Files:**
- Create: `packages/studio/src/edit/code-editor.tsx`, `src/edit/codemirror.tsx`
- Modify: `packages/studio/package.json`, `bun.lock`, `src/edit/expanded-editor.tsx`, `src/studio/studio.tsx`,
  `src/index.ts`
- Test: `packages/studio/test/unit/code-editor.test.tsx`

**Interfaces:**
- Produces: `type CodeEditorMode = "codemirror" | "textarea"`; `CodeEditorContext` (default `"textarea"`);
  `CodeEditor(props: { label: string; value: string; onChange(text: string): void; onBlur?(): void;
  onSubmit?(): void; invalid?: boolean; className?: string })`; `StudioProps.codeEditor?: CodeEditorMode`
  (default `"codemirror"`), exported type `CodeEditorMode` from `src/index.ts`. The textarea and CodeMirror's
  content element carry `aria-label={label}`; CodeMirror's content has role `textbox`.

- [ ] **Step 1: Dependencies**

Run: `cd packages/studio && bun add @codemirror/state@6.7.6 @codemirror/view@6.43.13 @codemirror/commands@6.11.1 @codemirror/language@6.12.4 @codemirror/lang-json@6.0.2`

- [ ] **Step 2: The failing tests**

`test/unit/code-editor.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CodeEditor, CodeEditorContext } from "../../src/edit/code-editor";

test("outside a studio it is a plain textarea", () => {
  let text = "";
  render(<CodeEditor label="Value of profile" value="{}" onChange={(t) => (text = t)} />);
  const area = screen.getByLabelText("Value of profile");
  expect(area.tagName).toBe("TEXTAREA");
  fireEvent.change(area, { target: { value: '{"a":1}' } });
  expect(text).toBe('{"a":1}');
});

test("in codemirror mode the textarea works until the editor has loaded, then CodeMirror replaces it", async () => {
  render(
    <CodeEditorContext value="codemirror">
      <CodeEditor label="Value of profile" value='{"a":1}' onChange={() => {}} />
    </CodeEditorContext>,
  );
  expect(screen.getByLabelText("Value of profile").tagName).toBe("TEXTAREA");
  await act(() => new Promise((r) => setTimeout(r, 200)));
  const content = screen.getByLabelText("Value of profile");
  expect(content.classList.contains("cm-content")).toBe(true);
  expect(content.textContent).toContain('"a"');
});
```

Run: `cd packages/studio && bun test ./test/unit/code-editor.test.tsx` → FAIL (module missing).
(If CodeMirror cannot mount under happy-dom, the second test keeps only its first assertion and the swap is
proved by Task 7's e2e; record it in the ledger.)

- [ ] **Step 3: `src/edit/code-editor.tsx`**

```tsx
import { createContext, type ComponentType, useContext, useEffect, useState } from "react";

export type CodeEditorMode = "codemirror" | "textarea";

/** The studio provides "codemirror"; anything rendered outside it stays a textarea. */
export const CodeEditorContext = createContext<CodeEditorMode>("textarea");

export interface CodeEditorProps {
  label: string;
  value: string;
  onChange(text: string): void;
  onBlur?(): void;
  /** Cmd/Ctrl+Enter. */
  onSubmit?(): void;
  invalid?: boolean;
  className?: string;
}

let loaded: ComponentType<CodeEditorProps> | null = null;

/** Multi-line code (json, arrays). CodeMirror is its own chunk: fetched the first time one is shown, never before. */
export function CodeEditor(props: CodeEditorProps) {
  const mode = useContext(CodeEditorContext);
  const [Editor, setEditor] = useState<ComponentType<CodeEditorProps> | null>(() => (mode === "codemirror" ? loaded : null));
  useEffect(() => {
    if (mode !== "codemirror" || Editor) return;
    let live = true;
    import("./codemirror").then(
      (m) => {
        loaded = m.CodeMirrorEditor;
        if (live) setEditor(() => m.CodeMirrorEditor);
      },
      // A chunk that cannot load (offline, a CSP) leaves the textarea, which edits the same text.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [mode, Editor]);
  if (Editor) return <Editor {...props} />;
  return (
    <textarea
      aria-label={props.label}
      className={
        props.className ??
        "h-64 w-full resize-y rounded-lg border border-input bg-transparent p-2 font-mono text-sm outline-none focus-visible:border-ring aria-invalid:border-destructive"
      }
      value={props.value}
      aria-invalid={props.invalid || undefined}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") props.onSubmit?.();
      }}
    />
  );
}
```

- [ ] **Step 4: `src/edit/codemirror.tsx`**

```tsx
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { cn } from "../lib/cn";
import type { CodeEditorProps } from "./code-editor";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)" },
  ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--border)", color: "var(--muted-foreground)" },
  "&.cm-focused": { outline: "none" },
});

export function CodeMirrorEditor({ label, value, onChange, onBlur, onSubmit, invalid, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onBlur, onSubmit });
  handlers.current = { onChange, onBlur, onSubmit };

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; later values arrive through the effect below
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle),
          json(),
          keymap.of([
            { key: "Mod-Enter", run: () => (handlers.current.onSubmit?.(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
          ]),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({ blur: () => (handlers.current.onBlur?.(), false) }),
          theme,
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  // A value set from outside (Format, a push while not editing) replaces the document; typing does not loop back.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={host}
      data-invalid={invalid || undefined}
      className={cn("h-64 w-full overflow-hidden rounded-lg border border-input data-invalid:border-destructive", className)}
    />
  );
}
```

- [ ] **Step 5: Use it**

- `src/edit/expanded-editor.tsx`: replace the `<textarea …/>` with
  `<CodeEditor label={`Value of ${column.name}`} value={text} onChange={setText} onSubmit={save} invalid={!parsed.ok} />`.
  The S3a grid test (`json opens the expanded editor…`) keeps passing: outside a studio it is a textarea.
- `src/studio/studio.tsx`: `StudioProps` gains
  `/** "textarea" keeps CodeMirror's chunk from ever loading (a strict CSP, a smaller host). */ codeEditor?: CodeEditorMode;`
  destructure it with default `"codemirror"`, and wrap the returned tree in `<CodeEditorContext value={codeEditor}>`.
- `src/index.ts`: `export type { CodeEditorMode } from "./edit/code-editor";`.
- Studio unit tests that type into a json editor (`studio-edit.test.tsx`, if any does) pass `codeEditor="textarea"`.

- [ ] **Step 6: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"` → all pass.

Sabotages (restore with `cp`): (1) `CodeEditorContext` defaults to `"codemirror"` → `outside a studio it is a plain
textarea` red; (2) `CodeEditor` never swaps (`if (Editor)` → `if (false)`) → the second test red (or, if it was
reduced, the e2e of Task 7).

Check the chunk: `cd packages/studio && bunx vite build --outDir /tmp/studio-build 2>&1 | grep -E "\.js "` — a
separate chunk holds `@codemirror` and the entry chunk does not (`rg -l "cm-content" /tmp/studio-build/assets`
names only the CodeMirror chunk). Record both sizes (gzip) in `packages/studio/NOTES.md` (Task 7).

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio bun.lock
git commit -m "feat(studio): CodeEditor — CodeMirror 6 for json and arrays, loaded on first use, textarea fallback"
```

---

### Task 5: The Expand Row panel

**Files:**
- Create: `packages/studio/src/edit/row-panel.tsx`
- Modify: `packages/studio/src/edit/draft.ts` (`revertCell`), `src/grid/data-grid.tsx`, `src/grid/resize-handle.tsx`
  (`edge`), `src/studio/studio.tsx`
- Test: `packages/studio/test/unit/draft.test.ts` (revert), `test/unit/row-panel.test.tsx`

**Interfaces:**
- Produces: `revertCell(draft, rowId, column): TableDraft`; `GridEditing.onExpandRow(rowId)`,
  `GridEditing.onFocusRow(rowId)` (a cell of that row was selected or started editing); lead cells gain a button
  `Expand row` (`LEAD_WIDTH` becomes 56); `ResizeHandleProps.edge?: "right" | "left"` (left: dragging left widens);
  `RowPanel(props: RowPanelProps)`:

```ts
export interface RowPanelProps {
  table: TableInfo;
  /** null: the row is not on the page any more (deleted, or moved by a change elsewhere). */
  row: { id: string; isNew: boolean; key: RowKey | null; live: Row } | null;
  draft: TableDraft;
  conflicts: ReadonlySet<string>;
  width: number;
  onResize(width: number): void;
  onEditExisting(rowId: string, key: RowKey, column: string, value: CellValue, original: CellValue): void;
  onEditNew(id: string, column: string, value: CellValue | undefined): void;
  onRevert(rowId: string, column: string): void;
  onClose(): void;
}
```

  DOM: `complementary` labelled `Row`; per column a field labelled `<column>` (input, select, CodeEditor, or input
  + a `Pick a date` button that opens the picker); an edited field has `data-pending` and a button
  `Revert <column>`; a conflicted field `data-conflict` and the text `changed elsewhere`; a required, unset field of
  a new row `data-missing`; a `Close` button. `<Studio>` renders it docked right of the grid.

- [ ] **Step 1: The failing tests**

In `test/unit/draft.test.ts` add (import `revertCell`):

```ts
test("revertCell drops one pending cell; the row goes when it was the last", () => {
  let d = setCell(EMPTY_DRAFT, "r1", K, "name", "b", "a");
  d = setCell(d, "r1", K, "age", 3, 2);
  d = revertCell(d, "r1", "name");
  expect(Object.keys(d.updates["r1"]?.cells ?? {})).toEqual(["age"]);
  expect(revertCell(d, "r1", "age").updates["r1"]).toBeUndefined();
});
```

`test/unit/row-panel.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_VIEW, type Page, Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const USERS = { schema: "public", name: "users" };
const seed = demoDataset(1).tables[0]?.rows ?? [];
const idOf = (n: number) => seed[n - 1]?.["id"] ?? null;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

function setup() {
  const log = createMemoryLog();
  const ds = createMockDataSource({ dataset: demoDataset(1), log });
  const other = createMockDataSource({ dataset: demoDataset(1), log });
  render(<Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />);
  const seen: Page[] = [];
  other.subscribePage({ table: USERS, filters: [], sort: [], limit: 5, offset: 0, withTotal: true }, (p) => seen.push(p), () => {});
  return { other, nameIn: (n: number) => seen.at(-1)?.rows[n - 1]?.["name"] };
}
const grid = () => within(screen.getByRole("grid"));
const panel = () => within(screen.getByRole("complementary", { name: "Row" }));
const rowOf = (text: string) => grid().getByText(text).closest("[role=row]") as HTMLElement;
async function open(text: string) {
  fireEvent.click(within(rowOf(text)).getByRole("button", { name: "Expand row" }));
  return panel();
}
function type(field: HTMLElement, to: string) {
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: to } });
  fireEvent.blur(field);
}

describe("the Expand Row panel", () => {
  test("shows every column of the row, with its type", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    expect((p.getByLabelText("email") as HTMLInputElement).value).toBe("user1@example.com");
    expect(p.getByText("timestamp with time zone")).toBeTruthy();
    expect((p.getByLabelText("role") as HTMLSelectElement).tagName).toBe("SELECT");
    expect(p.getByLabelText("profile").tagName).toBe("TEXTAREA");
  });

  test("an edit in the panel is a pending edit of the grid, saved by the same save", async () => {
    const { nameIn } = setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    type(p.getByLabelText("name"), "From the panel");
    expect(grid().getByText("From the panel").closest("[role=gridcell]")?.getAttribute("data-pending")).toBe("true");
    expect(p.getByLabelText("name").closest("[data-pending]")).toBeTruthy();
    const bar = within(screen.getByRole("region", { name: "Unsaved changes" }));
    await act(async () => fireEvent.click(bar.getByRole("button", { name: "Save changes" })));
    await settle();
    expect(nameIn(1)).toBe("From the panel");
  });

  test("revert drops that field's edit only", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    type(p.getByLabelText("name"), "X");
    type(p.getByLabelText("email"), "x@example.com");
    fireEvent.click(p.getByRole("button", { name: "Revert name" }));
    expect((p.getByLabelText("name") as HTMLInputElement).value).toBe("User 1");
    expect(within(screen.getByRole("region", { name: "Unsaved changes" })).getByText("1 unsaved change")).toBeTruthy();
  });

  test("the panel follows the selected row; the other row's edit stays", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    type(p.getByLabelText("name"), "Edited 1");
    fireEvent.click(grid().getByText("User 2"));
    expect((panel().getByLabelText("name") as HTMLInputElement).value).toBe("User 2");
    expect(grid().getByText("Edited 1").closest("[role=gridcell]")?.getAttribute("data-pending")).toBe("true");
  });

  test("a change elsewhere to a field being edited keeps what was typed and becomes a conflict", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    const name = p.getByLabelText("name") as HTMLInputElement;
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Mine" } });
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Theirs" } }]));
    await settle();
    expect(name.value).toBe("Mine");
    fireEvent.blur(name);
    expect(await panel().findByText(/changed elsewhere/)).toBeTruthy();
    expect(name.closest("[data-conflict]")).toBeTruthy();
  });

  test("a field of another row, unfocused, shows pushes as they arrive", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Pushed" } }]));
    await settle();
    expect((p.getByLabelText("name") as HTMLInputElement).value).toBe("Pushed");
  });

  test("a row deleted elsewhere says so; its panel does not vanish", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    await open("User 1");
    await act(() => other.deleteRows(USERS, [{ id: idOf(1) }]));
    await settle();
    expect(panel().getByText(/not on this page any more/)).toBeTruthy();
  });

  test("a new row opens in the panel; required fields are marked; NULL is not offered on NOT NULL selects", async () => {
    setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    fireEvent.click(within(newRow).getByRole("button", { name: "Expand row" }));
    const p = panel();
    expect(p.getByLabelText("email").closest("[data-missing]")).toBeTruthy();
    const role = p.getByLabelText("role") as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).not.toContain("NULL");
    type(p.getByLabelText("email"), "new@example.com");
    expect(p.getByLabelText("email").closest("[data-missing]")).toBeNull();
  });

  test("Close closes it", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    fireEvent.click(p.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Row" })).toBeNull();
  });
});
```

Run: `cd packages/studio && bun test ./test/unit/row-panel.test.tsx ./test/unit/draft.test.ts` → FAIL.

- [ ] **Step 2: `revertCell`**

In `src/edit/draft.ts`, after `discardRow`:

```ts
export function revertCell(draft: TableDraft, rowId: string, column: string): TableDraft {
  const row = draft.updates[rowId];
  if (!row?.cells[column]) return draft;
  const cells = { ...row.cells };
  delete cells[column];
  const updates = { ...draft.updates };
  if (Object.keys(cells).length === 0) delete updates[rowId];
  else updates[rowId] = { ...row, cells };
  return { ...draft, updates };
}
```

- [ ] **Step 3: `ResizeHandle` edge**

`ResizeHandleProps` gains `edge?: "right" | "left"`; with `"left"` the width is `width - (x - startX)` and
ArrowLeft widens; the element sits at `left-0` instead of `right-0`.

- [ ] **Step 4: `src/edit/row-panel.tsx`**

A field component per column, then the panel:

```tsx
import { CalendarDays, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CellValue, ColumnInfo, Row, RowKey, TableInfo } from "../contract";
import { isTimeKind } from "../lib/pgtime";
import { ResizeHandle } from "../grid/resize-handle";
import { cellKey } from "../studio/format";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CodeEditor } from "./code-editor";
import { DateTimePicker } from "./datetime-picker";
import type { TableDraft } from "./draft";
import { opensExpanded, parseCellValue, textForEditing } from "./values";

export interface RowPanelProps { /* as in Interfaces */ }

interface FieldProps {
  column: ColumnInfo;
  /** undefined: a new row's column at its DEFAULT. */
  value: CellValue | undefined;
  live: CellValue;
  isNew: boolean;
  pending: boolean;
  conflict: boolean;
  missing: boolean;
  onCommit(value: CellValue | undefined, original: CellValue): void;
  onRevert(): void;
}

const textOf = (c: ColumnInfo, v: CellValue | undefined) => (v === undefined || v === null ? "" : textForEditing(c, v));
const INPUT = "h-8 w-full rounded-md border border-input bg-transparent px-2 font-mono text-[13px] outline-none focus-visible:border-ring aria-invalid:border-destructive";

function Field({ column, value, live, isNew, pending, conflict, missing, onCommit, onRevert }: FieldProps) {
  const [text, setText] = useState(textOf(column, value));
  // While editing, pushes do not touch what is typed, and the value it started from is what a save expects.
  const [editing, setEditing] = useState<{ original: CellValue } | null>(null);
  useEffect(() => {
    if (!editing) setText(textOf(column, value));
  }, [column, value, editing]);
  const parsed = parseCellValue(column, text);
  const begin = () => setEditing((e) => e ?? { original: live });
  const end = () => {
    const original = editing?.original ?? live;
    setEditing(null);
    if (text === textOf(column, value)) return;
    if (parsed.ok) onCommit(parsed.value ?? null, original);
  };
  const id = `field-${column.name}`;
  const choices = column.kind === "boolean" ? ["true", "false"] : column.kind === "enum" ? (column.enumValues ?? []) : null;

  let control;
  if (choices) {
    control = (
      <select
        id={id}
        className={INPUT}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => {
          const t = e.target.value;
          onCommit(t === "" ? null : column.kind === "boolean" ? t === "true" : t, live);
        }}
      >
        {(value === undefined || value === null) && !column.nullable && <option value="" disabled>{isNew && column.hasDefault ? "DEFAULT" : "choose…"}</option>}
        {column.nullable && <option value="">NULL</option>}
        {choices.map((c) => <option key={c} value={c}>{column.kind === "boolean" ? c.toUpperCase() : c}</option>)}
      </select>
    );
  } else if (opensExpanded(column)) {
    control = (
      <div onFocus={begin}>
        <CodeEditor label={column.name} value={text} onChange={setText} onBlur={end} invalid={!parsed.ok} className="h-40" />
      </div>
    );
  } else {
    control = (
      <div className="flex gap-1">
        <input
          id={id}
          className={INPUT}
          value={text}
          placeholder={value === undefined ? (column.hasDefault ? "DEFAULT" : "NULL") : value === null ? "NULL" : undefined}
          aria-invalid={!parsed.ok || undefined}
          onFocus={begin}
          onChange={(e) => setText(e.target.value)}
          onBlur={end}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {isTimeKind(column.kind) && (
          <Popover>
            <PopoverTrigger render={<Button type="button" variant="outline" size="icon-sm" aria-label="Pick a date" />}>
              <CalendarDays />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-0">
              <DateTimePicker
                kind={column.kind}
                text={text}
                nullable={column.nullable}
                onPick={(t) => onCommit(t, editing?.original ?? live)}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
    );
  }

  return (
    <div data-pending={pending || undefined} data-conflict={conflict || undefined} data-missing={missing || undefined}
      className="flex flex-col gap-1 rounded-md p-1 data-pending:bg-edit/40 data-conflict:ring-2 data-conflict:ring-destructive data-missing:ring-1 data-missing:ring-destructive">
      <div className="flex items-center gap-1 text-xs">
        <label htmlFor={id} className="font-medium">{column.name}</label>
        {pending && (
          <button type="button" aria-label={`Revert ${column.name}`} onClick={onRevert} className="text-edit-foreground">
            <RotateCcw className="size-3" />
          </button>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{column.pgType}</span>
      </div>
      {control}
      {conflict && <p className="text-[11px] text-destructive">changed elsewhere to {textOf(column, live) || "NULL"}</p>}
      {!parsed.ok && editing && <p role="alert" className="text-[11px] text-destructive">{parsed.error}</p>}
    </div>
  );
}
```

(For the CodeEditor the label is the editor's own `aria-label`, so `getByLabelText(column.name)` finds the textarea
or CodeMirror's content; a code field renders its name as a `<span>`, and only inputs and selects get the
`<label htmlFor>`, so no label points at nothing. The fragment `let control;` gets its
type `let control: ReactNode;` with `import type { ReactNode } from "react"`.)

The panel:

```tsx
export function RowPanel(p: RowPanelProps) {
  const row = p.row;
  return (
    <aside aria-label="Row" className="relative flex shrink-0 flex-col border-l bg-background" style={{ width: p.width }}>
      <ResizeHandle name="row panel" width={p.width} edge="left" onResize={(w) => p.onResize(w)} />
      <div className="flex h-10 items-center border-b px-3 text-sm font-medium">
        {row?.isNew ? "New row" : "Row"}
        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" onClick={p.onClose}>
          <X />
        </Button>
      </div>
      {row === null ? (
        <p className="p-3 text-sm text-muted-foreground">
          This row is not on this page any more: deleted, or moved by a change elsewhere. Its unsaved edits are kept.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {p.table.columns.map((c) => {
            const pendingCell = row.isNew ? undefined : p.draft.updates[row.id]?.cells[c.name];
            const newValues = row.isNew ? p.draft.inserts.find((r) => r.id === row.id)?.values : undefined;
            const value = row.isNew
              ? newValues && Object.hasOwn(newValues, c.name) ? (newValues[c.name] ?? null) : undefined
              : pendingCell ? pendingCell.value : (row.live[c.name] ?? null);
            return (
              <Field
                key={`${row.id}\u0000${c.name}`}
                column={c}
                value={value}
                live={row.live[c.name] ?? null}
                isNew={row.isNew}
                pending={row.isNew ? value !== undefined : Boolean(pendingCell)}
                conflict={p.conflicts.has(cellKey(row.id, c.name))}
                missing={row.isNew && (value ?? null) === null && !c.nullable && !c.hasDefault}
                onCommit={(v, original) => {
                  if (row.isNew) p.onEditNew(row.id, c.name, v);
                  else if (row.key && v !== undefined) p.onEditExisting(row.id, row.key, c.name, v, original);
                }}
                onRevert={() => (row.isNew ? p.onEditNew(row.id, c.name, undefined) : p.onRevert(row.id, c.name))}
              />
            );
          })}
        </div>
      )}
    </aside>
  );
}
```

(Fields are keyed by row and column: switching rows remounts them, so an edit in progress never leaks to the next
row. `live` of a new row is `{}`.)

- [ ] **Step 5: The grid**

In `src/grid/data-grid.tsx`: `LEAD_WIDTH = 56`; `GridEditing` gains `onExpandRow(rowId: string): void;` and
`onFocusRow(rowId: string): void;`; the lead cell renders, after the checkbox / remove button:

```tsx
                  <button type="button" aria-label="Expand row" title="Expand row" onClick={() => editing.onExpandRow(d.id)} className="text-muted-foreground hover:text-foreground">
                    <Maximize2 className="size-3.5" />
                  </button>
```

(lead cell class gains `gap-1.5`; import `Maximize2` from lucide-react), and `onSelect` / `startEditing` call
`editing?.onFocusRow(ref.rowId)`.

- [ ] **Step 6: `<Studio>`**

In `src/studio/studio.tsx`:
- state: `const [panel, setPanel] = useState<{ table: string; rowId: string } | null>(null);` and
  `const [panelWidth, setPanelWidth] = useState(380);`; a `useEffect` on `view.table` closes a panel of another
  table (`setPanel((p) => (p && p.table !== view.table ? null : p))`).
- `gridEditing` gains `onExpandRow: (rowId) => setPanel({ table: draftKey, rowId })` and
  `onFocusRow: (rowId) => setPanel((p) => (p ? { ...p, rowId } : p))`.
- the panel's row: `const panelRow = panel && table ? (() => { const n = draft.inserts.find((r) => r.id === panel.rowId); if (n) return { id: n.id, isNew: true, key: null, live: {} }; const r = pageRows.find((x) => x.id === panel.rowId); return r ? { id: r.id, isNew: false, key: Object.fromEntries(table.primaryKey.map((k) => [k, r.row[k] ?? null])), live: r.row } : null; })() : null;`
- after a successful save, a panel on a new row that was sent follows it to its key: in `save`, keep
  `const { inserted } = await dataSource.applyEdits(…)`, then
  `setPanel((p) => { const i = sent.inserts.findIndex((r) => r.id === p?.rowId); const k = inserted[i]; return p && k ? { ...p, rowId: rowIdOf(table.primaryKey, k, 0) } : p; });`
- layout: the body becomes `<div className="flex min-h-0 flex-1"><div className="min-w-0 flex-1">{body}</div>{editable && panel && <RowPanel … />}</div>`
  with `onRevert={(rowId, column) => updateDraft(draftKey, (d) => revertCell(d, rowId, column))}` and the same
  `onEditExisting` / `onEditNew` as `gridEditing`.

- [ ] **Step 7: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"` → all pass.

Sabotages (restore with `cp`):
1. `Field.end` passes `live` instead of `editing?.original ?? live` → `a change elsewhere … becomes a conflict` red
   (the save would expect theirs).
2. The `useEffect` syncs `text` even while editing (drop `if (!editing)`) → same test red on `name.value`.
3. Fields keyed by column only (`key={c.name}`) → `the panel follows the selected row` red, or record why not.
4. `onFocusRow` not wired → `follows the selected row` red.
5. `revertCell` deletes the whole row → `revert drops that field's edit only` red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "feat(studio): the Expand Row panel — a docked form of the row, editing the same draft, following the selection"
```

---

### Task 6: The S3a leftovers — save errors per table, delete counts what is there

**Files:**
- Modify: `packages/studio/src/studio/studio.tsx`
- Test: `packages/studio/test/unit/studio-edit.test.tsx`

- [ ] **Step 1: The failing tests**

Add to `describe("editing in the studio"` in `test/unit/studio-edit.test.tsx`:

```tsx
  test("a failed save belongs to its table: another table shows no error, and it is still there on return", async () => {
    setup();
    await screen.findByText("User 1");
    await edit(String(idOf(2)), String(idOf(1)));
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "posts" }));
    await screen.findByText("Post 1");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "users" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already has a row");
  });

  test("delete counts only selected rows still on the page", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    const boxes = screen.getAllByRole("checkbox", { name: "Select row" });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(screen.getByRole("button", { name: "Delete 2 rows" })).toBeTruthy();
    await act(() => other.deleteRows(USERS, [{ id: idOf(1) }]));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 row" }));
    expect(within(await screen.findByRole("dialog")).getByText("Delete 1 row?")).toBeTruthy();
  });
```

Run: `cd packages/studio && bun test ./test/unit/studio-edit.test.tsx` → the two FAIL (the alert shows on posts;
the button still says `Delete 2 rows`).

- [ ] **Step 2: The fix**

In `src/studio/studio.tsx`:
- `const [saveErrors, setSaveErrors] = useState<Record<string, SaveError>>({});` replaces `saveError`;
  `const saveError = saveErrors[draftKey] ?? null;` and a helper
  `const setSaveError = (id: string, e: SaveError | null) => setSaveErrors((all) => { const next = { ...all }; if (e) next[id] = e; else delete next[id]; return next; });`
  — every former `setSaveError(x)` passes the table id (`id` in `save`, `draftKey` in the bar's handlers).
- `const doomed = pageRows.filter((r) => selectedRows.has(r.id));` moves up next to `pageRows`; `deleteSelected`
  uses it; the toolbar button shows when `doomed.length > 0` and both the button and the dialog title use
  `doomed.length`.

- [ ] **Step 3: Run, sabotage, commit**

Run: `cd packages/studio && bun test ./test 2>&1 | grep -E "^\(fail\)| pass$| fail$|Ran"` → all pass.

Sabotages (restore with `cp`): (1) `saveError` read from one global key (`saveErrors[""]` written for every table)
→ first test red; (2) the button counts `selectedRows.size` → second test red.

Run: `bunx biome check --write packages/studio && bun run check 2>&1 | grep -E "^Ran |fail"` → `0 fail`.

```bash
git add packages/studio
git commit -m "fix(studio): a save error belongs to its table; delete counts the selected rows still on the page"
```

---

### Task 7: End to end, notes, review

**Files:**
- Create: `packages/studio/e2e/editors.e2e.ts`
- Modify: `packages/studio/NOTES.md`, `packages/studio/README.md`, `docs/specs/STUDIO-00-ui-on-mocks.md`

- [ ] **Step 1: The e2e (real browser: the picker's popover, CodeMirror's chunk, the panel across tabs)**

`e2e/editors.e2e.ts`:

```ts
// The editors in a real browser: a picked day keeps the time and offset, CodeMirror loads and saves json, and the
// Expand Row panel's edit reaches another tab.
import { expect, type Page as Tab, test } from "@playwright/test";

async function openUsers(tab: Tab) {
  await tab.goto("/?v=1&table=public.users");
  await expect(tab.getByRole("gridcell", { name: "User 1", exact: true })).toBeVisible();
}
const firstRow = (tab: Tab) => tab.getByRole("row").filter({ has: tab.getByRole("gridcell", { name: "User 1", exact: true }) });

test("a picked day keeps the time, fraction and offset, and is saved for every tab", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  const cell = firstRow(a).getByRole("gridcell").filter({ hasText: /\+00$/ }).first();
  const before = (await cell.innerText()).trim();
  await cell.dblclick();
  await a.getByRole("group", { name: "Pick a date" }).getByRole("button", { name: /\b10(th)?\b/ }).first().click();
  const input = a.getByRole("textbox", { name: "Edit created_at" });
  const after = before.replace(/^\d{4}-\d{2}-\d{2}/, (d) => `${d.slice(0, 8)}10`);
  await expect(input).toHaveValue(after);
  await input.press("Enter");
  await a.getByRole("button", { name: "Save changes" }).click();
  await expect(firstRow(b).getByRole("gridcell", { name: after, exact: true })).toBeVisible();
});

test("json edits in CodeMirror, loaded on demand", async ({ page }) => {
  await openUsers(page);
  const chunks: string[] = [];
  page.on("response", (r) => chunks.push(r.url()));
  await firstRow(page).getByRole("gridcell").filter({ hasText: /"city"/ }).dblclick();
  const editor = page.getByRole("textbox", { name: "Value of profile" });
  await expect(editor).toHaveClass(/cm-content/);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('{"edited": true}');
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(firstRow(page).getByRole("gridcell", { name: '{"edited": true}' })).toHaveAttribute("data-pending", "true");
  expect(chunks.some((u) => /codemirror/i.test(u))).toBe(true);
});

test("an edit in the Expand Row panel reaches another tab", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await firstRow(a).getByRole("button", { name: "Expand row" }).click();
  const panel = a.getByRole("complementary", { name: "Row" });
  const name = panel.getByLabel("name", { exact: true });
  await name.fill("From the panel");
  await name.press("Enter");
  await a.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Save changes" }).click();
  await expect(b.getByRole("gridcell", { name: "From the panel", exact: true })).toBeVisible();
});
```

(The chunk assertion matches Vite's dev module URLs — `/node_modules/.vite/deps/@codemirror_…` or
`src/edit/codemirror.tsx`; adjust the regex to what the dev server serves, keeping "a CodeMirror module was
fetched after the page loaded". The json cell text is `formatCell`'s: the raw json string.)

Run: `cd packages/studio && bun run test:e2e` → `14 passed`. Three times.

Sabotage: `DateTimePicker`'s day pick drops the time (Task 1 sabotage 1 applied in `pgtime.ts`) → the first e2e red.
Restore with `cp`.

- [ ] **Step 2: NOTES.md — append**

```markdown
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
  opens new rows too. It opens from a button in the row's lead cell until the context menu (S4).
- CodeMirror 6 is its own chunk, fetched on first use (entry: <N> kB gzip; CodeMirror chunk: <M> kB gzip);
  `codeEditor="textarea"` keeps it from ever loading.
```

(Fill `<N>`/`<M>` from Task 4's build check.)

- [ ] **Step 3: README — in "Embedding", add**

```markdown
`codeEditor="textarea"` replaces CodeMirror (json and array editing) with a plain textarea, so its chunk never
loads — for a strict CSP or a smaller host.
```

- [ ] **Step 4: Spec progress**

In the **Progress** paragraph, before "Next:", add
`S3b (\`docs/superpowers/plans/2026-09-25-studio-00-3b-editors.md\`): a date/time picker that edits Postgres text by
parts, the Expand Row panel on the same draft, CodeMirror 6 loaded on demand; save errors per table.` and change
"Next: S3b (…); S4" to "Next: S4".

- [ ] **Step 5: Verify, commit, review**

Run: `bun run check && bun run test 2>&1 | grep -E "Ran |passed|failed| fail$"` → green; record the counts
(unit: 178 + the new tests; e2e 14).

```bash
git add packages/studio docs/specs/STUDIO-00-ui-on-mocks.md
git commit -m "test(studio): editors end to end; S3b notes, embedding note, progress"
```

A fresh reviewer (most capable model) reviews the branch. Critical/Important are fixed with a failing test first;
minors are recorded. Before merging, compare `git rev-parse main` with `git merge-base main HEAD`.
