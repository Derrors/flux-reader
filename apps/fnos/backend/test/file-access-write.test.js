const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

process.env.NODE_ENV = 'test';

const trimApi = require('../src/trim-api');
const fileAccess = require('../src/file-access');

async function makeFixture(t) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-reader-write-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'shared');
  const recovery = path.join(temporary, 'private-recovery');
  await fsp.mkdir(root);
  const document = path.join(root, 'notes.md');
  await fsp.writeFile(document, '# original\n');
  return { temporary, root, recovery, document };
}

function installAuthorization(
  t,
  root,
  { aclForPath = () => ({ readable: true, writable: true, deletable: true }) } = {},
) {
  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  trimApi.getSharedAccessibleFolders = async () => ({ paths: [root] });
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    return Object.fromEntries(
      list.map((requestedPath) => [
        requestedPath,
        { path: requestedPath, ...aclForPath(requestedPath) },
      ]),
    );
  };
  fileAccess.__test.setOpenedTargetResolverForTest(async (_fh, requestedPath) => {
    const actualPath = await fsp.realpath(requestedPath);
    return {
      actualPath,
      ioPath: actualPath,
      aclPath: actualPath,
      testFallback: true,
    };
  });
  fileAccess.__test.setRecoveryRootForTest(
    path.join(path.dirname(root), 'private-recovery'),
  );
  t.after(() => {
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
    fileAccess.__test.setOpenedTargetResolverForTest(null);
    fileAccess.__test.setSaveHooksForTest(null);
    fileAccess.__test.setRecoveryRootForTest(null);
  });
}

async function sharedArtifacts(root) {
  return (await fsp.readdir(root)).filter((name) =>
    name.startsWith('.flux-reader-save-'),
  );
}

async function walkFiles(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const result = [];
  for (const entry of entries) {
    const itemPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walkFiles(itemPath)));
    else result.push(itemPath);
  }
  return result;
}

