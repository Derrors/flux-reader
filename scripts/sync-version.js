#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readReleaseFiles(root) {
  const files = {
    version: path.join(root, 'VERSION'),
    manifest: path.join(root, 'apps', 'fnos', 'package', 'manifest'),
    xcodeProject: path.join(
      root,
      'apps',
      'macos',
      'FluxReader.xcodeproj',
      'project.pbxproj'
    ),
  };

  return {
    files,
    versionSource: fs.readFileSync(files.version, 'utf8'),
    manifestSource: fs.readFileSync(files.manifest, 'utf8'),
    xcodeProjectSource: fs.readFileSync(files.xcodeProject, 'utf8'),
  };
}

function inspectVersionFields(sources) {
  const normalizedVersionSource = sources.versionSource.replace(/\r\n/g, '\n');
  const versionMatch = normalizedVersionSource.match(/^([^\n]+)\n?$/);
  const version = versionMatch?.[1] ?? '';
  if (!versionMatch || !VERSION_PATTERN.test(version)) {
    throw new Error(
      `VERSION 必须是单行三段纯数字版本号，当前值：${JSON.stringify(sources.versionSource)}`
    );
  }

  const manifestMatches = [
    ...sources.manifestSource.matchAll(/^version="([^"]+)"[ \t]*$/gm),
  ];
  if (manifestMatches.length !== 1) {
    throw new Error(`fnOS manifest 必须且只能包含一个 version 字段，当前数量：${manifestMatches.length}`);
  }

  const xcodeMatches = [
    ...sources.xcodeProjectSource.matchAll(/^\s*MARKETING_VERSION = ([^;]+);[ \t]*$/gm),
  ];
  if (xcodeMatches.length !== 2) {
    throw new Error(`Xcode 工程必须包含两个 MARKETING_VERSION 字段，当前数量：${xcodeMatches.length}`);
  }

  return {
    version,
    manifestVersion: manifestMatches[0][1],
    xcodeVersions: xcodeMatches.map((match) => match[1].trim()),
  };
}

function writeFileAtomically(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, filePath);
}

function syncVersion({ root = DEFAULT_ROOT, write = false } = {}) {
  const sources = readReleaseFiles(root);
  const fields = inspectVersionFields(sources);

  const mismatches = [];
  if (fields.manifestVersion !== fields.version) {
    mismatches.push(`fnOS manifest=${fields.manifestVersion}`);
  }
  fields.xcodeVersions.forEach((value, index) => {
    if (value !== fields.version) {
      mismatches.push(`Xcode MARKETING_VERSION[${index}]=${value}`);
    }
  });

  if (mismatches.length === 0) return fields.version;

  if (!write) {
    throw new Error(
      `发布版本未同步：VERSION=${fields.version}，${mismatches.join('，')}。请运行 npm run version:sync。`
    );
  }

  const nextManifest = sources.manifestSource.replace(
    /^version="[^"]+"[ \t]*$/m,
    `version="${fields.version}"`
  );
  const nextXcodeProject = sources.xcodeProjectSource.replace(
    /^(\s*MARKETING_VERSION = )[^;]+;/gm,
    `$1${fields.version};`
  );

  writeFileAtomically(sources.files.manifest, nextManifest);
  writeFileAtomically(sources.files.xcodeProject, nextXcodeProject);

  const verified = inspectVersionFields(readReleaseFiles(root));
  if (
    verified.manifestVersion !== verified.version
    || verified.xcodeVersions.some((value) => value !== verified.version)
  ) {
    throw new Error('版本同步后校验失败');
  }
  return verified.version;
}

function releaseMetadata(version) {
  return {
    version,
    tag: `v${version}`,
    fpkAsset: `flux-reader-${version}.fpk`,
    dmgAsset: `Flux-Reader-${version}-unnotarized-universal.dmg`,
    signedDmgAsset: `Flux-Reader-${version}-universal.dmg`,
  };
}

function appendGitHubOutputs(version) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error('--github-output 只能在设置了 GITHUB_OUTPUT 的 GitHub Actions 步骤中使用');
  }

  const metadata = releaseMetadata(version);
  const lines = [
    `version=${metadata.version}`,
    `tag=${metadata.tag}`,
    `fpk_asset=${metadata.fpkAsset}`,
    `dmg_asset=${metadata.dmgAsset}`,
    `signed_dmg_asset=${metadata.signedDmgAsset}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const supported = new Set(['--check', '--write', '--github-output']);
  const unknown = [...args].filter((arg) => !supported.has(arg));
  if (unknown.length > 0) {
    throw new Error(`未知参数：${unknown.join(', ')}`);
  }
  if (args.has('--check') && args.has('--write')) {
    throw new Error('--check 与 --write 不能同时使用');
  }

  const write = args.has('--write');
  const version = syncVersion({ write });
  if (args.has('--github-output')) appendGitHubOutputs(version);
  console.log(`✓ 发布版本 ${version} 已${write ? '同步' : '校验'}`);
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
  inspectVersionFields,
  releaseMetadata,
  syncVersion,
};
