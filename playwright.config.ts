import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'artifacts/playwright',
  use: { baseURL: 'http://127.0.0.1:4173/ragbox/', headless: true, trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--disable-dev-shm-usage'] } },
  webServer: { command: 'npm run preview', url: 'http://127.0.0.1:4173/ragbox/', reuseExistingServer: !process.env.CI },
});
