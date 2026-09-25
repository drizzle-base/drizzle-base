import type { Filter, PageRequest, TableInfo } from "../contract";
import { parseFilterValue } from "./values";
import type { StudioView } from "./view";

/**
 * The page request a view asks for, and what it had to leave out. Nothing is dropped silently: a filter that
 * cannot apply would show more rows than the person asked for, so the studio shows `ignored`.
 */
export function toPageRequest(
  view: StudioView,
  table: TableInfo,
  withTotal: boolean,
): { req: PageRequest; ignored: string[] } {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const ignored: string[] = [];
  const filters: Filter[] = [];
  for (const f of view.filters) {
    const col = byName.get(f.column);
    if (!col) {
      ignored.push(`filter on "${f.column}": no such column`);
      continue;
    }
    const p = parseFilterValue(col, f.op, f.text);
    if (!p.ok) {
      ignored.push(`filter on "${f.column}": ${p.error}`);
      continue;
    }
    filters.push(
      p.value === undefined ? { column: f.column, op: f.op } : { column: f.column, op: f.op, value: p.value },
    );
  }
  const sort = view.sort.filter((s) => {
    if (byName.has(s.column)) return true;
    ignored.push(`sort by "${s.column}": no such column`);
    return false;
  });
  return {
    req: {
      table: { schema: table.schema, name: table.name },
      filters,
      sort,
      limit: view.limit,
      offset: view.offset,
      withTotal,
    },
    ignored,
  };
}
