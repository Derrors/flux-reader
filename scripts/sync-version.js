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
    windowsCargo: path.join(root, 'apps', 'windows', 'src-tauri', 'Cargo.toml'),
    windowsCargoLock: path.join(root, 'apps', 'windows', 'src-tauri', 'Cargo.lock'),
    tauriConfig: path.join(root, 'apps', 'windows', 'src-tauri', 'tauri.conf.json'),
  };

  return {
    files,
    versionSource: fs.readFileSync(files.version, 'utf8'),
    manifestSource: fs.readFileSync(files.manifest, 'utf8'),
    xcodeProjectSource: fs.readFileSync(files.xcodeProject, 'utf8'),
    windowsCargoSource: fs.readFileSync(files.windowsCargo, 'utf8'),
    windowsCargoLockSource: fs.readFileSync(files.windowsCargoLock, 'utf8'),
    tauriConfigSource: fs.readFileSync(files.tauriConfig, 'utf8'),
  };
}

function findCargoLockPackage(source, packageName) {
  const blocks = [
    ...source.matchAll(
      /^\[\[package\]\][ \t]*$(?:\r?\n|$)([\s\S]*?)(?=^\[\[package\]\][ \t]*$|(?![\s\S]))/gm
    ),
  ].filter((match) => {
    const names = [...match[1].matchAll(/^name = "([^"]+)"[ \t]*$/gm)];
    return names.length === 1 && names[0][1] === packageName;
  });
  if (blocks.length !== 1) {
    throw new Error(
      `Windows Cargo.lock 必须且只能包含一个 ${packageName} 包，当前数量：${blocks.length}`
    );
  }
  const block = blocks[0];
  const versions = [...block[1].matchAll(/^version = "([^"]+)"[ \t]*$/gm)];
  if (versions.length !== 1) {
    throw new Error(
      `Windows Cargo.lock 的 ${packageName} 必须且只能包含一个 version 字段，当前数量：${versions.length}`
    );
  }
  return {
    start: block.index,
    source: block[0],
    version: versions[0][1],
  };
}

function replaceCargoLockPackageVersion(source, packageName, version) {
  const entry = findCargoLockPackage(source, packageName);
  const nextEntry = entry.source.replace(
    /^version = "[^"]+"[ \t]*$/m,
    `version = "${version}"`
  );
  return `${source.slice(0, entry.start)}${nextEntry}${source.slice(entry.start + entry.source.length)}`;
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

  const cargoPackage = sources.windowsCargoSource.match(
    /^\[package\][ \t]*$([\s\S]*?)(?=^\[[^\]]+\][ \t]*$|(?![\s\S]))/m
  );
  const cargoVersionMatches = cargoPackage
    ? [...cargoPackage[1].matchAll(/^version = "([^"]+)"[ \t]*$/gm)]
    : [];
  if (cargoVersionMatches.length !== 1) {
    throw new Error(
      `Windows Cargo.toml [package] 必须且只能包含一个 version 字段，当前数量：${cargoVersionMatches.length}`
    );
  }
  const cargoLockPackage = findCargoLockPackage(
    sources.windowsCargoLockSource,
    'flux-reader-windows'
  );

  let tauriConfig;
  try {
    tauriConfig = JSON.parse(sources.tauriConfigSource);
  } catch (error) {
    throw new Error(`Windows tauri.conf.json 不是有效 JSON：${error.message}`);
  }
  if (typeof tauriConfig.version !== 'string') {
    throw new Error('Windows tauri.conf.json 缺少字符串 version 字段');
  }

  return {
    version,
    manifestVersion: manifestMatches[0][1],
    xcodeVersions: xcodeMatches.map((match) => match[1].trim()),
    windowsCargoVersion: cargoVersionMatches[0][1],
    windowsCargoLockVersion: cargoLockPackage.version,
    tauriVersion: tauriConfig.version,
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
  if (fields.windowsCargoVersion !== fields.version) {
    mismatches.push(`Windows Cargo=${fields.windowsCargoVersion}`);
  }
  if (fields.windowsCargoLockVersion !== fields.version) {
    mismatches.push(`Windows Cargo.lock=${fields.windowsCargoLockVersion}`);
  }
  if (fields.tauriVersion !== fields.version) {
    mismatches.push(`Tauri config=${fields.tauriVersion}`);
  }

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
  const nextWindowsCargo = sources.windowsCargoSource.replace(
    /(^\[package\][ \t]*$[\s\S]*?^version = ")[^"]+("[ \t]*$)/m,
    `$1${fields.version}$2`
  );
  const nextWindowsCargoLock = replaceCargoLockPackageVersion(
    sources.windowsCargoLockSource,
    'flux-reader-windows',
    fields.version
  );
  const nextTauriConfig = sources.tauriConfigSource.replace(
    /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/m,
    `$1${fields.version}$2`
  );

  writeFileAtomically(sources.files.manifest, nextManifest);
  writeFileAtomically(sources.files.xcodeProject, nextXcodeProject);
  writeFileAtomically(sources.files.windowsCargo, nextWindowsCargo);
  writeFileAtomically(sources.files.windowsCargoLock, nextWindowsCargoLock);
  writeFileAtomically(sources.files.tauriConfig, nextTauriConfig);

  const verified = inspectVersionFields(readReleaseFiles(root));
  if (
    verified.manifestVersion !== verified.version
    || verified.xcodeVersions.some((value) => value !== verified.version)
    || verified.windowsCargoVersion !== verified.version
    || verified.windowsCargoLockVersion !== verified.version
    || verified.tauriVersion !== verified.version
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
    windowsAsset: `flux-reader-${version}-windows-x64.exe`,
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
    `windows_asset=${metadata.windowsAsset}`,
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
