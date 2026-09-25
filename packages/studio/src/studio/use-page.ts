import { useEffect, useState } from "react";
import type { Page, PageRequest, StudioDataSource, TableInfo } from "../contract";
import { diffPages } from "./format";

export interface PageState {
  page: Page | null;
  error: Error | null;
  changed: ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();
const EMPTY: PageState = { page: null, error: null, changed: NOTHING };

/**
 * The live page for `req`. The state remembers which request it belongs to, so the render right after the request
 * changes shows nothing rather than the old request's rows under the new columns.
 */
export function usePage(ds: StudioDataSource, req: PageRequest | null, table: TableInfo | null): PageState {
  const [state, setState] = useState<PageState & { req: PageRequest | null }>({ ...EMPTY, req: null });
  useEffect(() => {
    if (!req || !table) return;
    const columns = table.columns.map((c) => c.name);
    setState({ ...EMPTY, req });
    return ds.subscribePage(
      req,
      (page) =>
        setState((prev) => ({
          req,
          page,
          error: null,
          changed: prev.req === req ? diffPages(prev.page, page, table.primaryKey, columns) : NOTHING,
        })),
      (error) => setState({ req, page: null, error, changed: NOTHING }),
    );
  }, [ds, req, table]);
  return state.req === req ? state : EMPTY;
}
