#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const {
  PLATFORM_IDS,
  readVersionSource,
  releaseMetadata,
} = require('./sync-version');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const CHINESE_TEXT_PATTERN = /[\u3400-\u9fff]/u;
const MAX_SUMMARY_BYTES = 64 * 1024;
const PLATFORM_LABELS = Object.freeze({
  fnos: 'fnOS',
  macos: 'macOS',
  windows: 'Windows',
});

function assertPlatform(platform) {
  if (!PLATFORM_IDS.includes(platform)) {
    throw new Error(`必须通过 --platform 指定 ${PLATFORM_IDS.join('、')} 之一`);
  }
  return platform;
}

function releaseMarker(platform) {
  return `<!-- flux-reader-release-workflow:${assertPlatform(platform)} -->`;
}

function readChineseSummary(root, platform, version) {
  const summaryPath = path.join(root, 'docs', 'releases', platform, `${version}.md`);
  let source;
  try {
    source = fs.readFileSync(summaryPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`缺少 ${path.relative(root, summaryPath)}，请先编写本平台版本的中文更新摘要`);
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

function downloadDescription(platform, asset) {
  if (platform === 'fnos') return `- \`${asset}\`：fnOS 安装包。`;
  if (platform === 'windows') return `- \`${asset}\`：Windows x64 安装程序。`;
  return `- \`${asset}\`：macOS 通用安装镜像（Intel 与 Apple Silicon，未公证）。`;
}

function buildReleaseNotes({ root = DEFAULT_ROOT, platform } = {}) {
  assertPlatform(platform);
  const version = readVersionSource(root, platform).version;
  const summary = readChineseSummary(root, platform, version);
  const metadata = releaseMetadata(platform, version);
  const notes = [
    releaseMarker(platform),
    '',
    `# Flux Reader ${PLATFORM_LABELS[platform]} ${version}`,
    '',
    summary,
    '',
    '## 下载说明',
    '',
    downloadDescription(platform, metadata.asset),
    '- `SHA256SUMS`：安装包完整性校验文件。',
    '',
  ];
  if (platform === 'macos') {
    notes.push(
      '> [!WARNING]',
      '> 此 DMG 仅使用 ad-hoc 签名，未使用 Apple Developer ID 签名，也未经过 Apple 公证。首次打开时 Gatekeeper 可能显示警告或阻止启动，仅建议用于自用、测试或受控环境。',
      '',
    );
  }
  return notes.join('\n');
}

function writeReleaseNotes(outputPath, options) {
  if (!outputPath) throw new Error('缺少 --output <path>');
  const absoluteOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, buildReleaseNotes(options));
  return absoluteOutput;
}

function parseArguments(argv) {
  let platform = null;
  let mode = null;
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--platform') {
      platform = argv[index + 1];
      index += 1;
    } else if (argument === '--check') {
      mode = 'check';
    } else if (argument === '--output') {
      mode = 'output';
      outputPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  assertPlatform(platform);
  if (!mode || (mode === 'output' && !outputPath)) {
    throw new Error(
      '用法：prepare-release-notes.js --platform <fnos|macos|windows> --check | --output <path>'
    );
  }
  return { platform, mode, outputPath };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.mode === 'check') {
    buildReleaseNotes({ platform: args.platform });
    console.log(`✓ ${PLATFORM_LABELS[args.platform]} 中文 Release 更新摘要已校验`);
    return;
  }
  const outputPath = writeReleaseNotes(args.outputPath, { platform: args.platform });
  console.log(`✓ 中文 Release 说明已生成：${outputPath}`);
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
  buildReleaseNotes,
  releaseMarker,
  writeReleaseNotes,
};
