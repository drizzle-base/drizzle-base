import { ArrowUpDown, Columns3, ListFilter, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type StudioDataSource, StudioDataSourceError, type TableInfo, tableId } from "../contract";
import { CodeEditorContext, type CodeEditorMode } from "../edit/code-editor";
import {
  addRow,
  changeCount,
  discardRow,
  EMPTY_DRAFT,
  findConflicts,
  isDirty,
  missingRequired,
  removeNewRow,
  resolveConflict,
  revertCell,
  setCell,
  setNewCell,
  type TableDraft,
  toEdits,
  withoutSaved,
} from "../edit/draft";
import { EditBar, type SaveError } from "../edit/edit-bar";
import { RowPanel } from "../edit/row-panel";
import { DataGrid, type GridEditing } from "../grid/data-grid";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { applyHeaderSort, PAGE_SIZES, type StudioView, toPageRequest, type ViewChange, viewOfTable } from "../view";
import { ColumnsPanel } from "./columns-panel";
import { FilterBar } from "./filter-bar";
import { cellKey, rowIdOf } from "./format";
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
  /** Told whenever pending edits appear or are all saved/discarded (to block navigation, warn on close). */
  onDirtyChange?(dirty: boolean): void;
  /** "textarea" keeps CodeMirror's chunk from ever loading (a strict CSP, a smaller host). */
  codeEditor?: CodeEditorMode;
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
  onDirtyChange,
  codeEditor = "codemirror",
}: StudioProps) {
  const [view, setView] = useControllableView(controlledView, defaultView, onViewChange);
  const prefs = useMemo(() => createPrefs(storageKey), [storageKey]);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(view.filters.length > 0);
  const [countedFor, setCountedFor] = useState<string | null>(null);
  const [layout, setLayoutState] = useState<ColumnLayout>(EMPTY_LAYOUT);
  // Pending edits of every table, kept while the person moves around: switching tables or Back loses nothing.
  const [drafts, setDrafts] = useState<Record<string, TableDraft>>({});
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, SaveError>>({});
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ table: string; rowId: string } | null>(null);
  const [panelWidth, setPanelWidth] = useState(380);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey stands for view's content
  const base = useMemo(() => (table ? toPageRequest(view, table, false) : null), [table, viewKey]);
  // Count when nothing filters the rows (what applies, not what the view names) or when asked to.
  const withTotal = (base?.req.filters.length ?? 0) === 0 || countedFor === filtersKey;
  const resolved = useMemo(() => (base ? { ...base, req: { ...base.req, withTotal } } : null), [base, withTotal]);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view (table, page, filters) clears the selection
  useEffect(() => {
    setSelectedRows(new Set());
  }, [viewKey]);

  useEffect(() => {
    setPanel((p) => (p && p.table !== view.table ? null : p));
  }, [view.table]);

  const editable = table !== null && table.kind === "table" && table.primaryKey.length > 0;
  const draftKey = view.table ?? "";
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const updateDraft = (id: string, fn: (d: TableDraft) => TableDraft) =>
    setDrafts((all) => ({ ...all, [id]: fn(all[id] ?? EMPTY_DRAFT) }));
  const dirtyTables = new Set(
    Object.entries(drafts)
      .filter(([, d]) => isDirty(d))
      .map(([t]) => t),
  );
  const anyDirty = dirtyTables.size > 0;
  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);

  const pageRows = table && page ? page.rows.map((row, i) => ({ id: rowIdOf(table.primaryKey, row, i), row })) : [];
  const doomed = pageRows.filter((r) => selectedRows.has(r.id));
  const saveError = saveErrors[draftKey] ?? null;
  const setSaveError = (id: string, e: SaveError | null) =>
    setSaveErrors((all) => {
      const next = { ...all };
      if (e) next[id] = e;
      else delete next[id];
      return next;
    });
  const conflicts = editable ? findConflicts(draft, pageRows) : [];
  const missing = table ? missingRequired(draft, table.columns).length : 0;

  const save = async () => {
    if (!table) return;
    const id = tableId(table);
    setSaving(true);
    setSaveError(id, null);
    // The grid stays editable while a save is in flight: on success remove only what was sent.
    const sent = draft;
    try {
      const { inserted } = await dataSource.applyEdits(table, toEdits(sent));
      updateDraft(id, (now) => withoutSaved(now, sent));
      setPanel((p) => {
        const i = sent.inserts.findIndex((r) => r.id === p?.rowId);
        const k = inserted[i];
        return p && k ? { ...p, rowId: rowIdOf(table.primaryKey, k, 0) } : p;
      });
    } catch (e) {
      const key = e instanceof StudioDataSourceError ? e.key : undefined;
      setSaveError(id, {
        message: e instanceof Error ? e.message : String(e),
        rowId: key ? rowIdOf(table.primaryKey, key, 0) : null,
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteSelected = async () => {
    if (!table) return;
    try {
      await dataSource.deleteRows(
        table,
        doomed.map((r) => Object.fromEntries(table.primaryKey.map((k) => [k, r.row[k] ?? null]))),
      );
      updateDraft(tableId(table), (d) => doomed.reduce((acc, r) => discardRow(acc, r.id), d));
      setSelectedRows(new Set());
      setConfirmDelete(false);
      setDeleteError(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  };

  const gridEditing: GridEditing | undefined = editable
    ? {
        draft,
        conflicts: new Set(conflicts.map((c) => cellKey(c.rowId, c.column))),
        selectedRows,
        onToggleRow: (id) =>
          setSelectedRows((s) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
        onToggleAll: (ids) => setSelectedRows((s) => (ids.every((id) => s.has(id)) ? new Set() : new Set(ids))),
        onEditExisting: (rowId, key, column, value, original) =>
          updateDraft(draftKey, (d) => setCell(d, rowId, key, column, value, original)),
        onEditNew: (id, column, value) => updateDraft(draftKey, (d) => setNewCell(d, id, column, value)),
        onRemoveNew: (id) => updateDraft(draftKey, (d) => removeNewRow(d, id)),
        onExpandRow: (rowId) => setPanel({ table: draftKey, rowId }),
        onFocusRow: (rowId) => setPanel((p) => (p ? { ...p, rowId } : p)),
      }
    : undefined;

  const panelRow =
    panel && table
      ? (() => {
          const n = draft.inserts.find((r) => r.id === panel.rowId);
          if (n) return { id: n.id, isNew: true, key: null, live: {} };
          const r = pageRows.find((x) => x.id === panel.rowId);
          return r
            ? {
                id: r.id,
                isNew: false,
                key: Object.fromEntries(table.primaryKey.map((k) => [k, r.row[k] ?? null])),
                live: r.row,
              }
            : null;
        })()
      : null;

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
        editing={gridEditing}
      />
    );
  else if (table) body = <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  else body = <p className="p-4 text-sm text-muted-foreground">Pick a table on the left.</p>;

  return (
    <CodeEditorContext value={codeEditor}>
      <div className="flex h-full min-h-0 bg-background text-foreground">
        {tables ? (
          <Sidebar tables={tables} selected={view.table} onSelect={selectTable} dirty={dirtyTables} />
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
                {editable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => updateDraft(draftKey, (d) => addRow(d).draft)}
                  >
                    <Plus />
                    Add row
                  </Button>
                )}
                {editable && doomed.length > 0 && (
                  <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
                    <Trash2 />
                    {`Delete ${doomed.length} ${doomed.length === 1 ? "row" : "rows"}`}
                  </Button>
                )}
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
          {editable && (isDirty(draft) || saveError) && (
            <EditBar
              changes={changeCount(draft)}
              missing={missing}
              conflicts={conflicts}
              error={saveError}
              saving={saving}
              onSave={() => void save()}
              onDiscard={() => {
                updateDraft(draftKey, () => EMPTY_DRAFT);
                setSaveError(draftKey, null);
              }}
              onResolve={(c, choice) => updateDraft(draftKey, (d) => resolveConflict(d, c, choice))}
              onDiscardRow={(rowId) => {
                updateDraft(draftKey, (d) => discardRow(d, rowId));
                setSaveError(draftKey, null);
              }}
            />
          )}
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
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">{body}</div>
            {editable && panel && table && (
              <RowPanel
                table={table}
                row={panelRow}
                draft={draft}
                conflicts={new Set(conflicts.map((c) => cellKey(c.rowId, c.column)))}
                width={panelWidth}
                onResize={setPanelWidth}
                onEditExisting={(rowId, key, column, value, original) =>
                  updateDraft(draftKey, (d) => setCell(d, rowId, key, column, value, original))
                }
                onEditNew={(id, column, value) => updateDraft(draftKey, (d) => setNewCell(d, id, column, value))}
                onRevert={(rowId, column) => updateDraft(draftKey, (d) => revertCell(d, rowId, column))}
                onClose={() => setPanel(null)}
              />
            )}
          </div>
          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogContent>
              <DialogTitle>{`Delete ${doomed.length} ${doomed.length === 1 ? "row" : "rows"}?`}</DialogTitle>
              <DialogDescription>
                They are deleted now, for every tab, and cannot be restored from here.
              </DialogDescription>
              {deleteError && (
                <p role="alert" className="text-sm text-destructive">
                  {deleteError}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" onClick={() => void deleteSelected()}>
                  Delete rows
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </main>
      </div>
    </CodeEditorContext>
  );
}
