import { describe, expect, test } from "bun:test";
import { col } from "../../src/mock";
import { createPrefs, EMPTY_LAYOUT, layoutColumns, moveItem } from "../../src/studio/prefs";
import { EMPTY_VIEW } from "../../src/view";

const columns = ["id", "email", "name"].map((n) => col(n, "text", "text"));

describe("layoutColumns", () => {
  test("saved order first, new columns after in table order; hidden are left out; widths clamp", () => {
    const { ordered, visible } = layoutColumns(columns, {
      order: ["name", "gone", "id"],
      hidden: ["id"],
      widths: { name: 320, email: 10 },
    });
    expect(ordered.map((c) => c.name)).toEqual(["name", "id", "email"]);
    expect(visible.map((v) => [v.column.name, v.width])).toEqual([
      ["name", 320],
      ["email", 60],
    ]);
  });
  test("an empty layout is the table's order at the default width", () => {
    expect(layoutColumns(columns, EMPTY_LAYOUT).visible.map((v) => v.width)).toEqual([200, 200, 200]);
  });
});

test("moveItem", () => {
  expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
});

describe("createPrefs", () => {
  test("layouts and last views round-trip per table and per namespace", () => {
    const a = createPrefs("db-a");
    const b = createPrefs("db-b");
    const layout = { order: ["name"], hidden: ["id"], widths: { name: 300 } };
    a.setLayout("public.users", layout);
    expect(a.layout("public.users")).toEqual(layout);
    expect(b.layout("public.users")).toEqual(EMPTY_LAYOUT);
    expect(a.layout("public.posts")).toEqual(EMPTY_LAYOUT);
    const view = { ...EMPTY_VIEW, table: "public.users", filters: [{ column: "age", op: "gt" as const, text: "3" }] };
    a.setLastView("public.users", view);
    expect(a.lastView("public.users")).toEqual(view);
    expect(a.lastView("public.posts")).toBeNull();
    const leftover = [{ column: "age", op: "gt" as const, text: "3" }];
    a.setFilterDrafts("public.users", leftover);
    expect(a.filterDrafts("public.users")).toEqual(leftover);
    expect(b.filterDrafts("public.users")).toBeNull();
    expect(a.filterDrafts("public.posts")).toBeNull();
    expect(localStorage.getItem("dzb-studio:db-a:filters:public.users")).toBe(JSON.stringify(leftover));
  });
  test("garbage in storage reads as nothing saved", () => {
    localStorage.setItem("dzb-studio:x:layout:t", "{not json");
    localStorage.setItem("dzb-studio:x:view:t", "v=9&table=t");
    localStorage.setItem("dzb-studio:x:filters:t", "{not json");
    const p = createPrefs("x");
    expect(p.layout("t")).toEqual(EMPTY_LAYOUT);
    expect(p.lastView("t")).toBeNull();
    expect(p.filterDrafts("t")).toBeNull();
    // Half-readable is unreadable: a saved view missing one of its filters would show more rows than it did.
    localStorage.setItem("dzb-studio:x:view:t", "v=1&table=t&where=garbage");
    expect(p.lastView("t")).toBeNull();
    localStorage.setItem("dzb-studio:x:filters:t", JSON.stringify([{ column: "age" }]));
    expect(p.filterDrafts("t")).toBeNull();
  });
  test("no storage (blocked or absent): nothing is saved and nothing throws", () => {
    const p = createPrefs("x", null);
    p.setLayout("t", { order: ["a"], hidden: [], widths: {} });
    p.setFilterDrafts("t", [{ column: "age", op: "eq", text: "1" }]);
    expect(p.layout("t")).toEqual(EMPTY_LAYOUT);
    expect(p.filterDrafts("t")).toBeNull();
  });
});
