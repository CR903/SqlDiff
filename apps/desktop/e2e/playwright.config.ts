import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { loadEnvFile } from './helpers/env-loader';

// 加载 apps/desktop/.env.e2e，让 preflight 真机 E2E「填好文件即可跑」，
// 不必手工 export 一串变量。语义（见 helpers/env-loader.ts）：
//   - process.env 已存在的键不覆盖（外部 / CI 注入优先，这是安全边界）
//   - 文件缺失静默（主 harness `npm run e2e` 不需要它）
// 放在 config 而非各 spec：单一入口，新增 e2e spec 自动受益。
loadEnvFile(resolve(__dirname, '..', '.env.e2e'), process.env);

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
