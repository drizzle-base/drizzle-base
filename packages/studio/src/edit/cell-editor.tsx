import { useCallback, useRef, useState } from "react";
import type { CellValue, ColumnInfo } from "../contract";
import { parseCellValue, textForEditing } from "./values";

export interface CellEditorProps {
  column: ColumnInfo;
  /** undefined: a new row's column still at its DEFAULT. */
  value: CellValue | undefined;
  onCommit(value: CellValue, move?: "next"): void;
  onCancel(): void;
}

const CONTROL = "h-full w-full min-w-0 bg-popover px-1 font-mono text-[13px] text-foreground outline-none";

/** In-place editor. Enter commits, Tab commits and moves right, Esc cancels; an invalid value stays and says why. */
export function CellEditor({ column, value, onCommit, onCancel }: CellEditorProps) {
  const [text, setText] = useState(value === undefined || value === null ? "" : textForEditing(column, value));
  // A commit unmounts the editor, which blurs it: without this the blur would commit (or cancel) a second time.
  const done = useRef(false);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  const focusOnMount = useCallback((el: HTMLElement | null) => el?.focus(), []);

  const choices =
    column.kind === "boolean" ? ["true", "false"] : column.kind === "enum" ? (column.enumValues ?? []) : null;
  if (choices) {
    const current = value === undefined || value === null ? "" : String(value);
    return (
      <select
        ref={focusOnMount}
        aria-label={`Edit ${column.name}`}
        className={CONTROL}
        defaultValue={current}
        onChange={(e) => {
          const t = e.target.value;
          finish(() => onCommit(t === "" ? null : column.kind === "boolean" ? t === "true" : t));
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(onCancel);
          e.stopPropagation();
        }}
        onBlur={() => finish(onCancel)}
      >
        {current === "" && !column.nullable && (
          <option value="" disabled>
            choose…
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
  }

  const parsed = parseCellValue(column, text);
  const commit = (move?: "next") => {
    if (parsed.ok) finish(() => onCommit(parsed.value ?? null, move));
  };
  return (
    <>
      <input
        ref={focusOnMount}
        aria-label={`Edit ${column.name}`}
        className={CONTROL}
        value={text}
        aria-invalid={!parsed.ok || undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Tab") {
            e.preventDefault();
            commit("next");
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(onCancel);
          }
        }}
        onBlur={() => (parsed.ok ? commit() : finish(onCancel))}
      />
      {!parsed.ok && (
        <span
          role="alert"
          className="absolute top-full left-0 z-20 rounded bg-destructive px-1.5 py-0.5 text-[11px] text-white"
        >
          {parsed.error}
        </span>
      )}
    </>
  );
}
