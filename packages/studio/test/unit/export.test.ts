import { expect, test } from "bun:test";
import { exportCsv, exportJson, exportSql, rowsToExport } from "../../src/grid/export";
import { col } from "../../src/mock";

const columns = [
  col("id", "integer", "int", { nullable: false }),
  col("name", "text", "text"),
  col("ok", "boolean", "boolean"),
];
const rows = [
  { id: 1, name: 'say "hi"', ok: true },
  { id: 2, name: null, ok: false },
];

test("JSON is an array of row objects", () => {
  expect(JSON.parse(exportJson(columns, rows))).toEqual([
    { id: 1, name: 'say "hi"', ok: true },
    { id: 2, name: null, ok: false },
  ]);
});

test("CSV quotes commas, quotes and newlines; NULL is empty", () => {
  expect(exportCsv(columns, rows)).toBe('id,name,ok\n1,"say ""hi""",true\n2,,false\n');
});

test("SQL inserts dollar-quote text and keeps NULL / TRUE", () => {
  const sql = exportSql({ schema: "public", name: "t" }, columns, rows);
  expect(sql).toContain('INSERT INTO "public"."t" ("id", "name", "ok") VALUES');
  expect(sql).toContain('1, $dzb$say "hi"$dzb$, TRUE');
  expect(sql).toContain("2, NULL, FALSE");
});

test("rowsToExport prefers the selection, in page order", () => {
  const page = [
    { id: "b", row: rows[1]! },
    { id: "a", row: rows[0]! },
  ];
  expect(rowsToExport(new Set(["a"]), page)).toEqual([rows[0]!]);
  expect(rowsToExport(new Set(), page)).toEqual(rows.slice().reverse());
});

test("SQL bumps the dollar-quote tag when the value contains it", () => {
  const sql = exportSql({ schema: "public", name: "t" }, [columns[1]!], [{ name: "has $dzb$ inside" }]);
  expect(sql).toContain("$dzb1$has $dzb$ inside$dzb1$");
});

test("SQL doubles quotes in identifiers", () => {
  const sql = exportSql({ schema: 'sch"ema', name: "t" }, [col('n"m', "integer", "int")], [{ 'n"m': 1 }]);
  expect(sql).toContain('INSERT INTO "sch""ema"."t" ("n""m")');
});
