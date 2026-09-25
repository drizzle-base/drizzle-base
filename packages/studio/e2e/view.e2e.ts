// The view lives in the URL: a link or a reload reopens the same table, filters, sort and page, Back undoes a
// filter, and a link the studio cannot fully read says what it ignored. Layout lives in localStorage.
import { expect, type Page as Tab, test } from "@playwright/test";

const firstEmails = (tab: Tab) =>
  tab
    .getByRole("gridcell")
    .filter({ hasText: /@example\.com$/ })
    .evaluateAll((cells) => cells.slice(0, 5).map((c) => c.textContent));

async function openUsers(tab: Tab) {
  await tab.getByRole("button", { name: "users", exact: true }).click();
  await expect(tab.getByText("1 - 50 of 3000")).toBeVisible();
}

test("filters and sort go to the URL; a reload shows the same rows", async ({ page }) => {
  await page.goto("/");
  await openUsers(page);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const row = page.getByRole("group", { name: "Filter 1" });
  await row.getByLabel("Column").selectOption("role");
  await row.getByLabel("Value").selectOption("admin");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("1 - 50 of 50+")).toBeVisible();
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("list", { name: "Columns" }).getByRole("button", { name: "age" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/where=role\.eq\.admin/);
  await expect(page).toHaveURL(/order=age\.asc/);
  const before = await firstEmails(page);
  await page.reload();
  await expect(page.getByText("1 - 50 of 50+")).toBeVisible();
  expect(await firstEmails(page)).toEqual(before);
  await expect(page.getByRole("group", { name: "Filter 1" }).getByLabel("Column")).toHaveValue("role");
});

test("Back undoes the last applied filter", async ({ page }) => {
  await page.goto("/");
  await openUsers(page);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const row = page.getByRole("group", { name: "Filter 1" });
  await row.getByLabel("Column").selectOption("role");
  await row.getByLabel("Value").selectOption("viewer");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/where=role\.eq\.viewer/);
  await page.goBack();
  await expect(page).not.toHaveURL(/where=/);
  await expect(page.getByText("1 - 50 of 3000")).toBeVisible();
});

test("a link the studio cannot fully read shows the rows it can, and says what it ignored", async ({ page }) => {
  await page.goto("/?v=1&table=public.users&where=nope.eq.1&where=age.bogus.1");
  const status = page.getByRole("status");
  await expect(status).toContainText('filter on "nope": no such column');
  await expect(status).toContainText('filter "age.bogus.1"');
  await expect(page.getByText("1 - 50 of 3000")).toBeVisible();
});

test("the header menu sorts; hidden columns and widths survive a reload", async ({ page }) => {
  await page.goto("/");
  await openUsers(page);
  await page.getByRole("columnheader", { name: /^age/ }).getByRole("button").click();
  await page.getByRole("menuitem", { name: "Sort descending" }).click();
  await expect(page).toHaveURL(/order=age\.desc/);
  await page.getByRole("button", { name: /^Columns/ }).click();
  await page.getByRole("list", { name: "Columns" }).getByRole("button", { name: "email" }).click();
  await page.keyboard.press("Escape");
  const handle = page.getByRole("separator", { name: "Resize name" });
  const box = await handle.boundingBox();
  if (!box) throw new Error("no resize handle");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 122, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.reload();
  await expect(page.getByRole("columnheader", { name: /^email/ })).toHaveCount(0);
  const width = await page
    .getByRole("columnheader", { name: /^name/ })
    .evaluate((h) => h.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(300);
});
