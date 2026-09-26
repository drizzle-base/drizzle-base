import { expect, test } from "bun:test";
import { exportCsv, exportJson, exportSql } from "../../src/grid/export";
import { parseImport } from "../../src/import/parse";
import { col } from "../../src/mock";

test("JSON / CSV / SQL of the same two rows round-trip through export", () => {
  const columns = [col("id", "integer", "int", { nullable: false }), col("name", "text", "text")];
  const rows = [
    { id: 1, name: 'say "hi"' },
    { id: 2, name: null },
  ];
  const table = { schema: "public", name: "t" };
  const json = parseImport(exportJson(columns, rows), "json");
  const csv = parseImport(exportCsv(columns, rows), "csv");
  const sql = parseImport(exportSql(table, columns, rows), "sql");
  expect(json.ok && csv.ok && sql.ok).toBe(true);
  if (json.ok && csv.ok && sql.ok) {
    expect(json.rows).toEqual([
      { id: "1", name: 'say "hi"' },
      { id: "2", name: "" },
    ]);
    expect(csv.rows).toEqual(json.rows);
    expect(sql.rows).toEqual(json.rows);
    expect(sql.table).toEqual(table);
  }
});

test("SQL that is not our INSERT is refused", () => {
  expect(parseImport("SELECT 1;", "sql").ok).toBe(false);
});

test("JSON objects and arrays become JSON text; null is empty", () => {
  const r = parseImport('[{"meta":{"k":1},"tags":["a"],"n":null}]\n', "json");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.rows).toEqual([{ meta: '{"k":1}', tags: '["a"]', n: "" }]);
});

test("empty CSV and a JSON value that is not an array of objects are refused", () => {
  expect(parseImport("", "csv").ok).toBe(false);
  expect(parseImport("\n", "csv").ok).toBe(false);
  expect(parseImport("{}", "json").ok).toBe(false);
  expect(parseImport("[1]", "json").ok).toBe(false);
});

test("SQL inverts dollar-quote bumps and doubled identifier quotes", () => {
  const bumped = parseImport(
    exportSql({ schema: "public", name: "t" }, [col("name", "text", "text")], [{ name: "has $dzb$ inside" }]),
    "sql",
  );
  expect(bumped.ok).toBe(true);
  if (bumped.ok) expect(bumped.rows).toEqual([{ name: "has $dzb$ inside" }]);

  const quoted = parseImport(
    exportSql({ schema: 'sch"ema', name: "t" }, [col('n"m', "integer", "int")], [{ 'n"m': 1 }]),
    "sql",
  );
  expect(quoted.ok).toBe(true);
  if (quoted.ok) {
    expect(quoted.table).toEqual({ schema: 'sch"ema', name: "t" });
    expect(quoted.rows).toEqual([{ 'n"m': "1" }]);
  }
});
