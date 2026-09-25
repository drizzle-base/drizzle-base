import { Eye, EyeOff, GripVertical } from "lucide-react";
import { useState } from "react";
import type { ColumnInfo } from "../contract";
import { Input } from "../ui/input";
import { type ColumnLayout, moveItem } from "./prefs";

export interface ColumnsPanelProps {
  /** In display order. */
  columns: ColumnInfo[];
  layout: ColumnLayout;
  onChange(layout: ColumnLayout): void;
}

export function ColumnsPanel({ columns, layout, onChange }: ColumnsPanelProps) {
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const names = columns.map((c) => c.name);
  const hidden = new Set(layout.hidden);
  const allHidden = names.every((n) => hidden.has(n));
  const needle = search.trim().toLowerCase();
  const shown = columns.filter((c) => c.name.toLowerCase().includes(needle));
  const toggle = (name: string) =>
    onChange({
      ...layout,
      hidden: hidden.has(name) ? layout.hidden.filter((h) => h !== name) : [...layout.hidden, name],
    });
  const move = (name: string, to: number) => onChange({ ...layout, order: moveItem(names, names.indexOf(name), to) });

  return (
    <div className="flex w-64 flex-col gap-1.5 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Columns</span>
        <button
          type="button"
          aria-label={allHidden ? "Show all columns" : "Hide all columns"}
          className="rounded p-1 hover:bg-muted"
          onClick={() => onChange({ ...layout, hidden: allHidden ? [] : names })}
        >
          {allHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </button>
      </div>
      <Input
        aria-label="Search columns"
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <p className="text-[11px] text-muted-foreground">Drag, or Alt+↑/↓, to reorder.</p>
      <ul aria-label="Columns" className="max-h-72 overflow-auto">
        {shown.map((c) => {
          const at = names.indexOf(c.name);
          return (
            <li
              key={c.name}
              draggable
              onDragStart={() => setDragging(c.name)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging && dragging !== c.name) move(dragging, at);
                setDragging(null);
              }}
            >
              <button
                type="button"
                aria-pressed={!hidden.has(c.name)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted aria-[pressed=false]:text-muted-foreground"
                onClick={() => toggle(c.name)}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  move(c.name, e.key === "ArrowUp" ? Math.max(0, at - 1) : at + 1);
                }}
              >
                {hidden.has(c.name) ? (
                  <EyeOff aria-hidden="true" className="size-3.5" />
                ) : (
                  <Eye aria-hidden="true" className="size-3.5" />
                )}
                <span className="flex-1 truncate">{c.name}</span>
                <GripVertical aria-hidden="true" className="size-3.5 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
