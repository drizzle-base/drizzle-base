import { ArrowUpDown, Columns3, ListFilter } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type StudioDataSource, type TableInfo, tableId } from "../contract";
import { DataGrid } from "../grid/data-grid";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { applyHeaderSort, PAGE_SIZES, type StudioView, toPageRequest, type ViewChange, viewOfTable } from "../view";
import { ColumnsPanel } from "./columns-panel";
import { FilterBar } from "./filter-bar";
import { Pager } from "./pager";
import { type ColumnLayout, createPrefs, EMPTY_LAYOUT, layoutColumns } from "./prefs";
import { Sidebar } from "./sidebar";
import { SortPanel } from "./sort-panel";
import { ThemeToggle } from "./theme";
import { usePage } from "./use-page";
import { useControllableView } from "./use-view";

export interface StudioProps {
  dataSource: StudioDataSource;
  /** Controlled view: a host keeps it (e.g. in its URL) and gets every change through onViewChange. */
  view?: StudioView;
  defaultView?: StudioView;
  onViewChange?(view: StudioView, change: ViewChange): void;
  /** Problems the host met reading the view (a bad link), shown with the studio's own. */
  notices?: string[];
  /** Separates saved layouts of different databases on one origin. */
  storageKey?: string;
}

const SELECT = "h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30";

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{n}</span> : null;
}

export function Studio({
  dataSource,
  view: controlledView,
  defaultView,
  onViewChange,
  notices = [],
  storageKey = "default",
}: StudioProps) {
  const [view, setView] = useControllableView(controlledView, defaultView, onViewChange);
  const prefs = useMemo(() => createPrefs(storageKey), [storageKey]);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(view.filters.length > 0);
  const [countedFor, setCountedFor] = useState<string | null>(null);
  const [layout, setLayoutState] = useState<ColumnLayout>(EMPTY_LAYOUT);

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

  const table = tables?.find((t) => tableId(t) === view.table) ?? null;
  // Keyed by content: a controlled host may hand an equal but new view object on every render.
  const viewKey = JSON.stringify(view);
  const filtersKey = JSON.stringify([view.table, view.filters]);
  const withTotal = view.filters.length === 0 || countedFor === filtersKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey stands for view's content
  const resolved = useMemo(() => (table ? toPageRequest(view, table, withTotal) : null), [table, viewKey, withTotal]);
  const { page, error, changed } = usePage(dataSource, resolved?.req ?? null, table);

  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey stands for view's content
  useEffect(() => {
    if (view.table) prefs.setLastView(view.table, view);
  }, [prefs, viewKey]);

  useEffect(() => {
    setLayoutState(view.table ? prefs.layout(view.table) : EMPTY_LAYOUT);
  }, [prefs, view.table]);
  const setLayout = (next: ColumnLayout, persist = true) => {
    setLayoutState(next);
    if (persist && view.table) prefs.setLayout(view.table, next);
  };

  // Rows deleted elsewhere can leave the page past the end: step back.
  useEffect(() => {
    if (!page || page.rows.length > 0 || view.offset === 0) return;
    const offset =
      page.total !== null
        ? Math.max(0, Math.floor((page.total - 1) / view.limit) * view.limit)
        : Math.max(0, view.offset - view.limit);
    setView({ ...view, offset }, { history: "replace" });
  }, [page, view, setView]);

  const selectTable = (id: string) => {
    const next = prefs.lastView(id) ?? viewOfTable(id, view.limit);
    setCountedFor(null);
    setFiltersOpen(next.filters.length > 0);
    setView(next, { history: "push" });
  };
  const change = (patch: Partial<StudioView>, history: ViewChange["history"]) =>
    setView({ ...view, ...patch }, { history });

  const laid = table ? layoutColumns(table.columns, layout) : null;
  const warnings = [
    ...notices,
    ...(resolved?.ignored ?? []),
    ...(tables && view.table && !table ? [`table "${view.table}": not in this database`] : []),
  ];
  const sizes = [...new Set([...PAGE_SIZES, view.limit])].sort((a, b) => a - b);

  let body: ReactNode;
  if (error)
    body = (
      <p role="alert" className="p-4 text-sm text-destructive">
        {error.message}
      </p>
    );
  else if (table && page && laid && resolved)
    body = (
      <DataGrid
        table={table}
        page={page}
        changed={changed}
        columns={laid.visible}
        sort={resolved.req.sort}
        onSort={(column, action) => change({ sort: applyHeaderSort(view.sort, column, action), offset: 0 }, "push")}
        onResize={(column, width, commit) =>
          setLayout({ ...layout, widths: { ...layout.widths, [column]: width } }, commit)
        }
      />
    );
  else if (table) body = <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  else body = <p className="p-4 text-sm text-muted-foreground">Pick a table on the left.</p>;

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {tables ? (
        <Sidebar tables={tables} selected={view.table} onSelect={selectTable} />
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
          {table && laid && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={filtersOpen}
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                <ListFilter />
                Filters
                <Count n={view.filters.length} />
              </Button>
              <Popover>
                <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
                  <ArrowUpDown />
                  Sort
                  <Count n={view.sort.length} />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto">
                  <SortPanel
                    columns={laid.ordered}
                    sort={view.sort}
                    onChange={(sort) => change({ sort, offset: 0 }, "push")}
                  />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
                  <Columns3 />
                  Columns
                  <Count n={layout.hidden.filter((h) => table.columns.some((c) => c.name === h)).length} />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto">
                  <ColumnsPanel columns={laid.ordered} layout={layout} onChange={(l) => setLayout(l)} />
                </PopoverContent>
              </Popover>
            </>
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
            {page && page.total === null && (
              <Button type="button" variant="ghost" size="xs" onClick={() => setCountedFor(filtersKey)}>
                Count rows
              </Button>
            )}
            {table && (
              <select
                aria-label="Rows per page"
                className={SELECT}
                value={view.limit}
                onChange={(e) => change({ limit: Number(e.target.value), offset: 0 }, "replace")}
              >
                {sizes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
            {page && (
              <Pager
                offset={view.offset}
                limit={view.limit}
                shown={page.rows.length}
                total={page.total}
                hasMore={page.hasMore}
                onOffsetChange={(offset) => change({ offset }, "replace")}
              />
            )}
            <ThemeToggle />
          </div>
        </header>
        {table && filtersOpen && (
          <FilterBar
            table={table}
            applied={view.filters}
            onApply={(filters) => change({ filters, offset: 0 }, "push")}
          />
        )}
        {warnings.length > 0 && (
          <div
            role="status"
            className="border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200"
          >
            {warnings.map((w) => (
              <p key={w}>Ignored {w}.</p>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">{body}</div>
      </main>
    </div>
  );
}
