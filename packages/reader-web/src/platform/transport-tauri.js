export const TAURI_TRANSPORT_COMMAND = 'reader_transport_request';
export const TAURI_TRANSPORT_CANCEL_COMMAND = 'reader_transport_cancel';
export const TAURI_FILE_CHANGED_EVENT = 'flux-reader:file-changed';

const LOCAL_RESOURCE_ORIGIN = 'http://flux-reader-resource.localhost';

let requestSequence = 0;

function nextRequestId() {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `webview-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('请求已取消', 'AbortError');
  }
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

function normalizeInvokeError(value) {
  if (value?.name === 'AbortError') return value;
  const details = value && typeof value === 'object' ? value : null;
  const message = typeof value === 'string'
    ? value
    : details?.message || 'Tauri 文件服务调用失败';
  const err = new Error(message);
  if (details) {
    err.code = details.error ?? details.code;
    err.status = details.status;
    err.details = details.details ?? details;
  }
  return err;
}

function publicTauriInvoke(scope = globalThis) {
  const core = scope.__TAURI__?.core;
  return typeof core?.invoke === 'function' ? core.invoke.bind(core) : null;
}

function publicTauriListen(scope = globalThis) {
  const getCurrentWindow = scope.__TAURI__?.webviewWindow?.getCurrentWebviewWindow;
  if (typeof getCurrentWindow !== 'function') return null;
  const currentWindow = getCurrentWindow();
  // 不能使用 event.listen 的 Any target；多 WebView 时它会收到其他窗口的定向事件。
  return typeof currentWindow?.listen === 'function'
    ? currentWindow.listen.bind(currentWindow)
    : null;
}

export function hasTauriInvoke(scope = globalThis) {
  return publicTauriInvoke(scope) !== null;
}

function normalizeQuery(params) {
  if (!params || typeof params !== 'object') return {};
  return Object.fromEntries(Object.entries(params).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return [[key, value.filter((item) => item != null).map(String)]];
    }
    return value == null ? [] : [[key, String(value)]];
  }));
}

function isAbsoluteFileLocator(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  if (value.startsWith('/')) return true;
  return /^[a-z]:\//i.test(value);
}

function resourceUrl(documentPath, resourcePath, workspacePath, revision) {
  const document = typeof documentPath === 'string' ? documentPath : '';
  const resource = String(resourcePath || '').trim();
  const workspace = typeof workspacePath === 'string' ? workspacePath : '';
  if (
    !isAbsoluteFileLocator(document)
    || document.length > 4096
    || !/\.(?:md|markdown|mdx)$/i.test(document)
  ) return null;
  if (
    !resource
    || resource.length > 4096
    || resource.startsWith('//')
    || resource.includes('\\')
    || resource.includes('\0')
    || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(resource)
  ) {
    return null;
  }
  if (workspace && (!isAbsoluteFileLocator(workspace) || workspace.length > 4096)) return null;

  const url = new URL('/image', LOCAL_RESOURCE_ORIGIN);
  url.searchParams.set('document', document);
  url.searchParams.set('path', resource);
  if (workspace) url.searchParams.set('workspace', workspace);
  if (revision != null && String(revision)) url.searchParams.set('v', String(revision));
  return url.toString();
}

/**
 * Tauri IPC 传输。
 *
 * Rust 侧按 request.id 维护取消句柄；Web 侧先停止等待，再 best-effort
 * 发送取消命令，避免已经过期的目录扫描或全文搜索继续占用资源。
 */
export function createTauriTransport({ invoke = null, listen = null } = {}) {
  const invokeCommand = invoke || publicTauriInvoke();
  const listenEvent = listen || publicTauriListen();
  if (typeof invokeCommand !== 'function') {
    throw new Error('Tauri invoke 不可用');
  }

  async function request(method, path, { params, body, signal } = {}) {
    if (signal?.aborted) throw abortError();

    const id = nextRequestId();
    const payload = {
      id,
      method,
      path,
      ...(params ? { query: normalizeQuery(params) } : {}),
      ...(body !== undefined ? { body } : {}),
    };
    let operation;
    try {
      operation = Promise.resolve(
        invokeCommand(TAURI_TRANSPORT_COMMAND, { request: payload }),
      ).catch((err) => {
        throw normalizeInvokeError(err);
      });
    } catch (err) {
      operation = Promise.reject(normalizeInvokeError(err));
    }
    if (!signal) return operation;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => {
        if (settled) return;
        // 取消命令失败不能覆盖调用方已经明确发出的取消意图。
        void Promise.resolve()
          .then(() => invokeCommand(TAURI_TRANSPORT_CANCEL_COMMAND, { requestId: id }))
          .catch(() => {});
        finish(reject, abortError());
      };

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      operation.then(
        (value) => finish(resolve, value),
        (err) => finish(reject, err),
      );
    });
  }

  async function subscribeFileChanges(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('文件变更监听器必须是函数');
    }
    if (typeof listenEvent !== 'function') {
      throw new Error('Tauri event.listen 不可用');
    }
    const unlisten = await listenEvent(TAURI_FILE_CHANGED_EVENT, (event) => {
      listener(event?.payload ?? event);
    });
    return typeof unlisten === 'function' ? unlisten : () => {};
  }

  return Object.freeze({
    get: (path, params, { signal } = {}) => request('GET', path, { params, signal }),
    put: (path, body, { signal } = {}) => request('PUT', path, { body, signal }),
    post: (path, body, { signal } = {}) => request('POST', path, { body, signal }),
    delete: (path, params, { signal } = {}) => request('DELETE', path, { params, signal }),
    resourceUrl,
    subscribeFileChanges,
  });
}

export function createGlobalTauriTransport(scope = globalThis) {
  const invoke = publicTauriInvoke(scope);
  if (!invoke) throw new Error('Tauri invoke 不可用');
  return createTauriTransport({ invoke, listen: publicTauriListen(scope) });
}
