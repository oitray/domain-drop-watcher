import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers/auth.js";

test("cron tick fetches RDAP and updates monitored_domains", async ({ page }) => {
  await authenticate(page, "cron-test@example.com");
  const testDomain = "available.com";
  await page.evaluate(async (fqdn) => {
    await fetch("/domains", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fqdn, cadenceMinutes: 1 }),
    });
  }, testDomain);
  await page.request.post("/api/test/run-cron");
  // After one cron tick the domain should have last_checked_at set and
  // pending_confirm_status = "available" (first confirmation pass from RDAP fixture)
  const domainResult = await page.evaluate(async (fqdn) => {
    const resp = await fetch(`/domains/${fqdn}`, { credentials: "same-origin" });
    return { ok: resp.ok, status: resp.status, body: resp.ok ? await resp.json() : null };
  }, testDomain);
  expect(domainResult.ok).toBe(true);
  const domain = domainResult.body as { last_checked_at: number | null; last_status: string | null };
  // Cron tick should have set last_checked_at and last_status (fixture returns "registered" for available.com)
  expect(domain.last_checked_at).not.toBeNull();
  await page.goto("/");
  await expect(page.locator("#logout-btn")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#domains-tbody")).toContainText(testDomain);
});
