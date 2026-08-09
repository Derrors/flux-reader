#!/usr/bin/env node
/**
 * fnOS 构建脚本：把共享阅读器产物与 fnOS 后端合并进应用包的 app/ 目录。
 *
 * 关于输出位置：fnpack 打包时会把应用包的 `app/` 目录整体压成 app.tgz，
 * 安装到 fnOS 后展开为 `/var/apps/{appname}/target/`。也就是说
 * 「打包时的 app/」== 「运行时的 target/」，因此产物必须放 app/，
 * 放 target/ 不会被 fnpack 收进 fpk。
 *
 * 产物布局：
 *   app/server/          后端 Express 服务 + 生产依赖  → 运行时 target/server/
 *   app/server/public/   前端静态产物（由后端托管）
 *   app/ui/              入口配置与图标（手工维护，不清理）
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FNOS_DIR = path.join(ROOT, 'apps', 'fnos');
const BACKEND_DIR = path.join(FNOS_DIR, 'backend');
const READER_DIR = path.join(ROOT, 'packages', 'reader-web');
const APP_PKG_DIR = path.join(FNOS_DIR, 'package');
const APP_DIR = path.join(APP_PKG_DIR, 'app');
const SERVER_OUT = path.join(APP_DIR, 'server');
const PUBLIC_OUT = path.join(SERVER_OUT, 'public');

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}  (cwd=${path.relative(ROOT, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/**
 * 构建前检查依赖是否就绪。
 *
 * 直接跑构建时若依赖缺失，只会抛出 `vite: command not found` 加一大段
 * Node 堆栈，看不出该做什么。这里提前给出可执行的修复命令。
 */
function checkDeps() {
  const missing = [];
  for (const [name, dir] of [
    ['apps/fnos/backend', BACKEND_DIR],
    ['packages/reader-web', READER_DIR],
  ]) {
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
      missing.push(name);
    }
  }
  // reader-web 装了但 vite 不在（典型情况：上次 install 中途失败）
  const viteBin = path.join(READER_DIR, 'node_modules', '.bin', 'vite');
  const readerIncomplete =
    !missing.includes('packages/reader-web') && !fs.existsSync(viteBin);

  if (missing.length === 0 && !readerIncomplete) return;

  console.error('\n✗ 依赖未就绪，无法构建\n');
  if (missing.length) {
    console.error(`  未安装依赖的目录：${missing.join('、')}`);
  }
  if (readerIncomplete) {
    console.error('  packages/reader-web/node_modules 存在但缺少 vite，上次安装可能中断');
  }
  console.error('\n  请先运行：\n');
  console.error('    npm run install:all\n');
  console.error('  若安装报 404（常见于 registry 版本同步滞后），改用公网源：\n');
  console.error('    npm run install:all --registry=https://registry.npmjs.org\n');
  process.exit(1);
}

function main() {
  checkDeps();

  // 1. 只清理 server 子目录，保留 app/ui（入口配置与图标是手工维护的）
  fs.rmSync(SERVER_OUT, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_OUT, { recursive: true });

  // 2. 构建共享阅读器
  run('npm run build', READER_DIR);
  fs.cpSync(path.join(READER_DIR, 'dist'), PUBLIC_OUT, { recursive: true });

  // 3. 复制后端源码
  for (const entry of ['src', 'package.json', 'package-lock.json']) {
    const from = path.join(BACKEND_DIR, entry);
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(SERVER_OUT, entry), { recursive: true });
    }
  }

  // 4. 只装生产依赖（NAS 上不需要 devDependencies）
  run('npm install --omit=dev --no-audit --no-fund', SERVER_OUT);

  console.log(`\n✅ 构建完成：${path.relative(ROOT, APP_DIR)}`);
  console.log('   下一步：cd apps/fnos/package && fnpack build');
}

main();
