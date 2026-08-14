/**
 * flux-reader 后端服务。
 *
 * 两种监听模式（靠环境变量切换，本地开发与线上共用同一份代码）：
 *   本地开发：PORT=5178          → TCP 端口
 *   装到 fnOS：SOCKET_PATH=...   → Unix Socket（统一网关转发到这里）
 *
 * 统一网关会在转发前校验登录态，并注入 x-trim-userid Header。
 * 但请记住：网关只保证「有人登录了」，业务鉴权仍需自己做。
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const trimApi = require('./trim-api');
const fileAccess = require('./file-access');
const {
  committedSaveOutcome,
  failedSaveOutcome,
} = require('./safe-save-contract');

const APP_NAME = process.env.TRIM_APPNAME || 'flux-reader';
const BASE_PATH = `/app/${APP_NAME}`;
const SOCKET_PATH = process.env.SOCKET_PATH;
const PORT = Number(process.env.PORT) || 5178;
// 前端静态产物目录。构建时放在 server/public（与 src/ 同级），
// 因此从 __dirname(=src/) 上跳一级；本地开发若无此目录则跳过静态托管。
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: fileAccess.MAX_SAVE_REQUEST_BYTES, strict: true }));

/**
 * 取当前登录用户 uid。
 * 网关注入 x-trim-userid；本地开发无此 Header 时降级为 local 标识。
 * 即使来源是网关 Header，也做字符白名单清洗后才使用。
 */
function getUserId(req) {
  const raw = req.headers['x-trim-userid'];
  if (!raw) return null;
  return String(raw).replace(/[^0-9]/g, '') || null;
}

function requireUser(req, res, next) {
  const uid = getUserId(req);
  if (!uid) {
    // 本地开发模式下没有网关，给出明确提示而不是静默通过
    if (!trimApi.isAvailable()) {
      return res.status(503).json({
        error: 'LOCAL_DEV_NO_GATEWAY',
        message:
          '当前不在 fnOS 环境中（无网关 Header、无 TRIM_API_TOKEN）。文件接口需安装到 NAS 后使用。',
      });
    }
    return res.status(401).json({ error: 'NO_USER', message: '未获取到登录用户身份' });
  }
  req.uid = uid;
  next();
}

function abortWhenResponseCloses(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnPrematureClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortOnPrematureClose);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener('aborted', abort);
      res.removeListener('close', abortOnPrematureClose);
    },
  };
}

function publicRecoveryInfo(recovery) {
  if (!recovery || typeof recovery !== 'object') return null;
  const recoveryId =
    typeof recovery.recoveryId === 'string' &&
    /^[a-f0-9]{48}$/u.test(recovery.recoveryId)
      ? recovery.recoveryId
      : null;
  return {
    available: recovery.available !== false,
    ...(recoveryId ? { recoveryId } : {}),
    ...(typeof recovery.phase === 'string' ? { phase: recovery.phase } : {}),
  };
}

const api = express.Router();

/** 运行环境自检，前端首屏调用以决定 UI 形态 */
api.get('/env', (req, res) => {
  res.json({
    appName: APP_NAME,
    basePath: BASE_PATH,
    openApiAvailable: trimApi.isAvailable(),
    uid: getUserId(req),
    mode: SOCKET_PATH ? 'socket' : 'port',
    platform: 'fnos',
    capabilitySchemaVersion: 1,
    capabilities: {
      nativeDialog: true,
      sessionScopedAuthorization: false,
      requestCancellation: true,
      workspaceSearch: true,
      safeSave: true,
      recovery: true,
      localResources: true,
      fileWatching: false,
      safeSaveSemantics: {
        writeVisibility: 'inPlaceWithReadBarrier',
        recoveryLocation: 'applicationPrivateStorage',
      },
      recoveryPolicy: {
        cleanupMode: 'automaticAfterCommit',
      },
    },
    policy: {
      maxEditableDocumentBytes: fileAccess.MAX_FILE_BYTES,
      maxLocalImageBytes: fileAccess.MAX_IMAGE_BYTES,
      maxWorkspaces: 8,
      maxDocumentTabs: 12,
    },
  });
});

