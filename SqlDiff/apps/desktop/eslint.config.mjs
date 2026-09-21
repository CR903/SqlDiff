// M1 最小 ESLint 配置；M5 按需追加规则。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist-main', 'dist-renderer', 'release', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
