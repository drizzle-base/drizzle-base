import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { Page, TableInfo } from "../../src/contract";
import { addRow, EMPTY_DRAFT, removeNewRow, setCell, setNewCell, type TableDraft } from "../../src/edit/draft";
import { DataGrid } from "../../src/grid/data-grid";
import { demoDataset } from "../../src/mock";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const users = demoDataset(1).tables[0]?.info as TableInfo;
const rows = (demoDataset(1).tables[0]?.rows ?? []).slice(0, 5);
const page: Page = { rows, total: 3000, hasMore: true, revision: 1 };

function Harness({
  start = EMPTY_DRAFT,
  conflicts = new Set<string>(),
}: {
  start?: TableDraft;
  conflicts?: Set<string>;
}) {
  const [draft, setDraft] = useState(start);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      <output data-testid="draft">{JSON.stringify(draft)}</output>
      <DataGrid
        table={users}
        page={page}
        changed={new Set()}
        columns={layoutColumns(users.columns, EMPTY_LAYOUT).visible}
        sort={[]}
        onSort={() => {}}
        onResize={() => {}}
        editing={{
          draft,
          conflicts,
          selectedRows: selected,
          onToggleRow: (id) => setSelected(new Set([...selected, id])),
          onToggleAll: (ids) => setSelected(new Set(ids)),
          onEditExisting: (rowId, key, column, value, original) =>
            setDraft(setCell(draft, rowId, key, column, value, original)),
          onEditNew: (id, column, value) => setDraft(setNewCell(draft, id, column, value)),
          onRemoveNew: (id) => setDraft(removeNewRow(draft, id)),
          onExpandRow: () => {},
          onFocusRow: () => {},
        }}
      />
    </>
  );
}

const draftNow = () => JSON.parse(screen.getByTestId("draft").textContent ?? "{}") as TableDraft;
const cell = (text: string) => screen.getByText(text).closest("[role=gridcell]") as HTMLElement;

describe("editing in the grid", () => {
  test("double-click edits; Enter commits a pending value; Esc cancels", () => {
    render(<Harness />);
    fireEvent.doubleClick(cell("User 1"));
    const input = screen.getByLabelText("Edit name");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cell("Renamed").getAttribute("data-pending")).toBe("true");
    expect(Object.values(draftNow().updates)[0]?.cells["name"]).toEqual({ value: "Renamed", original: "User 1" });
    fireEvent.doubleClick(cell("User 2"));
    fireEvent.change(screen.getByLabelText("Edit name"), { target: { value: "nope" } });
    fireEvent.keyDown(screen.getByLabelText("Edit name"), { key: "Escape" });
    expect(screen.getByText("User 2")).toBeTruthy();
    expect(Object.keys(draftNow().updates)).toHaveLength(1);
  });

  test("a click selects a cell and Enter starts editing it", () => {
    render(<Harness />);
    fireEvent.click(cell("User 3"));
    expect(cell("User 3").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(cell("User 3"), { key: "Enter" });
    expect(screen.getByLabelText("Edit name")).toBeTruthy();
  });

  test("an invalid value stays in the editor and says why", () => {
    render(<Harness />);
    const age = String(rows[0]?.["age"]);
    fireEvent.doubleClick(screen.getAllByText(age)[0]?.closest("[role=gridcell]") as HTMLElement);
    fireEvent.change(screen.getByLabelText("Edit age"), { target: { value: "old" } });
    fireEvent.keyDown(screen.getByLabelText("Edit age"), { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe('"old" is not an integer');
    expect(screen.getByLabelText("Edit age")).toBeTruthy();
    expect(Object.keys(draftNow().updates)).toHaveLength(0);
  });

  test("Tab commits and edits the next column", () => {
    render(<Harness />);
    fireEvent.doubleClick(cell("user1@example.com"));
    fireEvent.change(screen.getByLabelText("Edit email"), { target: { value: "a@b.c" } });
    fireEvent.keyDown(screen.getByLabelText("Edit email"), { key: "Tab" });
    expect(screen.getByLabelText("Edit name")).toBeTruthy();
  });

  test("enum and boolean edit with a select; a NOT NULL column offers no NULL", () => {
    render(<Harness />);
    fireEvent.doubleClick(screen.getAllByText(String(rows[0]?.["role"]))[0]?.closest("[role=gridcell]") as HTMLElement);
    const role = screen.getByLabelText("Edit role") as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).toEqual(["admin", "editor", "viewer"]);
    fireEvent.change(role, { target: { value: "admin" } });
    expect(Object.values(draftNow().updates)[0]?.cells["role"]?.value).toBe(
      rows[0]?.["role"] === "admin" ? undefined : "admin",
    );
  });

  test("json opens the expanded editor; invalid JSON cannot be saved", () => {
    render(<Harness />);
    const profile = String(rows[0]?.["profile"]);
    fireEvent.doubleClick(cell(profile));
    const dialog = screen.getByRole("dialog");
    const area = within(dialog).getByLabelText("Value of profile");
    fireEvent.change(area, { target: { value: "{bad" } });
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(area, { target: { value: '{"a": 1}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(Object.values(draftNow().updates)[0]?.cells["profile"]?.value).toBe('{"a": 1}');
  });

  test("a new row shows DEFAULT and NULL, marks what is required, and can be removed", () => {
    const { draft } = addRow(EMPTY_DRAFT);
    render(<Harness start={draft} />);
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    const cells = within(newRow).getAllByRole("gridcell").slice(1);
    expect(cells.slice(0, 3).map((c) => c.textContent)).toEqual(["DEFAULT", "NULL", "NULL"]);
    expect(cells[1]?.getAttribute("data-missing")).toBe("true");
    expect(cells[0]?.hasAttribute("data-missing")).toBe(false);
    fireEvent.click(within(newRow).getByRole("button", { name: "Remove new row" }));
    expect(draftNow().inserts).toEqual([]);
  });

  test("rows are selected with their checkbox, all at once from the header", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.getAllByRole("checkbox", { name: "Select row" }).every((c) => (c as HTMLInputElement).checked)).toBe(
      true,
    );
  });

  test("a conflicted cell is marked", () => {
    const d = setCell(EMPTY_DRAFT, `["${rows[0]?.["id"]}"]`, { id: rows[0]?.["id"] ?? null }, "name", "mine", "User 1");
    render(<Harness start={d} conflicts={new Set([`["${rows[0]?.["id"]}"]\u0000name`])} />);
    expect(cell("mine").getAttribute("data-conflict")).toBe("true");
  });
});