async function assertPrivateRecoveryPermissions(recovery) {
  const rootStat = await fsp.stat(recovery);
  assert.equal(rootStat.mode & 0o777, 0o700);
  const files = await walkFiles(recovery);
  for (const file of files) {
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600, file);
  }
  const buckets = await fsp.readdir(recovery, { withFileTypes: true });
  for (const bucket of buckets.filter((item) => item.isDirectory())) {
    assert.equal(
      (await fsp.stat(path.join(recovery, bucket.name))).mode & 0o777,
      0o700,
    );
  }
  return files;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function waitForChildOutput(child, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `child output timeout waiting for ${expected}; stdout=${stdout}; stderr=${stderr}`,
        ),
      );
    }, timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(expected)) {
        cleanup();
        resolve({ stdout, stderr });
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `child exited before ${expected}: code=${code} signal=${signal}; stdout=${stdout}; stderr=${stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

test('save preserves inode security metadata and cleans private recovery state', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  await fsp.chmod(document, 0o640);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const beforeStat = await fsp.stat(document, { bigint: true });

  assert.equal(before.writable, true);
  assert.match(before.revision, /^[a-f0-9]{64}$/u);
  const saved = await fileAccess.writeMarkdown(
    '1000',
    document,
    '# saved\n',
    before.revision,
  );
  const afterStat = await fsp.stat(document, { bigint: true });

  assert.equal(saved.content, '# saved\n');
  assert.equal(saved.saveSemantics, 'in-place-recoverable');
  assert.equal(saved.externalAtomicity, 'non-atomic-to-external-readers');
  assert.match(saved.revision, /^[a-f0-9]{64}$/u);
  assert.notEqual(saved.revision, before.revision);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.uid, beforeStat.uid);
  assert.equal(afterStat.gid, beforeStat.gid);
  assert.equal(afterStat.mode, beforeStat.mode);
  assert.equal(await fsp.readFile(document, 'utf8'), '# saved\n');
  const reread = await fileAccess.readMarkdown('1000', document);
  assert.equal(reread.revision, saved.revision);
  assert.equal(reread.writable, true);
  assert.deepEqual(await sharedArtifacts(root), []);
  assert.deepEqual(await walkFiles(recovery), []);
});

test('read and file-state expose a false writable capability for read-only uid ACL', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root, {
    aclForPath: () => ({ readable: true, writable: false, deletable: false }),
  });

  const read = await fileAccess.readMarkdown('1000', document);
  const state = await fileAccess.getMarkdownState('1000', document);
  assert.equal(read.writable, false);
  assert.equal(state.writable, false);
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# denied\n', read.revision),
    (err) => err.status === 403 && err.reason === 'USER_ACL_WRITE_DENIED',
  );
  assert.equal(await fsp.readFile(document, 'utf8'), '# original\n');
});

test('stale expected revision fails with current revision and preserves external content', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  await fsp.writeFile(document, '# external\n');

  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) =>
      err.status === 409 &&
      err.reason === 'FILE_CONFLICT' &&
      /^[a-f0-9]{64}$/u.test(err.currentRevision),
  );
  assert.equal(await fsp.readFile(document, 'utf8'), '# external\n');
});

test('saving unchanged content preserves revision, identity, and timestamps', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const beforeStat = await fsp.stat(document, { bigint: true });

  const saved = await fileAccess.writeMarkdown(
    '1000',
    document,
    before.content,
    before.revision,
  );
  const afterStat = await fsp.stat(document, { bigint: true });

  assert.equal(saved.revision, before.revision);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.ctimeNs, beforeStat.ctimeNs);
  assert.deepEqual(await walkFiles(recovery), []);
});

test('in-place save needs target write ACL but not parent write or target delete ACL', async (t) => {
  const { root, document } = await makeFixture(t);
  const realDocument = await fsp.realpath(document);
  let targetWritable = true;
  installAuthorization(t, root, {
    aclForPath: (requestedPath) => ({
      readable: true,
      writable: requestedPath === realDocument ? targetWritable : false,
      deletable: false,
    }),
  });
  let before = await fileAccess.readMarkdown('1000', document);

  const saved = await fileAccess.writeMarkdown(
    '1000',
    document,
    '# allowed\n',
    before.revision,
  );
  assert.equal(saved.content, '# allowed\n');

  targetWritable = false;
  before = await fileAccess.readMarkdown('1000', document);
  assert.equal(before.writable, false);
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# denied\n', before.revision),
    (err) => err.status === 403 && err.reason === 'USER_ACL_WRITE_DENIED',
  );
  assert.equal(await fsp.readFile(document, 'utf8'), '# allowed\n');
});

test('save rejects oversized, invalid Unicode, and symlink documents', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);

  await assert.rejects(
    fileAccess.writeMarkdown(
      '1000',
      document,
      'x'.repeat(fileAccess.MAX_FILE_BYTES + 1),
      before.revision,
    ),
    (err) => err.status === 413 && err.reason === 'FILE_TOO_LARGE',
  );
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '\ud800', before.revision),
    (err) => err.status === 422 && err.reason === 'INVALID_UTF8',
  );

  const linked = path.join(root, 'linked.md');
  await fsp.symlink(document, linked);
  const linkedRead = await fileAccess.readMarkdown('1000', linked);
  await assert.rejects(
    fileAccess.writeMarkdown('1000', linked, '# linked\n', linkedRead.revision),
    (err) => err.status === 409 && err.reason === 'SYMLINK_SAVE_DENIED',
  );

  const realDirectory = path.join(root, 'real-directory');
  const linkedDirectory = path.join(root, 'linked-directory');
  await fsp.mkdir(realDirectory);
  await fsp.writeFile(path.join(realDirectory, 'nested.md'), '# nested\n');
  await fsp.symlink(realDirectory, linkedDirectory);
  const nestedPath = path.join(linkedDirectory, 'nested.md');
  const nestedRead = await fileAccess.readMarkdown('1000', nestedPath);
  await assert.rejects(
    fileAccess.writeMarkdown('1000', nestedPath, '# changed\n', nestedRead.revision),
    (err) => err.status === 409 && err.reason === 'SYMLINK_SAVE_DENIED',
  );
});

test('external write after final check conflicts before mutation and leaves no journal', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  fileAccess.__test.setSaveHooksForTest({
    afterFinalCheck: async () => {
      await fsp.writeFile(document, '# external during final check\n');
    },
  });

  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) => err.status === 409 && err.reason === 'FILE_CONFLICT',
  );
  assert.equal(
    await fsp.readFile(document, 'utf8'),
    '# external during final check\n',
  );
  assert.deepEqual(await walkFiles(recovery), []);
});

test('shared authorization revoked during final check fails before mutation', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  let revoked = false;
  trimApi.getSharedAccessibleFolders = async () => ({
    paths: revoked ? [] : [root],
  });
  fileAccess.__test.setSaveHooksForTest({
    afterFinalCheck: async () => {
      revoked = true;
    },
  });

  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) =>
      err.status === 403 &&
      err.reason === 'SHARED_AUTHORIZATION_CHANGED' &&
      !err.recoveryRequired,
  );
  assert.equal(await fsp.readFile(document, 'utf8'), '# original\n');
  assert.deepEqual(await walkFiles(recovery), []);
});

test('abort observed during the second ACL pass stops before truncate', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const controller = new AbortController();
  const authorizedAcl = trimApi.checkUserACL;
  let abortOnNextAcl = false;
  trimApi.checkUserACL = async (...args) => {
    const result = await authorizedAcl(...args);
    if (abortOnNextAcl) {
      abortOnNextAcl = false;
      controller.abort();
    }
    return result;
  };
  fileAccess.__test.setSaveHooksForTest({
    afterFinalCheck: async () => {
      abortOnNextAcl = true;
    },
  });

  await assert.rejects(
    fileAccess.writeMarkdown(
      '1000',
      document,
      '# cancelled\n',
      before.revision,
      { signal: controller.signal },
    ),
    (err) => err.name === 'AbortError' && err.status === 499,
  );
  assert.equal(await fsp.readFile(document, 'utf8'), '# original\n');
  assert.deepEqual(await walkFiles(recovery), []);
});

test('pathname replacement after final check preserves replacement and original inode', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const heldOriginal = path.join(root, 'held-original.md');
  fileAccess.__test.setSaveHooksForTest({
    afterFinalCheck: async () => {
      await fsp.rename(document, heldOriginal);
      await fsp.writeFile(document, '# replacement during final check\n');
    },
  });

  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) => err.status === 409 && err.reason === 'FILE_CONFLICT',
  );
  assert.equal(
    await fsp.readFile(document, 'utf8'),
    '# replacement during final check\n',
  );
  assert.equal(await fsp.readFile(heldOriginal, 'utf8'), '# original\n');
  assert.deepEqual(await walkFiles(recovery), []);
});

test('same-path concurrent saves serialize and only one revision can commit', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);

  const results = await Promise.allSettled([
    fileAccess.writeMarkdown('1000', document, '# first\n', before.revision),
    fileAccess.writeMarkdown('1000', document, '# second\n', before.revision),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(rejected[0].reason.reason, 'FILE_CONFLICT');
  assert.equal(await fsp.readFile(document, 'utf8'), fulfilled[0].value.content);
});

test('hard-link aliases share the inode transaction lock', async (t) => {
  const { root, document } = await makeFixture(t);
  const alias = path.join(root, 'alias.md');
  await fsp.link(document, alias);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);

  const results = await Promise.allSettled([
    fileAccess.writeMarkdown('1000', document, '# first\n', before.revision),
    fileAccess.writeMarkdown('1000', alias, '# second\n', before.revision),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.reason, 'FILE_CONFLICT');
  assert.equal(await fsp.readFile(document, 'utf8'), fulfilled[0].value.content);
  assert.equal(await fsp.readFile(alias, 'utf8'), fulfilled[0].value.content);
});

test('application reads and file-state wait behind an in-place save window', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const release = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      enteredResolve();
      await release;
    },
  });

  const savePromise = fileAccess.writeMarkdown(
    '1000',
    document,
    '# saved behind barrier\n',
    before.revision,
  );
  await entered;
  let readSettled = false;
  let stateSettled = false;
  const readPromise = fileAccess.readMarkdown('1000', document).finally(() => {
    readSettled = true;
  });
  const statePromise = fileAccess.getMarkdownState('1000', document).finally(() => {
    stateSettled = true;
  });
  await nextTurn();
  assert.equal(readSettled, false);
  assert.equal(stateSettled, false);

  releaseResolve();
  const [saved, read, state] = await Promise.all([
    savePromise,
    readPromise,
    statePromise,
  ]);
  assert.equal(read.content, saved.content);
  assert.equal(state.revision, saved.revision);
});

test('SIGKILL after truncate leaves both baseline and attempted recovery versions durable', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  installAuthorization(t, root);
  const childScript = String.raw`
    const fsp = require('node:fs/promises');
    const trimApi = require(process.env.TEST_TRIM_API_MODULE);
    const fileAccess = require(process.env.TEST_FILE_ACCESS_MODULE);
    trimApi.getSharedAccessibleFolders = async () => ({ paths: [process.env.TEST_ROOT] });
    trimApi.checkUserACL = async (_uid, paths) => {
      const list = Array.isArray(paths) ? paths : [paths];
      return Object.fromEntries(list.map((requestedPath) => [requestedPath, {
        path: requestedPath,
        readable: true,
        writable: true,
        deletable: true,
      }]));
    };
    fileAccess.__test.setOpenedTargetResolverForTest(async (_fh, requestedPath) => {
      const actualPath = await fsp.realpath(requestedPath);
      return { actualPath, ioPath: actualPath, aclPath: actualPath, testFallback: true };
    });
    fileAccess.__test.setRecoveryRootForTest(process.env.TEST_RECOVERY_ROOT);
    (async () => {
      const before = await fileAccess.readMarkdown('1000', process.env.TEST_DOCUMENT);
      fileAccess.__test.setSaveHooksForTest({
        afterTruncate: async () => {
          process.stdout.write('AFTER_TRUNCATE\n');
          await new Promise(() => {});
        },
      });
      await fileAccess.writeMarkdown(
        '1000',
        process.env.TEST_DOCUMENT,
        '# attempted before crash\n',
        before.revision,
      );
    })().catch((err) => {
      console.error(err?.stack || err);
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ['-e', childScript], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TEST_ROOT: root,
      TEST_RECOVERY_ROOT: recovery,
      TEST_DOCUMENT: document,
      TEST_TRIM_API_MODULE: require.resolve('../src/trim-api'),
      TEST_FILE_ACCESS_MODULE: require.resolve('../src/file-access'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForChildOutput(child, 'AFTER_TRUNCATE');
  const exitPromise = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  const [exitCode, exitSignal] = await exitPromise;
  assert.equal(exitCode, null);
  assert.equal(exitSignal, 'SIGKILL');
  assert.equal((await fsp.stat(document)).size, 0);

  const state = await fileAccess.getRecoveryState('1000', document);
  assert.equal(state.available, true);
  const transaction = state.records.find((record) => record.phase === 'writing');
  assert.ok(transaction?.recoveryId);
  assert.equal(transaction.baselineAvailable, true);
  assert.equal(transaction.attemptedAvailable, true);
  const baseline = await fileAccess.readRecoveryVersion(
    '1000',
    document,
    transaction.recoveryId,
    'baseline',
  );
  const attempted = await fileAccess.readRecoveryVersion(
    '1000',
    document,
    transaction.recoveryId,
    'attempted',
  );
  assert.equal(baseline.content, '# original\n');
  assert.equal(attempted.content, '# attempted before crash\n');
  await assertPrivateRecoveryPermissions(recovery);
});

test('a truncate failure never rewrites the target and recovery uses a fresh CAS save', async (t) => {
  const { root, recovery, document, temporary } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  let visibleDuringMutation;
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      visibleDuringMutation = await fsp.readFile(document, 'utf8');
      throw new Error('injected failure after truncate');
    },
  });

  let saveError;
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) => {
      saveError = err;
      return (
        err.status === 409 &&
        err.reason === 'SAVE_RECOVERY_REQUIRED' &&
        err.recoveryRequired === true &&
        err.recovery?.phase === 'recovery-required'
      );
    },
  );
  assert.equal(visibleDuringMutation, '');
  assert.equal(await fsp.readFile(document, 'utf8'), '');
  assert.doesNotMatch(JSON.stringify(saveError.recovery), new RegExp(temporary, 'u'));

  const files = await assertPrivateRecoveryPermissions(recovery);
  assert.ok(files.some((file) => path.basename(file).startsWith('manifest-')));
  const state = await fileAccess.getRecoveryState('1000', document);
  assert.equal(state.available, true);
  assert.equal(state.records[0].recoveryId, saveError.recovery.recoveryId);

  const baseline = await fileAccess.readRecoveryVersion(
    '1000',
    document,
    saveError.recovery.recoveryId,
    'baseline',
  );
  const attempted = await fileAccess.readRecoveryVersion(
    '1000',
    document,
    saveError.recovery.recoveryId,
    'attempted',
  );
  assert.equal(baseline.content, '# original\n');
  assert.equal(attempted.content, '# mine\n');

  // 恢复不使用后端隐式回滚：先取最新 file-state，再把私有 baseline 当作
  // 普通编辑内容通过 revision CAS 保存。
  fileAccess.__test.setSaveHooksForTest(null);
  const failedState = await fileAccess.getMarkdownState('1000', document);
  const restored = await fileAccess.writeMarkdown(
    '1000',
    document,
    baseline.content,
    failedState.revision,
  );
  assert.equal(restored.content, '# original\n');
  assert.equal(await fsp.readFile(document, 'utf8'), '# original\n');
  await fileAccess.discardRecovery(
    '1000',
    document,
    saveError.recovery.recoveryId,
  );
  assert.equal((await fileAccess.getRecoveryState('1000', document)).available, false);
});

