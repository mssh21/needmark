import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4192', viewport: { width: 1200, height: 850 },
    headless: false, trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium',
      launchOptions: { args: ['--auto-select-tab-capture-source-by-title=NeedMark', '--allow-http-screen-capture'] } } },
    { name: 'webkit', use: { browserName: 'webkit', headless: true } },
  ],
  webServer: {
    command: 'pnpm demo', port: 4192, reuseExistingServer: false,
    env: { NEEDMARK_DEMO_PORT: '4192', NEEDMARK_OUTPUT_DIR: '/private/tmp/needmark-e2e-feedback', NEEDMARK_DEMO_LANGUAGE: 'ja' },
  },
});
