import { defineConfig, devices } from '@playwright/test';

const port = process.env.E2E_PORT || '8790';

export default defineConfig({
  testDir: 'e2e',
  // The journeys share one workspace (the first account owns it), so they run in order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node e2e/serve.js', url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, stdout: 'pipe' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