test('an external fd write after failure observation is never overwritten by recovery logic', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const externalFd = await fsp.open(document, 'r+');
  t.after(() => externalFd.close().catch(() => {}));
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      throw new Error('injected failure after truncate');
    },
    afterFailureObserved: async () => {
      await externalFd.truncate(0);
      await externalFd.writeFile('# external in former rollback window\n');
      await externalFd.sync();
    },
  });

  let saveError;
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) => {
      saveError = err;
      return (
        err.status === 409 &&
        err.reason === 'SAVE_RECOVERY_REQUIRED' &&
        err.recovery?.phase === 'recovery-required'
      );
    },
  );
  assert.equal(
    await fsp.readFile(document, 'utf8'),
    '# external in former rollback window\n',
  );
  const recoveryId = saveError.recovery.recoveryId;
  assert.equal(
    (await fileAccess.readRecoveryVersion('1000', document, recoveryId, 'baseline'))
      .content,
    '# original\n',
  );
  assert.equal(
    (await fileAccess.readRecoveryVersion('1000', document, recoveryId, 'attempted'))
      .content,
    '# mine\n',
  );
  assert.equal(
    (await fileAccess.readRecoveryVersion('1000', document, recoveryId, 'observed'))
      .content,
    '',
  );
});

test('oversized current inode still exposes file-state and matching recovery metadata', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      throw new Error('injected failure after truncate');
    },
  });

  let recoveryId;
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) => {
      recoveryId = err.recovery?.recoveryId;
      return err.reason === 'SAVE_RECOVERY_REQUIRED' && Boolean(recoveryId);
    },
  );
  fileAccess.__test.setSaveHooksForTest(null);
  await fsp.truncate(document, fileAccess.MAX_FILE_BYTES + 1);

  const state = await fileAccess.getMarkdownState('1000', document);
  assert.equal(state.size, fileAccess.MAX_FILE_BYTES + 1);
  assert.match(state.revision, /^[a-f0-9]{64}$/u);
  assert.equal(state.recovery.available, true);
  assert.equal(state.recovery.records[0].targetMatches, true);
  const recoveryState = await fileAccess.getRecoveryState('1000', document);
  assert.equal(recoveryState.records[0].recoveryId, recoveryId);
  assert.equal(
    (await fileAccess.readRecoveryVersion('1000', document, recoveryId, 'baseline'))
      .content,
    '# original\n',
  );
  await assert.rejects(
    fileAccess.readMarkdown('1000', document),
    (err) => err.status === 413 && err.reason === 'FILE_TOO_LARGE',
  );
});

