import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 不复用 vite.config.js：开发配置会在 serve 模式拉起后端，测试只需要
// 独立的 jsdom 环境和 React JSX 转换。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost/app/flux-reader/' },
    },
    setupFiles: './src/test/setup.js',
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    clearMocks: true,
    restoreMocks: true,
  },
});
