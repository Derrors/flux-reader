import { describe, expect, it, vi } from 'vitest';
import {
  createGlobalTauriTransport,
  createTauriTransport,
  hasTauriInvoke,
  TAURI_FILE_CHANGED_EVENT,
  TAURI_TRANSPORT_CANCEL_COMMAND,
  TAURI_TRANSPORT_COMMAND,
} from './transport-tauri';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Tauri transport', () => {
  it('把 get/put/post/delete 映射为带 request id 的 invoke 调用', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const transport = createTauriTransport({ invoke });

    await transport.get('/search', {
      path: ['/share/one', null, '/share/中文 two'],
      q: 'needle + #',
      limit: 100,
      ignored: null,
    });
    await transport.put('/file', { path: '/share/a.md', content: '# A' });
    await transport.post('/file-recovery/commit', { recoveryId: 'a'.repeat(48) });
    await transport.delete('/file-recovery', { recoveryId: 'b'.repeat(48) });

    expect(invoke).toHaveBeenCalledTimes(4);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      TAURI_TRANSPORT_COMMAND,
      TAURI_TRANSPORT_COMMAND,
      TAURI_TRANSPORT_COMMAND,
      TAURI_TRANSPORT_COMMAND,
    ]);
    expect(invoke.mock.calls[0][1]).toEqual({
      request: {
        id: expect.stringMatching(/^webview-/),
        method: 'GET',
        path: '/search',
        query: {
          path: ['/share/one', '/share/中文 two'],
          q: 'needle + #',
          limit: '100',
        },
      },
    });
    expect(invoke.mock.calls[1][1].request).toMatchObject({
      method: 'PUT',
      path: '/file',
      body: { path: '/share/a.md', content: '# A' },
    });
    expect(invoke.mock.calls[2][1].request).toMatchObject({
      method: 'POST',
      path: '/file-recovery/commit',
    });
    expect(invoke.mock.calls[3][1].request).toMatchObject({
      method: 'DELETE',
      path: '/file-recovery',
    });
  });

  it('调用前已取消时拒绝且不进入 Rust', async () => {
    const invoke = vi.fn();
    const transport = createTauriTransport({ invoke });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.get('/file', { path: '/share/a.md' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('调用中取消时立即拒绝，并把同一 request id 传给 Rust 取消命令', async () => {
    const running = deferred();
    const invoke = vi.fn((command) => (
      command === TAURI_TRANSPORT_COMMAND ? running.promise : Promise.resolve(null)
    ));
    const transport = createTauriTransport({ invoke });
    const controller = new AbortController();

    const pending = transport.get(
      '/search',
      { path: ['/share/docs'], q: 'needle' },
      { signal: controller.signal },
    );
    const requestId = invoke.mock.calls[0][1].request.id;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith(
      TAURI_TRANSPORT_CANCEL_COMMAND,
      { requestId },
    );
    running.resolve({ results: [] });
    await running.promise;
  });

  it('把 Rust 结构化错误映射为现有前端错误契约', async () => {
    const saveOutcome = {
      contractVersion: 1,
      kind: 'rejected',
      reason: 'conflict',
    };
    const invoke = vi.fn().mockRejectedValue({
      message: '文稿已变化',
      error: 'FILE_CONFLICT',
      status: 409,
      saveOutcome,
    });
    const transport = createTauriTransport({ invoke });

    await expect(transport.put('/file', {})).rejects.toMatchObject({
      message: '文稿已变化',
      code: 'FILE_CONFLICT',
      status: 409,
      details: { saveOutcome },
    });
  });

  it('支持官方 withGlobalTauri 暴露的 window.__TAURI__.core.invoke', async () => {
    const invoke = vi.fn().mockResolvedValue({ mode: 'tauri' });
    const listen = vi.fn().mockResolvedValue(() => {});
    const getCurrentWebviewWindow = vi.fn(() => ({ listen }));
    const scope = {
      __TAURI__: {
        core: { invoke },
        webviewWindow: { getCurrentWebviewWindow },
      },
    };

    expect(hasTauriInvoke(scope)).toBe(true);
    const transport = createGlobalTauriTransport(scope);
    await expect(transport.get('/env')).resolves.toEqual({ mode: 'tauri' });
    expect(invoke).toHaveBeenCalledWith(
      TAURI_TRANSPORT_COMMAND,
      { request: expect.objectContaining({ method: 'GET', path: '/env' }) },
    );
    await transport.subscribeFileChanges(vi.fn());
    expect(getCurrentWebviewWindow).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(TAURI_FILE_CHANGED_EVENT, expect.any(Function));
  });

  it('为 Windows 自定义图片协议生成编码 URL 并拒绝危险来源', () => {
    const transport = createTauriTransport({ invoke: vi.fn() });
    const value = transport.resourceUrl(
      'C:/资料/guide one.md',
      '../images/cover%20one.png?raw=1#preview',
      'C:/资料',
      'revision:2',
    );
    const url = new URL(value);

    expect(url.origin).toBe('http://flux-reader-resource.localhost');
    expect(url.pathname).toBe('/image');
    expect(url.searchParams.get('document')).toBe('C:/资料/guide one.md');
    expect(url.searchParams.get('path')).toBe('../images/cover%20one.png?raw=1#preview');
    expect(url.searchParams.get('workspace')).toBe('C:/资料');
    expect(url.searchParams.get('v')).toBe('revision:2');
    expect(transport.resourceUrl('C:/docs/a.md', 'https://evil.example/a.png')).toBeNull();
    expect(transport.resourceUrl('C:/docs/a.md', '..\\secret.png')).toBeNull();
    expect(transport.resourceUrl('relative.md', 'cover.png')).toBeNull();
    expect(transport.resourceUrl('//server/share/a.md', 'cover.png')).not.toBeNull();
  });

  it('只订阅约定事件并向业务层转交去包装的 payload', async () => {
    const unlisten = vi.fn();
    let eventHandler;
    const listen = vi.fn((eventName, handler) => {
      eventHandler = handler;
      return Promise.resolve(unlisten);
    });
    const listener = vi.fn();
    const transport = createTauriTransport({ invoke: vi.fn(), listen });

    const unsubscribe = await transport.subscribeFileChanges(listener);
    expect(listen).toHaveBeenCalledWith(TAURI_FILE_CHANGED_EVENT, expect.any(Function));
    eventHandler({ event: TAURI_FILE_CHANGED_EVENT, payload: { sequence: 9 } });
    expect(listener).toHaveBeenCalledWith({ sequence: 9 });
    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
