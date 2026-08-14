const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

function workflow(name) {
  return fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
}

test('platform releases are manual, independent, and gated by reusable quality jobs', () => {
  for (const platform of ['fnos', 'macos', 'windows']) {
    const source = workflow(`release-${platform}.yml`);
    assert.match(source, /workflow_dispatch:/);
    assert.doesNotMatch(source, /^\s*push:/m);
    assert.match(source, new RegExp(`--platform ${platform}`));
    assert.match(source, new RegExp(`uses: \\.\\/\\.github/workflows/_quality-${platform}\\.yml`));
    assert.match(source, new RegExp(`group: release-${platform}`));
  }
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/release.yml')), false);
});

test('central CI delegates from one affected-project graph', () => {
  const source = workflow('ci.yml');
  assert.match(source, /scripts\/affected-projects\.js/);
  for (const platform of ['fnos', 'macos', 'windows']) {
    assert.match(source, new RegExp(`outputs\\.${platform} == 'true'`));
    assert.match(source, new RegExp(`_quality-${platform}\\.yml`));
  }
});

test('notarized macOS release attaches to the independent macOS release tag', () => {
  const source = workflow('macos-notarized.yml');
  assert.match(source, /version:check:macos/);
  assert.match(source, /--platform macos --github-output/);
  assert.match(source, /test:macos-ui/);
  assert.match(source, /steps\.metadata\.outputs\.signed_asset/);
  assert.doesNotMatch(source, /signed_dmg_asset/);
});
