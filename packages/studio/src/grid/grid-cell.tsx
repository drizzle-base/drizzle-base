import type { MouseEvent } from "react";
import type { CellValue, ColumnInfo } from "../contract";
import { CellEditor } from "../edit/cell-editor";
import { formatCell } from "../studio/format";

export interface GridCellProps {
  index: number;
  column: ColumnInfo;
  width: number;
  /** undefined: a new row's column still at its DEFAULT (or NULL). */
  value: CellValue | undefined;
  isNew: boolean;
  pending: boolean;
  conflict: boolean;
  changed: boolean;
  selected: boolean;
  inRange: boolean;
  editing: boolean;
  onSelect(extend: boolean): void;
  onStartEdit(): void;
  onCommit(value: CellValue, move?: "next"): void;
  onCancel(): void;
  onExpand(): void;
  onContextMenu(e: MouseEvent): void;
  onToggleRelation?(): void;
  relationOpen?: boolean;
}

export function GridCell(p: GridCellProps) {
  const missing = p.isNew && (p.value ?? null) === null && !p.column.nullable && !p.column.hasDefault;
  const text = p.value === undefined ? (p.column.hasDefault ? "DEFAULT" : "NULL") : formatCell(p.value);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      role="gridcell"
      tabIndex={-1}
      aria-colindex={p.index}
      aria-selected={p.selected || undefined}
      data-range={p.inRange || undefined}
      data-null={p.value === null || p.value === undefined || undefined}
      data-changed={p.changed || undefined}
      data-pending={p.pending || (p.isNew && p.value !== undefined) || undefined}
      data-conflict={p.conflict || undefined}
      data-missing={missing || undefined}
      onClick={(e) => p.onSelect(e.shiftKey)}
      onDoubleClick={p.onStartEdit}
      onContextMenu={p.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !p.editing) {
          e.preventDefault();
          p.onStartEdit();
        }
      }}
      className="relative flex shrink-0 items-center border-r px-2 whitespace-nowrap data-changed:animate-cell-flash data-null:text-muted-foreground data-pending:bg-edit data-pending:text-edit-foreground data-range:bg-primary/10 aria-selected:outline-2 aria-selected:-outline-offset-2 aria-selected:outline-ring data-conflict:ring-2 data-conflict:ring-destructive data-conflict:ring-inset data-missing:ring-1 data-missing:ring-destructive data-missing:ring-inset"
      style={{ width: p.width }}
    >
      {p.editing ? (
        <CellEditor
          column={p.column}
          value={p.value}
          onCommit={p.onCommit}
          onCancel={p.onCancel}
          onExpand={p.onExpand}
        />
      ) : (
        <>
          <span className="min-w-0 truncate">{text}</span>
          {p.column.references && (
            <button
              type="button"
              aria-label={`Open ${p.column.references.table}`}
              aria-expanded={p.relationOpen || undefined}
              onClick={(e) => {
                e.stopPropagation();
                p.onToggleRelation?.();
              }}
              className="ml-1 shrink-0 text-muted-foreground hover:text-foreground"
            >
              →
            </button>
          )}
        </>
      )}
    </div>
  );
}
