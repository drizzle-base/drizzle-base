import { describe, expect, test } from "bun:test";
import { cellsInRect, parseTsv, toTsv } from "../../src/grid/range";

const rows = ["r1", "r2", "r3"];
const cols = ["a", "b", "c"];

describe("cellsInRect", () => {
  test("a single cell", () => {
    expect(cellsInRect({ rowId: "r2", column: "b" }, { rowId: "r2", column: "b" }, rows, cols)).toEqual([
      { rowId: "r2", column: "b" },
    ]);
  });

  test("a rectangle is inclusive and follows display order, not click order", () => {
    expect(cellsInRect({ rowId: "r3", column: "c" }, { rowId: "r2", column: "a" }, rows, cols)).toEqual([
      { rowId: "r2", column: "a" },
      { rowId: "r2", column: "b" },
      { rowId: "r2", column: "c" },
      { rowId: "r3", column: "a" },
      { rowId: "r3", column: "b" },
      { rowId: "r3", column: "c" },
    ]);
  });

  test("a corner that left the page does not empty the range", () => {
    expect(cellsInRect({ rowId: "gone", column: "a" }, { rowId: "r1", column: "b" }, rows, cols)).toEqual([
      { rowId: "r1", column: "a" },
      { rowId: "r1", column: "b" },
    ]);
  });

  test("both missing corners return an empty range", () => {
    expect(cellsInRect({ rowId: "gone", column: "a" }, { rowId: "also-gone", column: "b" }, rows, cols)).toEqual([]);
  });
});

describe("TSV", () => {
  test("a rectangle round-trips, including an empty cell and a quote", () => {
    const grid = [
      ["hello", ""],
      ['say "hi"', "x\ty"],
    ];
    expect(parseTsv(toTsv(grid))).toEqual(grid);
  });

  test("a trailing empty cell on the last row round-trips through toTsv", () => {
    expect(parseTsv(toTsv([["hello", ""]]))).toEqual([["hello", ""]]);
  });

  test("a trailing newline does not invent an empty row", () => {
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]]);
  });

  test("a quoted cell with an embedded newline round-trips through toTsv", () => {
    expect(parseTsv(toTsv([["a\nb"]]))).toEqual([["a\nb"]]);
  });
});
