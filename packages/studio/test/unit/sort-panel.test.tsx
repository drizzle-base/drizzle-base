import { expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Sort } from "../../src/contract";
import { col } from "../../src/mock";
import { SortPanel } from "../../src/studio/sort-panel";

const columns = ["id", "email", "age"].map((n) => col(n, "text", "text"));

function setup(sort: Sort[]) {
  const calls: Sort[][] = [];
  render(<SortPanel columns={columns} sort={sort} onChange={(s) => calls.push(s)} />);
  return calls;
}

test("columns not yet sorted are offered, searchable; picking one appends it ascending", () => {
  const calls = setup([{ column: "id", dir: "asc" }]);
  const offered = within(screen.getByRole("list", { name: "Columns" }));
  expect(offered.getAllByRole("button").map((b) => b.textContent)).toEqual(["email", "age"]);
  fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "ag" } });
  expect(offered.getAllByRole("button").map((b) => b.textContent)).toEqual(["age"]);
  fireEvent.click(offered.getByRole("button", { name: "age" }));
  expect(calls).toEqual([
    [
      { column: "id", dir: "asc" },
      { column: "age", dir: "asc" },
    ],
  ]);
});

test("an active sort flips direction, is removed, and all are cleared", () => {
  const calls = setup([
    { column: "id", dir: "asc" },
    { column: "age", dir: "desc" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Direction of age: desc" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove sort by id" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear sorting" }));
  expect(calls).toEqual([
    [
      { column: "id", dir: "asc" },
      { column: "age", dir: "asc" },
    ],
    [{ column: "age", dir: "desc" }],
    [],
  ]);
});
