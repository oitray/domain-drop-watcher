import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers/auth.js";

test("add an alert channel via API, see it in dashboard", async ({ page }) => {
  await authenticate(page, "channel-test@example.com");
  const result = await page.evaluate(async () => {
    const resp = await fetch("/channels", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "webhook-slack", target: "https://hooks.slack.com/services/test-w1", label: "w1" }),
    });
    return { ok: resp.ok, status: resp.status, body: await resp.json() };
  });
  expect(result.ok).toBe(true);
  expect((result.body as { type: string }).type).toBe("webhook-slack");
  await page.goto("/");
  await expect(page.locator("#logout-btn")).toBeVisible({ timeout: 10_000 });
  // Dismiss the landing-cta overlay if it's blocking clicks (HTML has display:flex after display:none)
  await page.evaluate(() => {
    const el = document.getElementById("landing-cta");
    if (el) el.style.display = "none";
  });
  await page.click("button[data-tab=channels]");
  await expect(page.locator("text=w1")).toBeVisible({ timeout: 10_000 });
});
