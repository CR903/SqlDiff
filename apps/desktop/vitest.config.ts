import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src-core/**/*.test.ts', 'src-main/**/*.test.ts', 'src-renderer/sql.test.ts'] },
});
