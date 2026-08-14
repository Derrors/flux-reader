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
    path.join(root, '.github/workflows/release-windows.yml'),
    'utf8',
  );
  const windowsWorkflow = fs.readFileSync(
    path.join(root, '.github/workflows/_quality-windows.yml'),
    'utf8',
  );

  assert.deepEqual(tauriConfig.bundle.targets, ['nsis']);
  assert.match(releaseWorkflow, /target\/release\/bundle\/nsis\/\*\.exe/);
  assert.doesNotMatch(releaseWorkflow, /target\/release\/bundle\/msi|\.msi\b/i);
  assert.match(windowsWorkflow, /cargo (check|test|clippy)/);
  assert.doesNotMatch(windowsWorkflow, /target\/release\/bundle\/msi|\.msi\b/i);
});

test('keeps the Windows production bootstrap compatible with renderer dependencies', () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'apps/windows/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const windowsHtml = fs.readFileSync(
    path.join(root, 'packages/reader-web/windows.html'),
    'utf8',
  );

  // Mermaid and its transitive dependencies mutate inherited prototype members
  // during module initialization. Tauri's freezePrototype option freezes
  // Object.prototype before the renderer starts and aborts React mounting.
  assert.equal(tauriConfig.app.security.freezePrototype, false);
  // Keep a visible fallback if a future renderer bootstrap fails before React
  // replaces the root contents, instead of presenting an unexplained white page.
  assert.match(windowsHtml, /<div id="root">\s*<p role="status">[^<]+<\/p>\s*<\/div>/);
});

test('keeps the native Windows title bar reachable and fully controllable', () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'apps/windows/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const [mainWindow] = tauriConfig.app.windows;

  // A centered 1280x820 logical window can exceed the usable work area on
  // smaller or DPI-scaled displays. Constraining it keeps the native caption
  // inside the monitor instead of centering the drag region above the screen.
  assert.equal(mainWindow.center, true);
  assert.equal(mainWindow.preventOverflow, true);
  assert.equal(mainWindow.decorations, true);
  assert.equal(mainWindow.resizable, true);
  assert.equal(mainWindow.maximizable, true);
  assert.equal(mainWindow.minimizable, true);
  assert.equal(mainWindow.closable, true);
  assert.equal(mainWindow.fullscreen, false);
});