/** 应用设置已授权且当前用户可读的根目录列表（诊断/兼容接口） */
api.get('/roots', requireUser, async (req, res) => {
  try {
    const language = String(req.query.language || 'zh-CN');
    const roots = await fileAccess.getAuthorizedRoots(req.uid, language);
    res.json({ roots });
  } catch (err) {
    // 这里的错误必须透出去。曾经因返回值解析漏了字段而静默得到空列表，
    // 前端显示「尚未授权任何文件夹」，与真的没授权无法区分，极难排查。
    res.status(err.status || 500).json({
      error: err.reason || 'ROOTS_FAILED',
      message: err.message,
    });
  }
});

/** 列目录 */
api.get('/list', requireUser, async (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: 'MISSING_PATH', message: '缺少 path 参数' });
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    res.json(await fileAccess.listDirectory(req.uid, String(dir), {
      includeRootMetadata: true,
      signal: requestLifetime.signal,
    }));
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    res.status(err.status || 500).json({ error: err.reason || 'LIST_FAILED', message: err.message });
  } finally {
    requestLifetime.cleanup();
  }
});

/** 读取 md 内容 —— 阅读器主接口 */
api.get('/file', requireUser, async (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'MISSING_PATH', message: '缺少 path 参数' });
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    const result = await fileAccess.readMarkdown(req.uid, String(p), {
      signal: requestLifetime.signal,
    });
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    res.status(err.status || 500).json({ error: err.reason || 'READ_FAILED', message: err.message });
  } finally {
    requestLifetime.cleanup();
  }
});

/**
 * 乐观并发保存。expectedRevision 必须来自最近一次 GET /file；
 * 后端在稳定 target/parent fd 上重验共享授权、用户 ACL 和版本后再提交。
 */
api.put('/file', requireUser, async (req, res) => {
  const { path: documentPath, content, expectedRevision } = req.body || {};
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    const result = await fileAccess.writeMarkdown(
      req.uid,
      documentPath,
      content,
      expectedRevision,
      { signal: requestLifetime.signal },
    );
    res.set('Cache-Control', 'private, no-store');
    res.json({
      ...result,
      saveOutcome: committedSaveOutcome(result, { locator: documentPath }),
    });
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    const recovery = publicRecoveryInfo(err.recovery);
    res.status(err.status || 500).json({
      error: err.reason || 'SAVE_FAILED',
      message: err.message,
      ...(err.currentRevision ? { currentRevision: err.currentRevision } : {}),
      ...(err.recoveryRequired ? { recoveryRequired: true } : {}),
      ...(recovery ? { recovery } : {}),
      saveOutcome: failedSaveOutcome(err, { publicRecovery: recovery }),
    });
  } finally {
    requestLifetime.cleanup();
  }
});

/**
 * 私有恢复工件只通过 opaque recoveryId 访问。每次列举/读取/丢弃都会重新
 * 校验当前共享授权根和当前 uid ACL，HTTP 响应从不暴露服务端真实路径。
 */
api.get('/file-recovery', requireUser, async (req, res) => {
  const documentPath = req.query.path;
  if (!documentPath) {
    return res.status(400).json({ error: 'MISSING_PATH', message: '缺少 path 参数' });
  }
  const recoveryId = req.query.recoveryId;
  const version = req.query.version;
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    const result = recoveryId || version
      ? await fileAccess.readRecoveryVersion(
          req.uid,
          String(documentPath),
          String(recoveryId || ''),
          String(version || ''),
          { signal: requestLifetime.signal },
        )
      : await fileAccess.getRecoveryState(req.uid, String(documentPath), {
          signal: requestLifetime.signal,
        });
    res.set('Cache-Control', 'private, no-store');
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    res.status(err.status || 500).json({
      error: err.reason || 'RECOVERY_READ_FAILED',
      message: err.message,
    });
  } finally {
    requestLifetime.cleanup();
  }
});

/**
 * 在服务端提交私有恢复版本。正文不经过 JSON，也不放宽普通编辑的 10 MiB
 * 上限；后端以 fresh expectedRevision 做同一套 ACL/path/inode CAS 与 journal。
 */
