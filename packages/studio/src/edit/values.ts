import type { CellValue, ColumnInfo } from "../contract";
import { type Parsed, parseScalar } from "../view";

/** Text typed in an editor, as the column's wire value (see CellValue). Arrays are JSON arrays of their elements. */
export function parseCellValue(col: ColumnInfo, text: string): Parsed {
  if (col.kind !== "array") return parseScalar(col, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not a JSON array, e.g. ["a", "b"]' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'not a JSON array, e.g. ["a", "b"]' };
  const element: ColumnInfo = { ...col, kind: col.elementKind ?? "text" };
  const values: CellValue[] = [];
  for (const item of parsed) {
    if (item === null) {
      values.push(null);
      continue;
    }
    if (typeof item === "object") return { ok: false, error: "nested arrays and objects are not supported" };
    const p = parseScalar(element, String(item));
    if (!p.ok) return p;
    values.push(p.value ?? null);
  }
  return { ok: true, value: values };
}

export function textForEditing(col: ColumnInfo, value: CellValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (col.kind === "json" && typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return String(value);
}

/** Kinds edited in the expanded editor (multi-line), not in the cell. */
export const opensExpanded = (col: ColumnInfo): boolean => col.kind === "json" || col.kind === "array";
