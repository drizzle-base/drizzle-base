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