test('failed restore privately preserves an oversized current baseline within the recovery hard limit', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      throw new Error('create initial recovery');
    },
  });
  let initialRecoveryId;
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# first attempt\n', before.revision),
    (err) => {
      initialRecoveryId = err.recovery?.recoveryId;
      return err.reason === 'SAVE_RECOVERY_REQUIRED' && Boolean(initialRecoveryId);
    },
  );
  fileAccess.__test.setSaveHooksForTest(null);
  await fsp.truncate(document, fileAccess.MAX_FILE_BYTES + 1);
  const freshState = await fileAccess.getMarkdownState('1000', document);
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      throw new Error('fail oversized recovery save');
    },
  });
  let oversizedRecoveryId;
  await assert.rejects(
    fileAccess.commitRecoveryVersion(
      '1000',
      document,
      initialRecoveryId,
      'baseline',
      freshState.revision,
    ),
    (err) => {
      oversizedRecoveryId = err.recovery?.recoveryId;
      return err.reason === 'SAVE_RECOVERY_REQUIRED' && Boolean(oversizedRecoveryId);
    },
  );
  fileAccess.__test.setSaveHooksForTest(null);

  const oversizedBaseline = await fileAccess.readRecoveryVersion(
    '1000',
    document,
    oversizedRecoveryId,
    'baseline',
  );
  assert.equal(oversizedBaseline.size, fileAccess.MAX_FILE_BYTES + 1);
  assert.equal(
    Buffer.byteLength(oversizedBaseline.content, 'utf8'),
    fileAccess.MAX_FILE_BYTES + 1,
  );
  const attempted = await fileAccess.readRecoveryVersion(
    '1000',
    document,
    oversizedRecoveryId,
    'attempted',
  );
  assert.equal(attempted.content, '# original\n');
});

