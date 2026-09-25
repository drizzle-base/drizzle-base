import { CalendarDays, RotateCcw, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { CellValue, ColumnInfo, Row, RowKey, TableInfo } from "../contract";
import { ResizeHandle } from "../grid/resize-handle";
import { isTimeKind } from "../lib/pgtime";
import { cellKey } from "../studio/format";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CodeEditor } from "./code-editor";
import { DateTimePicker } from "./datetime-picker";
import type { TableDraft } from "./draft";
import { opensExpanded, parseCellValue, textForEditing } from "./values";

export interface RowPanelProps {
  table: TableInfo;
  /** null: the row is not on the page any more (deleted, or moved by a change elsewhere). */
  row: { id: string; isNew: boolean; key: RowKey | null; live: Row } | null;
  draft: TableDraft;
  conflicts: ReadonlySet<string>;
  width: number;
  onResize(width: number): void;
  onEditExisting(rowId: string, key: RowKey, column: string, value: CellValue, original: CellValue): void;
  onEditNew(id: string, column: string, value: CellValue | undefined): void;
  onRevert(rowId: string, column: string): void;
  onClose(): void;
}

interface FieldProps {
  column: ColumnInfo;
  /** undefined: a new row's column at its DEFAULT. */
  value: CellValue | undefined;
  live: CellValue;
  isNew: boolean;
  pending: boolean;
  conflict: boolean;
  missing: boolean;
  onCommit(value: CellValue | undefined, original: CellValue): void;
  onRevert(): void;
}

const textOf = (c: ColumnInfo, v: CellValue | undefined) => (v === undefined || v === null ? "" : textForEditing(c, v));
const INPUT =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 font-mono text-[13px] outline-none focus-visible:border-ring aria-invalid:border-destructive";

