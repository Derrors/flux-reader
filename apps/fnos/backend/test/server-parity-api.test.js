const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');

const fileAccess = require('../src/file-access');
const { app } = require('../src/server');

async function invoke(url, { afterStart } = {}) {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const request = new http.IncomingMessage(socket);
  request.method = 'GET';
  request.url = url;
  request.headers = { host: 'localhost', 'x-trim-userid': '1000' };
  const response = new http.ServerResponse(request);
  const chunks = [];
  response.write = (chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    if (typeof callback === 'function') callback();
    return true;
  };
  const completed = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    response.once('close', finish);
    response.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      response.finished = true;
      if (typeof callback === 'function') callback();
      finish();
      return response;
    };
  });
  app(request, response);
  afterStart?.({ request, response });
  await completed;
  return {
    status: response.statusCode,
    headers: response.getHeaders(),
    body: Buffer.concat(chunks),
  };
}

test('env exposes the versioned fnOS capability and product policy contract', async () => {
  const response = await invoke('/api/env');
  assert.equal(response.status, 200);
  const environment = JSON.parse(response.body.toString('utf8'));
  assert.equal(environment.platform, 'fnos');
  assert.equal(environment.capabilitySchemaVersion, 1);
  assert.equal(environment.capabilities.safeSave, true);
  assert.equal(environment.capabilities.sessionScopedAuthorization, false);
  assert.equal(environment.capabilities.fileWatching, false);
  assert.equal(environment.policy.maxEditableDocumentBytes, fileAccess.MAX_FILE_BYTES);
  assert.equal(environment.policy.maxLocalImageBytes, fileAccess.MAX_IMAGE_BYTES);
  assert.equal(environment.policy.maxWorkspaces, 8);
  assert.equal(environment.policy.maxDocumentTabs, 12);
});

test('list API exposes the canonical directory path with its entries', async (t) => {
  const original = fileAccess.listDirectory;
  let received;
  fileAccess.listDirectory = async (...args) => {
    received = args;
    return {
      actualPath: '/volume/docs',
      entries: [{ path: '/volume/docs/readme.md', name: 'readme.md', type: 'file' }],
    };
  };
  t.after(() => {
    fileAccess.listDirectory = original;
  });

  const response = await invoke('/api/list?path=%2Fvolume%2Falias');

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), {
    actualPath: '/volume/docs',
    entries: [{ path: '/volume/docs/readme.md', name: 'readme.md', type: 'file' }],
  });
  assert.equal(received[0], '1000');
  assert.equal(received[1], '/volume/alias');
  assert.equal(received[2].includeRootMetadata, true);
  assert.equal(received[2].signal.aborted, false);
});

test('file-state API returns metadata without a document body', async (t) => {
  const original = fileAccess.getMarkdownState;
  let received;
  fileAccess.getMarkdownState = async (...args) => {
    received = args;
    return { actualPath: '/volume/readme.md', size: 12, mtime: 34, ctime: 56 };
  };
  t.after(() => {
    fileAccess.getMarkdownState = original;
  });

  const response = await invoke('/api/file-state?path=%2Fvolume%2Falias.md');

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), {
    actualPath: '/volume/readme.md',
    size: 12,
    mtime: 34,
    ctime: 56,
  });
  assert.deepEqual(received.slice(0, 2), ['1000', '/volume/alias.md']);
  assert.equal(received[2].signal.aborted, false);
});

test('file API forwards a live request signal to the Markdown reader', async (t) => {
  const original = fileAccess.readMarkdown;
  let received;
  fileAccess.readMarkdown = async (...args) => {
    received = args;
    return {
      content: '# document',
      actualPath: '/volume/readme.md',
      size: 10,
      revision: 'a'.repeat(64),
    };
  };
  t.after(() => {
    fileAccess.readMarkdown = original;
  });

  const response = await invoke('/api/file?path=%2Fvolume%2Falias.md');

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body.toString('utf8')).content, '# document');
  assert.deepEqual(received.slice(0, 2), ['1000', '/volume/alias.md']);
  assert.equal(received[2].signal.aborted, false);
});

test('search API accepts repeated selected workspace paths', async (t) => {
  const original = fileAccess.searchMarkdown;
  let received;
  fileAccess.searchMarkdown = async (...args) => {
    received = args;
    return { results: [], scannedFiles: 0, truncated: false };
  };
  t.after(() => {
    fileAccess.searchMarkdown = original;
  });

  const url = new URL('http://localhost/api/search');
  url.searchParams.append('path', '/volume/first');
  url.searchParams.append('path', '/volume/second');
  url.searchParams.set('q', 'needle');
  url.searchParams.set('limit', '25');
  const response = await invoke(`${url.pathname}${url.search}`);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), {
    results: [],
    scannedFiles: 0,
    truncated: false,
  });
  assert.deepEqual(received.slice(0, 4), [
    '1000',
    ['/volume/first', '/volume/second'],
    'needle',
    '25',
  ]);
  assert.equal(received[4].signal.aborted, false);
});

