import { defineConfig } from '@playwright/test';
import path from 'node:path';
const root = path.resolve(__dirname);
export default defineConfig({
  testDir: './test/browser', testMatch: '**/*.spec.ts', timeout: 90000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined },
  webServer: { command: 'node scripts/serve-webview.mjs', cwd: root, url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 60000 },
});
