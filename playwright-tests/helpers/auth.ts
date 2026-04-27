import type { Page } from "@playwright/test";

export async function authenticate(page: Page, email: string): Promise<void> {
  await page.request.post("/api/test/seed-user", { data: { email, admin: true } });
  await page.goto("/login");
  await page.fill("input[name=email]", email);
  await page.click("button:has-text('Send me a sign-in code')");
  // Wait for the code form to become visible (JS hides email form, shows code form)
  await page.waitForSelector("#code-form", { state: "visible" });
  const codeResp = await page.request.get(`/api/test/peek-code?email=${encodeURIComponent(email)}`);
  const { code } = await codeResp.json() as { code: string };
  await page.fill("input[name=code]", code);
  await page.click("button:has-text('Verify code')");
  // Wait for redirect away from /login to the dashboard root
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 15_000 });
}
