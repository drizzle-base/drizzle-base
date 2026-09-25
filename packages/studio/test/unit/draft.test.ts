import { describe, expect, test } from "bun:test";
import {
  addRow,
  changeCount,
  discardRow,
  EMPTY_DRAFT,
  findConflicts,
  isDirty,
  missingRequired,
  removeNewRow,
  resolveConflict,
  setCell,
  setNewCell,
  toEdits,
} from "../../src/edit/draft";
import { col } from "../../src/mock";

const K = { id: 1 };

describe("setCell", () => {
  test("the first original is kept across edits; going back to it removes the edit", () => {
    let d = setCell(EMPTY_DRAFT, "r1", K, "name", "b", "a");
    d = setCell(d, "r1", K, "name", "c", "b");
    expect(d.updates["r1"]?.cells["name"]).toEqual({ value: "c", original: "a" });
    d = setCell(d, "r1", K, "name", "a", "c");
    expect(d.updates["r1"]).toBeUndefined();
    expect(isDirty(d)).toBe(false);
  });
});

describe("new rows", () => {
  test("added at the top; a cell set back to undefined is the default again; removable", () => {
    const one = addRow(EMPTY_DRAFT);
    const two = addRow(one.draft);
    expect(two.draft.inserts.map((r) => r.id)).toEqual([two.id, one.id]);
    let d = setNewCell(two.draft, one.id, "email", "x@example.com");
    d = setNewCell(d, one.id, "name", "X");
    d = setNewCell(d, one.id, "name", undefined);
    expect(d.inserts.find((r) => r.id === one.id)?.values).toEqual({ email: "x@example.com" });
    expect(changeCount(d)).toBe(2);
    expect(removeNewRow(d, two.id).inserts.map((r) => r.id)).toEqual([one.id]);
  });
});

test("toEdits: updates carry what they change and what they expected", () => {
  let d = setCell(EMPTY_DRAFT, "r1", K, "name", "b", "a");
  d = setCell(d, "r1", K, "age", 3, 2);
  const n = addRow(d);
  d = setNewCell(n.draft, n.id, "email", "e");
  expect(toEdits(d)).toEqual({
    inserts: [{ email: "e" }],
    updates: [{ key: K, values: { name: "b", age: 3 }, expected: { name: "a", age: 2 } }],
  });
  expect(changeCount(discardRow(d, "r1"))).toBe(1);
});

describe("conflicts", () => {
  const d = setCell(EMPTY_DRAFT, "r1", K, "name", "mine", "a");
  test("a pending cell whose live value moved away from its original is a conflict", () => {
    expect(findConflicts(d, [{ id: "r1", row: { name: "a" } }])).toEqual([]);
    expect(findConflicts(d, [{ id: "r1", row: { name: "theirs" } }])).toEqual([
      { rowId: "r1", column: "name", mine: "mine", theirs: "theirs" },
    ]);
    expect(findConflicts(d, [])).toEqual([]);
  });
  test("keep mine rebases on theirs; use theirs drops the edit", () => {
    const c = { rowId: "r1", column: "name", mine: "mine", theirs: "theirs" };
    const kept = resolveConflict(d, c, "mine");
    expect(kept.updates["r1"]?.cells["name"]).toEqual({ value: "mine", original: "theirs" });
    expect(findConflicts(kept, [{ id: "r1", row: { name: "theirs" } }])).toEqual([]);
    expect(resolveConflict(d, c, "theirs").updates["r1"]).toBeUndefined();
  });
});

test("missingRequired: NOT NULL without a default, unset or NULL, on new rows", () => {
  const columns = [
    col("id", "integer", "serial", { isPrimaryKey: true, nullable: false, hasDefault: true }),
    col("email", "text", "text", { nullable: false }),
    col("name", "text", "text"),
  ];
  const n = addRow(EMPTY_DRAFT);
  expect(missingRequired(n.draft, columns)).toEqual([{ id: n.id, column: "email" }]);
  expect(missingRequired(setNewCell(n.draft, n.id, "email", null), columns)).toHaveLength(1);
  expect(missingRequired(setNewCell(n.draft, n.id, "email", "e"), columns)).toEqual([]);
});
