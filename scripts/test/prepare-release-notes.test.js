const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  RELEASE_MARKER,
  buildReleaseNotes,
  writeReleaseNotes,
} = require('../prepare-release-notes');

const temporaryRoots = [];

function fixture({ version = '1.2.3', summary = '## 本次更新\n\n- 新增中文发布说明。' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-reader-notes-test-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'docs', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  if (summary != null) {
    fs.writeFileSync(path.join(root, 'docs', 'releases', `${version}.md`), summary);
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

test('generates Chinese release notes with versioned assets and warning', () => {
  const root = fixture();
  const notes = buildReleaseNotes({ root });

  assert.match(notes, new RegExp(`^${RELEASE_MARKER}`));
  assert.match(notes, /## 本次更新/);
  assert.match(notes, /flux-reader-1\.2\.3\.fpk/);
  assert.match(notes, /Flux-Reader-1\.2\.3-unnotarized-universal\.dmg/);
  assert.match(notes, /未经过 Apple 公证/);
  assert.doesNotMatch(notes, /Full Changelog|What's Changed/);
});

test('writes the validated notes to the requested output path', () => {
  const root = fixture();
  const outputPath = path.join(root, 'output', 'RELEASE_NOTES.md');

  assert.equal(writeReleaseNotes(outputPath, { root }), outputPath);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), buildReleaseNotes({ root }));
});

test('rejects missing, empty, or non-Chinese version summaries', () => {
  assert.throws(
    () => buildReleaseNotes({ root: fixture({ summary: null }) }),
    /缺少 docs\/releases\/1\.2\.3\.md/,
  );
  assert.throws(
    () => buildReleaseNotes({ root: fixture({ summary: '   ' }) }),
    /不能为空/,
  );
  assert.throws(
    () => buildReleaseNotes({ root: fixture({ summary: '## Changes\n\n- Fix bugs.' }) }),
    /必须包含中文/,
  );
});
