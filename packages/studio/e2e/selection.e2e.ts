// Range, clipboard and foreign keys in a real browser: Open filters to the referenced row, and a copied name
// pastes as a pending edit.
import { expect, test } from "@playwright/test";

test("a copied name pastes as a pending edit; a foreign key opens the user", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?v=1&table=public.posts");
  await expect(page.getByRole("gridcell", { name: "Post 1", exact: true })).toBeVisible();
  const row = page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: "Post 1", exact: true }) });
  await row.getByRole("button", { name: /users/i }).click();
  const preview = page.getByRole("region", { name: "Related users" });
  await expect(preview.getByText(/@example\.com/)).toBeVisible();
  await preview.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/table=public\.users/);
  await expect(page.getByText(/1 - 1 of 1/)).toBeVisible();

  await page.goto("/?v=1&table=public.users");
  await expect(page.getByRole("gridcell", { name: "User 1", exact: true })).toBeVisible();
  await page.getByRole("gridcell", { name: "User 1", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+c");
  await page.getByRole("gridcell", { name: "User 2", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByRole("gridcell", { name: "User 1", exact: true })).toHaveCount(2);
  await expect(page.getByRole("gridcell", { name: "User 1", exact: true }).nth(1)).toHaveAttribute(
    "data-pending",
    "true",
  );
});
