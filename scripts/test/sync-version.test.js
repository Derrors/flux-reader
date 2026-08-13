const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { releaseMetadata, syncVersion } = require('../sync-version');

const temporaryRoots = [];

function fixture({
  version = '1.2.3',
  manifestVersion = version,
  xcodeVersion = version,
  windowsCargoVersion = version,
  tauriVersion = version,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-reader-version-test-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'apps', 'fnos', 'package'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'macos', 'FluxReader.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'windows', 'src-tauri'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  fs.writeFileSync(
    path.join(root, 'apps', 'fnos', 'package', 'manifest'),
    `appname="flux-reader"\nversion="${manifestVersion}"\n`
  );
  fs.writeFileSync(
    path.join(root, 'apps', 'windows', 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "flux-reader-windows"\nversion = "${windowsCargoVersion}"\n\n[dependencies]\nserde = "1"\n`
  );
  fs.writeFileSync(
    path.join(root, 'apps', 'windows', 'src-tauri', 'tauri.conf.json'),
    `${JSON.stringify({ productName: 'Flux Reader', version: tauriVersion }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, 'apps', 'macos', 'FluxReader.xcodeproj', 'project.pbxproj'),
    [
      'Debug = {',
      `  MARKETING_VERSION = ${xcodeVersion};`,
      '};',
      'Release = {',
      `  MARKETING_VERSION = ${xcodeVersion};`,
      '};',
      '',
    ].join('\n')
  );
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    const expectedPrefix = path.join(os.tmpdir(), 'flux-reader-version-test-');
    assert.ok(root.startsWith(expectedPrefix), `拒绝清理非测试目录：${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts a synchronized three-part release version', () => {
  const root = fixture();
  assert.equal(syncVersion({ root }), '1.2.3');
});

test('keeps release tag and asset names in one versioned contract', () => {
  assert.deepEqual(releaseMetadata('1.2.3'), {
    version: '1.2.3',
    tag: 'v1.2.3',
    fpkAsset: 'flux-reader-1.2.3.fpk',
    dmgAsset: 'Flux-Reader-1.2.3-unnotarized-universal.dmg',
    signedDmgAsset: 'Flux-Reader-1.2.3-universal.dmg',
    windowsAsset: 'flux-reader-1.2.3-windows-x64.exe',
  });
});

test('writes the same release contract to GitHub Actions outputs', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-reader-version-test-'));
  temporaryRoots.push(outputRoot);
  const outputPath = path.join(outputRoot, 'github-output');
  const scriptPath = path.resolve(__dirname, '..', 'sync-version.js');
  const version = syncVersion();

  execFileSync(process.execPath, [scriptPath, '--check', '--github-output'], {
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
    stdio: 'pipe',
  });

  const outputs = Object.fromEntries(
    fs.readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2))
  );
  const metadata = releaseMetadata(version);
  assert.deepEqual(outputs, {
    version: metadata.version,
    tag: metadata.tag,
    fpk_asset: metadata.fpkAsset,
    dmg_asset: metadata.dmgAsset,
    signed_dmg_asset: metadata.signedDmgAsset,
    windows_asset: metadata.windowsAsset,
  });
});

test('rejects drift without modifying source files', () => {
  const root = fixture({
    manifestVersion: '1.2.2',
    xcodeVersion: '1.2.1',
    windowsCargoVersion: '1.1.9',
    tauriVersion: '1.0.0',
  });
  assert.throws(() => syncVersion({ root }), /发布版本未同步/);
  assert.match(
    fs.readFileSync(path.join(root, 'apps', 'fnos', 'package', 'manifest'), 'utf8'),
    /version="1\.2\.2"/
  );
});

test('writes every distribution version and is idempotent', () => {
  const root = fixture({
    version: '2.0.1',
    manifestVersion: '1.9.9',
    xcodeVersion: '1.0.0',
    windowsCargoVersion: '1.8.0',
    tauriVersion: '1.7.0',
  });
  assert.equal(syncVersion({ root, write: true }), '2.0.1');

  const manifestPath = path.join(root, 'apps', 'fnos', 'package', 'manifest');
  const projectPath = path.join(root, 'apps', 'macos', 'FluxReader.xcodeproj', 'project.pbxproj');
  const cargoPath = path.join(root, 'apps', 'windows', 'src-tauri', 'Cargo.toml');
  const tauriPath = path.join(root, 'apps', 'windows', 'src-tauri', 'tauri.conf.json');
  const firstManifest = fs.readFileSync(manifestPath, 'utf8');
  const firstProject = fs.readFileSync(projectPath, 'utf8');
  const firstCargo = fs.readFileSync(cargoPath, 'utf8');
  const firstTauriConfig = fs.readFileSync(tauriPath, 'utf8');
  assert.match(firstManifest, /version="2\.0\.1"/);
  assert.equal((firstProject.match(/MARKETING_VERSION = 2\.0\.1;/g) || []).length, 2);
  assert.match(firstCargo, /^version = "2\.0\.1"$/m);
  assert.equal(JSON.parse(firstTauriConfig).version, '2.0.1');

  assert.equal(syncVersion({ root, write: true }), '2.0.1');
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), firstManifest);
  assert.equal(fs.readFileSync(projectPath, 'utf8'), firstProject);
  assert.equal(fs.readFileSync(cargoPath, 'utf8'), firstCargo);
  assert.equal(fs.readFileSync(tauriPath, 'utf8'), firstTauriConfig);
});

test('rejects invalid versions and ambiguous version fields', () => {
  const invalidRoot = fixture({ version: '1.2' });
  assert.throws(() => syncVersion({ root: invalidRoot }), /单行三段纯数字版本号/);

  const multilineRoot = fixture();
  fs.writeFileSync(path.join(multilineRoot, 'VERSION'), '1.2.3\n1.2.4\n');
  assert.throws(() => syncVersion({ root: multilineRoot }), /单行三段纯数字版本号/);

  const duplicateRoot = fixture();
  const manifestPath = path.join(duplicateRoot, 'apps', 'fnos', 'package', 'manifest');
  fs.appendFileSync(manifestPath, 'version="9.9.9"\n');
  assert.throws(() => syncVersion({ root: duplicateRoot }), /只能包含一个 version 字段/);
});