test('external same-inode write after publish is preserved for manual recovery', async (t) => {
  const { root, recovery, document, temporary } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const externalFd = await fsp.open(document, 'r+');
  t.after(() => externalFd.close().catch(() => {}));
  fileAccess.__test.setSaveHooksForTest({
    afterPublish: async () => {
      await externalFd.truncate(0);
      await externalFd.writeFile('# external after publish\n');
      await externalFd.sync();
    },
  });

  let saveError;
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) => {
      saveError = err;
      return (
        err.status === 409 &&
        err.reason === 'FILE_CONFLICT' &&
        err.recoveryRequired === true &&
        err.recovery?.phase === 'recovery-required'
      );
    },
  );
  assert.equal(
    await fsp.readFile(document, 'utf8'),
    '# external after publish\n',
  );
  assert.doesNotMatch(JSON.stringify(saveError.recovery), new RegExp(temporary, 'u'));
  const files = await assertPrivateRecoveryPermissions(recovery);
  assert.ok(files.some((file) => path.basename(file).startsWith('baseline-')));
  assert.ok(files.some((file) => path.basename(file).startsWith('attempted-')));
  assert.ok(files.some((file) => path.basename(file).startsWith('observed-')));

  const recoveryId = saveError.recovery.recoveryId;
  assert.equal(
    (await fileAccess.readRecoveryVersion('1000', document, recoveryId, 'baseline'))
      .content,
    '# original\n',
  );
  assert.equal(
    (await fileAccess.readRecoveryVersion('1000', document, recoveryId, 'attempted'))
      .content,
    '# mine\n',
  );
  assert.equal(
    (await fileAccess.readRecoveryVersion('1000', document, recoveryId, 'observed'))
      .content,
    '# external after publish\n',
  );

  const heldExternal = path.join(root, 'held-external.md');
  await fsp.rename(document, heldExternal);
  await fsp.writeFile(document, '# replacement inode\n');
  await assert.rejects(
    fileAccess.readRecoveryVersion('1000', document, recoveryId, 'baseline'),
    (err) => err.status === 409 && err.reason === 'RECOVERY_TARGET_CHANGED',
  );
  const state = await fileAccess.getRecoveryState('1000', document);
  assert.equal(state.records[0].targetMatches, false);
  await fileAccess.discardRecovery('1000', document, recoveryId);
});

