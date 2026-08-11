import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fnosRoot = path.join(packageRoot, 'dist-contract-fnos');
const macosRoot = path.join(packageRoot, 'dist-contract-macos');
const manifest = JSON.parse(await readFile(
  path.join(packageRoot, 'test/fixtures/render-contract/manifest.json'),
  'utf8',
));

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resolveChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known CI/development installation path.
    }
  }
  throw new Error('Chromium executable not found; set CHROME_BIN to its absolute path');
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(2_000).then(() => false),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  await Promise.race([exited, delay(2_000)]);
}

function staticTarget(requestURL) {
  const url = new URL(requestURL, 'http://127.0.0.1');
  const routes = [
    ['/app/flux-reader/', fnosRoot, 'index.html'],
    ['/macos/', macosRoot, 'macos.html'],
  ];
  for (const [prefix, root, indexFile] of routes) {
    if (!url.pathname.startsWith(prefix)) continue;
    let relative;
    try {
      relative = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return null;
    }
    const requested = relative || indexFile;
    const resolved = path.resolve(root, requested);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    return resolved;
  }
  return null;
}

async function createStaticServer() {
  const server = createServer(async (request, response) => {
    const target = staticTarget(request.url || '/');
    if (!target) {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      const metadata = await stat(target);
      const file = metadata.isDirectory() ? path.join(target, 'index.html') : target;
      const body = await readFile(file);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentTypes.get(path.extname(file)) || 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

class DevToolsPipe {
  constructor(child) {
    this.child = child;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    child.stdio[4].on('data', (chunk) => this.receive(chunk));
    child.once('exit', (code, signal) => {
      const error = new Error(`Chromium exited early (code=${code}, signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const boundary = this.buffer.indexOf(0);
      if (boundary < 0) return;
      const payload = this.buffer.subarray(0, boundary).toString('utf8');
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!payload) continue;
      const message = JSON.parse(payload);
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result || {});
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.child.stdio[3].write(`${JSON.stringify(message)}\0`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return response.result?.value;
}

async function waitForContract(cdp, sessionId, expected, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const snapshot = await evaluate(cdp, sessionId, `(() => ({
        href: location.href,
        state: document.documentElement.dataset.renderContractState || null,
        entry: document.documentElement.dataset.renderContractEntry || null,
        file: document.documentElement.dataset.renderContractCase || null,
        result: globalThis.__FLUX_READER_RENDER_CONTRACT__ || null
      }))()`);
      if (
        snapshot?.href === expected.url
        && snapshot.entry === expected.entry
        && snapshot.file === expected.file
        && ['passed', 'failed'].includes(snapshot.state)
      ) {
        if (snapshot.state === 'passed' && snapshot.result?.failures?.length === 0) {
          return snapshot.result;
        }
        const dom = await evaluate(
          cdp,
          sessionId,
          'document.documentElement.outerHTML.slice(0, 12000)',
        );
        throw new Error(
          `${expected.entry}/${expected.file}: ${JSON.stringify(snapshot.result)}\n${dom}`,
        );
      }
    } catch (error) {
      // A navigation briefly destroys the previous execution context. Retry
      // those transient evaluation failures, but surface a completed contract
      // failure immediately.
      if (String(error.message).startsWith(`${expected.entry}/${expected.file}:`)) throw error;
    }
    await delay(50);
  }
  throw new Error(`${expected.entry}/${expected.file}: timed out waiting for contract state`);
}

const server = await createStaticServer();
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const profileDirectory = await mkdtemp(path.join(tmpdir(), 'flux-reader-contract-'));
const chromeBinary = await resolveChromeBinary();
const stderr = [];
const chrome = spawn(chromeBinary, [
  '--headless=new',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-gpu',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-proxy-server',
  '--remote-debugging-pipe',
  `--user-data-dir=${profileDirectory}`,
  'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
});
chrome.stderr.on('data', (chunk) => {
  stderr.push(chunk.toString('utf8'));
  if (stderr.length > 20) stderr.shift();
});

let exitCode = 0;
try {
  console.log('Starting Chromium DevTools pipe…');
  const cdp = new DevToolsPipe(chrome);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const entries = [
    { entry: 'fnos', path: '/app/flux-reader/index.html' },
    { entry: 'macos', path: '/macos/macos.html' },
  ];
  let passed = 0;
  for (const entry of entries) {
    for (const contractCase of manifest.cases) {
      const url = `${origin}${entry.path}?case=${encodeURIComponent(contractCase.file)}`;
      process.stdout.write(`Checking ${entry.entry}/${contractCase.file}… `);
      await cdp.send('Page.navigate', { url }, sessionId);
      await waitForContract(cdp, sessionId, {
        url,
        entry: entry.entry,
        file: contractCase.file,
      });
      passed += 1;
      console.log('passed');
    }
  }
  console.log(`Chromium render contract: ${passed} entry/case combinations passed.`);
  await cdp.send('Browser.close').catch(() => {});
} catch (error) {
  exitCode = 1;
  console.error(error.stack || error.message || error);
  if (stderr.length) console.error(stderr.join('').slice(-12_000));
} finally {
  await stopChild(chrome);
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  try {
    await rm(profileDirectory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150,
    });
  } catch (error) {
    // Chrome helpers can briefly keep profile files busy after the browser
    // process exits. A best-effort cleanup must not turn passed contracts into
    // a failed CI run; hosted runners discard their temporary directory.
    console.warn(`Unable to remove Chromium profile ${profileDirectory}: ${error.message}`);
  }
}

process.exitCode = exitCode;
