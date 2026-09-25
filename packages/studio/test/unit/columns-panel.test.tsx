import { expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { col } from "../../src/mock";
import { ColumnsPanel } from "../../src/studio/columns-panel";
import { type ColumnLayout, EMPTY_LAYOUT } from "../../src/studio/prefs";

const columns = ["id", "email", "name"].map((n) => col(n, "text", "text"));

function setup(layout: ColumnLayout = EMPTY_LAYOUT) {
  const calls: ColumnLayout[] = [];
  render(<ColumnsPanel columns={columns} layout={layout} onChange={(l) => calls.push(l)} />);
  const item = (name: string) => within(screen.getByRole("list", { name: "Columns" })).getByRole("button", { name });
  return { calls, item };
}

test("clicking a column toggles it; its state is announced", () => {
  const { calls, item } = setup({ ...EMPTY_LAYOUT, hidden: ["name"] });
  expect(item("email").getAttribute("aria-pressed")).toBe("true");
  expect(item("name").getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(item("email"));
  fireEvent.click(item("name"));
  expect(calls.map((l) => l.hidden)).toEqual([["name", "email"], []]);
});

test("hide all, then show all", () => {
  const first = setup();
  fireEvent.click(screen.getByRole("button", { name: "Hide all columns" }));
  expect(first.calls.at(-1)?.hidden).toEqual(["id", "email", "name"]);
});

test("Alt+Arrow moves a column; so does dropping one onto another", () => {
  const { calls, item } = setup();
  fireEvent.keyDown(item("name"), { key: "ArrowUp", altKey: true });
  expect(calls.at(-1)?.order).toEqual(["id", "name", "email"]);
  fireEvent.dragStart(item("id").closest("li") as HTMLElement);
  fireEvent.drop(item("name").closest("li") as HTMLElement);
  expect(calls.at(-1)?.order).toEqual(["email", "name", "id"]);
});

test("search narrows the list", () => {
  setup();
  fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "em" } });
  const names = within(screen.getByRole("list", { name: "Columns" }))
    .getAllByRole("button")
    .map((b) => b.textContent);
  expect(names).toEqual(["email"]);
});
