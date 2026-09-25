import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const USERS = { schema: "public", name: "users" };
const FIRST_USER_ID = demoDataset(1).tables[0]?.rows[0]?.["id"] ?? null;

function setup(pageSize?: number) {
  const log = createMemoryLog();
  const ds = createMockDataSource({ dataset: demoDataset(1), log });
  const otherTab = createMockDataSource({ dataset: demoDataset(1), log });
  render(<Studio dataSource={ds} pageSize={pageSize} />);
  return { ds, otherTab };
}

async function openTable(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

const changedCells = () => screen.queryAllByRole("gridcell").filter((c) => c.hasAttribute("data-changed"));

describe("<Studio>", () => {
  test("lists the default schema's tables, then views, with row estimates", async () => {
    setup();
    const nav = await screen.findByRole("navigation", { name: "Tables" });
    const names = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["audit_log50", "comments2.00K", "posts1.50K", "users3.00K", "published_posts"]);
    expect(within(nav).getByRole("button", { name: "published_posts" }).getAttribute("data-kind")).toBe("view");
  });

  test("searching filters the list", async () => {
    setup();
    fireEvent.change(await screen.findByLabelText("Search tables"), { target: { value: "po" } });
    const nav = screen.getByRole("navigation", { name: "Tables" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["posts1.50K", "published_posts"]);
  });

  test("opening a table shows its first page and the pager", async () => {
    setup();
    await openTable("users");
    expect(await screen.findByText("user1@example.com")).toBeTruthy();
    expect(screen.getByText("1 - 50 of 3000")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(true);
  });

  test("a write from another tab appears without a refresh, and only its cell flashes", async () => {
    const { otherTab } = setup();
    await openTable("users");
    await screen.findByText("user1@example.com");
    expect(changedCells()).toEqual([]);
    await act(async () => {
      await otherTab.externalWrite({
        kind: "update",
        table: USERS,
        changes: [{ key: { id: FIRST_USER_ID }, values: { name: "Changed in psql" } }],
      });
    });
    const cell = (await screen.findByText("Changed in psql")).closest("[role=gridcell]");
    expect(cell?.getAttribute("data-changed")).toBe("true");
    expect(changedCells()).toHaveLength(1);
  });

  test("next page, and switching table, show no changed cells", async () => {
    setup();
    await openTable("users");
    await screen.findByText("user1@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("51 - 100 of 3000")).toBeTruthy();
    expect(await screen.findByText("user51@example.com")).toBeTruthy();
    expect(changedCells()).toEqual([]);
    await openTable("posts");
    expect(await screen.findByText("1 - 50 of 1500")).toBeTruthy();
    expect(changedCells()).toEqual([]);
  });

  test("the last page emptied elsewhere steps back to the new last page", async () => {
    const { otherTab } = setup(1000);
    await openTable("users");
    expect(await screen.findByText("1 - 1000 of 3000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("1001 - 2000 of 3000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("2001 - 3000 of 3000")).toBeTruthy();
    const last =
      demoDataset(1)
        .tables[0]?.rows.slice(2000)
        .map((r) => ({ id: r["id"] ?? null })) ?? [];
    await act(async () => {
      await otherTab.deleteRows(USERS, last);
    });
    expect(await screen.findByText("1001 - 2000 of 2000")).toBeTruthy();
  });

  test("a table without a primary key is marked read-only", async () => {
    setup();
    await openTable("audit_log");
    expect(await screen.findByText("read-only")).toBeTruthy();
  });
});
