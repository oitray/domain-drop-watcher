import { test, expect } from "@playwright/test";

test("dashboard root returns 200 and renders login page when not authed", async ({ page }) => {
  const resp = await page.goto("/");
  expect(resp?.status()).toBe(200);
  // JS checkAuth() detects 401 from /domains and redirects to /login
  await page.waitForURL(/\/login/);
  await expect(page.locator("p.subtitle")).toBeVisible();
});
