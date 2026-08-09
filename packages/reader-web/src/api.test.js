import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

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
  it.each([
    ['env', () => api.env(), '/app/flux-reader/api/env', null],
    ['list', () => api.list('/share/docs'), '/app/flux-reader/api/list', '/share/docs'],
    ['file', () => api.file('/share/docs/a.md'), '/app/flux-reader/api/file', '/share/docs/a.md'],
    ['sample', () => api.sample(), '/app/flux-reader/api/sample', null],
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

  it('非 2xx JSON 响应映射 message、status 与 code', async () => {
    fetch.mockResolvedValueOnce(response(
      { message: '没有权限', error: 'USER_ACL_DENIED' },
      { ok: false, status: 403 },
    ));

    await expect(api.file('/share/private.md')).rejects.toMatchObject({
      message: '没有权限',
      status: 403,
      code: 'USER_ACL_DENIED',
    });
  });

  it('非 JSON 响应给出包含 HTTP 状态的明确错误', async () => {
    fetch.mockResolvedValueOnce(response('<html>bad gateway</html>', { status: 502 }));

    await expect(api.env()).rejects.toThrow('接口返回非 JSON (HTTP 502)');
  });
});
