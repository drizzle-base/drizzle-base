import { describe, expect, test } from "bun:test";
import type { ColumnInfo, Filter, Row, Sort } from "../../src/contract";
import { StudioDataSourceError } from "../../src/contract";
import { likeToRegExp, type QueryTable, runPage } from "../../src/mock/query";

const c = (name: string, kind: ColumnInfo["kind"], isPrimaryKey = false): ColumnInfo => ({
  name,
  kind,
  pgType: kind,
  nullable: !isPrimaryKey,
  hasDefault: false,
  isPrimaryKey,
});

const T: QueryTable = {
  columns: [c("id", "integer", true), c("label", "text"), c("price", "numeric"), c("big", "bigint"), c("n", "integer")],
  primaryKey: ["id"],
};
const ROWS: Row[] = [
  { id: 1, label: "alpha", price: "10.00", big: "9007199254740993", n: 3 },
  { id: 2, label: "beta", price: "9.50", big: "9007199254740992", n: null },
  { id: 3, label: "50%_off", price: null, big: "1", n: 1 },
  { id: 4, label: "gamma", price: "100.00", big: null, n: 2 },
];

const ids = (filters: Filter[], sort: Sort[] = [], limit = 50, offset = 0) =>
  runPage(T, ROWS, { filters, sort, limit, offset }).rows.map((r) => r["id"]);

describe("filters", () => {
  test("numeric compares as a number, not as text", () => {
    expect(ids([{ column: "price", op: "lt", value: "10.00" }])).toEqual([2]);
  });
  test("bigint compares exactly beyond 2^53", () => {
    expect(ids([{ column: "big", op: "gt", value: "9007199254740992" }])).toEqual([1]);
  });
  test("a comparison with NULL is never true", () => {
    expect(ids([{ column: "n", op: "neq", value: 3 }])).toEqual([3, 4]);
    expect(ids([{ column: "n", op: "eq", value: null }])).toEqual([]);
  });
  test("isNull / isNotNull / in", () => {
    expect(ids([{ column: "price", op: "isNull" }])).toEqual([3]);
    expect(ids([{ column: "price", op: "isNotNull" }])).toEqual([1, 2, 4]);
    expect(ids([{ column: "n", op: "in", value: [1, 3, null] }])).toEqual([1, 3]);
  });
  test("like / ilike / notLike, with backslash escapes", () => {
    expect(ids([{ column: "label", op: "like", value: "%a" }])).toEqual([1, 2, 4]);
    expect(ids([{ column: "label", op: "ilike", value: "ALP%" }])).toEqual([1]);
    expect(ids([{ column: "label", op: "notLike", value: "%a" }])).toEqual([3]);
    expect(ids([{ column: "label", op: "like", value: "50\\%\\_off" }])).toEqual([3]);
    expect(likeToRegExp("a_c", false).test("abc")).toBe(true);
    expect(likeToRegExp("a.c", false).test("abc")).toBe(false);
  });
  test("filters combine with AND", () => {
    expect(
      ids([
        { column: "n", op: "isNotNull" },
        { column: "label", op: "like", value: "%a" },
      ]),
    ).toEqual([1, 4]);
  });
});

describe("sort and pages", () => {
  test("no sort: primary key order", () => {
    expect(ids([], [])).toEqual([1, 2, 3, 4]);
  });
  test("ASC puts NULLs last, DESC first", () => {
    expect(ids([], [{ column: "n", dir: "asc" }])).toEqual([3, 4, 1, 2]);
    expect(ids([], [{ column: "n", dir: "desc" }])).toEqual([2, 1, 4, 3]);
  });
  test("numeric sorts as a number", () => {
    expect(ids([], [{ column: "price", dir: "asc" }])).toEqual([2, 1, 4, 3]);
  });
  test("limit/offset slice the sorted rows; total ignores them", () => {
    const page = runPage(T, ROWS, { filters: [], sort: [], limit: 2, offset: 1 });
    expect(page.rows.map((r) => r["id"])).toEqual([2, 3]);
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(true);
  });
});

describe("errors", () => {
  test("an unknown column is refused with its code", () => {
    try {
      ids([{ column: "nope", op: "isNull" }]);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StudioDataSourceError);
      expect((e as StudioDataSourceError).code).toBe("unknown_column");
    }
  });
  test("`in` without an array and a negative limit are invalid values", () => {
    expect(() => ids([{ column: "n", op: "in", value: 1 }])).toThrow(StudioDataSourceError);
    expect(() => ids([], [], -1)).toThrow(StudioDataSourceError);
  });
});
