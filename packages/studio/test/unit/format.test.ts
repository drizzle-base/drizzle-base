import { describe, expect, test } from "bun:test";
import type { Page } from "../../src/contract";
import { cellKey, diffPages, formatCell, formatCount, rowIdOf } from "../../src/studio/format";

describe("formatCell", () => {
  test("NULL, booleans, arrays, numbers and text", () => {
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell(true)).toBe("TRUE");
    expect(formatCell(false)).toBe("FALSE");
    expect(formatCell(["t0", "x"])).toBe('["t0","x"]');
    expect(formatCell(42)).toBe("42");
    expect(formatCell("2026-09-25 12:43:35.257072+00")).toBe("2026-09-25 12:43:35.257072+00");
  });
});

test("formatCount: sidebar row estimates", () => {
  expect(formatCount(null)).toBe("");
  expect(formatCount(50)).toBe("50");
  expect(formatCount(2000)).toBe("2.00K");
  expect(formatCount(1_500_000)).toBe("1.50M");
});

describe("diffPages", () => {
  const page = (rows: Page["rows"], revision: number): Page => ({ rows, total: rows.length, revision });
  const cols = ["id", "name", "n"];

  test("marks exactly the cells whose value changed, by primary key", () => {
    const prev = page(
      [
        { id: 1, name: "a", n: 1 },
        { id: 2, name: "b", n: 2 },
      ],
      1,
    );
    const next = page(
      [
        { id: 2, name: "B", n: 2 },
        { id: 1, name: "a", n: 1 },
      ],
      2,
    );
    expect(diffPages(prev, next, ["id"], cols)).toEqual(new Set([cellKey(rowIdOf(["id"], { id: 2 }, 0), "name")]));
  });

  test("a row new to the page is marked whole", () => {
    const prev = page([{ id: 1, name: "a", n: 1 }], 1);
    const next = page(
      [
        { id: 1, name: "a", n: 1 },
        { id: 3, name: "c", n: null },
      ],
      2,
    );
    const id3 = rowIdOf(["id"], { id: 3 }, 1);
    expect(diffPages(prev, next, ["id"], cols)).toEqual(new Set(cols.map((c) => cellKey(id3, c))));
  });

  test("the first page marks nothing", () => {
    expect(diffPages(null, page([{ id: 1, name: "a", n: 1 }], 1), ["id"], cols).size).toBe(0);
  });

  test("no primary key, no diff: positions are not identities", () => {
    const prev = page([{ name: "a" }, { name: "b" }], 1);
    const next = page([{ name: "b" }], 2);
    expect(diffPages(prev, next, [], ["name"]).size).toBe(0);
  });
});
