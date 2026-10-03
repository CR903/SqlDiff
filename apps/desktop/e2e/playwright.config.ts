import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  workers: 1,
  timeout: 60_000,
  reporter: [['html', { open: 'never' }], ['list']],
  outputDir: './test-results',
  use: {
    // Electron fixture 不需要 browserName；保留默认配置。
    trace: 'retain-on-failure',
  },
});
