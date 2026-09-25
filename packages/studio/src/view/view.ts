import type { FilterOp, Sort } from "../contract";

/** A filter as the person typed it: the value stays text until it meets its column (see request.ts). */
export interface ViewFilter {
  column: string;
  op: FilterOp;
  text: string;
}

/** What the studio shows. Serialisable (codec.ts), so a host can keep it in its URL. */
export interface StudioView {
  table: string | null;
  filters: ViewFilter[];
  sort: Sort[];
  limit: number;
  offset: number;
}

/** How a host should record a change: a new history entry, or in place of the current one. */
export interface ViewChange {
  history: "push" | "replace";
}

export const DEFAULT_LIMIT = 50;
export const PAGE_SIZES = [50, 100, 500, 1000] as const;
export const EMPTY_VIEW: StudioView = { table: null, filters: [], sort: [], limit: DEFAULT_LIMIT, offset: 0 };

export function viewOfTable(table: string, limit: number = DEFAULT_LIMIT): StudioView {
  return { ...EMPTY_VIEW, table, limit };
}

export function sameView(a: StudioView, b: StudioView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
