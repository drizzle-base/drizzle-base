import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Page, Sort, TableInfo } from "../../src/contract";
import { DataGrid, type DataGridProps } from "../../src/grid/data-grid";
import { col } from "../../src/mock";
import { cellKey, rowIdOf } from "../../src/studio/format";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const table: TableInfo = {
  schema: "public",
  name: "t",
  kind: "table",
  columns: [
    col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }),
    col("label", "text", "varchar(255)"),
  ],
  primaryKey: ["id"],
  indexes: [],
  estimatedRows: null,
};
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, label: i === 1 ? null : `row ${i + 1}` }));
const page: Page = { rows, total: 1000, hasMore: false, revision: 3 };

function grid(over: Partial<DataGridProps> = {}) {
  const calls: unknown[][] = [];
  const props: DataGridProps = {
    table,
    page,
    changed: new Set(),
    columns: layoutColumns(table.columns, EMPTY_LAYOUT).visible,
    sort: [],
    onSort: (...a) => calls.push(["sort", ...a]),
    onResize: (...a) => calls.push(["resize", ...a]),
    ...over,
  };
  render(<DataGrid {...props} />);
  return calls;
}

test("headers show the column name and its Postgres type", () => {
  grid();
  const header = screen.getAllByRole("columnheader")[1];
  expect(header?.textContent).toContain("label");
  expect(header?.textContent).toContain("varchar(255)");
});

test("NULL renders muted, as NULL", () => {
  grid();
  const cell = screen.getAllByRole("gridcell").find((c) => c.textContent === "NULL");
  expect(cell).toBeTruthy();
  expect(cell?.hasAttribute("data-null")).toBe(true);
});

test("only a window of the rows is in the DOM", () => {
  grid();
  expect(screen.queryByText("row 1")).toBeTruthy();
  expect(screen.queryByText("row 1000")).toBeNull();
  expect(screen.getAllByRole("row").length).toBeLessThan(100);
});

test("changed cells carry data-changed, the others do not", () => {
  grid({ changed: new Set([cellKey(rowIdOf(["id"], { id: 3 }, 2), "label")]) });
  const cellOf = (text: string) => screen.getByText(text).closest("[role=gridcell]");
  expect(cellOf("row 3")?.getAttribute("data-changed")).toBe("true");
  expect(cellOf("row 4")?.hasAttribute("data-changed")).toBe(false);
});

test("only the laid-out columns render, in their order and width", () => {
  grid({
    columns: layoutColumns(table.columns, { order: ["label", "id"], hidden: ["id"], widths: { label: 333 } }).visible,
  });
  const headers = screen.getAllByRole("columnheader");
  expect(headers.map((h) => h.textContent?.startsWith("label"))).toEqual([true]);
  expect((headers[0] as HTMLElement).style.width).toBe("333px");
});

test("a sorted column says so, with its position when there are several", () => {
  const sort: Sort[] = [
    { column: "label", dir: "desc" },
    { column: "id", dir: "asc" },
  ];
  grid({ sort });
  const [id, label] = screen.getAllByRole("columnheader");
  expect(label?.getAttribute("aria-sort")).toBe("descending");
  expect(id?.getAttribute("aria-sort")).toBe("ascending");
  expect(label?.textContent).toContain("1");
});

test("dragging a header's edge resizes it (live, then committed); arrows do too", () => {
  const calls = grid();
  const handle = screen.getByRole("separator", { name: "Resize label" });
  fireEvent.pointerDown(handle, { clientX: 100 });
  fireEvent.pointerMove(window, { clientX: 150 });
  fireEvent.pointerUp(window, { clientX: 160 });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(calls).toEqual([
    ["resize", "label", 250, false],
    ["resize", "label", 260, true],
    ["resize", "label", 184, true],
  ]);
});

test("no visible column says so instead of an empty grid", () => {
  grid({ columns: [] });
  expect(screen.getByText(/All columns are hidden/)).toBeTruthy();
});
