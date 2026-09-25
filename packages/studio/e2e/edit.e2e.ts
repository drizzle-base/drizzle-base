// Editing across tabs: a save reaches the other tab, a concurrent edit shows up as a conflict before anything is
// overwritten, and closing a tab with unsaved edits asks first.
import { expect, type Page as Tab, test } from "@playwright/test";

async function openUsers(tab: Tab) {
  await tab.goto("/?v=1&table=public.users");
  await expect(tab.getByRole("gridcell", { name: "User 1", exact: true })).toBeVisible();
}

async function editName(tab: Tab, from: string, to: string) {
  await tab.getByRole("gridcell", { name: from, exact: true }).dblclick();
  const input = tab.getByRole("textbox", { name: "Edit name" });
  await input.fill(to);
  await input.press("Enter");
}

test("a save in one tab reaches the other", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await editName(a, "User 1", "Saved in A");
  await a.getByRole("button", { name: "Save changes" }).click();
  await expect(b.getByRole("gridcell", { name: "Saved in A", exact: true })).toBeVisible();
});

test("a concurrent edit is a conflict, resolved without losing either side", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openUsers(a);
  await openUsers(b);
  await editName(a, "User 1", "From A");
  await editName(b, "User 1", "From B");
  await b.getByRole("button", { name: "Save changes" }).click();
  const region = a.getByRole("region", { name: "Unsaved changes" });
  await expect(region.getByText(/changed elsewhere/)).toBeVisible();
  await expect(region.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await region.getByRole("button", { name: "Keep mine" }).click();
  await region.getByRole("button", { name: "Save changes" }).click();
  await expect(b.getByRole("gridcell", { name: "From A", exact: true })).toBeVisible();
});

test("unsaved edits warn before the tab closes", async ({ page }) => {
  await openUsers(page);
  await editName(page, "User 1", "Not saved");
  let asked = false;
  page.on("dialog", async (d) => {
    asked = d.type() === "beforeunload";
    await d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
});
