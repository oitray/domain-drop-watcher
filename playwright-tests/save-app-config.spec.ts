import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers/auth.js";

test("PUT /config/app/alert_from_address then GET confirms value", async ({ page }) => {
  await authenticate(page, "config-test@example.com");
  // page.evaluate runs in the browser context where cookies + origin are correct
  const putResult = await page.evaluate(async () => {
    const resp = await fetch("/config/app/alert_from_address", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "alerts@example.com" }),
    });
    return { ok: resp.ok, status: resp.status, body: await resp.json() };
  });
  expect(putResult.ok).toBe(true);
  expect((putResult.body as { value: string }).value).toBe("alerts@example.com");

  const getResult = await page.evaluate(async () => {
    const resp = await fetch("/config/app", { credentials: "same-origin" });
    return { ok: resp.ok, body: resp.ok ? await resp.json() : null };
  });
  expect(getResult.ok).toBe(true);
  expect((getResult.body as { alert_from_address: string }).alert_from_address).toBe("alerts@example.com");
});
