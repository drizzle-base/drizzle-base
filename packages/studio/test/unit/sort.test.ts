import { expect, test } from "bun:test";
import type { Sort } from "../../src/contract";
import { applyHeaderSort, sortPosition } from "../../src/view";

const two: Sort[] = [
  { column: "a", dir: "asc" },
  { column: "b", dir: "desc" },
];

test("header ascending/descending replace every sort; add appends once; clear removes that column", () => {
  expect(applyHeaderSort(two, "c", "desc")).toEqual([{ column: "c", dir: "desc" }]);
  expect(applyHeaderSort(two, "c", "add")).toEqual([...two, { column: "c", dir: "asc" }]);
  expect(applyHeaderSort(two, "a", "add")).toEqual(two);
  expect(applyHeaderSort(two, "a", "clear")).toEqual([{ column: "b", dir: "desc" }]);
});

test("sortPosition numbers columns only when there is more than one sort", () => {
  expect(sortPosition(two, "b")).toEqual({ dir: "desc", position: 2 });
  expect(sortPosition([{ column: "a", dir: "asc" }], "a")).toEqual({ dir: "asc", position: 0 });
  expect(sortPosition(two, "z")).toBeNull();
});
