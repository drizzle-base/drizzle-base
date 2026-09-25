import type { CellValue, ColumnInfo, Edits, Row, RowKey } from "../contract";

export interface CellEdit {
  value: CellValue;
  /** The value when the first edit of this cell began: what a save expects the row still to have. */
  original: CellValue;
}

export interface PendingRow {
  key: RowKey;
  cells: Record<string, CellEdit>;
}

/** A row to insert; `values` holds only the columns the person set (the rest take DEFAULT or NULL). */
export interface NewRow {
  id: string;
  values: Row;
}

export interface TableDraft {
  updates: Record<string, PendingRow>;
  inserts: NewRow[];
}

export interface Conflict {
  rowId: string;
  column: string;
  mine: CellValue;
  theirs: CellValue;
}

export const EMPTY_DRAFT: TableDraft = { updates: {}, inserts: [] };

const same = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function setCell(
  draft: TableDraft,
  rowId: string,
  key: RowKey,
  column: string,
  value: CellValue,
  original: CellValue,
): TableDraft {
  const cells = { ...(draft.updates[rowId]?.cells ?? {}) };
  const first = cells[column]?.original ?? original;
  if (same(value, first)) delete cells[column];
  else cells[column] = { value, original: first };
  const updates = { ...draft.updates };
  if (Object.keys(cells).length === 0) delete updates[rowId];
  else updates[rowId] = { key, cells };
  return { ...draft, updates };
}

let nextNew = 0;

export function addRow(draft: TableDraft): { draft: TableDraft; id: string } {
  const id = `new:${nextNew++}`;
  return { draft: { ...draft, inserts: [{ id, values: {} }, ...draft.inserts] }, id };
}

/** `undefined` puts the column back to its DEFAULT (or NULL). */
export function setNewCell(draft: TableDraft, id: string, column: string, value: CellValue | undefined): TableDraft {
  return {
    ...draft,
    inserts: draft.inserts.map((r) => {
      if (r.id !== id) return r;
      const values = { ...r.values };
      if (value === undefined) delete values[column];
      else values[column] = value;
      return { ...r, values };
    }),
  };
}

export function removeNewRow(draft: TableDraft, id: string): TableDraft {
  return { ...draft, inserts: draft.inserts.filter((r) => r.id !== id) };
}

export function discardRow(draft: TableDraft, rowId: string): TableDraft {
  const updates = { ...draft.updates };
  delete updates[rowId];
  return { ...draft, updates };
}

export function changeCount(draft: TableDraft): number {
  return Object.values(draft.updates).reduce((n, r) => n + Object.keys(r.cells).length, 0) + draft.inserts.length;
}

export const isDirty = (draft: TableDraft): boolean => changeCount(draft) > 0;

export function toEdits(draft: TableDraft): Edits {
  return {
    inserts: draft.inserts.map((r) => r.values),
    updates: Object.values(draft.updates).map((r) => ({
      key: r.key,
      values: Object.fromEntries(Object.entries(r.cells).map(([c, e]) => [c, e.value])),
      expected: Object.fromEntries(Object.entries(r.cells).map(([c, e]) => [c, e.original])),
    })),
  };
}

/** Pending cells whose live value is no longer the one the edit started from. Rows not on the page are unknown. */
export function findConflicts(draft: TableDraft, rows: { id: string; row: Row }[]): Conflict[] {
  const out: Conflict[] = [];
  for (const { id, row } of rows) {
    const pending = draft.updates[id];
    if (!pending) continue;
    for (const [column, e] of Object.entries(pending.cells)) {
      const theirs = row[column] ?? null;
      if (!same(theirs, e.original)) out.push({ rowId: id, column, mine: e.value, theirs });
    }
  }
  return out;
}

/** "mine" rebases the edit on their value (so a save expects theirs); "theirs" drops the edit. */
export function resolveConflict(draft: TableDraft, c: Conflict, choice: "mine" | "theirs"): TableDraft {
  const row = draft.updates[c.rowId];
  if (!row) return draft;
  const cells = { ...row.cells };
  if (choice === "theirs" || same(c.mine, c.theirs)) delete cells[c.column];
  else cells[c.column] = { value: c.mine, original: c.theirs };
  const updates = { ...draft.updates };
  if (Object.keys(cells).length === 0) delete updates[c.rowId];
  else updates[c.rowId] = { ...row, cells };
  return { ...draft, updates };
}

export function missingRequired(draft: TableDraft, columns: ColumnInfo[]): { id: string; column: string }[] {
  const required = columns.filter((c) => !c.nullable && !c.hasDefault);
  return draft.inserts.flatMap((r) =>
    required.filter((c) => (r.values[c.name] ?? null) === null).map((c) => ({ id: r.id, column: c.name })),
  );
}
