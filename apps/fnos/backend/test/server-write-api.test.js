const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const trimApi = require('../src/trim-api');
const fileAccess = require('../src/file-access');
const { app } = require('../src/server');

async function request(
  rawBody,
  headers = {},
  { method = 'PUT', url = '/api/file' } = {},
) {
  const socket = new (require('node:stream').Duplex)({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const req = new http.IncomingMessage(socket);
  const originalRequestEmit = req.emit;
  req.emit = function emitWithoutSyntheticAbort(event, ...args) {
    if (event === 'aborted') return false;
    return originalRequestEmit.call(this, event, ...args);
  };
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'x-trim-userid': '1000',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(rawBody)),
    ...headers,
  };
  const res = new http.ServerResponse(req);
  // IncomingMessage/ServerResponse 在没有真实传输层的测试 socket 上会在异步
  // handler 完成前发出合成 aborted/close。它们不代表客户端断开；
  // 忽略它们，等待路由调用 res.end，才能覆盖包含 fsync 的恢复提交。
  const originalEmit = res.emit;
  res.emit = function emitWithoutSyntheticPrematureClose(event, ...args) {
    if (event === 'close' && !res.finished) return false;
    return originalEmit.call(this, event, ...args);
  };
  const chunks = [];
  res.write = (chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    if (typeof callback === 'function') callback();
    return true;
  };
  const completed = new Promise((resolve) => {
    res.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      res.finished = true;
      if (typeof callback === 'function') callback();
      resolve();
      return res;
    };
  });
  app(req, res);
  req.push(Buffer.from(rawBody));
  req.push(null);
  await completed;
  return {
    status: res.statusCode,
    headers: res.getHeaders(),
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

async function makeRealSaveFixture(t) {
  const temporary = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'flux-reader-server-recovery-'),
  );
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'shared');
  const recovery = path.join(temporary, 'private-recovery');
  const document = path.join(root, 'notes.md');
  await fsp.mkdir(root);
  await fsp.writeFile(document, '# original\n');
  return { root, recovery, document };
}

