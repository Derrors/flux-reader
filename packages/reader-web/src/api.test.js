import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createApi } from './api';

function response(body, { ok, status = 200 } = {}) {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({})));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api 请求契约', () => {
  it('业务 API 只通过 transport 接口发起请求', async () => {
    const transport = {
      get: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      subscribeFileChanges: vi.fn().mockResolvedValue(() => {}),
    };
    const client = createApi(transport);
    const controller = new AbortController();

    await client.file('/share/docs/a.md', { signal: controller.signal });
    await client.saveFile('/share/docs/a.md', '# A', 'a'.repeat(64));
    await client.commitRecovery(
      '/share/docs/a.md',
      'b'.repeat(48),
      'attempted',
      'c'.repeat(64),
    );
    await client.discardRecovery('/share/docs/a.md', 'd'.repeat(48));
    const listener = vi.fn();
    await client.subscribeFileChanges(listener);

    expect(transport.get).toHaveBeenCalledWith(
      '/file',
      { path: '/share/docs/a.md' },
      { signal: controller.signal },
    );
    expect(transport.put).toHaveBeenCalledWith('/file', {
      path: '/share/docs/a.md',
      content: '# A',
      expectedRevision: 'a'.repeat(64),
    }, undefined);
    expect(transport.post).toHaveBeenCalledWith('/file-recovery/commit', {
      path: '/share/docs/a.md',
      recoveryId: 'b'.repeat(48),
      version: 'attempted',
      expectedRevision: 'c'.repeat(64),
    }, undefined);
    expect(transport.delete).toHaveBeenCalledWith('/file-recovery', {
      path: '/share/docs/a.md',
      recoveryId: 'd'.repeat(48),
    }, undefined);
    expect(transport.subscribeFileChanges).toHaveBeenCalledWith(listener);
  });

  it.each([
    ['env', () => api.env(), '/app/flux-reader/api/env', null],
    ['list', () => api.list('/share/docs'), '/app/flux-reader/api/list', '/share/docs'],
    ['file', () => api.file('/share/docs/a.md'), '/app/flux-reader/api/file', '/share/docs/a.md'],
    ['recoveryState', () => api.recoveryState('/share/docs/a.md'), '/app/flux-reader/api/file-recovery', '/share/docs/a.md'],
    ['fileState', () => api.fileState('/share/docs/a.md'), '/app/flux-reader/api/file-state', '/share/docs/a.md'],
    ['workspaceState', () => api.workspaceState('/share/docs'), '/app/flux-reader/api/workspace-state', '/share/docs'],
  ])('%s 使用统一网关前缀、路径参数与同源凭证', async (
    _name,
    call,
    expectedPath,
    expectedFilePath,
  ) => {
    await call();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [requestUrl, options] = fetch.mock.calls[0];
    const parsedUrl = new URL(String(requestUrl));
    expect(parsedUrl.pathname).toBe(expectedPath);
    expect(parsedUrl.searchParams.get('path')).toBe(expectedFilePath);
    expect(options).toEqual({ credentials: 'same-origin' });
  });

  it.each([
    '/share/中文 文件.md',
    '/share/a%20b.md',
    '/share/项目 + #1?.markdown',
  ])('路径参数经过 URL 编码后仍逐字符还原：%s', async (filePath) => {
    await api.file(filePath);

    const [requestUrl] = fetch.mock.calls[0];
    expect(new URL(String(requestUrl)).searchParams.get('path')).toBe(filePath);
  });

  it('目录读取把 AbortSignal 透传给 fetch', async () => {
    const controller = new AbortController();
    await api.list('/share/docs', { signal: controller.signal });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      { credentials: 'same-origin', signal: controller.signal },
    );
  });

  it.each([
    ['file', (signal) => api.file('/share/docs/a.md', { signal })],
    ['fileState', (signal) => api.fileState('/share/docs/a.md', { signal })],
    ['recoveryState', (signal) => api.recoveryState('/share/docs/a.md', { signal })],
    ['recoveryVersion', (signal) => api.recoveryVersion(
      '/share/docs/a.md',
      'a'.repeat(48),
      'baseline',
      { signal },
    )],
  ])('%s 把 AbortSignal 透传给 fetch', async (_name, call) => {
    const controller = new AbortController();
    await call(controller.signal);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      { credentials: 'same-origin', signal: controller.signal },
    );
  });

  it('搜索通过重复 path 参数提交多个工作区，并带查询与上限', async () => {
    const controller = new AbortController();
    await api.search(
      ['/share/one', '/share/中文 two'],
      'needle + #',
      100,
      { signal: controller.signal },
    );

    const [requestUrl, options] = fetch.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(url.pathname).toBe('/app/flux-reader/api/search');
    expect(url.searchParams.getAll('path')).toEqual(['/share/one', '/share/中文 two']);
    expect(url.searchParams.get('q')).toBe('needle + #');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(options).toEqual({
      credentials: 'same-origin',
      signal: controller.signal,
    });
  });

  it('保存使用同源 PUT JSON 并提交不透明 revision', async () => {
    await api.saveFile('/share/docs/a.md', '# 新正文', 'a'.repeat(64));

    const [requestUrl, options] = fetch.mock.calls[0];
    expect(new URL(String(requestUrl)).pathname).toBe('/app/flux-reader/api/file');
    expect(options).toEqual({
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/share/docs/a.md',
        content: '# 新正文',
        expectedRevision: 'a'.repeat(64),
      }),
    });
  });

  it('恢复正文与清理使用 opaque recoveryId，且不暴露服务端路径', async () => {
    const recoveryId = 'a'.repeat(48);
    await api.recoveryVersion('/share/docs/a.md', recoveryId, 'attempted');
    let [requestUrl, options] = fetch.mock.calls[0];
    let url = new URL(String(requestUrl));
    expect(url.pathname).toBe('/app/flux-reader/api/file-recovery');
    expect(url.searchParams.get('path')).toBe('/share/docs/a.md');
    expect(url.searchParams.get('recoveryId')).toBe(recoveryId);
    expect(url.searchParams.get('version')).toBe('attempted');
    expect(options).toEqual({ credentials: 'same-origin' });

    fetch.mockClear();
    await api.discardRecovery('/share/docs/a.md', recoveryId);
    [requestUrl, options] = fetch.mock.calls[0];
    url = new URL(String(requestUrl));
    expect(url.searchParams.get('path')).toBe('/share/docs/a.md');
    expect(url.searchParams.get('recoveryId')).toBe(recoveryId);
    expect(options).toEqual({ method: 'DELETE', credentials: 'same-origin' });
  });

  it('服务端恢复提交只发送 opaque 标识与 fresh revision', async () => {
    const recoveryId = 'b'.repeat(48);
    const revision = 'c'.repeat(64);
    const controller = new AbortController();
    await api.commitRecovery(
      '/share/docs/a.md',
      recoveryId,
      'attempted',
      revision,
      { signal: controller.signal },
    );

    const [requestUrl, options] = fetch.mock.calls[0];
    expect(new URL(String(requestUrl)).pathname)
      .toBe('/app/flux-reader/api/file-recovery/commit');
    expect(options).toEqual({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/share/docs/a.md',
        recoveryId,
        version: 'attempted',
        expectedRevision: revision,
      }),
      signal: controller.signal,
    });
  });

  it.each([
    ['images/cover.png', '/share/docs', 'mtime:1'],
    ['/images/root-cover.png', undefined, undefined],
    ['../assets/cover.png', '/share', 'workspace:2'],
  ])('为安全图片端点生成同源编码 URL：%s', (
    resourcePath,
    workspacePath,
    revision,
  ) => {
    const value = api.resourceUrl(
      '/share/docs/guide 中文.md',
      resourcePath,
      workspacePath,
      revision,
    );
    const url = new URL(value, window.location.origin);

    expect(url.pathname).toBe('/app/flux-reader/api/resource');
    expect(url.searchParams.get('document')).toBe('/share/docs/guide 中文.md');
    expect(url.searchParams.get('path')).toBe(resourcePath);
    expect(url.searchParams.get('workspace')).toBe(workspacePath ?? null);
    expect(url.searchParams.get('v')).toBe(revision ?? null);
  });

  it.each([
    ['相对资源协议', 'javascript:alert(1)'],
    ['协议相对地址', '//evil.example/a.png'],
    ['反斜杠路径', '\\server\\a.png'],
    ['空路径', ''],
  ])('图片 URL 拒绝%s', (_label, resourcePath) => {
    expect(api.resourceUrl('/share/docs/a.md', resourcePath, '/share/docs')).toBeNull();
  });

  it('非 2xx JSON 响应映射 message、status 与 code', async () => {
    fetch.mockResolvedValueOnce(response(
      { message: '没有权限', error: 'USER_ACL_DENIED' },
      { ok: false, status: 403 },
    ));

    await expect(api.file('/share/private.md')).rejects.toMatchObject({
      message: '没有权限',
      status: 403,
      code: 'USER_ACL_DENIED',
      details: { message: '没有权限', error: 'USER_ACL_DENIED' },
    });
  });

  it('非 JSON 响应给出包含 HTTP 状态的明确错误', async () => {
    fetch.mockResolvedValueOnce(response('<html>bad gateway</html>', { status: 502 }));

    await expect(api.env()).rejects.toThrow('接口返回非 JSON (HTTP 502)');
  });
});
