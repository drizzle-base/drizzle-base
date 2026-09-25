import type { CellValue, ColumnInfo, FilterOp } from "../contract";
import { parsePgTime } from "../lib/pgtime";

export type Parsed = { ok: true; value: CellValue | undefined } | { ok: false; error: string };

export const NO_VALUE_OPS: FilterOp[] = ["isNull", "isNotNull"];

const INT = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BYTEA = /^\\x(?:[0-9a-f]{2})*$/i;

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

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
    case "date":
      return parsePgTime("date", t) ? ok(t) : fail(`"${t}" is not a date (YYYY-MM-DD)`);
    case "timestamp":
      return parsePgTime("timestamp", t) ? ok(t) : fail(`"${t}" is not a timestamp (YYYY-MM-DD HH:MM:SS)`);
    case "timestamptz":
      return parsePgTime("timestamptz", t) ? ok(t) : fail(`"${t}" is not a timestamp (YYYY-MM-DD HH:MM:SS+00)`);
    case "json":
      return isJson(t) ? ok(t) : fail(`"${t}" is not JSON`);
    case "bytea":
      return BYTEA.test(t) ? ok(t) : fail(`"${t}" is not \\x followed by hex pairs`);
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
  // An array compares with an array literal; typing one is not offered yet, so nothing else would mean anything.
  if (col.kind === "array") return fail("array columns filter by is null or is not null only");
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