test('post-publish pathname replacement preserves both external and attempted inodes', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const heldAttempt = path.join(root, 'held-attempt.md');
  fileAccess.__test.setSaveHooksForTest({
    afterPublish: async () => {
      await fsp.rename(document, heldAttempt);
      await fsp.writeFile(document, '# external after publish\n');
    },
  });

  let saveError;
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# mine\n', before.revision),
    (err) => {
      saveError = err;
      return (
        err.status === 409 &&
        err.reason === 'FILE_CONFLICT' &&
        err.recoveryRequired === true &&
        err.recovery?.phase === 'recovery-required'
      );
    },
  );
  assert.equal(await fsp.readFile(document, 'utf8'), '# external after publish\n');
  assert.equal(await fsp.readFile(heldAttempt, 'utf8'), '# mine\n');
  assert.ok(saveError.recovery.recoveryId);
  assert.deepEqual(await sharedArtifacts(root), []);
});

test('an active recovery record cannot be discarded through a replacement inode', async (t) => {
  const { root, recovery, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  const heldAttempt = path.join(root, 'held-active-attempt.md');
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const release = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  fileAccess.__test.setSaveHooksForTest({
    afterPublish: async () => {
      await fsp.rename(document, heldAttempt);
      await fsp.writeFile(document, '# replacement while active\n');
      enteredResolve();
      await release;
    },
  });

  const savePromise = fileAccess
    .writeMarkdown('1000', document, '# mine\n', before.revision)
    .then(
      () => null,
      (err) => err,
    );
  await entered;
  const manifestPath = (await walkFiles(recovery)).find((file) =>
    path.basename(file).startsWith('manifest-'),
  );
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));

  await assert.rejects(
    fileAccess.discardRecovery('1000', document, manifest.recoveryId),
    (err) => err.status === 409 && err.reason === 'RECOVERY_IN_PROGRESS',
  );
  assert.equal(await fsp.readFile(manifestPath, 'utf8').then(Boolean), true);

  releaseResolve();
  const saveError = await savePromise;
  assert.equal(saveError.reason, 'FILE_CONFLICT');
  assert.equal(saveError.recovery.recoveryId, manifest.recoveryId);
  const baselinePath = (await walkFiles(recovery)).find((file) =>
    path.basename(file).startsWith('baseline-'),
  );
  assert.equal(await fsp.readFile(baselinePath, 'utf8'), '# original\n');
  assert.equal(await fsp.readFile(document, 'utf8'), '# replacement while active\n');
  assert.equal(await fsp.readFile(heldAttempt, 'utf8'), '# mine\n');

  await fileAccess.discardRecovery('1000', document, manifest.recoveryId);
});

