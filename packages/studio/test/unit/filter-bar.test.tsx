import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TableInfo } from "../../src/contract";
import { demoDataset } from "../../src/mock";
import { FilterBar } from "../../src/studio/filter-bar";
import { createPrefs } from "../../src/studio/prefs";
import type { ViewFilter } from "../../src/view";

const users = demoDataset(1).tables[0]?.info as TableInfo;

function setup(applied: ViewFilter[] = []) {
  const calls: ViewFilter[][] = [];
  const view = render(<FilterBar table={users} applied={applied} onApply={(f) => calls.push(f)} />);
  const row = (n: number) => within(screen.getByRole("group", { name: `Filter ${n}` }));
  const set = (n: number, label: string, value: string) =>
    fireEvent.change(row(n).getByLabelText(label), { target: { value } });
  return { calls, view, row, set };
}

describe("<FilterBar>", () => {
  test("typing does not filter; Apply and Enter do", () => {
    const { calls, row, set } = setup();
    set(1, "Column", "name");
    set(1, "Value", "User 1");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.keyDown(row(1).getByLabelText("Value"), { key: "Enter" });
    expect(calls).toEqual([
      [{ column: "name", op: "eq", text: "User 1" }],
      [{ column: "name", op: "eq", text: "User 1" }],
    ]);
  });

  test("an invalid value blocks Apply and says why", () => {
    const { calls, row, set } = setup();
    set(1, "Column", "age");
    set(1, "Value", "old");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    expect(row(1).getByText('"old" is not an integer')).toBeTruthy();
    expect(row(1).getByLabelText("Value").getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(row(1).getByLabelText("Value"), { key: "Enter" });
    expect(calls).toEqual([]);
    set(1, "Value", "30");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false);
  });

  test("boolean and enum offer their values; is null asks for none", () => {
    const { calls, row, set } = setup();
    set(1, "Column", "active");
    expect(row(1).getByLabelText("Value").tagName).toBe("SELECT");
    set(1, "Column", "role");
    const options = [...row(1).getByLabelText("Value").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["choose…", "admin", "editor", "viewer"]);
    set(1, "Operator", "isNull");
    expect(row(1).queryByLabelText("Value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(calls).toEqual([[{ column: "role", op: "isNull", text: "" }]]);
  });

  test("in takes a typed list; a bad item is named", () => {
    const { row, set } = setup();
    set(1, "Column", "role");
    set(1, "Operator", "in");
    set(1, "Value", "admin, nope");
    expect(row(1).getByText(/"nope" is not one of/)).toBeTruthy();
  });

  test("blank rows are not applied; rows can be removed; Clear filters applies nothing", () => {
    const { calls, row, set } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    set(2, "Column", "email");
    set(2, "Operator", "ilike");
    set(2, "Value", "%@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(calls.at(-1)).toEqual([{ column: "email", op: "ilike", text: "%@example.com" }]);
    fireEvent.click(row(1).getByRole("button", { name: "Remove filter 1" }));
    expect(screen.queryByRole("group", { name: "Filter 2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(calls.at(-1)).toEqual([]);
  });

  test("what is applied changing from outside (a link, Back) replaces the drafts", () => {
    const { view, row } = setup([{ column: "name", op: "eq", text: "a" }]);
    view.rerender(
      <FilterBar table={users} applied={[{ column: "email", op: "ilike", text: "b%" }]} onApply={() => {}} />,
    );
    expect((row(1).getByLabelText("Value") as HTMLInputElement).value).toBe("b%");
  });

  test("every draft edit is reported; remounting via prefs keeps the typed text", () => {
    const prefs = createPrefs("x");
    const table = "public.users";
    const seen: ViewFilter[][] = [];
    const bar = (applied: ViewFilter[]) => (
      <FilterBar
        table={users}
        applied={applied}
        onApply={() => {}}
        onDraftChange={(f) => {
          seen.push(f);
          prefs.setFilterDrafts(table, f);
        }}
      />
    );
    const row = (n: number) => within(screen.getByRole("group", { name: `Filter ${n}` }));
    const first = render(bar([]));
    fireEvent.change(row(1).getByLabelText("Column"), { target: { value: "name" } });
    fireEvent.change(row(1).getByLabelText("Value"), { target: { value: "User 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.click(row(2).getByRole("button", { name: "Remove filter 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(seen.length).toBeGreaterThanOrEqual(4);
    fireEvent.change(row(1).getByLabelText("Column"), { target: { value: "name" } });
    fireEvent.change(row(1).getByLabelText("Value"), { target: { value: "User 1" } });
    expect(prefs.filterDrafts(table)).toEqual([{ column: "name", op: "eq", text: "User 1" }]);
    first.unmount();
    render(bar(prefs.filterDrafts(table) ?? []));
    expect((row(1).getByLabelText("Value") as HTMLInputElement).value).toBe("User 1");
  });
});
