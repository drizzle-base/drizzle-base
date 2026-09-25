// The realtime promise in a real browser: tabs of one origin share the mock's log, and a write from any of them —
// or from "outside" — reaches every open page without a refresh. Each test gets a fresh context: empty storage.
import { expect, type Page as Tab, test } from "@playwright/test";
import type { Page } from "../src/contract";

const USERS = { schema: "public", name: "users" };

async function openUsers(tab: Tab) {
  await tab.goto("/");
  await tab.getByRole("button", { name: "users", exact: true }).click();
  await expect(tab.getByRole("gridcell", { name: "user1@example.com", exact: true })).toBeVisible();
}

/** The id of user1, read through the data source like any client would. */
function user1Id(tab: Tab) {
  return tab.evaluate(async (users) => {
    const ds = window.__dzbMock;
    if (!ds) throw new Error("the playground did not expose __dzbMock");
    const page = await new Promise<Page>((resolve, reject) => {
      const stop = ds.subscribePage(
        {
          table: users,
          filters: [{ column: "email", op: "eq", value: "user1@example.com" }],
          sort: [],
          limit: 1,
          offset: 0,
          withTotal: true,
        },
        (p) => {
          stop();
          resolve(p);
        },
        reject,
      );
    });
    // users.id is a uuid: text on the wire.
    return String(page.rows[0]?.["id"]);
  }, USERS);
}

test("an external write appears in every open tab without a refresh", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const psql = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await psql.goto("/");
  const id = await user1Id(psql);
  await psql.evaluate(
    async ({ users, id }) => {
      await window.__dzbMock?.externalWrite({
        kind: "update",
        table: users,
        changes: [{ key: { id }, values: { name: "Set by psql" } }],
      });
    },
    { users: USERS, id },
  );
  for (const tab of [a, b]) {
    const cell = tab.getByRole("gridcell", { name: "Set by psql", exact: true });
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute("data-changed", "true");
  }
});

test("a write in one tab appears in the other", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  const id = await user1Id(a);
  await a.evaluate(
    async ({ users, id }) => {
      await window.__dzbMock?.updateRows(users, [{ key: { id }, values: { name: "Set in tab A" } }]);
    },
    { users: USERS, id },
  );
  await expect(b.getByRole("gridcell", { name: "Set in tab A", exact: true })).toBeVisible();
});

test("writes from two tabs at once converge: every open page ends with all of them", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/");
  await b.goto("/");
  // Each tab keeps a live subscription open from before the writes; only pushes can bring the other tab's rows.
  const watch = (tab: Tab) =>
    tab.evaluate(() => {
      const ds = window.__dzbMock;
      if (!ds) throw new Error("no __dzbMock");
      const w = window as unknown as { __ids?: unknown[] };
      ds.subscribePage(
        {
          table: { schema: "billing", name: "invoices" },
          filters: [{ column: "status", op: "like", value: "concurrent-%" }],
          sort: [],
          limit: 100,
          offset: 0,
          withTotal: true,
        },
        (p) => {
          w.__ids = p.rows.map((r) => r["id"]);
        },
        () => {},
      );
    });
  await watch(a);
  await watch(b);
  const insertTen = (tab: Tab, who: string) =>
    tab.evaluate(async (who) => {
      const invoices = { schema: "billing", name: "invoices" };
      for (let i = 0; i < 10; i++) {
        await window.__dzbMock?.insertRows(invoices, [{ amount_cents: 1, status: `concurrent-${who}-${i}` }]);
      }
    }, who);
  await Promise.all([insertTen(a, "a"), insertTen(b, "b")]);
  const ids = (tab: Tab) => tab.evaluate(() => (window as unknown as { __ids?: unknown[] }).__ids ?? []);
  await expect.poll(async () => (await ids(a)).length).toBe(20);
  await expect.poll(async () => (await ids(b)).length).toBe(20);
  expect(await ids(a)).toEqual(await ids(b));
  expect(new Set(await ids(a)).size).toBe(20);
});

test("the schema selector switches the sidebar to another schema", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Schema" }).click();
  await page.getByRole("option", { name: "billing" }).click();
  await page.getByRole("button", { name: "invoices", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: /amount_cents/ })).toBeVisible();
});
