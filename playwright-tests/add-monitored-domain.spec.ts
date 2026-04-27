import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers/auth.js";

test("add a monitored domain via API, see it in dashboard", async ({ page }) => {
  await authenticate(page, "domain-test@example.com");
  await page.evaluate(async () => {
    await fetch("/domains", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fqdn: "monitored-test.com", cadenceMinutes: 60 }),
    });
  });
  await page.goto("/");
  // Wait for logout-btn to confirm dashboard is fully loaded
  await expect(page.locator("#logout-btn")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#domains-tbody strong").filter({ hasText: "monitored-test.com" })).toBeVisible({ timeout: 10_000 });
});