test('recovery cleanup fsync failure occurs after commit and never removes saved target', async (t) => {
  const { root, document } = await makeFixture(t);
  installAuthorization(t, root);
  const before = await fileAccess.readMarkdown('1000', document);
  fileAccess.__test.setSaveHooksForTest({
    cleanupRecoverySync: async () => {
      throw Object.assign(new Error('injected recovery fsync failure'), {
        code: 'EIO',
      });
    },
  });

  const saved = await fileAccess.writeMarkdown(
    '1000',
    document,
    '# committed\n',
    before.revision,
  );
  assert.equal(saved.recoveryCleanupPending, true);
  assert.equal(await fsp.readFile(document, 'utf8'), '# committed\n');
  assert.equal((await fileAccess.readMarkdown('1000', document)).revision, saved.revision);
});

test('quota scan tolerates another document deleting its empty recovery bucket', async (t) => {
  const { root, document } = await makeFixture(t);
  const secondDocument = path.join(root, 'second.md');
  await fsp.writeFile(secondDocument, '# second original\n');
  installAuthorization(t, root);
  const firstBefore = await fileAccess.readMarkdown('1000', document);
  const secondBefore = await fileAccess.readMarkdown('1000', secondDocument);
  let cleanupEnteredResolve;
  let rootListedResolve;
  let continueScanResolve;
  const cleanupEntered = new Promise((resolve) => {
    cleanupEnteredResolve = resolve;
  });
  const rootListed = new Promise((resolve) => {
    rootListedResolve = resolve;
  });
  const continueScan = new Promise((resolve) => {
    continueScanResolve = resolve;
  });
  let firstCleanupWaiting = false;
  fileAccess.__test.setSaveHooksForTest({
    cleanupRecoverySync: async () => {
      if (firstCleanupWaiting) return;
      firstCleanupWaiting = true;
      cleanupEnteredResolve();
      await rootListed;
    },
    afterRecoveryRootList: async () => {
      if (!firstCleanupWaiting) return;
      rootListedResolve();
      await continueScan;
    },
  });

  const firstSave = fileAccess.writeMarkdown(
    '1000',
    document,
    '# first saved\n',
    firstBefore.revision,
  );
  await cleanupEntered;
  const secondSave = fileAccess.writeMarkdown(
    '1000',
    secondDocument,
    '# second saved\n',
    secondBefore.revision,
  );
  await rootListed;
  await firstSave;
  continueScanResolve();
  await secondSave;

  assert.equal(await fsp.readFile(document, 'utf8'), '# first saved\n');
  assert.equal(await fsp.readFile(secondDocument, 'utf8'), '# second saved\n');
});

test('successful saves across 300 documents do not accumulate empty recovery buckets', async (t) => {
  const { root, recovery } = await makeFixture(t);
  installAuthorization(t, root);
  for (let index = 0; index < 300; index += 1) {
    const document = path.join(root, `doc-${index}.md`);
    await fsp.writeFile(document, `# ${index}\n`);
    const before = await fileAccess.readMarkdown('1000', document);
    await fileAccess.writeMarkdown(
      '1000',
      document,
      `# saved ${index}\n`,
      before.revision,
    );
  }
  assert.deepEqual(await walkFiles(recovery), []);
  const buckets = await fsp.readdir(recovery, { withFileTypes: true });
  assert.equal(buckets.filter((entry) => entry.isDirectory()).length, 0);
});
