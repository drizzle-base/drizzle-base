import { useMemo } from "react";
import type { CellValue, PageRequest, StudioDataSource, TableInfo } from "../contract";
import { formatCell } from "../studio/format";
import { usePage } from "../studio/use-page";
import { Button } from "../ui/button";

export interface FkPreviewProps {
  ds: StudioDataSource;
  table: TableInfo;
  column: string;
  value: CellValue;
  onOpen(): void;
}

export function FkPreview({ ds, table, column, value, onOpen }: FkPreviewProps) {
  const req = useMemo<PageRequest>(
    () => ({
      table: { schema: table.schema, name: table.name },
      filters: [{ column, op: "eq", value }],
      sort: [],
      limit: 5,
      offset: 0,
      withTotal: true,
    }),
    [table.schema, table.name, column, value],
  );
  const { page, error } = usePage(ds, req, table);
  const cols = table.columns.filter((c) => c.pgType !== "relation");

  return (
    <section aria-label={`Related ${table.name}`} className="w-full border-t bg-muted/40 p-2">
      {error ? (
        <p className="text-xs text-destructive">{error.message}</p>
      ) : !page ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : page.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No matching row.</p>
      ) : (
        <table className="mb-2 w-full text-left text-[12px]">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.name} className="px-1.5 font-medium">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={JSON.stringify(table.primaryKey.length > 0 ? table.primaryKey.map((k) => row[k] ?? null) : row)}>
                {cols.map((c) => (
                  <td key={c.name} className="truncate px-1.5">
                    {formatCell(row[c.name] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Button type="button" size="xs" variant="outline" onClick={onOpen}>
        Open
      </Button>
    </section>
  );
}
