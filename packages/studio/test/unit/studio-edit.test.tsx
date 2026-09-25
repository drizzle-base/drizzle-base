import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_VIEW, type Page, Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const USERS = { schema: "public", name: "users" };
const seed = demoDataset(1).tables[0]?.rows ?? [];
const idOf = (n: number) => seed[n - 1]?.["id"] ?? null;

function setup(onDirtyChange?: (dirty: boolean) => void) {
  const log = createMemoryLog();
  const ds = createMockDataSource({ dataset: demoDataset(1), log });
  const other = createMockDataSource({ dataset: demoDataset(1), log });
  render(
    <Studio dataSource={ds} defaultView={{ ...EMPTY_VIEW, table: "public.users" }} onDirtyChange={onDirtyChange} />,
  );
  const seen: Page[] = [];
  other.subscribePage(
    { table: USERS, filters: [], sort: [], limit: 5, offset: 0, withTotal: true },
    (p) => seen.push(p),
    () => {},
  );
  return { ds, other, seen, nameIn: (n: number) => seen.at(-1)?.rows[n - 1]?.["name"] };
}

// Inside the grid: the edit bar repeats values ("yours: …").
const cell = (text: string) =>
  within(screen.getByRole("grid")).getByText(text).closest("[role=gridcell]") as HTMLElement;
async function edit(text: string, to: string) {
  fireEvent.doubleClick(cell(text));
  const input = await screen.findByRole("textbox", { name: /^Edit / });
  fireEvent.change(input, { target: { value: to } });
  fireEvent.keyDown(input, { key: "Enter" });
}
const bar = () => within(screen.getByRole("region", { name: "Unsaved changes" }));
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

describe("editing in the studio", () => {
  test("an edit pends until saved; Save writes it and other tabs see it", async () => {
    const { nameIn } = setup();
    await screen.findByText("User 1");
    await edit("User 1", "Renamed");
    expect(bar().getByText("1 unsaved change")).toBeTruthy();
    await settle();
    expect(nameIn(1)).toBe("User 1");
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    await settle();
    expect(nameIn(1)).toBe("Renamed");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  test("Discard puts every value back", async () => {
    setup();
    await screen.findByText("User 1");
    await edit("User 1", "X");
    fireEvent.click(bar().getByRole("button", { name: "Discard changes" }));
    expect(screen.getByText("User 1")).toBeTruthy();
  });

  test("a failed save keeps every edit and says why", async () => {
    const { nameIn } = setup();
    await screen.findByText("User 1");
    await edit("User 3", "Would land alone");
    // A new row whose id is taken: the insert fails, and the valid update beside it must not land either.
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    for (const [index, value] of [
      [1, String(idOf(1))],
      [2, "taken@example.com"],
    ] as const) {
      fireEvent.doubleClick(within(newRow).getAllByRole("gridcell")[index] as HTMLElement);
      const input = await screen.findByRole("textbox", { name: /^Edit / });
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    expect((await screen.findByRole("alert")).textContent).toContain("already has a row");
    expect(bar().getByText("2 unsaved changes")).toBeTruthy();
    await settle();
    expect(nameIn(3)).toBe("User 3");
  });

  test("a change elsewhere to an edited cell is a conflict: blocked until resolved; keep mine wins", async () => {
    const { other, nameIn } = setup();
    await screen.findByText("User 1");
    await edit("User 1", "Mine");
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Theirs" } }]));
    expect(await bar().findByText(/changed elsewhere/)).toBeTruthy();
    expect(bar().getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    expect(cell("Mine").getAttribute("data-conflict")).toBe("true");
    fireEvent.click(bar().getByRole("button", { name: "Keep mine" }));
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    await settle();
    expect(nameIn(1)).toBe("Mine");
  });

  test("use theirs drops the edit", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    await edit("User 1", "Mine");
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Theirs" } }]));
    fireEvent.click(await bar().findByRole("button", { name: "Use theirs" }));
    expect(screen.getByText("Theirs")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  test("a row deleted elsewhere turns its save into a conflict, with a way out", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    await edit("User 2", "Edited");
    await act(() => other.deleteRows(USERS, [{ id: idOf(2) }]));
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("deleted elsewhere");
    fireEvent.click(within(alert).getByRole("button", { name: "Discard this row's edits" }));
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  test("a new row needs its required values before it can be saved", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(bar().getByText("1 required value missing")).toBeTruthy();
    expect(bar().getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    fireEvent.doubleClick(within(newRow).getAllByRole("gridcell")[2] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Edit email"), { target: { value: "new@example.com" } });
    fireEvent.keyDown(screen.getByLabelText("Edit email"), { key: "Enter" });
    await act(async () => fireEvent.click(bar().getByRole("button", { name: "Save changes" })));
    const seen: Page[] = [];
    other.subscribePage(
      {
        table: USERS,
        filters: [{ column: "email", op: "eq", value: "new@example.com" }],
        sort: [],
        limit: 1,
        offset: 0,
        withTotal: true,
      },
      (p) => seen.push(p),
      () => {},
    );
    await settle();
    expect(seen.at(-1)?.total).toBe(1);
  });

  test("deleting asks first, then deletes for every tab", async () => {
    const { seen } = setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Select row" })[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 row" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete rows" })));
    await settle();
    expect(seen.at(-1)?.total).toBe(2999);
  });

  test("edits survive switching tables; the sidebar marks the table; the host is told", async () => {
    const dirty: boolean[] = [];
    setup((d) => dirty.push(d));
    await screen.findByText("User 1");
    await edit("User 1", "Kept");
    fireEvent.click(screen.getByRole("button", { name: "posts" }));
    await screen.findByText("Post 1");
    expect(screen.getByRole("button", { name: "users" }).getAttribute("data-dirty")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "users" }));
    expect((await screen.findByText("Kept")).closest("[role=gridcell]")?.getAttribute("data-pending")).toBe("true");
    expect(dirty).toContain(true);
  });

  test("views and tables without a key show no editing", async () => {
    setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getByRole("button", { name: "audit_log" }));
    await screen.findByText("read-only");
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select all rows" })).toBeNull();
  });
});
