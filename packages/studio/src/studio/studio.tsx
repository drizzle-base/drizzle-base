import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type PageRequest, type StudioDataSource, type TableInfo, tableId } from "../contract";
import { DataGrid } from "../grid/data-grid";
import { Pager } from "./pager";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme";
import { usePage } from "./use-page";

export interface StudioProps {
  dataSource: StudioDataSource;
  pageSize?: number;
}

export function Studio({ dataSource, pageSize = 50 }: StudioProps) {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let live = true;
    void dataSource.listTables().then(
      (t) => {
        if (live) setTables(t);
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => {
      live = false;
    };
  }, [dataSource]);

  const table = tables?.find((t) => tableId(t) === selected) ?? null;
  const req = useMemo<PageRequest | null>(
    () =>
      table
        ? {
            table: { schema: table.schema, name: table.name },
            filters: [],
            sort: [],
            limit: pageSize,
            offset,
            withTotal: true,
          }
        : null,
    [table, pageSize, offset],
  );
  const { page, error, changed } = usePage(dataSource, req, table);

  // Rows deleted elsewhere can leave us past the end: step back to the new last page.
  const total = page?.total ?? null;
  useEffect(() => {
    if (total !== null && offset > 0 && offset >= total)
      setOffset(Math.max(0, Math.floor((total - 1) / pageSize) * pageSize));
  }, [total, offset, pageSize]);

  const select = (id: string) => {
    setSelected(id);
    setOffset(0);
  };

  let body: ReactNode;
  if (error)
    body = (
      <p role="alert" className="p-4 text-sm text-destructive">
        {error.message}
      </p>
    );
  else if (table && page) body = <DataGrid table={table} page={page} changed={changed} />;
  else if (table) body = <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  else body = <p className="p-4 text-sm text-muted-foreground">Pick a table on the left.</p>;

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {tables ? (
        <Sidebar tables={tables} selected={selected} onSelect={select} />
      ) : (
        <div className="w-64 shrink-0 border-r p-3 text-sm text-muted-foreground">
          {loadError ? loadError.message : "Loading…"}
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <span className="truncate text-sm font-medium">{table ? tableId(table) : "No table selected"}</span>
          {table && table.primaryKey.length === 0 && (
            <span className="rounded border px-1.5 text-xs text-muted-foreground">read-only</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {page && (
              <span
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                title={`revision ${page.revision}`}
              >
                <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500" />
                Live
              </span>
            )}
            {page && (
              <Pager
                offset={offset}
                limit={pageSize}
                shown={page.rows.length}
                total={page.total}
                onOffsetChange={setOffset}
              />
            )}
            <ThemeToggle />
          </div>
        </header>
        <div className="min-h-0 flex-1">{body}</div>
      </main>
    </div>
  );
}
