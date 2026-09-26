import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Maximize2, X } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { CellValue, Page, Row, RowKey, Sort, TableInfo } from "../contract";
import type { TableDraft } from "../edit/draft";
import { ExpandedEditor } from "../edit/expanded-editor";
import { opensExpanded } from "../edit/values";
import { cellKey, rowIdOf } from "../studio/format";
import type { LaidOutColumn } from "../studio/prefs";
import { type HeaderSortAction, sortPosition } from "../view";
import { GridCell } from "./grid-cell";
import { HeaderCell } from "./header-cell";
import { type CellRef, cellsInRect } from "./range";

const ROW_HEIGHT = 32;
const LEAD_WIDTH = 56;
const features = tableFeatures({});

export interface GridEditing {
  draft: TableDraft;
  /** cellKey(rowId, column) of every conflicted cell. */
  conflicts: ReadonlySet<string>;
  selectedRows: ReadonlySet<string>;
  onToggleRow(rowId: string): void;
  onToggleAll(rowIds: string[]): void;
  onEditExisting(rowId: string, key: RowKey, column: string, value: CellValue, original: CellValue): void;
  onEditNew(id: string, column: string, value: CellValue | undefined): void;
  onRemoveNew(id: string): void;
  onExpandRow(rowId: string): void;
  onFocusRow(rowId: string): void;
}

export interface DataGridProps {
  table: TableInfo;
  page: Page;
  changed: ReadonlySet<string>;
  /** Visible columns in display order, with widths (see layoutColumns). */
  columns: LaidOutColumn[];
  sort: Sort[];
  onSort(column: string, action: HeaderSortAction): void;
  onResize(column: string, width: number, commit: boolean): void;
  /** Absent: read-only. */
  editing?: GridEditing;
}

interface DisplayRow {
  id: string;
  row: Row;
  isNew: boolean;
  key: RowKey | null;
}

