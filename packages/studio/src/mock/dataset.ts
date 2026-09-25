import type { CellValue, ColumnInfo, ColumnKind, Row, TableInfo } from "../contract";

/** How the mock fills an omitted column on insert. Not part of the contract, which only says `hasDefault`. */
export type MockDefault = "serial" | "uuidv7" | "now" | { value: CellValue };

export interface MockTable {
  info: TableInfo;
  rows: Row[];
  defaults: Record<string, MockDefault>;
}

export interface MockView {
  info: TableInfo;
  compute(read: (tableId: string) => readonly Row[]): Row[];
}

export interface MockDataset {
  tables: MockTable[];
  views: MockView[];
}

export function col(
  name: string,
  kind: ColumnKind,
  pgType: string,
  extra: Partial<Omit<ColumnInfo, "name" | "kind" | "pgType">> = {},
): ColumnInfo {
  return { nullable: true, hasDefault: false, isPrimaryKey: false, ...extra, name, kind, pgType };
}

export function mockTable(
  schema: string,
  name: string,
  columns: ColumnInfo[],
  rows: Row[],
  defaults: Record<string, MockDefault> = {},
): MockTable {
  const cols = columns.map((c) => ({ ...c, hasDefault: defaults[c.name] !== undefined }));
  return {
    info: {
      schema,
      name,
      kind: "table",
      columns: cols,
      primaryKey: cols.filter((c) => c.isPrimaryKey).map((c) => c.name),
      estimatedRows: rows.length,
    },
    rows,
    defaults,
  };
}

export function mockView(schema: string, name: string, columns: ColumnInfo[], compute: MockView["compute"]): MockView {
  return {
    info: {
      schema,
      name,
      kind: "view",
      columns: columns.map((c) => ({ ...c, isPrimaryKey: false, hasDefault: false })),
      primaryKey: [],
      estimatedRows: null,
    },
    compute,
  };
}
