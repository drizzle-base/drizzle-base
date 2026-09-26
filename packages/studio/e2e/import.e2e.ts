// Import lands as pending inserts; STRUCTURE lists the primary-key index; DATA or Back returns the grid.
import { expect, test } from "@playwright/test";

test("import is pending; STRUCTURE lists the primary key; DATA returns the grid", async ({ page }) => {
  await page.goto("/?v=1&table=public.users");
  await expect(page.getByRole("gridcell", { name: "User 1", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Import" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await dialog.locator("textarea").fill(JSON.stringify([{ name: "Imported", email: "imported@example.com" }]));
  await dialog.getByRole("button", { name: "Import rows" }).click();

  const pending = page.getByRole("gridcell", { name: "Imported", exact: true });
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("data-pending", "true");

  await page.getByRole("button", { name: "STRUCTURE" }).click();
  await expect(page.getByRole("region", { name: "Structure" })).toContainText("users_pkey");
  await expect(page.getByRole("grid")).toHaveCount(0);

  await page.getByRole("button", { name: "DATA", exact: true }).click();
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "Imported", exact: true })).toHaveAttribute("data-pending", "true");
});