api.post('/file-recovery/commit', requireUser, async (req, res) => {
  const {
    path: documentPath,
    recoveryId,
    version,
    expectedRevision,
  } = req.body || {};
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    const result = await fileAccess.commitRecoveryVersion(
      req.uid,
      documentPath,
      recoveryId,
      version,
      expectedRevision,
      { signal: requestLifetime.signal },
    );
    res.set('Cache-Control', 'private, no-store');
    res.json({
      ...result,
      saveOutcome: committedSaveOutcome(result, { locator: documentPath }),
    });
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    const recovery = publicRecoveryInfo(err.recovery);
    res.status(err.status || 500).json({
      error: err.reason || 'RECOVERY_COMMIT_FAILED',
      message: err.message,
      ...(err.currentRevision ? { currentRevision: err.currentRevision } : {}),
      ...(err.recoveryRequired ? { recoveryRequired: true } : {}),
      ...(recovery ? { recovery } : {}),
      saveOutcome: failedSaveOutcome(err, { publicRecovery: recovery }),
    });
  } finally {
    requestLifetime.cleanup();
  }
});

api.delete('/file-recovery', requireUser, async (req, res) => {
  const documentPath = req.query.path;
  const recoveryId = req.query.recoveryId;
  if (!documentPath || !recoveryId) {
    return res.status(400).json({
      error: 'MISSING_RECOVERY_ARGUMENT',
      message: '缺少 path 或 recoveryId 参数',
    });
  }
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    const result = await fileAccess.discardRecovery(
      req.uid,
      String(documentPath),
      String(recoveryId),
      { signal: requestLifetime.signal },
    );
    res.set('Cache-Control', 'private, no-store');
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    res.status(err.status || 500).json({
      error: err.reason || 'RECOVERY_DISCARD_FAILED',
      message: err.message,
    });
  } finally {
    requestLifetime.cleanup();
  }
});

/** 只读取 Markdown 元数据，供最近文稿重验和自动刷新探测。 */
api.get('/file-state', requireUser, async (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'MISSING_PATH', message: '缺少 path 参数' });
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    res.json(await fileAccess.getMarkdownState(req.uid, String(p), {
      signal: requestLifetime.signal,
    }));
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    res.status(err.status || 500).json({
      error: err.reason || 'FILE_STATE_FAILED',
      message: err.message,
    });
  } finally {
    requestLifetime.cleanup();
  }
});

/** 在一个或多个显式选择的工作区内搜索文件名与 Markdown 正文。 */
api.get('/search', requireUser, async (req, res) => {
  const rawPaths = req.query.path;
  if (!rawPaths) {
    return res.status(400).json({ error: 'MISSING_PATH', message: '缺少 path 参数' });
  }
  const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).map(String);
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    const result = await fileAccess.searchMarkdown(
      req.uid,
      paths,
      String(req.query.q || ''),
      req.query.limit,
      { signal: requestLifetime.signal },
    );
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    res.status(err.status || 500).json({
      error: err.reason || 'SEARCH_FAILED',
      message: err.message,
    });
  } finally {
    requestLifetime.cleanup();
  }
});

/**
 * Markdown 本地相对图片。v 参数由前端用作文稿 revision cache-buster，
 * 后端无需参与寻址；响应仍禁用缓存，避免跨权限/版本复用。
 */
api.get('/resource', requireUser, async (req, res) => {
  const document = req.query.document;
  const resourcePath = req.query.path;
  if (!document || !resourcePath) {
    return res.status(400).json({
      error: 'MISSING_RESOURCE_PATH',
      message: '缺少 document 或 path 参数',
    });
  }
  try {
    const resource = await fileAccess.readLocalImage(
      req.uid,
      String(document),
      String(resourcePath),
      req.query.workspace ? String(req.query.workspace) : null,
    );
    res.set({
      'Cache-Control': 'private, no-store',
      'Content-Type': resource.mimeType,
      'Content-Length': String(resource.size),
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(resource.data);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.reason || 'RESOURCE_FAILED',
      message: err.message,
    });
  }
});

