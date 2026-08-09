const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('共享授权仍按当前用户 ACL 过滤根目录、子项与文件读取', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-reader-shared-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const visibleDir = path.join(root, 'visible-dir');
  const hiddenDir = path.join(root, 'hidden-dir');
  const visibleFile = path.join(root, 'visible.md');
  const hiddenFile = path.join(root, 'hidden.md');
  await fs.mkdir(visibleDir);
  await fs.mkdir(hiddenDir);
  await fs.writeFile(visibleFile, '# visible\n');
  await fs.writeFile(hiddenFile, '# hidden\n');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'not markdown\n');

  const realRoot = await fs.realpath(root);
  const realVisibleDir = await fs.realpath(visibleDir);
  const realVisibleFile = await fs.realpath(visibleFile);

  const state = {
    sharedPaths: [root],
    readable: new Set([realRoot, realVisibleDir, realVisibleFile]),
  };

  const trimApiPath = require.resolve('../src/trim-api');
  require.cache[trimApiPath] = {
    id: trimApiPath,
    filename: trimApiPath,
    loaded: true,
    exports: {
      getSharedAccessibleFolders: async () => ({ paths: state.sharedPaths }),
      checkUserACL: async (_uid, paths) =>
        Object.fromEntries(
          paths.map((target) => [
            target,
            {
              path: target,
              readable: state.readable.has(target),
              writable: false,
              deletable: false,
            },
          ]),
        ),
      convertPath: async (paths) => ({
        result: paths.map((target) => ({ path: target, semanticPath: `显示/${path.basename(target)}` })),
      }),
    },
  };

  const fileAccessPath = require.resolve('../src/file-access');
  delete require.cache[fileAccessPath];
  const fileAccess = require(fileAccessPath);
  // 这是共享授权功能测试，显式注入 actualPath 降级，使 Linux/macOS
  // 都使用 state.readable 中的真实路径。稳定 fd ACL 由 security tests 独立覆盖。
  fileAccess.__test.setOpenedTargetResolverForTest(async (_fh, requestedPath) => {
    const actualPath = await fs.realpath(requestedPath);
    return {
      actualPath,
      ioPath: actualPath,
      aclPath: actualPath,
      testFallback: true,
    };
  });
  t.after(() => fileAccess.__test.setOpenedTargetResolverForTest(null));

  const roots = await fileAccess.getAuthorizedRoots('1000');
  assert.deepEqual(roots, [
    { path: root, displayPath: `显示/${path.basename(root)}`, isFile: false },
  ]);

  const entries = await fileAccess.listDirectory('1000', root);
  assert.deepEqual(
    entries.map((item) => item.name),
    ['visible-dir', 'visible.md'],
  );

  const result = await fileAccess.readMarkdown('1000', visibleFile);
  assert.equal(result.content, '# visible\n');

  await assert.rejects(
    fileAccess.readMarkdown('1000', hiddenFile),
    (err) => err.status === 403 && /当前用户无权/.test(err.message),
  );

  state.readable.delete(realRoot);
  assert.deepEqual(await fileAccess.getAuthorizedRoots('1000'), []);

  state.sharedPaths = [];
  await assert.rejects(
    fileAccess.readMarkdown('1000', visibleFile),
    (err) => err.reason === 'NO_AUTHORIZED_PATH' && err.status === 403,
  );
});
