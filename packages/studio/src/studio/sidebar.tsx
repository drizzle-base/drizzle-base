import { Table2, View } from "lucide-react";
import { useMemo, useState } from "react";
import { type TableInfo, tableId } from "../contract";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { formatCount } from "./format";

export interface SidebarProps {
  tables: TableInfo[];
  selected: string | null;
  onSelect(id: string): void;
  dirty?: ReadonlySet<string>;
}

export function Sidebar({ tables, selected, onSelect, dirty }: SidebarProps) {
  const schemas = useMemo(() => [...new Set(tables.map((t) => t.schema))].sort(), [tables]);
  const [schema, setSchema] = useState(() => (schemas.includes("public") ? "public" : (schemas[0] ?? "")));
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const visible = tables
    .filter((t) => t.schema === schema && t.name.toLowerCase().includes(needle))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "table" ? -1 : 1));

  return (
    <nav aria-label="Tables" className="flex h-full w-64 shrink-0 flex-col gap-2 border-r p-3">
      {schemas.length > 1 && (
        <Select
          value={schema}
          onValueChange={(v) => {
            if (typeof v === "string") setSchema(v);
          }}
        >
          <SelectTrigger aria-label="Schema" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schemas.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Input
        type="search"
        aria-label="Search tables"
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto">
        {visible.map((t) => {
          const id = tableId(t);
          const Icon = t.kind === "view" ? View : Table2;
          return (
            <li key={id}>
              <button
                type="button"
                data-kind={t.kind}
                aria-label={t.name}
                data-dirty={dirty?.has(id) || undefined}
                title={dirty?.has(id) ? "Unsaved changes" : undefined}
                aria-current={id === selected ? "page" : undefined}
                onClick={() => onSelect(id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{t.name}</span>
                {dirty?.has(id) && (
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-edit-foreground" />
                )}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {formatCount(t.estimatedRows)}
                </span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No tables</li>}
      </ul>
    </nav>
  );
}