test('search API aborts backend work when the response closes early', async (t) => {
  const original = fileAccess.searchMarkdown;
  let observedSignal;
  fileAccess.searchMarkdown = async (_uid, _paths, _query, _limit, { signal }) => {
    observedSignal = signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        },
        { once: true },
      );
    });
  };
  t.after(() => {
    fileAccess.searchMarkdown = original;
  });

  const response = await invoke('/api/search?path=%2Fvolume&q=needle', {
    afterStart: ({ response: pendingResponse }) => pendingResponse.emit('close'),
  });
  assert.equal(observedSignal.aborted, true);
  assert.equal(response.body.length, 0);
});

for (const entry of [
  {
    label: 'file',
    method: 'readMarkdown',
    url: '/api/file?path=%2Fvolume%2Freadme.md',
  },
  {
    label: 'file-state',
    method: 'getMarkdownState',
    url: '/api/file-state?path=%2Fvolume%2Freadme.md',
  },
]) {
  test(`${entry.label} API aborts file access when the response closes early`, async (t) => {
    const original = fileAccess[entry.method];
    let observedSignal;
    fileAccess[entry.method] = async (...args) => {
      observedSignal = args.at(-1).signal;
      await new Promise((resolve, reject) => {
        observedSignal.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    };
    t.after(() => {
      fileAccess[entry.method] = original;
    });

    const response = await invoke(entry.url, {
      afterStart: ({ response: pendingResponse }) => pendingResponse.emit('close'),
    });
    assert.equal(observedSignal.aborted, true);
    assert.equal(response.body.length, 0);
  });
}

for (const entry of [
  {
    label: 'list',
    method: 'listDirectory',
    url: '/api/list?path=%2Fvolume',
  },
  {
    label: 'workspace-state',
    method: 'getWorkspaceState',
    url: '/api/workspace-state?path=%2Fvolume',
  },
]) {
  test(`${entry.label} API aborts recursive file access when the response closes early`, async (t) => {
    const original = fileAccess[entry.method];
    let observedSignal;
    fileAccess[entry.method] = async (...args) => {
      observedSignal = args.at(-1).signal;
      await new Promise((resolve, reject) => {
        observedSignal.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    };
    t.after(() => {
      fileAccess[entry.method] = original;
    });

    const response = await invoke(entry.url, {
      afterStart: ({ response: pendingResponse }) => pendingResponse.emit('close'),
    });
    assert.equal(observedSignal.aborted, true);
    assert.equal(response.body.length, 0);
  });
}

test('resource API accepts cache-buster and returns non-cacheable nosniff bytes', async (t) => {
  const original = fileAccess.readLocalImage;
  let received;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fileAccess.readLocalImage = async (...args) => {
    received = args;
    return { data: png, mimeType: 'image/png', size: png.length, mtime: 123 };
  };
  t.after(() => {
    fileAccess.readLocalImage = original;
  });

  const url = new URL('http://localhost/api/resource');
  url.searchParams.set('document', '/volume/docs/readme.md');
  url.searchParams.set('path', '../images/cover.png');
  url.searchParams.set('workspace', '/volume');
  url.searchParams.set('v', '456');
  const response = await invoke(`${url.pathname}${url.search}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(response.body, png);
  assert.deepEqual(received, [
    '1000',
    '/volume/docs/readme.md',
    '../images/cover.png',
    '/volume',
  ]);
});

test('workspace-state API exposes an opaque recursive revision', async (t) => {
  const original = fileAccess.getWorkspaceState;
  let received;
  fileAccess.getWorkspaceState = async (...args) => {
    received = args;
    return {
      path: '/volume/docs',
      actualPath: '/volume/docs',
      revision: 'abc123',
      fileCount: 2,
      imageCount: 1,
      directoryCount: 3,
      generatedAt: 42,
    };
  };
  t.after(() => {
    fileAccess.getWorkspaceState = original;
  });

  const response = await invoke('/api/workspace-state?path=%2Fvolume%2Fdocs');
  assert.equal(response.status, 200);
  assert.deepEqual(
    JSON.parse(response.body.toString('utf8')),
    {
      path: '/volume/docs',
      actualPath: '/volume/docs',
      revision: 'abc123',
      fileCount: 2,
      imageCount: 1,
      directoryCount: 3,
      generatedAt: 42,
    },
  );
  assert.equal(received[0], '1000');
  assert.equal(received[1], '/volume/docs');
  assert.equal(received[2].signal.aborted, false);
});
