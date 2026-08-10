const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { shutdown, __test } = require('../src/server');

test('SIGTERM-style shutdown drains an active save before completing', async (t) => {
  let releaseSave;
  const activeSave = new Promise((resolve) => {
    releaseSave = resolve;
  });
  let closeAllConnectionsCalled = false;
  const fakeServer = {
    close(callback) {
      void activeSave.then(callback);
    },
    closeAllConnections() {
      closeAllConnectionsCalled = true;
    },
  };
  __test.setActiveServerForTest(fakeServer);
  t.after(() => {
    __test.setActiveServerForTest(null);
  });

  let shutdownSettled = false;
  const shutdownPromise = shutdown('SIGTERM_TEST', { timeoutMs: 2_000 }).then(
    (result) => {
      shutdownSettled = true;
      return result;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);
  assert.equal(closeAllConnectionsCalled, false);

  releaseSave();
  const result = await shutdownPromise;
  assert.deepEqual(result, { timedOut: false });
  assert.equal(closeAllConnectionsCalled, false);
});
