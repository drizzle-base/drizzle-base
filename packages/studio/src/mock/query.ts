import {
  type CellValue,
  type ColumnInfo,
  type ColumnKind,
  type Filter,
  type PageRequest,
  type Row,
  StudioDataSourceError,
} from "../contract";
import { instantOf, parsePgTime } from "../lib/pgtime";

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
    case "date":
    case "timestamp":
    case "timestamptz": {
      const x = parsePgTime(kind, textOf(a));
      const y = parsePgTime(kind, textOf(b));
      if (x && y) return Math.sign(instantOf(x) - instantOf(y));
      return textOf(a) < textOf(b) ? -1 : textOf(a) > textOf(b) ? 1 : 0;
    }
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
    if (!Array.isArray(f.value))
      throw new StudioDataSourceError("invalid_value", `"in" on "${col.name}" needs an array`);
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
): { rows: Row[]; total: number; hasMore: boolean } {
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
  return {
    rows: kept.slice(req.offset, req.offset + req.limit),
    total: kept.length,
    hasMore: req.offset + req.limit < kept.length,
  };
}
