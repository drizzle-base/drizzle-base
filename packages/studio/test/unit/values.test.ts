import { describe, expect, test } from "bun:test";
import type { CellValue, ColumnInfo } from "../../src/contract";
import { col } from "../../src/mock";
import { type Parsed, parseFilterValue, parseScalar, splitList } from "../../src/view";

const ok = (value: CellValue | undefined): Parsed => ({ ok: true, value });
const c = (kind: ColumnInfo["kind"], extra: Partial<ColumnInfo> = {}) => col("c", kind, kind, extra);

describe("parseScalar: text becomes the column's wire value", () => {
  test("numbers", () => {
    expect(parseScalar(c("integer"), " 42 ")).toEqual(ok(42));
    expect(parseScalar(c("integer"), "4.2").ok).toBe(false);
    expect(parseScalar(c("integer"), "9007199254740993").ok).toBe(false);
    expect(parseScalar(c("float"), "0.5")).toEqual(ok(0.5));
    expect(parseScalar(c("bigint"), "9007199254740993")).toEqual(ok("9007199254740993"));
    expect(parseScalar(c("numeric"), "10.50")).toEqual(ok("10.50"));
    expect(parseScalar(c("numeric"), "1e3").ok).toBe(false);
  });
  test("booleans, enums, uuids", () => {
    expect(parseScalar(c("boolean"), "true")).toEqual(ok(true));
    expect(parseScalar(c("boolean"), "yes").ok).toBe(false);
    expect(parseScalar(c("enum", { enumValues: ["admin", "viewer"] }), "admin")).toEqual(ok("admin"));
    const bad = parseScalar(c("enum", { enumValues: ["admin", "viewer"] }), "root");
    expect(bad).toEqual({ ok: false, error: '"root" is not one of admin, viewer' });
    expect(parseScalar(c("uuid"), "019B76DA-ABE8-708F-AF41-000000000000")).toEqual(
      ok("019b76da-abe8-708f-af41-000000000000"),
    );
    expect(parseScalar(c("uuid"), "nope").ok).toBe(false);
  });
  test("text keeps its spaces; other kinds pass through as text", () => {
    expect(parseScalar(c("text"), " a ")).toEqual(ok(" a "));
    expect(parseScalar(c("timestamptz"), "2026-01-01")).toEqual(ok("2026-01-01"));
  });
});

describe("parseFilterValue", () => {
  test("is null takes no value; like keeps the pattern as typed", () => {
    expect(parseFilterValue(c("integer"), "isNull", "junk")).toEqual(ok(undefined));
    expect(parseFilterValue(c("integer"), "like", "1%")).toEqual(ok("1%"));
  });
  test("in: a typed list, trimmed; the first bad item is the error", () => {
    expect(parseFilterValue(c("integer"), "in", "1, 2,3")).toEqual(ok([1, 2, 3]));
    expect(parseFilterValue(c("integer"), "in", "1, x")).toEqual({ ok: false, error: '"x" is not an integer' });
    expect(parseFilterValue(c("integer"), "in", "  ").ok).toBe(false);
  });
});

describe("splitList", () => {
  test("commas split, spaces around items go, quotes keep commas and double quotes escape", () => {
    expect(splitList(' a , "b,c", "say ""hi""" ,d')).toEqual({ ok: true, items: ["a", "b,c", 'say "hi"', "d"] });
    expect(splitList("")).toEqual({ ok: true, items: [] });
    expect(splitList('"open').ok).toBe(false);
    expect(splitList('"a" b').ok).toBe(false);
  });
});
