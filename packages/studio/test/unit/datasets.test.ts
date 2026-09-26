import { describe, expect, test } from "bun:test";
import { type ColumnKind, type Row, tableId } from "../../src/contract";
import { conformanceDataset } from "../../src/mock/datasets/conformance";
import { demoDataset } from "../../src/mock/datasets/demo";

describe("demo dataset", () => {
  test("the same seed builds the same rows; another seed does not", () => {
    expect(JSON.stringify(demoDataset(1))).toBe(JSON.stringify(demoDataset(1)));
    expect(JSON.stringify(demoDataset(1))).not.toBe(JSON.stringify(demoDataset(2)));
  });

  test("its relations and sizes", () => {
    const d = demoDataset(1);
    const sizes = Object.fromEntries(d.tables.map((t) => [tableId(t.info), t.rows.length]));
    expect(sizes).toEqual({
      "public.users": 3000,
      "public.posts": 1500,
      "public.comments": 2000,
      "public.audit_log": 50,
      "billing.invoices": 100,
    });
    expect(d.views.map((v) => tableId(v.info))).toEqual(["public.published_posts"]);
    expect(d.tables.find((t) => t.info.name === "audit_log")?.info.primaryKey).toEqual([]);
  });

  test("every column kind appears, so every editor has a column to edit", () => {
    const kinds = new Set<ColumnKind>(demoDataset(1).tables.flatMap((t) => t.info.columns.map((c) => c.kind)));
    const all: ColumnKind[] = [
      "text",
      "integer",
      "bigint",
      "float",
      "numeric",
      "boolean",
      "uuid",
      "date",
      "timestamp",
      "timestamptz",
      "json",
      "enum",
      "bytea",
      "array",
      "unknown",
    ];
    expect(all.filter((k) => !kinds.has(k))).toEqual([]);
  });

  test("every foreign key points at an existing row, and NOT NULL columns hold no NULL", () => {
    const d = demoDataset(1);
    const byId = new Map(d.tables.map((t) => [tableId(t.info), t]));
    for (const t of d.tables) {
      for (const c of t.info.columns) {
        const values = t.rows.map((r) => r[c.name] ?? null);
        if (!c.nullable) expect(values.filter((v) => v === null).length).toBe(0);
        const ref = c.references;
        if (!ref) continue;
        const target = byId.get(`${ref.schema}.${ref.table}`);
        const keys = new Set(target?.rows.map((r: Row) => JSON.stringify(r[ref.column] ?? null)));
        const dangling = values.filter((v) => v !== null && !keys.has(JSON.stringify(v)));
        expect(dangling).toEqual([]);
      }
    }
  });

  test("hasDefault mirrors the defaults and the primary key mirrors isPrimaryKey", () => {
    for (const t of demoDataset(1).tables) {
      for (const c of t.info.columns) expect(c.hasDefault).toBe(t.defaults[c.name] !== undefined);
      expect(t.info.primaryKey).toEqual(t.info.columns.filter((c) => c.isPrimaryKey).map((c) => c.name));
    }
  });

  test("a table with a primary key lists that index; a view and a heap do not", () => {
    const d = demoDataset(1);
    const users = d.tables.find((t) => t.info.name === "users")?.info;
    expect(users?.indexes).toEqual([{ name: "users_pkey", columns: ["id"], unique: true, primary: true }]);
    expect(d.tables.find((t) => t.info.name === "audit_log")?.info.indexes).toEqual([]);
    expect(d.views[0]?.info.indexes).toEqual([]);
  });

  test("the view derives its rows from its base tables", () => {
    const d = demoDataset(1);
    const rows = (id: string) => d.tables.find((t) => tableId(t.info) === id)?.rows ?? [];
    const published = d.views[0]?.compute(rows) ?? [];
    expect(published.length).toBe(rows("public.posts").filter((p) => p["published"] === true).length);
    expect(published[0]).toEqual({ id: expect.any(Number), title: expect.any(String), email: expect.any(String) });
  });
});

test("conformance dataset: the shape the conformance suite relies on", () => {
  const d = conformanceDataset();
  const items = d.tables.find((t) => t.info.name === "items");
  expect(items?.info.primaryKey).toEqual(["id"]);
  expect(items?.rows).toEqual([]);
  expect(items?.info.columns.map((c) => [c.name, c.kind, c.nullable, c.hasDefault])).toEqual([
    ["id", "integer", false, true],
    ["label", "text", false, false],
    ["rank", "integer", true, false],
    ["note", "text", true, false],
  ]);
  expect(d.tables.find((t) => t.info.name === "log")?.info.primaryKey).toEqual([]);
  expect(d.views.map((v) => [v.info.name, v.info.kind, v.info.primaryKey])).toEqual([["items_view", "view", []]]);
});
