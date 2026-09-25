import { expect, test } from "bun:test";
import { opensExpanded, parseCellValue, textForEditing } from "../../src/edit/values";
import { col } from "../../src/mock";

test("arrays are JSON arrays typed element by element", () => {
  const ints = col("xs", "array", "integer[]", { elementKind: "integer" });
  expect(parseCellValue(ints, "[1, 2, null]")).toEqual({ ok: true, value: [1, 2, null] });
  expect(parseCellValue(ints, '[1, "x"]')).toEqual({ ok: false, error: '"x" is not an integer' });
  expect(parseCellValue(ints, "1,2").ok).toBe(false);
  expect(parseCellValue(ints, "[[1]]").ok).toBe(false);
});

test("other kinds use the filter parser: text keeps spaces, numbers are typed", () => {
  expect(parseCellValue(col("n", "text", "text"), " a ")).toEqual({ ok: true, value: " a " });
  expect(parseCellValue(col("n", "integer", "integer"), "7")).toEqual({ ok: true, value: 7 });
});

test("text for editing: NULL is empty, arrays and json read well", () => {
  expect(textForEditing(col("n", "text", "text"), null)).toBe("");
  expect(textForEditing(col("xs", "array", "text[]"), ["a", "b"])).toBe('["a","b"]');
  expect(textForEditing(col("j", "json", "jsonb"), '{"a":1}')).toBe('{\n  "a": 1\n}');
  expect(textForEditing(col("b", "boolean", "boolean"), false)).toBe("false");
  expect(opensExpanded(col("j", "json", "jsonb"))).toBe(true);
  expect(opensExpanded(col("t", "text", "text"))).toBe(false);
});
