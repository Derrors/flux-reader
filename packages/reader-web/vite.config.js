import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

// 本地开发就用生产路径前缀 /app/flux-reader，
// 提前模拟统一网关下的访问路径，避免上线才发现路由问题。
const BASE = '/app/flux-reader/';
const BACKEND_PORT = 5178;

/**
 * 由 Vite 自己拉起后端接口服务。
 *
 * 为什么这样做：预览平台执行启动脚本时只跑单条前台命令，
 * 用 `node server.js &` 这类后台写法不可靠（& 可能被剥离，
 * 导致后端阻塞在前台、Vite 根本起不来）。把后端作为 Vite
 * 的子进程拉起，启动脚本就只需要一条 vite 命令。
 */
function backendPlugin() {
  let child = null;
  return {
    name: 'flux-reader-backend',
    apply: 'serve',
    configureServer(server) {
      const entry = resolve(
        __dirname,
        '..',
        '..',
        'apps',
        'fnos',
        'backend',
        'src',
        'server.js',
      );
      child = spawn(process.execPath, [entry], {
        env: { ...process.env, PORT: String(BACKEND_PORT) },
        stdio: 'inherit',
      });
      child.on('exit', (code) => {
        if (code) server.config.logger.error(`[backend] 退出，code=${code}`);
      });
      const kill = () => {
        if (child && !child.killed) child.kill('SIGTERM');
      };
      server.httpServer?.on('close', kill);
      process.on('exit', kill);
    },
  };
}

export default defineConfig(({ mode }) => {
  const isMacOSBuild = mode === 'macos' || mode === 'contract-macos';
  const isWindowsBuild = mode === 'windows';
  const isDesktopBuild = isMacOSBuild || isWindowsBuild;
  const isContractBuild = mode === 'contract-fnos' || mode === 'contract-macos';

  return {
    // 桌面端从应用包内加载静态资源；相对路径让 macOS 自定义 scheme 与
    // Tauri WebView2 共用同一套分包策略。
    base: isDesktopBuild ? './' : BASE,
    plugins: [react(), !isDesktopBuild && backendPlugin()].filter(Boolean),
    // shiki worker 内部会做代码分割（按需加载语法定义），
    // 默认的 iife 格式不支持分包，必须用 es。
    worker: {
      format: 'es',
    },
    build: {
      outDir: isContractBuild
        ? (isMacOSBuild ? 'dist-contract-macos' : 'dist-contract-fnos')
        : (isMacOSBuild ? 'dist-macos' : isWindowsBuild ? 'dist-windows' : 'dist'),
      emptyOutDir: true,
      // macOS 只打包渲染核心，不引入 fnOS 应用外壳和 API。
      rollupOptions: {
        input: resolve(
          __dirname,
          isMacOSBuild ? 'macos.html' : isWindowsBuild ? 'windows.html' : 'index.html',
        ),
        output: {
          manualChunks(id) {
            if (id.includes('mermaid')) return 'markdown-mermaid';
            if (id.includes('shiki')) return 'markdown-shiki';
            if (id.includes('katex')) return 'markdown-katex';
          },
        },
      },
      chunkSizeWarningLimit: 1500,
    },
    server: {
      host: '0.0.0.0',
      port: 5177,
      strictPort: true,
      // 预览环境经域名访问，放开 host 校验
      allowedHosts: true,
      proxy: {
        // 前端 dev server 把接口转给本地后端
        '/app/flux-reader/api': `http://127.0.0.1:${BACKEND_PORT}`,
      },
    },
  };
});
