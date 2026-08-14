const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  buildReleaseNotes,
  releaseMarker,
  writeReleaseNotes,
} = require('../prepare-release-notes');

const temporaryRoots = [];

function fixture({
  platform = 'fnos',
  version = '1.2.3',
  summary = '## 本次更新\n\n- 新增中文发布说明。',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-reader-notes-test-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'releases', platform), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', platform), `${version}\n`);
  if (summary != null) {
    fs.writeFileSync(path.join(root, 'docs', 'releases', platform, `${version}.md`), summary);
  }
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    const expectedPrefix = path.join(os.tmpdir(), 'flux-reader-notes-test-');
    assert.ok(root.startsWith(expectedPrefix), `拒绝清理非测试目录：${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generates one platform release with a platform marker and asset', () => {
  const fnos = buildReleaseNotes({ root: fixture(), platform: 'fnos' });
  assert.match(fnos, new RegExp(`^${releaseMarker('fnos')}`));
  assert.match(fnos, /Flux Reader fnOS 1\.2\.3/);
  assert.match(fnos, /flux-reader-1\.2\.3\.fpk/);
  assert.doesNotMatch(fnos, /\.dmg|windows-x64/);

  const windows = buildReleaseNotes({
    root: fixture({ platform: 'windows' }),
    platform: 'windows',
  });
  assert.match(windows, /flux-reader-1\.2\.3-windows-x64\.exe/);
  assert.doesNotMatch(windows, /\.fpk|\.dmg/);

  const macos = buildReleaseNotes({
    root: fixture({ platform: 'macos' }),
    platform: 'macos',
  });
  assert.match(macos, /Flux-Reader-1\.2\.3-unnotarized-universal\.dmg/);
  assert.match(macos, /未经过 Apple 公证/);
});

test('writes validated platform notes to the requested output path', () => {
  const root = fixture({ platform: 'windows' });
  const outputPath = path.join(root, 'output', 'RELEASE_NOTES.md');
  assert.equal(writeReleaseNotes(outputPath, { root, platform: 'windows' }), outputPath);
  assert.equal(
    fs.readFileSync(outputPath, 'utf8'),
    buildReleaseNotes({ root, platform: 'windows' }),
  );
});

test('rejects missing, empty, non-Chinese, or unspecified platform summaries', () => {
  assert.throws(
    () => buildReleaseNotes({ root: fixture({ summary: null }), platform: 'fnos' }),
    /缺少 docs\/releases\/fnos\/1\.2\.3\.md/,
  );
  assert.throws(
    () => buildReleaseNotes({ root: fixture({ summary: '   ' }), platform: 'fnos' }),
    /不能为空/,
  );
  assert.throws(
    () => buildReleaseNotes({
      root: fixture({ platform: 'macos', summary: '## Changes\n\n- Fix bugs.' }),
      platform: 'macos',
    }),
    /必须包含中文/,
  );
  assert.throws(() => buildReleaseNotes({ root: fixture() }), /必须通过 --platform/);
});
