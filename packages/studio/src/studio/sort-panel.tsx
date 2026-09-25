import { X } from "lucide-react";
import { useState } from "react";
import type { ColumnInfo, Sort } from "../contract";
import { Input } from "../ui/input";

export interface SortPanelProps {
  columns: ColumnInfo[];
  sort: Sort[];
  onChange(sort: Sort[]): void;
}

const ROW = "flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted";

export function SortPanel({ columns, sort, onChange }: SortPanelProps) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const offered = columns.filter(
    (c) => !sort.some((s) => s.column === c.name) && c.name.toLowerCase().includes(needle),
  );
  return (
    <div className="flex w-[28rem] gap-2 text-sm">
      <div className="flex w-1/2 flex-col gap-1.5 border-r pr-2">
        <Input
          aria-label="Search columns"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul aria-label="Columns" className="max-h-64 overflow-auto">
          {offered.map((c) => (
            <li key={c.name}>
              <button type="button" className={ROW} onClick={() => onChange([...sort, { column: c.name, dir: "asc" }])}>
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex w-1/2 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Sort by</span>
          {sort.length > 0 && (
            <button type="button" className="text-xs underline underline-offset-2" onClick={() => onChange([])}>
              Clear sorting
            </button>
          )}
        </div>
        {sort.length === 0 ? (
          <p className="text-xs text-muted-foreground">Rows follow the primary key.</p>
        ) : (
          <ol aria-label="Active sorts" className="flex flex-col gap-0.5">
            {sort.map((s, i) => (
              <li key={s.column} className="flex items-center gap-1.5 rounded-md bg-muted/60 px-1.5 py-1">
                <span className="w-3 text-xs text-muted-foreground">{i + 1}</span>
                <span className="flex-1 truncate">{s.column}</span>
                <button
                  type="button"
                  aria-label={`Direction of ${s.column}: ${s.dir}`}
                  className="text-xs uppercase underline underline-offset-2"
                  onClick={() =>
                    onChange(
                      sort.map((x) => (x.column === s.column ? { ...x, dir: x.dir === "asc" ? "desc" : "asc" } : x)),
                    )
                  }
                >
                  {s.dir}
                </button>
                <button
                  type="button"
                  aria-label={`Remove sort by ${s.column}`}
                  onClick={() => onChange(sort.filter((x) => x.column !== s.column))}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
