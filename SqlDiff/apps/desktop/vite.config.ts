import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// M1 骨架：Vite 只构建渲染进程（产物 dist-renderer）。
// 主进程由 `tsc -p tsconfig.main.json` 编译到 dist-main（见 package.json build）。
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173 },
  build: { outDir: 'dist-renderer', emptyOutDir: true },
});
