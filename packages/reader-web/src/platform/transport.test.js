import { describe, expect, it, vi } from 'vitest';
import { httpTransport } from './transport-http';
import { selectTransport } from './transport';
import { TAURI_TRANSPORT_COMMAND } from './transport-tauri';

describe('platform transport 选择', () => {
  it('普通浏览器保持使用 fnOS HTTP transport', () => {
    expect(selectTransport({})).toBe(httpTransport);
  });

  it('Tauri WebView 使用官方全局 invoke transport', async () => {
    const invoke = vi.fn().mockResolvedValue({ mode: 'tauri' });
    const transport = selectTransport({ __TAURI__: { core: { invoke } } });

    await expect(transport.get('/env')).resolves.toEqual({ mode: 'tauri' });
    expect(invoke).toHaveBeenCalledWith(
      TAURI_TRANSPORT_COMMAND,
      { request: expect.objectContaining({ method: 'GET', path: '/env' }) },
    );
  });
});
