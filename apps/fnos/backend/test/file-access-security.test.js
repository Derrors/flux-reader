const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const trimApi = require('../src/trim-api');
const fileAccess = require('../src/file-access');

test('builds an ACL fd path that is resolvable from the gateway process', () => {
  assert.equal(
    fileAccess.__test.crossProcessFdPath(17),
    `/proc/${process.pid}/fd/17`,
  );
});

function aclMap(paths) {
  return Object.fromEntries(
    paths.map((p) => [
      p,
      { path: p, readable: true, writable: false, deletable: false },
    ]),
  );
}

async function makeFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-reader-fd-security-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared');
  const outside = path.join(root, 'outside');
  await fsp.mkdir(shared);
  await fsp.mkdir(outside);
  return { root, shared, outside };
}

function mockAuthorization(t, shared) {
  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  trimApi.getSharedAccessibleFolders = async () => ({ paths: [shared] });
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    return aclMap(list);
  };
  t.after(() => {
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
  });
}

function injectActualPathResolver(t) {
  fileAccess.__test.setOpenedTargetResolverForTest(async (_fh, requestedPath) => {
    const actualPath = await fsp.realpath(requestedPath);
    return {
      actualPath,
      ioPath: actualPath,
      aclPath: actualPath,
      testFallback: true,
    };
  });
  t.after(() => fileAccess.__test.setOpenedTargetResolverForTest(null));
}

test('rejects an ancestor symlink switched outside shared roots before open', async (t) => {
  const { shared, outside } = await makeFixture(t);
  mockAuthorization(t, shared);

  const inside = path.join(shared, 'inside');
  await fsp.mkdir(inside);
  await fsp.writeFile(path.join(inside, 'race.md'), '# inside');
  await fsp.writeFile(path.join(outside, 'race.md'), '# outside');

  const link = path.join(shared, 'link');
  await fsp.symlink(inside, link);
  const requested = path.join(link, 'race.md');
  const originalOpen = fsp.open;
  let switched = false;
  fsp.open = async function patchedOpen(openPath, flags) {
    if (!switched && openPath === requested) {
      switched = true;
      await fsp.unlink(link);
      await fsp.symlink(outside, link);
    }
    return originalOpen.call(this, openPath, flags);
  };
  t.after(() => {
    fsp.open = originalOpen;
  });

  await assert.rejects(
    fileAccess.readMarkdown('1000', requested),
    (err) => err.reason === 'PATH_CHANGED_DURING_OPEN',
  );
});

test('rejects a file replaced while exact ACL is in flight', async (t) => {
  const { shared } = await makeFixture(t);
  mockAuthorization(t, shared);
  injectActualPathResolver(t);

  const target = path.join(shared, 'replace.md');
  const original = path.join(shared, 'replace-original.md');
  await fsp.writeFile(target, '# original');

  let replaced = false;
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    if (!replaced && list.length === 1 && list[0] === fs.realpathSync(target)) {
      replaced = true;
      await fsp.rename(target, original);
      await fsp.writeFile(target, '# replacement');
    }
    return aclMap(list);
  };

  await assert.rejects(
    fileAccess.readMarkdown('1000', target),
    (err) => err.reason === 'PATH_CHANGED_DURING_AUTHORIZATION',
  );
});

test('binds exact file ACL to an injected stable fd path across an ABA swap', async (t) => {
  const { shared } = await makeFixture(t);
  const target = path.join(shared, 'aba.md');
  const heldOriginal = path.join(shared, 'aba-original.md');
  const heldDecoy = path.join(shared, 'aba-decoy.md');
  await fsp.writeFile(target, '# original');

  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  trimApi.getSharedAccessibleFolders = async () => ({ paths: [shared] });

  const stableQueries = [];
  let swapped = false;
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    stableQueries.push(...list);
    assert.ok(list.every((p) => p.startsWith('/test-proc/')));
    if (!swapped) {
      swapped = true;
      // pathname 在 ACL 调用期间短暂指向 decoy，返回前再恢复原 inode。
      await fsp.rename(target, heldOriginal);
      await fsp.writeFile(target, '# readable decoy');
      await fsp.rename(target, heldDecoy);
      await fsp.rename(heldOriginal, target);
    }
    return aclMap(list);
  };

  fileAccess.__test.setOpenedTargetResolverForTest(async (fh, requestedPath) => ({
    actualPath: await fsp.realpath(requestedPath),
    ioPath: await fsp.realpath(requestedPath),
    aclPath: `/test-proc/${fh.fd}`,
    testFallback: false,
  }));
  t.after(() => {
    fileAccess.__test.setOpenedTargetResolverForTest(null);
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
  });

  const result = await fileAccess.readMarkdown('1000', target);
  assert.equal(result.content, '# original');
  // 事务屏障前后各重验一次，同一个稳定 fd ACL 路径不能退回 pathname。
  assert.equal(stableQueries.length, 2);
  assert.ok(stableQueries.every((query) => query === stableQueries[0]));
  assert.notEqual(stableQueries[0], target);
});

