import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Page, TableInfo } from "../../src/contract";
import { DataGrid } from "../../src/grid/data-grid";
import { col } from "../../src/mock";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const table: TableInfo = {
  schema: "public",
  name: "t",
  kind: "table",
  columns: [col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }), col("label", "text", "text")],
  primaryKey: ["id"],
  estimatedRows: 20,
};
const page: Page = {
  rows: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` })),
  total: 20,
  hasMore: false,
  revision: 1,
};

function renderGrid() {
  render(
    <DataGrid
      table={table}
      page={page}
      changed={new Set()}
      columns={layoutColumns(table.columns, EMPTY_LAYOUT).visible}
      sort={[]}
      onSort={() => {}}
      onResize={() => {}}
    />,
  );
  return screen.getByRole("grid");
}
const cell = (text: string) => screen.getByText(text).closest("[role=gridcell]") as HTMLElement;

test("click selects one cell; Shift+click extends a rectangle", () => {
  const grid = renderGrid();
  fireEvent.click(cell("row 1"));
  expect(cell("row 1").getAttribute("aria-selected")).toBe("true");
  expect(cell("row 2").hasAttribute("data-range")).toBe(false);
  fireEvent.click(cell("row 3"), { shiftKey: true });
  expect(cell("row 1").hasAttribute("data-range")).toBe(true);
  expect(cell("row 2").hasAttribute("data-range")).toBe(true);
  expect(cell("row 3").hasAttribute("data-range")).toBe(true);
  expect(cell("row 3").getAttribute("aria-selected")).toBe("true");
  expect(cell("row 4").hasAttribute("data-range")).toBe(false);
  fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
  expect(cell("row 4").hasAttribute("data-range")).toBe(true);
});