/** 递归可见 Markdown/图片树的轻量 revision，供前端轮询自动刷新。 */
api.get('/workspace-state', requireUser, async (req, res) => {
  const workspacePath = req.query.path;
  if (!workspacePath) {
    return res.status(400).json({ error: 'MISSING_PATH', message: '缺少 path 参数' });
  }
  const requestLifetime = abortWhenResponseCloses(req, res);
  try {
    res.json(await fileAccess.getWorkspaceState(
      req.uid,
      String(workspacePath),
      { signal: requestLifetime.signal },
    ));
  } catch (err) {
    if (err.name === 'AbortError' && requestLifetime.signal.aborted) return;
    res.status(err.status || 500).json({
      error: err.reason || 'WORKSPACE_STATE_FAILED',
      message: err.message,
    });
  } finally {
    requestLifetime.cleanup();
  }
});

// 同时挂到网关前缀与根路径，本地开发与线上都能用同一套前端代码
app.use(`${BASE_PATH}/api`, api);
app.use('/api', api);

// 静态资源
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(BASE_PATH, express.static(PUBLIC_DIR));
  app.use('/', express.static(PUBLIC_DIR));
  // SPA 兜底
  app.get(/^(?!\/(app\/[^/]+\/)?api\/).*/, (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

// JSON 解析错误必须保持机器可读；默认 Express 会返回 HTML。
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'REQUEST_TOO_LARGE',
      message: `请求体过大，Markdown 内容上限为 ${fileAccess.MAX_FILE_BYTES / 1024 / 1024} MiB`,
    });
  }
  if (err instanceof SyntaxError && err?.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'INVALID_JSON',
      message: '请求体不是有效 JSON',
    });
  }
  return next(err);
});

const SHUTDOWN_TIMEOUT_MS = 8_000;
let activeServer = null;
let activeSocketPath = null;
let shutdownPromise = null;

function start({ socketPath = SOCKET_PATH, port = PORT } = {}) {
  if (activeServer) return activeServer;

  if (socketPath) {
    // 复用前先清理残留 socket 文件，否则 EADDRINUSE
    fs.rmSync(socketPath, { force: true });
    activeSocketPath = socketPath;
    activeServer = app.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o660);
      } catch {
        // 权限调整失败不阻塞启动
      }
      console.log(`[flux-reader] listening on unix socket ${socketPath}`);
    });
  } else {
    activeSocketPath = null;
    activeServer = app.listen(port, () => {
      const address = activeServer.address();
      const listeningPort =
        address && typeof address === 'object' ? address.port : port;
      console.log(
        `[flux-reader] listening on http://127.0.0.1:${listeningPort}${BASE_PATH}`,
      );
    });
  }
  activeServer.once('close', () => {
    activeServer = null;
  });
  fileAccess.cleanupExpiredRecoveries().catch((err) => {
    console.error(`[flux-reader] recovery cleanup skipped: ${err.message}`);
  });
  return activeServer;
}

function shutdown(signal, { timeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
  if (shutdownPromise) return shutdownPromise;
  console.log(`[flux-reader] received ${signal}, draining active requests`);
  const server = activeServer;
  const socketPath = activeSocketPath;
  shutdownPromise = new Promise((resolve) => {
    let finished = false;
    const finish = (timedOut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socketPath) fs.rmSync(socketPath, { force: true });
      activeSocketPath = null;
      resolve({ timedOut });
    };
    const timer = setTimeout(() => {
      // cmd/main 在 10 秒后会 SIGKILL；8 秒时关闭连接并退出，写事务若仍未
      // 完成，其 writing-phase journal 已在 truncate 前 fsync，可供恢复。
      server?.closeAllConnections?.();
      finish(true);
    }, timeoutMs);
    timer.unref?.();

    if (!server) {
      finish(false);
      return;
    }
    server.close(() => finish(false));
  });
  const pending = shutdownPromise;
  void pending.finally(() => {
    if (shutdownPromise === pending) shutdownPromise = null;
  });
  return shutdownPromise;
}

function setActiveServerForTest(server, socketPath = null) {
  if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    throw new Error('active server 只能在测试环境注入');
  }
  activeServer = server || null;
  activeSocketPath = socketPath;
  shutdownPromise = null;
}

if (require.main === module) {
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0));
  });
  start();
}


module.exports = {
  app,
  start,
  shutdown,
  __test: { setActiveServerForTest },
};
