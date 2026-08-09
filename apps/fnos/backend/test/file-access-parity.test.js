const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const trimApi = require('../src/trim-api');
const fileAccess = require('../src/file-access');

function aclMap(paths, readable = () => true) {
  return Object.fromEntries(
    paths.map((target) => [
      target,
      {
        path: target,
        readable: readable(target),
        writable: false,
        deletable: false,
      },
    ]),
  );
}

async function makeFixture(t) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-reader-parity-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const first = path.join(temporary, 'first');
  const second = path.join(temporary, 'second');
  const outside = path.join(temporary, 'outside');
  await Promise.all([
    fsp.mkdir(first),
    fsp.mkdir(second),
    fsp.mkdir(outside),
  ]);
  return { temporary, first, second, outside };
}

function installAuthorization(
  t,
  sharedRoots,
  { readable = () => true, queries = [], onAcl = () => {} } = {},
) {
  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  trimApi.getSharedAccessibleFolders = async () => ({ paths: sharedRoots });
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    queries.push(...list);
    onAcl(list);
    return aclMap(list, readable);
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
  t.after(() => {
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
    fileAccess.__test.setOpenedTargetResolverForTest(null);
    fileAccess.__test.setSearchContentLimitsForTest(null);
  });
}

function mutateDuringFirstRead(t, targetPath) {
  const originalOpen = fsp.open;
  let mutated = false;
  fsp.open = async (openPath, ...args) => {
    const handle = await originalOpen.call(fsp, openPath, ...args);
    if (String(openPath) !== targetPath) return handle;
    return {
      fd: handle.fd,
      stat: (...statArgs) => handle.stat(...statArgs),
      close: (...closeArgs) => handle.close(...closeArgs),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (!mutated) {
          mutated = true;
          const writer = await originalOpen.call(fsp, targetPath, 'a');
          try {
            await writer.writeFile(Buffer.from([1]));
          } finally {
            await writer.close();
          }
        }
        return result;
      },
    };
  };
  t.after(() => {
    fsp.open = originalOpen;
  });
}

test('searches multiple readable workspaces and deduplicates nested selections', async (t) => {
  const { first, second } = await makeFixture(t);
  installAuthorization(t, [first, second]);

  const nested = path.join(first, 'nested');
  await fsp.mkdir(nested);
  await fsp.writeFile(path.join(first, 'needle-title.md'), '# filename match\n');
  await fsp.writeFile(path.join(first, 'content.md'), '# Notes\nThe Needle is here.\n');
  await fsp.writeFile(path.join(nested, 'deep.md'), '# Deep\nneedle in nested workspace\n');
  await fsp.writeFile(path.join(second, 'other.md'), '# Other\nNEEDLE in another root\n');

  const result = await fileAccess.searchMarkdown(
    '1000',
    [first, nested, second],
    'needle',
  );

  assert.equal(result.scannedFiles, 4);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.results.map((item) => [item.name, item.matchKind]),
    [
      ['needle-title.md', 'fileName'],
      ['content.md', 'content'],
      ['deep.md', 'content'],
      ['other.md', 'content'],
    ],
  );
  const deep = result.results.find((item) => item.name === 'deep.md');
  assert.equal(deep.workspacePath, nested);
  assert.equal(result.results.filter((item) => item.name === 'deep.md').length, 1);
});

test('search requires current-user read access to every selected workspace', async (t) => {
  const { first, second } = await makeFixture(t);
  const deniedRoot = await fsp.realpath(second);
  installAuthorization(t, [first, second], {
    readable: (target) => target !== deniedRoot,
  });

  await assert.rejects(
    fileAccess.searchMarkdown('1000', [first, second], 'needle'),
    (err) => err.reason === 'USER_ACL_DENIED' && err.status === 403,
  );
});

test('search ignores symlinks and stops at its total content scan budget', async (t) => {
  const { first, outside } = await makeFixture(t);
  installAuthorization(t, [first]);
  await fsp.writeFile(path.join(outside, 'secret.md'), 'needle outside');
  await fsp.symlink(path.join(outside, 'secret.md'), path.join(first, 'linked.md'));
  await fsp.writeFile(path.join(first, 'a.md'), 'no match in the first file');
  await fsp.writeFile(path.join(first, 'b.md'), 'needle appears only in the second file');
  fileAccess.__test.setSearchContentLimitsForTest({ bytes: 1024, files: 1 });

  const result = await fileAccess.searchMarkdown('1000', first, 'needle');
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.contentFilesRead, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results, []);
});