export function DataGrid({ table, page, changed, columns, sort, onSort, onResize, editing }: DataGridProps) {
  const inserts = editing?.draft.inserts;
  const display = useMemo<DisplayRow[]>(
    () => [
      ...(inserts ?? []).map((n) => ({ id: n.id, row: n.values, isNew: true, key: null })),
      ...page.rows.map((row, i) => ({
        id: rowIdOf(table.primaryKey, row, i),
        row,
        isNew: false,
        key: table.primaryKey.length > 0 ? Object.fromEntries(table.primaryKey.map((k) => [k, row[k] ?? null])) : null,
      })),
    ],
    [inserts, page.rows, table.primaryKey],
  );
  const defs = useMemo<ColumnDef<typeof features, DisplayRow, unknown>[]>(
    () =>
      columns.map(({ column }) => ({
        id: column.name,
        accessorFn: (d: DisplayRow) => d.row[column.name] ?? null,
        header: column.name,
      })),
    [columns],
  );
  const grid = useTable({ features, columns: defs, data: display, getRowId: (d) => d.id });
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = grid.getRowModel().rows;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [focus, setFocus] = useState<CellRef | null>(null);
  // `original` is the row's value when editing began: a push while the editor is open must not become the
  // expected value, or a save would overwrite the other person's change instead of reporting a conflict.
  const [editingCell, setEditingCell] = useState<(CellRef & { expanded: boolean; original: CellValue }) | null>(null);

  const lead = editing ? LEAD_WIDTH : 0;
  const width = lead + columns.reduce((w, c) => w + c.width, 0);
  const byId = new Map(display.map((d) => [d.id, d]));
  const existingIds = display.filter((d) => !d.isNew && d.key).map((d) => d.id);
  const allSelected = existingIds.length > 0 && existingIds.every((id) => editing?.selectedRows.has(id));
  const rowIds = display.map((d) => d.id);
  const colNames = columns.map((c) => c.column.name);
  const range =
    anchor && focus
      ? new Set(cellsInRect(anchor, focus, rowIds, colNames).map((c) => cellKey(c.rowId, c.column)))
      : new Set<string>();

  const cellValue = (d: DisplayRow, column: string): CellValue | undefined => {
    if (d.isNew) return Object.hasOwn(d.row, column) ? (d.row[column] ?? null) : undefined;
    const pending = editing?.draft.updates[d.id]?.cells[column];
    return pending ? pending.value : (d.row[column] ?? null);
  };
  const select = (ref: CellRef, extend: boolean) => {
    setFocus(ref);
    setAnchor((a) => (extend && a ? a : ref));
    editing?.onFocusRow(ref.rowId);
  };
  const startEditing = (ref: CellRef) => {
    const col = columns.find((c) => c.column.name === ref.column)?.column;
    if (!editing || !col) return;
    const d = byId.get(ref.rowId);
    setAnchor(ref);
    setFocus(ref);
    setEditingCell({ ...ref, expanded: opensExpanded(col), original: d?.row[ref.column] ?? null });
    editing.onFocusRow(ref.rowId);
  };
  const commit = (ref: CellRef, value: CellValue | undefined, move?: "next") => {
    const d = byId.get(ref.rowId);
    if (!editing || !d) return;
    const original =
      editingCell?.rowId === ref.rowId && editingCell.column === ref.column
        ? editingCell.original
        : (d.row[ref.column] ?? null);
    if (d.isNew) editing.onEditNew(d.id, ref.column, value);
    else if (d.key && value !== undefined) editing.onEditExisting(d.id, d.key, ref.column, value, original);
    setEditingCell(null);
    if (move === "next") {
      const next = columns[columns.findIndex((c) => c.column.name === ref.column) + 1];
      if (next) startEditing({ rowId: ref.rowId, column: next.column.name });
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (editingCell) return;
    const move = (dr: number, dc: number, extend: boolean) => {
      if (!focus) return;
      const r = rowIds.indexOf(focus.rowId);
      const c = colNames.indexOf(focus.column);
      const nr = Math.max(0, Math.min(rowIds.length - 1, r + dr));
      const nc = Math.max(0, Math.min(colNames.length - 1, c + dc));
      const next = { rowId: rowIds[nr] ?? focus.rowId, column: colNames[nc] ?? focus.column };
      select(next, extend);
    };
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1, 0, e.shiftKey);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1, 0, e.shiftKey);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      move(0, 1, e.shiftKey);
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      move(0, -1, e.shiftKey);
    }
    if (e.key === "Enter") {
      if (!focus) return;
      e.preventDefault();
      startEditing(focus);
    } else if (e.key === "Escape") {
      setAnchor(null);
      setFocus(null);
    }
  };

  if (columns.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">All columns are hidden. Show some from Columns.</p>;
  }

  const expandedRow = editingCell?.expanded ? byId.get(editingCell.rowId) : undefined;
  const expandedCol = editingCell?.expanded
    ? columns.find((c) => c.column.name === editingCell.column)?.column
    : undefined;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + (editing ? 1 : 0)}
      onKeyDown={onKeyDown}
      className="relative h-full overflow-auto font-mono text-[13px] outline-none"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot */}
      <div
        role="row"
        tabIndex={-1}
        aria-rowindex={1}
        className="sticky top-0 z-10 flex border-b bg-background"
        style={{ width }}
      >
        {editing && (
          // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
          <div
            role="columnheader"
            tabIndex={-1}
            aria-colindex={1}
            className="flex shrink-0 items-center justify-center border-r"
            style={{ width: LEAD_WIDTH }}
          >
            <input
              type="checkbox"
              aria-label="Select all rows"
              checked={allSelected}
              onChange={() => editing.onToggleAll(existingIds)}
            />
          </div>
        )}
        {columns.map((c, i) => (
          <HeaderCell
            key={c.column.name}
            index={i + (editing ? 1 : 0)}
            column={c.column}
            width={c.width}
            sorted={sortPosition(sort, c.column.name)}
            onSort={(action) => onSort(c.column.name, action)}
            onResize={(w, done) => onResize(c.column.name, w, done)}
          />
        ))}
      </div>
      <div className="relative" style={{ height: virtual.getTotalSize(), width }}>
        {virtual.getVirtualItems().map((item) => {
          const tr = rows[item.index];
          if (!tr) return null;
          const d = tr.original;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
            <div
              key={d.id}
              role="row"
              tabIndex={-1}
              aria-rowindex={item.index + 2}
              data-new={d.isNew || undefined}
              className="absolute left-0 flex border-b hover:bg-muted/60"
              style={{ height: ROW_HEIGHT, width, transform: `translateY(${item.start}px)` }}
            >
              {editing && (
                // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
                <div
                  role="gridcell"
                  tabIndex={-1}
                  aria-colindex={1}
                  className="flex shrink-0 items-center justify-center gap-1.5 border-r"
                  style={{ width: LEAD_WIDTH }}
                >
                  {d.isNew ? (
                    <button type="button" aria-label="Remove new row" onClick={() => editing.onRemoveNew(d.id)}>
                      <X className="size-3.5" />
                    </button>
                  ) : d.key ? (
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      checked={editing.selectedRows.has(d.id)}
                      onChange={() => editing.onToggleRow(d.id)}
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-label="Expand row"
                    title="Expand row"
                    onClick={() => editing.onExpandRow(d.id)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Maximize2 className="size-3.5" />
                  </button>
                </div>
              )}
              {columns.map((laid, i) => {
                const name = laid.column.name;
                const ref = { rowId: d.id, column: name };
                const k = cellKey(d.id, name);
                const isChanged = changed.has(k);
                const isEditing = editingCell?.rowId === d.id && editingCell.column === name;
                return (
                  <GridCell
                    // A changed cell remounts on each revision so its flash restarts, unless it is being edited:
                    // remounting would throw away what the person is typing.
                    key={isChanged && !isEditing ? `${k}:${page.revision}` : k}
                    index={i + (editing ? 2 : 1)}
                    column={laid.column}
                    width={laid.width}
                    value={cellValue(d, name)}
                    isNew={d.isNew}
                    pending={!d.isNew && Boolean(editing?.draft.updates[d.id]?.cells[name])}
                    conflict={editing?.conflicts.has(k) ?? false}
                    changed={isChanged}
                    selected={focus?.rowId === d.id && focus.column === name}
                    inRange={range.has(k)}
                    editing={editingCell?.rowId === d.id && editingCell.column === name && !editingCell.expanded}
                    onSelect={(extend) => select(ref, extend)}
                    onStartEdit={() => startEditing(ref)}
                    onCommit={(v, move) => commit(ref, v, move)}
                    onCancel={() => setEditingCell(null)}
                    onExpand={() => setEditingCell((c) => (c ? { ...c, expanded: true } : c))}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {editingCell && expandedRow && expandedCol && (
        <ExpandedEditor
          column={expandedCol}
          value={cellValue(expandedRow, expandedCol.name)}
          isNew={expandedRow.isNew}
          onSave={(v) => commit(editingCell, v)}
          onClose={() => setEditingCell(null)}
        />
      )}
    </div>
  );
}