function Field({ column, value, live, isNew, pending, conflict, missing, onCommit, onRevert }: FieldProps) {
  const [text, setText] = useState(textOf(column, value));
  // While editing, pushes do not touch what is typed, and the value it started from is what a save expects.
  const [editing, setEditing] = useState<{ original: CellValue } | null>(null);
  useEffect(() => {
    if (!editing) setText(textOf(column, value));
  }, [column, value, editing]);
  const parsed = parseCellValue(column, text);
  const begin = () => setEditing((e) => e ?? { original: live });
  const end = () => {
    const original = editing?.original ?? live;
    setEditing(null);
    if (text === textOf(column, value)) return;
    if (parsed.ok) onCommit(parsed.value ?? null, original);
  };
  const id = `field-${column.name}`;
  const choices =
    column.kind === "boolean" ? ["true", "false"] : column.kind === "enum" ? (column.enumValues ?? []) : null;
  const code = opensExpanded(column);

  let control: ReactNode;
  if (choices) {
    control = (
      <select
        id={id}
        className={INPUT}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => {
          const t = e.target.value;
          onCommit(t === "" ? null : column.kind === "boolean" ? t === "true" : t, live);
        }}
      >
        {(value === undefined || value === null) && !column.nullable && (
          <option value="" disabled>
            {isNew && column.hasDefault ? "DEFAULT" : "choose…"}
          </option>
        )}
        {column.nullable && <option value="">NULL</option>}
        {choices.map((c) => (
          <option key={c} value={c}>
            {column.kind === "boolean" ? c.toUpperCase() : c}
          </option>
        ))}
      </select>
    );
  } else if (code) {
    control = (
      // biome-ignore lint/a11y/noStaticElementInteractions: focus inside starts the same in-progress session as an input's onFocus
      <div onFocus={begin}>
        <CodeEditor
          label={column.name}
          value={text}
          onChange={setText}
          onBlur={end}
          invalid={!parsed.ok}
          className="h-40"
        />
      </div>
    );
  } else {
    control = (
      <div className="flex gap-1">
        <input
          id={id}
          className={INPUT}
          value={text}
          placeholder={
            value === undefined ? (column.hasDefault ? "DEFAULT" : "NULL") : value === null ? "NULL" : undefined
          }
          aria-invalid={!parsed.ok || undefined}
          onFocus={begin}
          onChange={(e) => setText(e.target.value)}
          onBlur={end}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {isTimeKind(column.kind) && (
          <Popover>
            <PopoverTrigger render={<Button type="button" variant="outline" size="icon-sm" aria-label="Pick a date" />}>
              <CalendarDays />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-0">
              <DateTimePicker
                kind={column.kind}
                text={text}
                nullable={column.nullable}
                onPick={(t) => {
                  setText(t ?? "");
                  setEditing(null);
                  onCommit(t, editing?.original ?? live);
                }}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
    );
  }

  return (
    <div
      data-pending={pending || undefined}
      data-conflict={conflict || undefined}
      data-missing={missing || undefined}
      className="flex flex-col gap-1 rounded-md p-1 data-pending:bg-edit/40 data-conflict:ring-2 data-conflict:ring-destructive data-missing:ring-1 data-missing:ring-destructive"
    >
      <div className="flex items-center gap-1 text-xs">
        {code ? (
          <span className="font-medium">{column.name}</span>
        ) : (
          <label htmlFor={id} className="font-medium">
            {column.name}
          </label>
        )}
        {pending && (
          <button
            type="button"
            aria-label={`Revert ${column.name}`}
            onClick={onRevert}
            className="text-edit-foreground"
          >
            <RotateCcw className="size-3" />
          </button>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{column.pgType}</span>
      </div>
      {control}
      {conflict && (
        <p className="text-[11px] text-destructive">changed elsewhere to {textOf(column, live) || "NULL"}</p>
      )}
      {!parsed.ok && editing && (
        <p role="alert" className="text-[11px] text-destructive">
          {parsed.error}
        </p>
      )}
    </div>
  );
}

export function RowPanel(p: RowPanelProps) {
  const row = p.row;
  return (
    <aside
      aria-label="Row"
      className="relative flex shrink-0 flex-col border-l bg-background"
      style={{ width: p.width }}
    >
      <ResizeHandle name="row panel" width={p.width} edge="left" onResize={(w) => p.onResize(w)} />
      <div className="flex h-10 items-center border-b px-3 text-sm font-medium">
        {row?.isNew ? "New row" : "Row"}
        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" onClick={p.onClose}>
          <X />
        </Button>
      </div>
      {row === null ? (
        <p className="p-3 text-sm text-muted-foreground">
          This row is not on this page any more: deleted, or moved by a change elsewhere. Its unsaved edits are kept.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {p.table.columns.map((c) => {
            const pendingCell = row.isNew ? undefined : p.draft.updates[row.id]?.cells[c.name];
            const newValues = row.isNew ? p.draft.inserts.find((r) => r.id === row.id)?.values : undefined;
            const value = row.isNew
              ? newValues && Object.hasOwn(newValues, c.name)
                ? (newValues[c.name] ?? null)
                : undefined
              : pendingCell
                ? pendingCell.value
                : (row.live[c.name] ?? null);
            return (
              <Field
                // Row+column: switching rows remounts, so an in-progress edit never leaks.
                key={`${row.id}\u0000${c.name}`}
                column={c}
                value={value}
                live={row.live[c.name] ?? null}
                isNew={row.isNew}
                pending={row.isNew ? value !== undefined : Boolean(pendingCell)}
                conflict={p.conflicts.has(cellKey(row.id, c.name))}
                missing={row.isNew && (value ?? null) === null && !c.nullable && !c.hasDefault}
                onCommit={(v, original) => {
                  if (row.isNew) p.onEditNew(row.id, c.name, v);
                  else if (row.key && v !== undefined) p.onEditExisting(row.id, row.key, c.name, v, original);
                }}
                onRevert={() => (row.isNew ? p.onEditNew(row.id, c.name, undefined) : p.onRevert(row.id, c.name))}
              />
            );
          })}
        </div>
      )}
    </aside>
  );
}
