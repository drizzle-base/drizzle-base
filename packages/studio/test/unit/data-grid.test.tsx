import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { Page, TableInfo } from "../../src/contract";
import { DataGrid } from "../../src/grid/data-grid";
import { col } from "../../src/mock";
import { cellKey, rowIdOf } from "../../src/studio/format";

const table: TableInfo = {
  schema: "public",
  name: "t",
  kind: "table",
  columns: [
    col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }),
    col("label", "text", "varchar(255)"),
  ],
  primaryKey: ["id"],
  estimatedRows: null,
};
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, label: i === 1 ? null : `row ${i + 1}` }));
const page: Page = { rows, total: 1000, revision: 3 };

test("headers show the column name and its Postgres type", () => {
  render(<DataGrid table={table} page={page} changed={new Set()} />);
  const header = screen.getAllByRole("columnheader")[1];
  expect(header?.textContent).toContain("label");
  expect(header?.textContent).toContain("varchar(255)");
});

test("NULL renders muted, as NULL", () => {
  render(<DataGrid table={table} page={page} changed={new Set()} />);
  const cell = screen.getAllByRole("gridcell").find((c) => c.textContent === "NULL");
  expect(cell).toBeTruthy();
  expect(cell?.hasAttribute("data-null")).toBe(true);
});

test("only a window of the rows is in the DOM", () => {
  render(<DataGrid table={table} page={page} changed={new Set()} />);
  expect(screen.queryByText("row 1")).toBeTruthy();
  expect(screen.queryByText("row 1000")).toBeNull();
  expect(screen.getAllByRole("row").length).toBeLessThan(100);
});

test("changed cells carry data-changed, the others do not", () => {
  const changed = new Set([cellKey(rowIdOf(["id"], { id: 3 }, 2), "label")]);
  render(<DataGrid table={table} page={page} changed={changed} />);
  const cellOf = (text: string) => screen.getByText(text).closest("[role=gridcell]");
  expect(cellOf("row 3")?.getAttribute("data-changed")).toBe("true");
  expect(cellOf("row 4")?.hasAttribute("data-changed")).toBe(false);
});
