import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { EMPTY_VIEW, Studio, type StudioView, type ViewChange } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";
import { createPrefs } from "../../src/studio/prefs";

const USERS = { schema: "public", name: "users" };
const FIRST_USER_ID = demoDataset(1).tables[0]?.rows[0]?.["id"] ?? null;

function sources() {
  const log = createMemoryLog();
  return {
    ds: createMockDataSource({ dataset: demoDataset(1), log }),
    otherTab: createMockDataSource({ dataset: demoDataset(1), log }),
  };
}

function setup(limit?: number) {
  const { ds, otherTab } = sources();
  render(<Studio dataSource={ds} defaultView={{ ...EMPTY_VIEW, limit: limit ?? EMPTY_VIEW.limit }} />);
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
  test("filters narrow the rows; the pager says 50+ until counted", async () => {
    setup();
    await openTable("users");
    await screen.findByText("1 - 50 of 3000");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const row = within(screen.getByRole("group", { name: "Filter 1" }));
    fireEvent.change(row.getByLabelText("Column"), { target: { value: "role" } });
    fireEvent.change(row.getByLabelText("Value"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("1 - 50 of 50+")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Count rows" }));
    expect(await screen.findByText("1 - 50 of 1000")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Filters/ }).textContent).toContain("1");
  });

  test("controlled: the host gets push for tables and filters, replace for pages", async () => {
    const { ds } = sources();
    const changes: [StudioView, ViewChange][] = [];
    function Host() {
      const [view, setView] = useState<StudioView>(EMPTY_VIEW);
      return (
        <Studio
          dataSource={ds}
          view={view}
          onViewChange={(v, c) => {
            changes.push([v, c]);
            setView(v);
          }}
        />
      );
    }
    render(<Host />);
    await openTable("users");
    await screen.findByText("1 - 50 of 3000");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("51 - 100 of 3000");
    expect(changes.map(([v, c]) => [v.table, v.offset, c.history])).toEqual([
      ["public.users", 0, "push"],
      ["public.users", 50, "replace"],
    ]);
  });

  test("an equal view object does not resubscribe", async () => {
    const { ds } = sources();
    let subscriptions = 0;
    const counting = {
      ...ds,
      subscribePage: (...a: Parameters<typeof ds.subscribePage>) => {
        subscriptions++;
        return ds.subscribePage(...a);
      },
    };
    const view: StudioView = { ...EMPTY_VIEW, table: "public.users" };
    const r = render(<Studio dataSource={counting} view={{ ...view }} />);
    await screen.findByText("1 - 50 of 3000");
    r.rerender(<Studio dataSource={counting} view={{ ...view }} />);
    r.rerender(<Studio dataSource={counting} view={{ ...view }} />);
    await screen.findByText("1 - 50 of 3000");
    expect(subscriptions).toBe(1);
  });

  test("coming back to a table restores its last view", async () => {
    setup();
    await openTable("users");
    await screen.findByText("1 - 50 of 3000");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("51 - 100 of 3000");
    await openTable("posts");
    await screen.findByText("1 - 50 of 1500");
    await openTable("users");
    expect(await screen.findByText("51 - 100 of 3000")).toBeTruthy();
  });

  test("the column layout saved for a table is applied", async () => {
    createPrefs("default").setLayout("public.users", { order: ["email", "id"], hidden: ["name"], widths: {} });
    setup();
    await openTable("users");
    await screen.findByText("user1@example.com");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(headers[0]?.startsWith("email")).toBe(true);
    expect(headers[1]?.startsWith("id")).toBe(true);
    expect(headers.some((h) => h.startsWith("name"))).toBe(false);
  });

  test("an unknown filter column is reported, not dropped silently", async () => {
    const { ds } = sources();
    render(
      <Studio
        dataSource={ds}
        defaultView={{ ...EMPTY_VIEW, table: "public.users", filters: [{ column: "nope", op: "eq", text: "1" }] }}
        notices={['order "x": not column.asc or column.desc, comma-separated']}
      />,
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain('filter on "nope": no such column');
    expect(status.textContent).toContain('order "x"');
  });

  test("a view whose filters are all ignored is unfiltered, so it counts", async () => {
    const { ds } = sources();
    render(
      <Studio
        dataSource={ds}
        defaultView={{ ...EMPTY_VIEW, table: "public.users", filters: [{ column: "nope", op: "eq", text: "1" }] }}
      />,
    );
    expect(await screen.findByText("1 - 50 of 3000")).toBeTruthy();
  });

  test("a view naming a table this database lacks says so", async () => {
    const { ds } = sources();
    render(<Studio dataSource={ds} defaultView={{ ...EMPTY_VIEW, table: "public.gone" }} />);
    expect((await screen.findByRole("status")).textContent).toContain('table "public.gone"');
  });
});
