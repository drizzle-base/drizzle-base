import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5488" },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:5488",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
