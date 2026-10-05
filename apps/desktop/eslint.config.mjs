// M1 最小 ESLint 配置；M5 按需追加规则。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // dist-* / release / node_modules 是构建产物；playwright-report 与 test-results 是
  // E2E harness 自己的产物（内含压缩过的第三方 bundle，no-undef 会误报上千条）。
  // 四者都不入库（见 .gitignore），因此也不该进 lint。
  {
    ignores: [
      'dist-main',
      'dist-renderer',
      'release',
      'node_modules',
      'playwright-report',
      'test-results',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
