import { Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ColumnInfo, FilterOp, TableInfo } from "../contract";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NO_VALUE_OPS, parseFilterValue, type ViewFilter } from "../view";

export const OPERATORS: { op: FilterOp; label: string }[] = [
  { op: "eq", label: "equals" },
  { op: "neq", label: "not equals" },
  { op: "gt", label: "greater" },
  { op: "gte", label: "greater or equals" },
  { op: "lt", label: "less" },
  { op: "lte", label: "less or equals" },
  { op: "like", label: "like" },
  { op: "ilike", label: "ilike" },
  { op: "notLike", label: "not like" },
  { op: "in", label: "in" },
  { op: "isNull", label: "is null" },
  { op: "isNotNull", label: "is not null" },
];

const SELECT =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30";

interface Draft extends ViewFilter {
  key: number;
}

let nextKey = 0;
const draft = (f: ViewFilter): Draft => ({ ...f, key: nextKey++ });
const blank = (table: TableInfo): Draft => draft({ column: table.columns[0]?.name ?? "", op: "eq", text: "" });
const draftsOf = (table: TableInfo, filters: ViewFilter[]): Draft[] =>
  filters.length > 0 ? filters.map(draft) : [blank(table)];
const isBlank = (f: ViewFilter) => !NO_VALUE_OPS.includes(f.op) && f.text.trim() === "";
const plain = ({ column, op, text }: Draft): ViewFilter => ({ column, op, text });

/** Values a column offers as a list instead of free text. */
function choicesFor(col: ColumnInfo | undefined, op: FilterOp): string[] | null {
  if (!col || (op !== "eq" && op !== "neq")) return null;
  if (col.kind === "boolean") return ["true", "false"];
  if (col.kind === "enum") return col.enumValues ?? [];
  return null;
}

export interface FilterBarProps {
  table: TableInfo;
  applied: ViewFilter[];
  onApply(filters: ViewFilter[]): void;
}

/** Filters are drafts until applied (Apply or Enter), as in Drizzle Studio: typing never queries. */
export function FilterBar({ table, applied, onApply }: FilterBarProps) {
  const id = useId();
  const appliedKey = JSON.stringify(applied);
  const [drafts, setDrafts] = useState<Draft[]>(() => draftsOf(table, applied));
  // What is applied changed from outside the bar (a link, Back, another table): show that instead.
  useEffect(() => {
    setDrafts(draftsOf(table, JSON.parse(appliedKey) as ViewFilter[]));
  }, [appliedKey, table]);

  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const errors = drafts.map((d) => {
    const col = byName.get(d.column);
    if (!col) return `no column "${d.column}"`;
    if (isBlank(d)) return null;
    const p = parseFilterValue(col, d.op, d.text);
    return p.ok ? null : p.error;
  });
  const canApply = errors.every((e) => e === null);
  const apply = () => {
    if (canApply) onApply(drafts.filter((d) => !isBlank(d)).map(plain));
  };
  const update = (key: number, patch: Partial<ViewFilter>) =>
    setDrafts(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const remove = (key: number) => {
    const rest = drafts.filter((d) => d.key !== key);
    setDrafts(rest.length > 0 ? rest : [blank(table)]);
  };

  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2">
      {drafts.map((d, i) => {
        const col = byName.get(d.column);
        const choices = choicesFor(col, d.op);
        const error = errors[i] ?? null;
        const errorId = `${id}-${d.key}-error`;
        return (
          <fieldset
            key={d.key}
            aria-label={`Filter ${i + 1}`}
            className="m-0 flex min-w-0 items-center gap-1.5 border-0 p-0"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove filter ${i + 1}`}
              onClick={() => remove(d.key)}
            >
              <X />
            </Button>
            <span className="w-10 text-xs text-muted-foreground">{i === 0 ? "where" : "and"}</span>
            <select
              aria-label="Column"
              className={SELECT}
              value={d.column}
              onChange={(e) => update(d.key, { column: e.target.value })}
            >
              {table.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Operator"
              className={SELECT}
              value={d.op}
              onChange={(e) => update(d.key, { op: e.target.value as FilterOp })}
            >
              {OPERATORS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {NO_VALUE_OPS.includes(d.op) ? null : choices ? (
              <select
                aria-label="Value"
                className={SELECT}
                value={d.text}
                aria-invalid={error !== null || undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => update(d.key, { text: e.target.value })}
              >
                <option value="">choose…</option>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                aria-label="Value"
                className="h-8 w-56"
                value={d.text}
                placeholder={d.op === "in" ? 'a, b, "c,d"' : "value"}
                aria-invalid={error !== null || undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => update(d.key, { text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") apply();
                }}
              />
            )}
            {error && (
              <span id={errorId} className="text-xs text-destructive">
                {error}
              </span>
            )}
          </fieldset>
        );
      })}
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={() => setDrafts([...drafts, blank(table)])}>
          <Plus />
          Add filter
        </Button>
        <Button type="button" size="sm" disabled={!canApply} onClick={apply}>
          Apply
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setDrafts([blank(table)]);
            onApply([]);
          }}
        >
          Clear filters
        </Button>
      </div>
    </div>
  );
}
