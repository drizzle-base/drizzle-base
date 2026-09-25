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
