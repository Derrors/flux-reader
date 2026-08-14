#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const PLATFORM_IDS = Object.freeze(['fnos', 'macos', 'windows']);

function allPlatforms(reason) {
  return {
    fnos: true,
    macos: true,
    windows: true,
    reasons: [reason],
  };
}

function addPlatform(result, platform, reason) {
  result[platform] = true;
  result.reasons.push(`${platform}:${reason}`);
}

function classifyChangedFiles(files) {
  const normalized = [...new Set(
    (Array.isArray(files) ? files : [])
      .filter((file) => typeof file === 'string')
      .map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''))
      .filter(Boolean),
  )];
  if (normalized.length === 0) return allPlatforms('no-diff');

  const result = { fnos: false, macos: false, windows: false, reasons: [] };
  for (const file of normalized) {
    if (
      file.startsWith('packages/reader-web/')
      || file.startsWith('contracts/safe-save/')
      || file === 'package.json'
      || file === 'scripts/sync-version.js'
      || file === 'scripts/prepare-release-notes.js'
      || file === 'scripts/affected-projects.js'
      || file.startsWith('scripts/test/')
      || file === '.github/workflows/ci.yml'
    ) {
      for (const platform of PLATFORM_IDS) addPlatform(result, platform, file);
      continue;
    }
    if (
      file.startsWith('apps/fnos/')
      || file === 'versions/fnos'
      || file === 'scripts/build-fnos.js'
      || file.includes('_quality-fnos.yml')
      || file.includes('release-fnos.yml')
    ) {
      addPlatform(result, 'fnos', file);
      continue;
    }
    if (
      file.startsWith('apps/macos/')
      || file === 'versions/macos'
      || file === 'scripts/build-macos-dmg.sh'
      || file.includes('_quality-macos.yml')
      || file.includes('release-macos.yml')
      || file.includes('macos-notarized.yml')
    ) {
      addPlatform(result, 'macos', file);
      continue;
    }
    if (
      file.startsWith('apps/windows/')
      || file === 'versions/windows'
      || file.includes('_quality-windows.yml')
      || file.includes('release-windows.yml')
    ) {
      addPlatform(result, 'windows', file);
      continue;
    }
    if (
      file.startsWith('docs/')
      || file === 'README.md'
      || file === 'README.en.md'
      || file.startsWith('.github/ISSUE_TEMPLATE/')
      || file.startsWith('.github/PULL_REQUEST_TEMPLATE')
    ) {
      result.reasons.push(`docs:${file}`);
      continue;
    }
    return allPlatforms(`unclassified:${file}`);
  }
  return result;
}

function changedFilesBetween(base, head = 'HEAD') {
  if (!base) return [];
  const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', base, head], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split(/\r?\n/u).filter(Boolean);
}

function appendGitHubOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('--github-output 需要 GITHUB_OUTPUT');
  const lines = [
    ...PLATFORM_IDS.map((platform) => `${platform}=${result[platform] ? 'true' : 'false'}`),
    `any=${PLATFORM_IDS.some((platform) => result[platform]) ? 'true' : 'false'}`,
    `reasons=${JSON.stringify(result.reasons)}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function parseArguments(argv) {
  let base = '';
  let head = 'HEAD';
  let all = false;
  let githubOutput = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') {
      base = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--head') {
      head = argv[index + 1] || 'HEAD';
      index += 1;
    } else if (argument === '--all') {
      all = true;
    } else if (argument === '--github-output') {
      githubOutput = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return { base, head, all, githubOutput };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = options.all ? [] : changedFilesBetween(options.base, options.head);
  const result = options.all ? allPlatforms('manual-all') : classifyChangedFiles(files);
  if (options.githubOutput) appendGitHubOutputs(result);
  console.log(JSON.stringify({ ...result, files }, null, 2));
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
  classifyChangedFiles,
};
