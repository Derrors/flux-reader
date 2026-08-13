#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHINESE_TEXT_PATTERN = /[\u3400-\u9fff]/u;
const RELEASE_MARKER = '<!-- flux-reader-release-workflow -->';
const MAX_SUMMARY_BYTES = 64 * 1024;

function readVersion(root) {
  const source = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (!VERSION_PATTERN.test(source)) {
    throw new Error(`VERSION 不是有效的三段版本号：${JSON.stringify(source)}`);
  }
  return source;
}

function readChineseSummary(root, version) {
  const summaryPath = path.join(root, 'docs', 'releases', `${version}.md`);
  let source;
  try {
    source = fs.readFileSync(summaryPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`缺少 ${path.relative(root, summaryPath)}，请先编写本版本的中文更新摘要`);
    }
    throw error;
  }

  if (Buffer.byteLength(source, 'utf8') > MAX_SUMMARY_BYTES) {
    throw new Error(`中文更新摘要超过 ${MAX_SUMMARY_BYTES / 1024} KiB 上限`);
  }
  const summary = source.trim();
  if (!summary) throw new Error('中文更新摘要不能为空');
  if (!CHINESE_TEXT_PATTERN.test(summary)) {
    throw new Error('版本更新摘要必须包含中文内容');
  }
  return summary;
}

function buildReleaseNotes({ root = DEFAULT_ROOT } = {}) {
  const version = readVersion(root);
  const summary = readChineseSummary(root, version);
  const fpkAsset = `flux-reader-${version}.fpk`;
  const dmgAsset = `Flux-Reader-${version}-unnotarized-universal.dmg`;
  const windowsAsset = `flux-reader-${version}-windows-x64.exe`;

  return [
    RELEASE_MARKER,
    '',
    summary,
    '',
    '## 下载说明',
    '',
    `- \`${fpkAsset}\`：fnOS 安装包。`,
    `- \`${dmgAsset}\`：macOS 通用安装镜像（Intel 与 Apple Silicon）。`,
    `- \`${windowsAsset}\`：Windows x64 安装程序。`,
    '- `SHA256SUMS`：安装包完整性校验文件。',
    '',
    '> [!WARNING]',
    '> macOS DMG 仅使用 ad-hoc 签名，未使用 Apple Developer ID 签名，也未经过 Apple 公证。首次打开时 Gatekeeper 可能显示警告或阻止启动，仅建议用于自用、测试或受控环境。',
    '',
  ].join('\n');
}

function writeReleaseNotes(outputPath, options) {
  if (!outputPath) throw new Error('缺少 --output <path>');
  const absoluteOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, buildReleaseNotes(options));
  return absoluteOutput;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    buildReleaseNotes();
    console.log('✓ 中文 Release 更新摘要已校验');
    return;
  }
  if (args.length === 2 && args[0] === '--output') {
    const outputPath = writeReleaseNotes(args[1]);
    console.log(`✓ 中文 Release 说明已生成：${outputPath}`);
    return;
  }
  throw new Error('用法：prepare-release-notes.js --check | --output <path>');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RELEASE_MARKER,
  buildReleaseNotes,
  writeReleaseNotes,
};
