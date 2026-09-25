import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { CellValue, Page, Row, Sort, TableInfo } from "../contract";
import { cellKey, formatCell, rowIdOf } from "../studio/format";
import type { LaidOutColumn } from "../studio/prefs";
import { type HeaderSortAction, sortPosition } from "../view";
import { HeaderCell } from "./header-cell";

const ROW_HEIGHT = 32;
const features = tableFeatures({});

export interface DataGridProps {
  table: TableInfo;
  page: Page;
  changed: ReadonlySet<string>;
  /** Visible columns in display order, with widths (see layoutColumns). */
  columns: LaidOutColumn[];
  sort: Sort[];
  onSort(column: string, action: HeaderSortAction): void;
  onResize(column: string, width: number, commit: boolean): void;
}

export function DataGrid({ table, page, changed, columns, sort, onSort, onResize }: DataGridProps) {
  const defs = useMemo<ColumnDef<typeof features, Row, unknown>[]>(
    () =>
      columns.map(({ column }) => ({
        id: column.name,
        accessorFn: (r: Row) => r[column.name] ?? null,
        header: column.name,
      })),
    [columns],
  );
  const grid = useTable({
    features,
    columns: defs,
    data: page.rows,
    getRowId: (r, i) => rowIdOf(table.primaryKey, r, i),
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = grid.getRowModel().rows;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const width = columns.reduce((w, c) => w + c.width, 0);

  if (columns.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">All columns are hidden. Show some from Columns.</p>;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
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
        {columns.map((c, i) => (
          <HeaderCell
            key={c.column.name}
            index={i}
            column={c.column}
            width={c.width}
            sorted={sortPosition(sort, c.column.name)}
            onSort={(action) => onSort(c.column.name, action)}
            onResize={(w, commit) => onResize(c.column.name, w, commit)}
          />
        ))}
      </div>
      <div className="relative" style={{ height: virtual.getTotalSize(), width }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
            <div
              key={row.id}
              role="row"
              tabIndex={-1}
              aria-rowindex={item.index + 2}
              className="absolute left-0 flex border-b hover:bg-muted/60"
              style={{ height: ROW_HEIGHT, width, transform: `translateY(${item.start}px)` }}
            >
              {row.getAllCells().map((cell, i) => {
                const value = cell.getValue() as CellValue;
                const isChanged = changed.has(cellKey(row.id, cell.column.id));
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
                  <div
                    // A changed cell remounts on each revision so its flash animation restarts.
                    key={isChanged ? `${cell.id}:${page.revision}` : cell.id}
                    role="gridcell"
                    tabIndex={-1}
                    aria-colindex={i + 1}
                    data-null={value === null || undefined}
                    data-changed={isChanged || undefined}
                    className="flex shrink-0 items-center overflow-hidden border-r px-2 whitespace-nowrap data-changed:animate-cell-flash data-null:text-muted-foreground"
                    style={{ width: columns[i]?.width }}
                  >
                    <span className="truncate">{formatCell(value)}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
