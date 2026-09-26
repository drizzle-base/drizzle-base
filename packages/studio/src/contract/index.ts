// The studio's only view of a database. The UI is written against this interface; the in-memory mock implements it
// now and the drizzle-base admin functions later. Every change is recorded in docs/specs/STUDIO-00-ui-on-mocks.md.

export type ColumnKind =
  | "text"
  | "integer"
  | "bigint"
  | "float"
  | "numeric"
  | "boolean"
  | "uuid"
  | "date"
  | "timestamp"
  | "timestamptz"
  | "json"
  | "enum"
  | "bytea"
  | "array"
  | "unknown";

export interface ColumnInfo {
  name: string;
  kind: ColumnKind;
  /** As Postgres names it: "timestamp with time zone", "varchar(255)", "text[]", or the enum's type name. */
  pgType: string;
  nullable: boolean;
  /** An insert may omit it (uuidv7(), now(), serial…). */
  hasDefault: boolean;
  isPrimaryKey: boolean;
  enumValues?: string[];
  /** For kind "array": the kind of its elements. */
  elementKind?: ColumnKind;
  references?: { schema: string; table: string; column: string };
}

export interface TableRef {
  schema: string;
  name: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableInfo extends TableRef {
  kind: "table" | "view";
  columns: ColumnInfo[];
  /** Empty for views and for tables without one: those are read-only. */
  primaryKey: string[];
  /** Empty for views and heaps. A table with a primary key lists that index. */
  indexes: IndexInfo[];
  estimatedRows: number | null;
}

/**
 * A cell value on the wire. SQL NULL is `null`. `integer` and `float` are numbers, `boolean` is a boolean, an `array`
 * is an array of its elements' values. Every other kind — `bigint` and `numeric` included, so no precision is lost —
 * is the text Postgres prints for it with `TimeZone=UTC`, `DateStyle=ISO`: `2026-09-25 12:43:35.257072+00`,
 * `\x6964`, `{"a": 1}`.
 */
export type CellValue = null | string | number | boolean | CellValue[];
export type Row = Record<string, CellValue>;
/** Primary-key column → value. */
export type RowKey = Record<string, CellValue>;

/** An update. `expected` holds the values of the changed columns as the editor last saw them: if the row no longer
 * has them (someone else changed it, or it is gone), the write is refused with code "conflict". */
export interface RowUpdate {
  key: RowKey;
  values: Row;
  expected?: Row;
}

export interface Edits {
  inserts: Row[];
  updates: RowUpdate[];
}

export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "like"
  | "ilike"
  | "notLike"
  | "in"
  | "isNull"
  | "isNotNull";

/** `value` is absent for isNull/isNotNull and an array for `in`. SQL semantics: a comparison with NULL is never true. */
export interface Filter {
  column: string;
  op: FilterOp;
  value?: CellValue;
}

export interface Sort {
  column: string;
  dir: "asc" | "desc";
}

/**
 * Filters combine with AND. Rows are ordered by `sort` (ASC puts NULLs last, DESC first, as Postgres does), then by
 * the primary key ascending, so pages are stable.
 */
export interface PageRequest {
  table: TableRef;
  filters: Filter[];
  sort: Sort[];
  limit: number;
  offset: number;
  /**
   * Ask for `Page.total`. Counting every row a filter keeps can cost far more than the page itself, and a page is a
   * subscription re-run on every change: the UI asks only when it will show the number.
   */
  withTotal: boolean;
}

/**
 * `total` counts every row the filters keep; null when `withTotal` was false (or the backend will not count).
 * `hasMore` says whether rows exist past this page, which needs no count. `revision` identifies the data the page
 * was computed from: a page pushed because of a write carries a higher revision than any page before it.
 */
export interface Page {
  rows: Row[];
  total: number | null;
  hasMore: boolean;
  revision: number;
}

export type Unsubscribe = () => void;

export type StudioErrorCode =
  | "read_only"
  | "unknown_table"
  | "unknown_column"
  | "not_null"
  | "unique_violation"
  | "conflict"
  | "invalid_value";

export class StudioDataSourceError extends Error {
  override readonly name = "StudioDataSourceError";

  constructor(
    readonly code: StudioErrorCode,
    message: string,
    /** The row a conflict (or another row-level failure) is about. */
    readonly key?: RowKey,
  ) {
    super(message);
  }
}

export interface StudioDataSource {
  listTables(): Promise<TableInfo[]>;
  /**
   * A page is a subscription: pushed once, then again whenever its result changes, whoever changed the data. Never
   * calls back synchronously from inside `subscribePage`, and never after the returned function has been called.
   */
  subscribePage(req: PageRequest, onPage: (page: Page) => void, onError: (e: Error) => void): Unsubscribe;
  /** Rejects with a StudioDataSourceError; a key naming no row changes nothing, as UPDATE does. */
  updateRows(table: TableRef, changes: { key: RowKey; values: Row }[]): Promise<void>;
  /** Omitted columns take their default (or NULL). Resolves with each new row's key, in order. */
  insertRows(table: TableRef, rows: Row[]): Promise<RowKey[]>;
  deleteRows(table: TableRef, keys: RowKey[]): Promise<void>;
  /** One atomic write: every insert and update, or none. Resolves with the inserted rows' keys, in order. */
  applyEdits(table: TableRef, edits: Edits): Promise<{ inserted: RowKey[] }>;
}

export function tableId(t: TableRef): string {
  return `${t.schema}.${t.name}`;
}
