import type { Sort } from "../contract";

export type HeaderSortAction = "asc" | "desc" | "add" | "clear";

/** What a column header's menu does: ascending/descending replace every sort, as in Drizzle Studio. */
export function applyHeaderSort(sort: Sort[], column: string, action: HeaderSortAction): Sort[] {
  switch (action) {
    case "asc":
    case "desc":
      return [{ column, dir: action }];
    case "add":
      return sort.some((s) => s.column === column) ? sort : [...sort, { column, dir: "asc" }];
    case "clear":
      return sort.filter((s) => s.column !== column);
  }
}

export function sortPosition(sort: Sort[], column: string): { dir: "asc" | "desc"; position: number } | null {
  const i = sort.findIndex((s) => s.column === column);
  const s = sort[i];
  if (!s) return null;
  return { dir: s.dir, position: sort.length > 1 ? i + 1 : 0 };
}
