import type { CellValue, ColumnInfo } from "../contract";
import { textForEditing } from "../edit/values";
import { type CellRef, toTsv } from "./range";

export interface ClipboardIO {
  write(text: string): Promise<void>;
  read(): Promise<string>;
}

export const browserClipboard: ClipboardIO = {
  write: (text) => navigator.clipboard.writeText(text),
  read: () => navigator.clipboard.readText(),
};

/** One TSV row per distinct `rowId` in `cells` order, one column per distinct `column`. NULL / DEFAULT → "". */
export function valuesToTsv(
  cells: CellRef[],
  cellOf: (c: CellRef) => { col: ColumnInfo; value: CellValue | undefined },
): string {
  const rowIds: string[] = [];
  const columns: string[] = [];
  for (const c of cells) {
    if (!rowIds.includes(c.rowId)) rowIds.push(c.rowId);
    if (!columns.includes(c.column)) columns.push(c.column);
  }
  return toTsv(
    rowIds.map((rowId) =>
      columns.map((column) => {
        const { col, value } = cellOf({ rowId, column });
        if (value === null || value === undefined) return "";
        return textForEditing(col, value);
      }),
    ),
  );
}
