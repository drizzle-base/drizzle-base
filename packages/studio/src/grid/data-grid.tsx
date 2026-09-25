import {
  type ColumnDef,
  columnSizingFeature,
  columnVisibilityFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { CellValue, ColumnInfo, Page, Row, TableInfo } from "../contract";
import { cellKey, formatCell, rowIdOf } from "../studio/format";

const ROW_HEIGHT = 32;
const COLUMN_WIDTH = 200;
const features = tableFeatures({ columnSizingFeature, columnVisibilityFeature });

export interface DataGridProps {
  table: TableInfo;
  page: Page;
  changed: ReadonlySet<string>;
}

export function DataGrid({ table, page, changed }: DataGridProps) {
  const byName = useMemo(() => new Map<string, ColumnInfo>(table.columns.map((c) => [c.name, c])), [table]);
  const columns = useMemo<ColumnDef<typeof features, Row, unknown>[]>(
    () =>
      table.columns.map((c) => ({
        id: c.name,
        accessorFn: (r: Row) => r[c.name] ?? null,
        header: c.name,
        size: COLUMN_WIDTH,
      })),
    [table],
  );
  const grid = useTable({
    features,
    columns,
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
  const width = grid.getVisibleLeafColumns().reduce((w, c) => w + c.getSize(), 0);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length + 1}
      aria-colcount={table.columns.length}
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
        {grid.getHeaderGroups()[0]?.headers.map((h, i) => (
          // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
          <div
            key={h.id}
            role="columnheader"
            tabIndex={-1}
            aria-colindex={i + 1}
            className="flex h-8 shrink-0 items-center gap-1.5 overflow-hidden border-r px-2"
            style={{ width: h.column.getSize() }}
          >
            <span className="truncate font-semibold">{h.column.id}</span>
            <span className="truncate text-[11px] text-muted-foreground">{byName.get(h.column.id)?.pgType}</span>
          </div>
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
              {row.getVisibleCells().map((cell, i) => {
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
                    style={{ width: cell.column.getSize() }}
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
