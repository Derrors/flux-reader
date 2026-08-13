const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

test('publishes Windows only as an NSIS EXE installer', () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'apps/windows/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const releaseWorkflow = fs.readFileSync(
    path.join(root, '.github/workflows/release.yml'),
    'utf8',
  );
  const windowsWorkflow = fs.readFileSync(
    path.join(root, '.github/workflows/windows.yml'),
    'utf8',
  );

  assert.deepEqual(tauriConfig.bundle.targets, ['nsis']);
  assert.match(releaseWorkflow, /target\/release\/bundle\/nsis\/\*\.exe/);
  assert.doesNotMatch(releaseWorkflow, /target\/release\/bundle\/msi|\.msi\b/i);
  assert.match(windowsWorkflow, /target\/release\/bundle\/nsis\/\*\.exe/);
  assert.doesNotMatch(windowsWorkflow, /target\/release\/bundle\/msi|\.msi\b/i);
});
