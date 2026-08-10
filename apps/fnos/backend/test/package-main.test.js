const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

test('fnOS launcher passes its resolved private var directory to Node', async () => {
  const launcher = await fsp.readFile(
    path.resolve(__dirname, '../../package/cmd/main'),
    'utf8',
  );
  assert.match(launcher, /TRIM_PKGVAR="\$\{VAR_DIR\}" \\/u);
});
