import { useEffect, useMemo, useState } from "react";
import { type ColumnInfo, type TableRef, tableId } from "../contract";
import { addRow, setNewCell, type TableDraft } from "../edit/draft";
import { parseCellValue } from "../edit/values";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { type ImportKind, parseImport } from "./parse";

export function applyImport(
  draft: TableDraft,
  columns: ColumnInfo[],
  rows: Record<string, string>[],
): { draft: TableDraft; applied: number } {
  const known = new Map(columns.map((c) => [c.name, c]));
  let next = draft;
  let applied = 0;
  for (const row of rows) {
    const added = addRow(next);
    next = added.draft;
    for (const [name, text] of Object.entries(row)) {
      const col = known.get(name);
      if (!col) continue;
      if (text === "") {
        if (col.nullable || col.hasDefault) next = setNewCell(next, added.id, name, null);
        continue;
      }
      const parsed = parseCellValue(col, text);
      if (parsed.ok) next = setNewCell(next, added.id, name, parsed.value ?? null);
    }
    applied += 1;
  }
  return { draft: next, applied };
}

function kindFromFileName(name: string): ImportKind | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".sql")) return "sql";
  return undefined;
}

function sqlTableError(named: TableRef, current: TableRef): string | null {
  if (tableId(named) === tableId(current)) return null;
  return `SQL names ${tableId(named)}, not ${tableId(current)}`;
}

export function ImportDialog({
  open,
  onOpenChange,
  table,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  table: TableRef;
  onApply: (rows: Record<string, string>[]) => void;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ImportKind>("json");

  useEffect(() => {
    if (open) return;
    setText("");
    setKind("json");
  }, [open]);

  const preview = useMemo(() => {
    const parsed = parseImport(text, kind);
    if (!parsed.ok) return { ok: false as const, error: parsed.error, rows: [] };
    const mismatch = parsed.table ? sqlTableError(parsed.table, table) : null;
    if (mismatch) return { ok: false as const, error: mismatch, rows: [] };
    return { ok: true as const, error: null as string | null, rows: parsed.rows };
  }, [text, kind, table]);

  const canImport = preview.ok && preview.rows.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Import</DialogTitle>
        <DialogDescription>Paste JSON, CSV or our INSERT SQL. Rows are pending until Save.</DialogDescription>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <select
              aria-label="Kind"
              className="h-8 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none dark:bg-input/30"
              value={kind}
              onChange={(e) => setKind(e.target.value as ImportKind)}
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="sql">SQL</option>
            </select>
            <input
              type="file"
              aria-label="File"
              accept=".json,.csv,.sql,application/json,text/csv,text/plain"
              className="min-w-0 flex-1 text-xs"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const fromName = kindFromFileName(file.name);
                if (fromName) setKind(fromName);
                void file.text().then(setText);
              }}
            />
          </div>
          <textarea
            className="min-h-36 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p role="status" className={preview.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {preview.error ?? `${preview.rows.length} ${preview.rows.length === 1 ? "row" : "rows"}`}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canImport}
            onClick={() => {
              if (!canImport) return;
              onApply(preview.rows);
              onOpenChange(false);
            }}
          >
            Import rows
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
