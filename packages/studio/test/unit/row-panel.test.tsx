import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_VIEW, type Page, Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const USERS = { schema: "public", name: "users" };
const seed = demoDataset(1).tables[0]?.rows ?? [];
const idOf = (n: number) => seed[n - 1]?.["id"] ?? null;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

function setup() {
  const log = createMemoryLog();
  const ds = createMockDataSource({ dataset: demoDataset(1), log });
  const other = createMockDataSource({ dataset: demoDataset(1), log });
  render(<Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />);
  const seen: Page[] = [];
  other.subscribePage(
    { table: USERS, filters: [], sort: [], limit: 5, offset: 0, withTotal: true },
    (p) => seen.push(p),
    () => {},
  );
  return { other, nameIn: (n: number) => seen.at(-1)?.rows[n - 1]?.["name"] };
}
const grid = () => within(screen.getByRole("grid"));
const panel = () => within(screen.getByRole("complementary", { name: "Row" }));
const rowOf = (text: string) => grid().getByText(text).closest("[role=row]") as HTMLElement;
async function open(text: string) {
  fireEvent.click(within(rowOf(text)).getByRole("button", { name: "Expand row" }));
  return panel();
}
function type(field: HTMLElement, to: string) {
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: to } });
  fireEvent.blur(field);
}

describe("the Expand Row panel", () => {
  test("shows every column of the row, with its type", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    expect((p.getByLabelText("email") as HTMLInputElement).value).toBe("user1@example.com");
    expect(p.getByText("timestamp with time zone")).toBeTruthy();
    expect((p.getByLabelText("role") as HTMLSelectElement).tagName).toBe("SELECT");
    expect(p.getByLabelText("profile").tagName).toBe("TEXTAREA");
  });

  test("an edit in the panel is a pending edit of the grid, saved by the same save", async () => {
    const { nameIn } = setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    type(p.getByLabelText("name"), "From the panel");
    expect(grid().getByText("From the panel").closest("[role=gridcell]")?.getAttribute("data-pending")).toBe("true");
    expect(p.getByLabelText("name").closest("[data-pending]")).toBeTruthy();
    const bar = within(screen.getByRole("region", { name: "Unsaved changes" }));
    await act(async () => fireEvent.click(bar.getByRole("button", { name: "Save changes" })));
    await settle();
    expect(nameIn(1)).toBe("From the panel");
  });

  test("revert drops that field's edit only", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    type(p.getByLabelText("name"), "X");
    type(p.getByLabelText("email"), "x@example.com");
    fireEvent.click(p.getByRole("button", { name: "Revert name" }));
    expect((p.getByLabelText("name") as HTMLInputElement).value).toBe("User 1");
    expect(within(screen.getByRole("region", { name: "Unsaved changes" })).getByText("1 unsaved change")).toBeTruthy();
  });

  test("the panel follows the selected row; the other row's edit stays", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    type(p.getByLabelText("name"), "Edited 1");
    fireEvent.click(grid().getByText("User 2"));
    expect((panel().getByLabelText("name") as HTMLInputElement).value).toBe("User 2");
    expect(grid().getByText("Edited 1").closest("[role=gridcell]")?.getAttribute("data-pending")).toBe("true");
  });

  test("switching rows remounts an in-progress field so the typed text never leaks", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    const name = p.getByLabelText("name") as HTMLInputElement;
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Edited 1" } });
    fireEvent.click(grid().getByText("User 2"));
    expect((panel().getByLabelText("name") as HTMLInputElement).value).toBe("User 2");
  });

  test("a change elsewhere to a field being edited keeps what was typed and becomes a conflict", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    const name = p.getByLabelText("name") as HTMLInputElement;
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Mine" } });
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Theirs" } }]));
    await settle();
    expect(name.value).toBe("Mine");
    fireEvent.blur(name);
    expect(await panel().findByText(/changed elsewhere/)).toBeTruthy();
    expect(name.closest("[data-conflict]")).toBeTruthy();
  });

  test("a field of another row, unfocused, shows pushes as they arrive", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    await act(() => other.updateRows(USERS, [{ key: { id: idOf(1) }, values: { name: "Pushed" } }]));
    await settle();
    expect((p.getByLabelText("name") as HTMLInputElement).value).toBe("Pushed");
  });

  test("a row deleted elsewhere says so; its panel does not vanish", async () => {
    const { other } = setup();
    await screen.findByText("User 1");
    await open("User 1");
    await act(() => other.deleteRows(USERS, [{ id: idOf(1) }]));
    await settle();
    expect(panel().getByText(/not on this page any more/)).toBeTruthy();
  });

  test("a new row opens in the panel; required fields are marked; NULL is not offered on NOT NULL selects", async () => {
    setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    fireEvent.click(within(newRow).getByRole("button", { name: "Expand row" }));
    const p = panel();
    expect(p.getByLabelText("email").closest("[data-missing]")).toBeTruthy();
    const role = p.getByLabelText("role") as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).not.toContain("NULL");
    type(p.getByLabelText("email"), "new@example.com");
    expect(p.getByLabelText("email").closest("[data-missing]")).toBeNull();
  });

  test("after save, the panel follows the inserted row even when it is not on this page", async () => {
    setup();
    await screen.findByText("User 1");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    const newRow = screen.getAllByRole("row").find((r) => r.hasAttribute("data-new")) as HTMLElement;
    fireEvent.click(within(newRow).getByRole("button", { name: "Expand row" }));
    type(panel().getByLabelText("email"), "new@example.com");
    const bar = within(screen.getByRole("region", { name: "Unsaved changes" }));
    await act(async () => fireEvent.click(bar.getByRole("button", { name: "Save changes" })));
    await settle();
    expect(screen.queryByText(/not on this page any more/)).toBeNull();
    expect((panel().getByLabelText("email") as HTMLInputElement).value).toBe("new@example.com");
  });

  test("Close closes it", async () => {
    setup();
    await screen.findByText("User 1");
    const p = await open("User 1");
    fireEvent.click(p.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Row" })).toBeNull();
  });
});
