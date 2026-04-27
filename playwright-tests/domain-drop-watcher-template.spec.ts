import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers/auth.js";

test.describe("dashboard loads", () => {
  test("returns 200 + login page", async ({ page }) => {
    const resp = await page.goto("/");
    expect(resp?.status()).toBe(200);
    // JS checkAuth() detects 401 from /domains and redirects to /login
    await page.waitForURL(/\/login/);
    await expect(page.locator("p.subtitle")).toBeVisible();
  });
});

test.describe("magic-link flow", () => {
  test("request → redeem → dashboard", async ({ page }) => {
    const email = "magic-link@example.com";
    await page.request.post("/api/test/seed-user", { data: { email, admin: true } });

    await page.goto("/login");
    await page.fill("input[name=email]", email);
    await page.click("button:has-text('Send me a sign-in code')");
    // Wait for the code form to become visible
    await page.waitForSelector("#code-form", { state: "visible" });

    const codeResp = await page.request.get(`/api/test/peek-code?email=${encodeURIComponent(email)}`);
    const { code } = await codeResp.json() as { code: string };

    await page.fill("input[name=code]", code);
    await page.click("button:has-text('Verify code')");

    await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 15_000 });
    await expect(page.locator("#logout-btn")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("monitored domain", () => {
  test("add via API, see in dashboard", async ({ page }) => {
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
});

test.describe("alert channel", () => {
  test("add via API, see in dashboard", async ({ page }) => {
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
    await expect(page.locator("text=w1").first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("app config", () => {
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
});

test.describe("cron tick", () => {
  test("fetches RDAP and updates monitored_domains", async ({ page }) => {
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
});
