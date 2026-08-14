#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLATFORM_IDS = Object.freeze(['fnos', 'macos', 'windows']);

function assertPlatform(platform, { allowAll = true } = {}) {
  if (PLATFORM_IDS.includes(platform)) return platform;
  if (allowAll && platform === 'all') return platform;
  throw new Error(`未知平台：${platform}；可选值为 ${PLATFORM_IDS.join('、')}${allowAll ? '、all' : ''}`);
}

function versionFilePath(root, platform) {
  assertPlatform(platform, { allowAll: false });
  return path.join(root, 'versions', platform);
}

function readVersionSource(root, platform) {
  const filePath = versionFilePath(root, platform);
  const source = fs.readFileSync(filePath, 'utf8');
  const normalized = source.replace(/\r\n/g, '\n');
  const match = normalized.match(/^([^\n]+)\n?$/);
  const version = match?.[1] ?? '';
  if (!match || !VERSION_PATTERN.test(version)) {
    throw new Error(
      `${path.relative(root, filePath)} 必须是单行三段纯数字版本号，当前值：${JSON.stringify(source)}`
    );
  }
  return { filePath, source, version };
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

function readDistributionSources(root) {
  const files = {
    manifest: path.join(root, 'apps', 'fnos', 'package', 'manifest'),
    xcodeProject: path.join(root, 'apps', 'macos', 'FluxReader.xcodeproj', 'project.pbxproj'),
    windowsCargo: path.join(root, 'apps', 'windows', 'src-tauri', 'Cargo.toml'),
    windowsCargoLock: path.join(root, 'apps', 'windows', 'src-tauri', 'Cargo.lock'),
    tauriConfig: path.join(root, 'apps', 'windows', 'src-tauri', 'tauri.conf.json'),
  };
  return {
    files,
    manifestSource: fs.readFileSync(files.manifest, 'utf8'),
    xcodeProjectSource: fs.readFileSync(files.xcodeProject, 'utf8'),
    windowsCargoSource: fs.readFileSync(files.windowsCargo, 'utf8'),
    windowsCargoLockSource: fs.readFileSync(files.windowsCargoLock, 'utf8'),
    tauriConfigSource: fs.readFileSync(files.tauriConfig, 'utf8'),
  };
}

function inspectDistributionFields(sources) {
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
    fnos: [manifestMatches[0][1]],
    macos: xcodeMatches.map((match) => match[1].trim()),
    windows: [cargoVersionMatches[0][1], cargoLockPackage.version, tauriConfig.version],
  };
}

function writeFileAtomically(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, filePath);
}

function selectedPlatforms(platform) {
  assertPlatform(platform);
  return platform === 'all' ? [...PLATFORM_IDS] : [platform];
}

function synchronizeDistributionSource(platform, version, sources) {
  if (platform === 'fnos') {
    writeFileAtomically(
      sources.files.manifest,
      sources.manifestSource.replace(/^version="[^"]+"[ \t]*$/m, `version="${version}"`)
    );
    return;
  }
  if (platform === 'macos') {
    writeFileAtomically(
      sources.files.xcodeProject,
      sources.xcodeProjectSource.replace(
        /^(\s*MARKETING_VERSION = )[^;]+;/gm,
        `$1${version};`
      )
    );
    return;
  }

  const nextCargo = sources.windowsCargoSource.replace(
    /(^\[package\][ \t]*$[\s\S]*?^version = ")[^"]+("[ \t]*$)/m,
    `$1${version}$2`
  );
  const nextCargoLock = replaceCargoLockPackageVersion(
    sources.windowsCargoLockSource,
    'flux-reader-windows',
    version
  );
  const nextTauri = sources.tauriConfigSource.replace(
    /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/m,
    `$1${version}$2`
  );
  writeFileAtomically(sources.files.windowsCargo, nextCargo);
  writeFileAtomically(sources.files.windowsCargoLock, nextCargoLock);
  writeFileAtomically(sources.files.tauriConfig, nextTauri);
}

function syncVersion({ root = DEFAULT_ROOT, platform = 'all', write = false } = {}) {
  const platforms = selectedPlatforms(platform);
  const versions = Object.fromEntries(
    platforms.map((id) => [id, readVersionSource(root, id).version])
  );
  let sources = readDistributionSources(root);
  let fields = inspectDistributionFields(sources);
  const mismatches = [];

  for (const id of platforms) {
    const differing = fields[id].filter((value) => value !== versions[id]);
    if (differing.length > 0) mismatches.push(`${id}=${[...new Set(differing)].join('/')}`);
  }

  if (mismatches.length > 0 && !write) {
    throw new Error(
      `平台版本未同步：${platforms.map((id) => `${id}=${versions[id]}`).join('，')}；`
      + `${mismatches.join('，')}。请运行 npm run version:sync -- --platform <平台>。`
    );
  }

  if (mismatches.length > 0) {
    for (const id of platforms) {
      if (fields[id].some((value) => value !== versions[id])) {
        synchronizeDistributionSource(id, versions[id], sources);
        sources = readDistributionSources(root);
        fields = inspectDistributionFields(sources);
      }
    }
  }

  for (const id of platforms) {
    if (fields[id].some((value) => value !== versions[id])) {
      throw new Error(`${id} 版本同步后校验失败`);
    }
  }
  return platform === 'all' ? versions : versions[platform];
}

function releaseMetadata(platform, version) {
  assertPlatform(platform, { allowAll: false });
  const common = {
    platform,
    version,
    tag: `${platform}/v${version}`,
  };
  if (platform === 'fnos') {
    return { ...common, asset: `flux-reader-${version}.fpk` };
  }
  if (platform === 'macos') {
    return {
      ...common,
      asset: `Flux-Reader-${version}-unnotarized-universal.dmg`,
      signedAsset: `Flux-Reader-${version}-universal.dmg`,
    };
  }
  return { ...common, asset: `flux-reader-${version}-windows-x64.exe` };
}

function appendGitHubOutputs(platform, version) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error('--github-output 只能在设置了 GITHUB_OUTPUT 的 GitHub Actions 步骤中使用');
  }
  const metadata = releaseMetadata(platform, version);
  const lines = [
    `platform=${metadata.platform}`,
    `version=${metadata.version}`,
    `tag=${metadata.tag}`,
    `asset=${metadata.asset}`,
    `signed_asset=${metadata.signedAsset || ''}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function parseArguments(argv) {
  let platform = 'all';
  let write = false;
  let githubOutput = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') continue;
    if (argument === '--write') {
      write = true;
      continue;
    }
    if (argument === '--github-output') {
      githubOutput = true;
      continue;
    }
    if (argument === '--platform') {
      platform = argv[index + 1];
      index += 1;
      if (!platform) throw new Error('--platform 缺少值');
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  assertPlatform(platform);
  if (githubOutput && platform === 'all') {
    throw new Error('--github-output 必须通过 --platform 指定一个平台');
  }
  return { platform, write, githubOutput };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const version = syncVersion(options);
  if (options.githubOutput) appendGitHubOutputs(options.platform, version);
  const summary = options.platform === 'all'
    ? PLATFORM_IDS.map((id) => `${id}=${version[id]}`).join('，')
    : `${options.platform}=${version}`;
  console.log(`✓ 平台版本 ${summary} 已${options.write ? '同步' : '校验'}`);
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
  PLATFORM_IDS,
  inspectDistributionFields,
  readVersionSource,
  releaseMetadata,
  syncVersion,
};
