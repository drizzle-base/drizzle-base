// The editors in a real browser: a picked day keeps the time and offset, CodeMirror loads and saves json, and the
// Expand Row panel's edit reaches another tab.
import { expect, type Page as Tab, test } from "@playwright/test";

async function openUsers(tab: Tab) {
  await tab.goto("/?v=1&table=public.users");
  await expect(tab.getByRole("gridcell", { name: "User 1", exact: true })).toBeVisible();
}
const firstRow = (tab: Tab) =>
  tab.getByRole("row").filter({ has: tab.getByRole("gridcell", { name: "User 1", exact: true }) });

test("a picked day keeps the time, fraction and offset, and is saved for every tab", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  const cell = firstRow(a).getByRole("gridcell").filter({ hasText: /\+00$/ }).first();
  await cell.scrollIntoViewIfNeeded();
  const before = (await cell.innerText()).trim();
  await cell.dblclick();
  await a
    .getByRole("group", { name: "Pick a date" })
    .locator("button")
    .filter({ hasText: /^10(th)?$/ })
    .locator("xpath=self::*[not(ancestor::*[@data-outside])]")
    .click();
  const input = a.getByRole("textbox", { name: "Edit created_at" });
  const after = before.replace(/^\d{4}-\d{2}-\d{2}/, (d) => `${d.slice(0, 8)}10`);
  await expect(input).toHaveValue(after);
  await input.press("Enter");
  await a.getByRole("button", { name: "Save changes" }).click();
  await expect(firstRow(b).getByRole("gridcell", { name: after, exact: true })).toBeVisible();
});

test("json edits in CodeMirror, loaded on demand", async ({ page }) => {
  await openUsers(page);
  const chunks: string[] = [];
  page.on("response", (r) => chunks.push(r.url()));
  await firstRow(page)
    .getByRole("gridcell")
    .filter({ hasText: /"city"/ })
    .dblclick();
  const editor = page.getByRole("textbox", { name: "Value of profile" });
  await expect(editor).toHaveClass(/cm-content/);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('{"edited": true}');
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(firstRow(page).getByRole("gridcell", { name: '{"edited": true}' })).toHaveAttribute(
    "data-pending",
    "true",
  );
  expect(chunks.some((u) => /codemirror/i.test(u))).toBe(true);
});

test("an edit in the Expand Row panel reaches another tab", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await firstRow(a).getByRole("button", { name: "Expand row" }).click();
  const panel = a.getByRole("complementary", { name: "Row" });
  const name = panel.getByLabel("name", { exact: true });
  await name.fill("From the panel");
  await name.press("Enter");
  await a.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Save changes" }).click();
  await expect(b.getByRole("gridcell", { name: "From the panel", exact: true })).toBeVisible();
});
