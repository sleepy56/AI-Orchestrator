import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:5193",
    browserName: "chromium",
    ...(process.env.CI ? {} : { channel: "chrome" }),
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5193 --strictPort",
    url: "http://127.0.0.1:5193",
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: "list",
});
