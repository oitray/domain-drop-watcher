import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright-tests",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:8787",
    headless: true,
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : [
    {
      command: "node playwright-tests/fixtures/rdap-server.mjs",
      port: 9999,
      reuseExistingServer: !process.env.CI,
      timeout: 10_000,
    },
    {
      command: "bash playwright-tests/fixtures/start-dev.sh",
      url: "http://127.0.0.1:8787",
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