test('search propagates AbortSignal and stops after the in-flight ACL check', async (t) => {
  const { first } = await makeFixture(t);
  const controller = new AbortController();
  const queries = [];
  installAuthorization(t, [first], {
    queries,
    onAcl: () => controller.abort(),
  });
  await fsp.writeFile(path.join(first, 'notes.md'), 'needle');

  await assert.rejects(
    fileAccess.searchMarkdown('1000', first, 'needle', 100, {
      signal: controller.signal,
    }),
    (err) => err.name === 'AbortError' && err.reason === 'SEARCH_ABORTED',
  );
  assert.equal(queries.length, 1);
});

test('maps target open errors without treating NAS faults as authorization failures', async (t) => {
  const { first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const document = path.join(first, 'fault.md');
  await fsp.writeFile(document, '# fault');
  const originalOpen = fsp.open;
  t.after(() => {
    fsp.open = originalOpen;
  });

  const cases = [
    ['ENOENT', 404, 'PATH_NOT_FOUND'],
    ['ENOTDIR', 404, 'PATH_NOT_FOUND'],
    ['EACCES', 403, 'PATH_OPEN_DENIED'],
    ['EPERM', 403, 'PATH_OPEN_DENIED'],
    ['EMFILE', 503, 'PATH_OPEN_UNAVAILABLE'],
    ['ENFILE', 503, 'PATH_OPEN_UNAVAILABLE'],
    ['ENOMEM', 503, 'PATH_OPEN_UNAVAILABLE'],
    ['EIO', 500, 'PATH_OPEN_FAILED'],
    ['EUNKNOWN', 500, 'PATH_OPEN_FAILED'],
  ];
  for (const [code, status, reason] of cases) {
    fsp.open = async (openPath, ...args) => {
      if (String(openPath) === document) {
        throw Object.assign(new Error(code), { code });
      }
      return originalOpen.call(fsp, openPath, ...args);
    };
    await assert.rejects(
      fileAccess.readMarkdown('1000', document),
      (err) => err.status === status && err.reason === reason,
      code,
    );
  }

  fsp.open = async (openPath, ...args) => {
    if (String(openPath) === first) {
      throw Object.assign(new Error('storage I/O failed'), { code: 'EIO' });
    }
    return originalOpen.call(fsp, openPath, ...args);
  };
  await assert.rejects(
    fileAccess.listDirectory('1000', first),
    (err) => err.status === 500 && err.reason === 'PATH_OPEN_FAILED',
  );
});

test('rejects Markdown changed during its single-buffer read', async (t) => {
  const { first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const document = path.join(first, 'changing.md');
  await fsp.writeFile(document, '# initial');
  mutateDuringFirstRead(t, document);

  await assert.rejects(
    fileAccess.readMarkdown('1000', document),
    (err) => err.status === 409 && err.reason === 'FILE_CHANGED_DURING_READ',
  );
});

test('rejects invalid UTF-8 Markdown and search skips that candidate', async (t) => {
  const { first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const invalid = path.join(first, 'broken.md');
  await fsp.writeFile(invalid, Buffer.from([0xc3, 0x28]));
  await fsp.writeFile(path.join(first, 'valid.md'), 'needle in valid UTF-8');

  await assert.rejects(
    fileAccess.readMarkdown('1000', invalid),
    (err) => err.status === 422 && err.reason === 'INVALID_UTF8',
  );
  const result = await fileAccess.searchMarkdown('1000', first, 'needle');
  assert.deepEqual(result.results.map((item) => item.name), ['valid.md']);
});

test('loads a local relative image through document, workspace, and image ACL checks', async (t) => {
  const { first } = await makeFixture(t);
  const queries = [];
  installAuthorization(t, [first], { queries });
  const docs = path.join(first, 'docs');
  const images = path.join(first, 'images');
  await Promise.all([fsp.mkdir(docs), fsp.mkdir(images)]);
  const document = path.join(docs, 'readme.md');
  const image = path.join(images, 'cover 1.png');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  await fsp.writeFile(document, '![cover](../images/cover%201.png)');
  await fsp.writeFile(image, png);

  const resource = await fileAccess.readLocalImage(
    '1000',
    document,
    '../images/cover%201.png?raw=1#preview',
    first,
  );
  assert.equal(resource.mimeType, 'image/png');
  assert.deepEqual(resource.data, png);
  assert.ok(queries.includes(await fsp.realpath(document)));
  assert.ok(queries.includes(await fsp.realpath(first)));
  assert.ok(queries.includes(await fsp.realpath(image)));
});

test('resource loading rejects traversal and symlink escape even into another authorized root', async (t) => {
  const { first, second } = await makeFixture(t);
  installAuthorization(t, [first, second]);
  const docs = path.join(first, 'docs');
  const images = path.join(first, 'images');
  await Promise.all([fsp.mkdir(docs), fsp.mkdir(images)]);
  const document = path.join(docs, 'readme.md');
  const secret = path.join(second, 'secret.png');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await fsp.writeFile(document, '# document');
  await fsp.writeFile(secret, png);
  await fsp.symlink(secret, path.join(images, 'linked.png'));

  await assert.rejects(
    fileAccess.readLocalImage('1000', document, '../../second/secret.png', first),
    (err) => err.reason === 'RESOURCE_OUTSIDE_WORKSPACE',
  );
  await assert.rejects(
    fileAccess.readLocalImage('1000', document, '../images/linked.png', first),
    (err) => err.reason === 'RESOURCE_OUTSIDE_WORKSPACE',
  );
});

test('resource loading enforces image allowlist, signature, and size limit', async (t) => {
  const { first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const document = path.join(first, 'readme.md');
  const svg = path.join(first, 'unsafe.svg');
  const fakePng = path.join(first, 'fake.png');
  const hugePng = path.join(first, 'huge.png');
  await fsp.writeFile(document, '# document');
  await fsp.writeFile(svg, '<svg><script>alert(1)</script></svg>');
  await fsp.writeFile(fakePng, 'not a png');
  await fsp.writeFile(hugePng, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await fsp.truncate(hugePng, fileAccess.MAX_IMAGE_BYTES + 1);

  await assert.rejects(
    fileAccess.readLocalImage('1000', document, 'unsafe.svg'),
    (err) => err.reason === 'UNSUPPORTED_IMAGE_TYPE' && err.status === 415,
  );
  await assert.rejects(
    fileAccess.readLocalImage('1000', document, 'fake.png'),
    (err) => err.reason === 'INVALID_IMAGE_CONTENT' && err.status === 415,
  );
  await assert.rejects(
    fileAccess.readLocalImage('1000', document, 'huge.png'),
    (err) => err.reason === 'IMAGE_TOO_LARGE' && err.status === 413,
  );
});

test('missing image opened through a production-style stable workspace path is 404', async (t) => {
  const { temporary, first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const document = path.join(first, 'readme.md');
  await fsp.writeFile(document, '# document');

  const stablePrefix = path.join(temporary, 'synthetic-stable-fd');
  const stableTargets = new Map();
  const originalOpen = fsp.open;
  let attemptedStablePath = false;
  const translateStablePath = (requestedPath) => {
    for (const [stablePath, actualPath] of stableTargets) {
      if (requestedPath === stablePath) return actualPath;
      if (requestedPath.startsWith(`${stablePath}${path.sep}`)) {
        return path.join(actualPath, path.relative(stablePath, requestedPath));
      }
    }
    return null;
  };
  fsp.open = async (openPath, ...args) => {
    const requestedPath = String(openPath);
    const translatedPath = translateStablePath(requestedPath);
    if (translatedPath) {
      attemptedStablePath = true;
      return originalOpen.call(fsp, translatedPath, ...args);
    }
    return originalOpen.call(fsp, openPath, ...args);
  };
  fileAccess.__test.setOpenedTargetResolverForTest(async (fh, requestedPath) => {
    const translatedPath = translateStablePath(String(requestedPath));
    const actualPath = await fsp.realpath(translatedPath || requestedPath);
    const stablePath = path.join(stablePrefix, String(fh.fd));
    stableTargets.set(stablePath, actualPath);
    return {
      actualPath,
      ioPath: stablePath,
      aclPath: actualPath,
      testFallback: false,
    };
  });
  t.after(() => {
    fsp.open = originalOpen;
  });

  await assert.rejects(
    fileAccess.readLocalImage('1000', document, 'missing.png', first),
    (err) => err.status === 404 && err.reason === 'PATH_NOT_FOUND',
  );
  assert.equal(attemptedStablePath, true);
});

test('rejects an image changed during its single-buffer read', async (t) => {
  const { first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const document = path.join(first, 'readme.md');
  const image = path.join(first, 'changing.png');
  await fsp.writeFile(document, '# document');
  await fsp.writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  mutateDuringFirstRead(t, await fsp.realpath(image));

  await assert.rejects(
    fileAccess.readLocalImage('1000', document, 'changing.png'),
    (err) => err.status === 409 && err.reason === 'RESOURCE_CHANGED_DURING_READ',
  );
});

test('directory and workspace state expose the canonical root for an alias path', async (t) => {
  const { temporary, first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const alias = path.join(temporary, 'workspace-alias');
  await fsp.symlink(first, alias);
  await fsp.writeFile(path.join(first, 'readme.md'), '# document');

  const listing = await fileAccess.listDirectory('1000', alias, {
    includeRootMetadata: true,
  });
  assert.equal(listing.actualPath, await fsp.realpath(first));
  assert.equal(listing.entries[0].path, path.join(await fsp.realpath(first), 'readme.md'));

  const state = await fileAccess.getWorkspaceState('1000', alias);
  assert.equal(state.path, alias);
  assert.equal(state.actualPath, await fsp.realpath(first));
});

test('Markdown state validates access without reading the document body', async (t) => {
  const { first } = await makeFixture(t);
  installAuthorization(t, [first]);
  const document = path.join(first, 'readme.md');
  await fsp.writeFile(document, '# document');

  const state = await fileAccess.getMarkdownState('1000', document);
  assert.equal(state.actualPath, await fsp.realpath(document));
  assert.equal(state.size, Buffer.byteLength('# document'));
  assert.equal(typeof state.mtime, 'number');
  assert.equal(typeof state.ctime, 'number');
  assert.equal(Object.hasOwn(state, 'content'), false);

  await fsp.truncate(document, fileAccess.MAX_FILE_BYTES + 1);
  await assert.rejects(
    fileAccess.getMarkdownState('1000', document),
    (err) => err.status === 413 && err.reason === 'FILE_TOO_LARGE',
  );
});

test('workspace revision changes for nested Markdown and supported image metadata', async (t) => {
  const { first } = await makeFixture(t);
  const queries = [];
  installAuthorization(t, [first], { queries });
  const nested = path.join(first, 'nested');
  await fsp.mkdir(nested);
  const document = path.join(nested, 'notes.md');
  const image = path.join(nested, 'cover.png');
  await fsp.writeFile(document, '# one');
  await fsp.writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const initial = await fileAccess.getWorkspaceState('1000', first);
  const unchanged = await fileAccess.getWorkspaceState('1000', first);
  assert.equal(initial.revision, unchanged.revision);
  assert.equal(initial.fileCount, 1);
  assert.equal(initial.imageCount, 1);
  assert.equal(initial.directoryCount, 1);
  assert.ok(queries.includes(await fsp.realpath(image)));

  await fsp.writeFile(document, '# document changed to a different size');
  const documentChanged = await fileAccess.getWorkspaceState('1000', first);
  assert.notEqual(documentChanged.revision, initial.revision);

  await fsp.writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const imageChanged = await fileAccess.getWorkspaceState('1000', first);
  assert.notEqual(imageChanged.revision, documentChanged.revision);
});

test('workspace state refuses trees deeper than the traversal cap', async (t) => {
  const { first } = await makeFixture(t);
  installAuthorization(t, [first]);
  let current = first;
  for (let index = 0; index < 20; index += 1) {
    current = path.join(current, `d${index}`);
    await fsp.mkdir(current);
  }

  await assert.rejects(
    fileAccess.getWorkspaceState('1000', first),
    (err) => err.reason === 'WORKSPACE_SCAN_LIMIT' && err.status === 413,
  );
});
