import type { CellValue, ColumnInfo, Row, TableRef } from "../contract";
import { textForEditing } from "../edit/values";

const textOf = (col: ColumnInfo, v: CellValue | undefined): string => (v == null ? "" : textForEditing(col, v));

const csvField = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

export function exportJson(columns: ColumnInfo[], rows: Row[]): string {
  return `${JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((c) => [c.name, row[c.name] ?? null]))),
    null,
    2,
  )}\n`;
}

export function exportCsv(columns: ColumnInfo[], rows: Row[]): string {
  const header = columns.map((c) => csvField(c.name)).join(",");
  const body = rows.map((row) => columns.map((c) => csvField(textOf(c, row[c.name]))).join(","));
  return `${[header, ...body].join("\n")}\n`;
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function dollarQuote(value: string): string {
  let tag = "dzb";
  let n = 0;
  while (value.includes(`$${tag}$`)) {
    n += 1;
    tag = `dzb${n}`;
  }
  return `$${tag}$${value}$${tag}$`;
}

function sqlLiteral(value: CellValue): string {
  if (value === null) return "NULL";
  if (value === true) return "TRUE";
  if (value === false) return "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return dollarQuote(value);
  return dollarQuote(JSON.stringify(value));
}

export function exportSql(table: TableRef, columns: ColumnInfo[], rows: Row[]): string {
  const cols = columns.map((c) => ident(c.name)).join(", ");
  const values = rows.map((row) => `(${columns.map((c) => sqlLiteral(row[c.name] ?? null)).join(", ")})`).join(", ");
  return `INSERT INTO ${ident(table.schema)}.${ident(table.name)} (${cols}) VALUES ${values};\n`;
}

const downloadImpl = (filename: string, text: string, mime: string): void => {
  const a = document.createElement("a");
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

export let download = downloadImpl;

export const setDownloadForTests = (fn: typeof download): void => {
  download = fn;
};

export function rowsToExport(selectedIds: ReadonlySet<string>, pageRows: { id: string; row: Row }[]): Row[] {
  if (selectedIds.size === 0) return pageRows.map((r) => r.row);
  return pageRows.filter((r) => selectedIds.has(r.id)).map((r) => r.row);
}