test('binds root, parent, and every listed child ACL to stable fd paths', async (t) => {
  const { shared } = await makeFixture(t);
  await fsp.writeFile(path.join(shared, 'visible.md'), '# visible');
  await fsp.mkdir(path.join(shared, 'visible-dir'));
  await Promise.all(
    Array.from({ length: 203 }, (_, index) =>
      fsp.writeFile(
        path.join(shared, `batch-${String(index).padStart(3, '0')}.md`),
        '# batch',
      ),
    ),
  );

  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  trimApi.getSharedAccessibleFolders = async () => ({ paths: [shared] });
  const aclBatches = [];
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    aclBatches.push(list.slice());
    assert.ok(list.every((p) => p.startsWith('/test-proc/')));
    return aclMap(list);
  };

  fileAccess.__test.setOpenedTargetResolverForTest(async (fh, requestedPath) => {
    const actualPath = await fsp.realpath(requestedPath);
    return {
      actualPath,
      ioPath: actualPath,
      aclPath: `/test-proc/${fh.fd}`,
      testFallback: false,
    };
  });
  t.after(() => {
    fileAccess.__test.setOpenedTargetResolverForTest(null);
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
  });

  const roots = await fileAccess.getAuthorizedRoots('1000');
  assert.equal(roots.length, 1);
  const entries = await fileAccess.listDirectory('1000', shared);
  assert.equal(entries.length, 205);
  assert.ok(entries.some((item) => item.name === 'visible-dir'));
  assert.ok(entries.some((item) => item.name === 'visible.md'));
  assert.deepEqual(
    aclBatches.map((batch) => batch.length),
    [1, 1, 100, 100, 5],
  );
});

test('fails closed with a clear error when stable fd ACL is unsupported', async (t) => {
  const { shared } = await makeFixture(t);
  const target = path.join(shared, 'unsupported.md');
  await fsp.writeFile(target, '# unsupported');

  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  trimApi.getSharedAccessibleFolders = async () => ({ paths: [shared] });
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    return Object.fromEntries(
      list.map((p) => [
        p,
        {
          path: p,
          readable: !p.startsWith('/test-proc/'),
          writable: false,
          deletable: false,
        },
      ]),
    );
  };

  fileAccess.__test.setOpenedTargetResolverForTest(async (fh, requestedPath) => {
    const actualPath = await fsp.realpath(requestedPath);
    return {
      actualPath,
      ioPath: actualPath,
      aclPath: `/test-proc/${fh.fd}`,
      testFallback: false,
    };
  });
  t.after(() => {
    fileAccess.__test.setOpenedTargetResolverForTest(null);
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
  });

  await assert.rejects(
    fileAccess.readMarkdown('1000', target),
    (err) => err.reason === 'SECURE_FD_ACL_UNAVAILABLE' && err.status === 503,
  );
});

test('requires the opened target to remain in the current shared roots', async (t) => {
  const { shared } = await makeFixture(t);
  const target = path.join(shared, 'revoked.md');
  await fsp.writeFile(target, '# revoked');

  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  let sharedQueryCount = 0;
  trimApi.getSharedAccessibleFolders = async () => ({
    paths: sharedQueryCount++ === 0 ? [shared] : [],
  });
  trimApi.checkUserACL = async () => {
    throw new Error('ACL must not run after shared authorization is revoked');
  };
  t.after(() => {
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
  });

  await assert.rejects(
    fileAccess.readMarkdown('1000', target),
    (err) => err.reason === 'SHARED_AUTHORIZATION_CHANGED',
  );
});

test('rejects a directory replaced while its exact ACL is in flight', async (t) => {
  const { shared } = await makeFixture(t);
  mockAuthorization(t, shared);
  injectActualPathResolver(t);

  const target = path.join(shared, 'replace-dir');
  const original = path.join(shared, 'replace-dir-original');
  await fsp.mkdir(target);
  await fsp.writeFile(path.join(target, 'secret.md'), '# secret');

  let replaced = false;
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    if (!replaced && list.length === 1 && list[0] === fs.realpathSync(target)) {
      replaced = true;
      await fsp.rename(target, original);
      await fsp.mkdir(target);
      await fsp.writeFile(path.join(target, 'public.md'), '# public');
    }
    return aclMap(list);
  };

  await assert.rejects(
    fileAccess.listDirectory('1000', target),
    (err) => err.reason === 'PATH_CHANGED_DURING_AUTHORIZATION',
  );
});