function installRealAuthorization(t, root, recovery) {
  const originalShared = trimApi.getSharedAccessibleFolders;
  const originalAcl = trimApi.checkUserACL;
  trimApi.getSharedAccessibleFolders = async () => ({ paths: [root] });
  trimApi.checkUserACL = async (_uid, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    return Object.fromEntries(
      list.map((requestedPath) => [
        requestedPath,
        {
          path: requestedPath,
          readable: true,
          writable: true,
          deletable: true,
        },
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
  fileAccess.__test.setRecoveryRootForTest(recovery);
  t.after(() => {
    trimApi.getSharedAccessibleFolders = originalShared;
    trimApi.checkUserACL = originalAcl;
    fileAccess.__test.setOpenedTargetResolverForTest(null);
    fileAccess.__test.setSaveHooksForTest(null);
    fileAccess.__test.setRecoveryRootForTest(null);
  });
}

async function createRecoveryJournal(document) {
  const before = await fileAccess.readMarkdown('1000', document);
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      throw new Error('injected failure after truncate');
    },
  });
  let recoveryId;
  await assert.rejects(
    fileAccess.writeMarkdown('1000', document, '# attempted\n', before.revision),
    (err) => {
      recoveryId = err.recovery?.recoveryId;
      return err.reason === 'SAVE_RECOVERY_REQUIRED' && Boolean(recoveryId);
    },
  );
  fileAccess.__test.setSaveHooksForTest(null);
  return recoveryId;
}

test('PUT /api/file forwards the optimistic save contract and returns metadata', async (t) => {
  const original = fileAccess.writeMarkdown;
  let received;
  let receivedSignalAborted;
  fileAccess.writeMarkdown = async (...args) => {
    received = args;
    receivedSignalAborted = args[4].signal.aborted;
    return {
      content: '# saved',
      actualPath: '/volume/notes.md',
      size: 7,
      mtime: 11,
      ctime: 12,
      revision: 'b'.repeat(64),
    };
  };
  t.after(() => {
    fileAccess.writeMarkdown = original;
  });

  const payload = {
    path: '/volume/notes.md',
    content: '# saved',
    expectedRevision: 'a'.repeat(64),
  };
  const response = await request(JSON.stringify(payload));

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(JSON.parse(response.body), {
    content: '# saved',
    actualPath: '/volume/notes.md',
    size: 7,
    mtime: 11,
    ctime: 12,
    revision: 'b'.repeat(64),
    saveOutcome: {
      contractVersion: 1,
      kind: 'committed',
      snapshot: {
        locator: '/volume/notes.md',
        version: 'b'.repeat(64),
        contentIncluded: false,
        byteCount: 7,
        capabilities: {
          readable: true,
          writable: true,
          supportsCreate: false,
          supportsSaveAs: false,
        },
        implementationSemantics: {
          writeVisibility: 'recoverableInPlace',
          recoveryLocation: 'private',
        },
      },
      recoveryReferences: [],
    },
  });
  assert.deepEqual(received.slice(0, 4), [
    '1000',
    payload.path,
    payload.content,
    payload.expectedRevision,
  ]);
  assert.equal(receivedSignalAborted, false);
});

test('PUT /api/file exposes conflict revision without returning disk content', async (t) => {
  const original = fileAccess.writeMarkdown;
  fileAccess.writeMarkdown = async () => {
    const err = new Error('文稿已被外部修改');
    err.status = 409;
    err.reason = 'FILE_CONFLICT';
    err.currentRevision = 'c'.repeat(64);
    throw err;
  };
  t.after(() => {
    fileAccess.writeMarkdown = original;
  });

  const response = await request(
    JSON.stringify({
      path: '/volume/notes.md',
      content: '# mine',
      expectedRevision: 'a'.repeat(64),
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'FILE_CONFLICT',
    message: '文稿已被外部修改',
    currentRevision: 'c'.repeat(64),
    saveOutcome: {
      contractVersion: 1,
      kind: 'rejected',
      reason: 'conflict',
      currentVersion: 'c'.repeat(64),
    },
  });
});

test('PUT recovery errors expose only opaque recovery metadata', async (t) => {
  const original = fileAccess.writeMarkdown;
  fileAccess.writeMarkdown = async () => {
    const err = new Error('需要恢复');
    err.status = 409;
    err.reason = 'SAVE_RECOVERY_REQUIRED';
    err.recoveryRequired = true;
    err.recovery = {
      available: true,
      recoveryId: 'e'.repeat(48),
      phase: 'recovery-required',
      previousVersion: '/private/secret/baseline.bin',
    };
    throw err;
  };
  t.after(() => {
    fileAccess.writeMarkdown = original;
  });

  const response = await request(
    JSON.stringify({
      path: '/volume/notes.md',
      content: '# mine',
      expectedRevision: 'a'.repeat(64),
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'SAVE_RECOVERY_REQUIRED',
    message: '需要恢复',
    recoveryRequired: true,
    recovery: {
      available: true,
      recoveryId: 'e'.repeat(48),
      phase: 'recovery-required',
    },
    saveOutcome: {
      contractVersion: 1,
      kind: 'recoveryRequired',
      commitState: 'unknown',
      recoveryReferences: [{
        kind: 'privateJournal',
        reference: 'e'.repeat(48),
        phase: 'recovery-required',
      }],
    },
  });
  assert.doesNotMatch(response.body, /private\/secret/u);
});

test('GET and DELETE /api/file-recovery forward opaque recovery contracts', async (t) => {
  const originalState = fileAccess.getRecoveryState;
  const originalRead = fileAccess.readRecoveryVersion;
  const originalDiscard = fileAccess.discardRecovery;
  const recoveryId = 'f'.repeat(48);
  const calls = [];
  fileAccess.getRecoveryState = async (...args) => {
    calls.push(['state', ...args.slice(0, 2)]);
    return { available: true, records: [{ recoveryId, phase: 'recovery-required' }] };
  };
  fileAccess.readRecoveryVersion = async (...args) => {
    calls.push(['read', ...args.slice(0, 4)]);
    return { recoveryId, version: 'baseline', content: '# original', size: 10 };
  };
  fileAccess.discardRecovery = async (...args) => {
    calls.push(['discard', ...args.slice(0, 3)]);
    return { recoveryId, discarded: true };
  };
  t.after(() => {
    fileAccess.getRecoveryState = originalState;
    fileAccess.readRecoveryVersion = originalRead;
    fileAccess.discardRecovery = originalDiscard;
  });

  const encodedPath = encodeURIComponent('/volume/notes.md');
  const state = await request('', {}, {
    method: 'GET',
    url: `/api/file-recovery?path=${encodedPath}`,
  });
  const version = await request('', {}, {
    method: 'GET',
    url: `/api/file-recovery?path=${encodedPath}&recoveryId=${recoveryId}&version=baseline`,
  });
  const discarded = await request('', {}, {
    method: 'DELETE',
    url: `/api/file-recovery?path=${encodedPath}&recoveryId=${recoveryId}`,
  });

  assert.equal(state.status, 200);
  assert.equal(version.status, 200);
  assert.equal(discarded.status, 200);
  assert.equal(JSON.parse(version.body).content, '# original');
  assert.equal(JSON.parse(discarded.body).discarded, true);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ['state', '1000', '/volume/notes.md'],
    ['read', '1000', '/volume/notes.md'],
    ['discard', '1000', '/volume/notes.md'],
  ]);
});

test('recovery commit restores an exact-limit private baseline without sending document bytes through JSON', async (t) => {
  const { root, recovery, document } = await makeRealSaveFixture(t);
  installRealAuthorization(t, root, recovery);
  const initialRecoveryId = await createRecoveryJournal(document);
  const oversizedBaseline = Buffer.alloc(
    fileAccess.MAX_RECOVERY_BASELINE_BYTES,
    0x61,
  );
  await fsp.writeFile(document, oversizedBaseline);
  const inodeBeforeRestore = await fsp.stat(document, { bigint: true });
  const encodedPath = encodeURIComponent(document);

  const stateResponse = await request('', {}, {
    method: 'GET',
    url: `/api/file-state?path=${encodedPath}`,
  });
  assert.equal(stateResponse.status, 200);
  const stateBeforeFailedRestore = JSON.parse(stateResponse.body);
  assert.equal(stateBeforeFailedRestore.size, oversizedBaseline.length);

  // 恢复原始小工件时注入 truncate 后失败，迫使新 journal 把
  // 当前精确达到恢复硬上限的 inode 作为 baseline 私有化。
  fileAccess.__test.setSaveHooksForTest({
    afterTruncate: async () => {
      throw new Error('fail after oversized baseline is journaled');
    },
  });
  const failedRestore = await request(
    JSON.stringify({
      path: document,
      recoveryId: initialRecoveryId,
      version: 'baseline',
      expectedRevision: stateBeforeFailedRestore.revision,
    }),
    {},
    { method: 'POST', url: '/api/file-recovery/commit' },
  );
  assert.equal(failedRestore.status, 409, failedRestore.body);
  const failedBody = JSON.parse(failedRestore.body);
  assert.equal(failedBody.error, 'SAVE_RECOVERY_REQUIRED');
  assert.match(failedBody.recovery?.recoveryId || '', /^[a-f0-9]{48}$/u);
  const oversizedRecoveryId = failedBody.recovery.recoveryId;
  fileAccess.__test.setSaveHooksForTest(null);

  const freshStateResponse = await request('', {}, {
    method: 'GET',
    url: `/api/file-state?path=${encodedPath}`,
  });
  assert.equal(freshStateResponse.status, 200);
  const freshState = JSON.parse(freshStateResponse.body);

  // 只发送不透明 ID/版本/CAS；8 MiB 正文不进入 JSON 请求或响应。
  const restoredResponse = await request(
    JSON.stringify({
      path: document,
      recoveryId: oversizedRecoveryId,
      version: 'baseline',
      expectedRevision: freshState.revision,
    }),
    {},
    { method: 'POST', url: '/api/file-recovery/commit' },
  );

  assert.equal(restoredResponse.status, 200, restoredResponse.body);
  const restored = JSON.parse(restoredResponse.body);
  assert.equal(Object.hasOwn(restored, 'content'), false);
  assert.equal(restored.size, oversizedBaseline.length);
  assert.deepEqual(await fsp.readFile(document), oversizedBaseline);
  const inodeAfterRestore = await fsp.stat(document, { bigint: true });
  assert.equal(inodeAfterRestore.dev, inodeBeforeRestore.dev);
  assert.equal(inodeAfterRestore.ino, inodeBeforeRestore.ino);
});

test('recovery commit fails closed when the current baseline exceeds the recovery hard limit', async (t) => {
  const { root, recovery, document } = await makeRealSaveFixture(t);
  installRealAuthorization(t, root, recovery);
  const recoveryId = await createRecoveryJournal(document);
  await fsp.truncate(document, fileAccess.MAX_RECOVERY_BASELINE_BYTES + 1);
  const inodeBeforeRestore = await fsp.stat(document, { bigint: true });
  const encodedPath = encodeURIComponent(document);

  const stateResponse = await request('', {}, {
    method: 'GET',
    url: `/api/file-state?path=${encodedPath}`,
  });
  assert.equal(stateResponse.status, 200);
  const freshState = JSON.parse(stateResponse.body);

  const restoreResponse = await request(
    JSON.stringify({
      path: document,
      recoveryId,
      version: 'baseline',
      expectedRevision: freshState.revision,
    }),
    {},
    { method: 'POST', url: '/api/file-recovery/commit' },
  );

  assert.equal(restoreResponse.status, 413);
  assert.equal(
    JSON.parse(restoreResponse.body).error,
    'RECOVERY_BASELINE_TOO_LARGE',
  );
  const inodeAfterRestore = await fsp.stat(document, { bigint: true });
  assert.equal(inodeAfterRestore.dev, inodeBeforeRestore.dev);
  assert.equal(inodeAfterRestore.ino, inodeBeforeRestore.ino);
  assert.equal(
    inodeAfterRestore.size,
    BigInt(fileAccess.MAX_RECOVERY_BASELINE_BYTES + 1),
  );
});

test('JSON limit accepts a near-10MiB Markdown body even when escaping doubles it', async (t) => {
  const original = fileAccess.writeMarkdown;
  let decodedBytes = 0;
  fileAccess.writeMarkdown = async (_uid, documentPath, content) => {
    decodedBytes = Buffer.byteLength(content);
    return {
      content: '',
      actualPath: documentPath,
      size: decodedBytes,
      mtime: 1,
      ctime: 1,
      revision: 'd'.repeat(64),
    };
  };
  t.after(() => {
    fileAccess.writeMarkdown = original;
  });
  const content = '\\'.repeat(fileAccess.MAX_FILE_BYTES - 128);
  const rawBody = JSON.stringify({
    path: '/volume/notes.md',
    content,
    expectedRevision: 'a'.repeat(64),
  });
  assert.ok(Buffer.byteLength(rawBody) > fileAccess.MAX_FILE_BYTES);

  const response = await request(rawBody);

  assert.equal(response.status, 200);
  assert.equal(decodedBytes, fileAccess.MAX_FILE_BYTES - 128);
});

test('decoded Markdown over 10MiB reaches business validation and returns FILE_TOO_LARGE', async () => {
  const response = await request(
    JSON.stringify({
      path: '/volume/notes.md',
      content: 'x'.repeat(fileAccess.MAX_FILE_BYTES + 1),
      expectedRevision: 'a'.repeat(64),
    }),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'FILE_TOO_LARGE',
    message: '文件过大，保存上限为 10 MiB',
    saveOutcome: {
      contractVersion: 1,
      kind: 'rejected',
      reason: 'tooLarge',
    },
  });
});

test('JSON parser rejects oversized save requests with a machine-readable error', async (t) => {
  const response = await request(
    JSON.stringify({
      path: '/volume/notes.md',
      content: 'x'.repeat(fileAccess.MAX_SAVE_REQUEST_BYTES),
      expectedRevision: 'a'.repeat(64),
    }),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'REQUEST_TOO_LARGE',
    message: '请求体过大，Markdown 内容上限为 10 MiB',
  });
});
