import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDER_PAYLOAD,
  normalizeRenderPayload,
  resolveMacOSImageSource,
} from './bridge';

describe('macOS 渲染 bridge', () => {
  it('保留合法的 Swift 渲染载荷', () => {
    expect(
      normalizeRenderPayload({
        content: '# 标题',
        title: 'guide.md',
        theme: 'dark',
        resourceToken: 'doc-1',
      }),
    ).toEqual({
      content: '# 标题',
      title: 'guide.md',
      theme: 'dark',
      resourceToken: 'doc-1',
    });
  });

  it('拒绝非字符串字段并回退到浅色主题', () => {
    expect(
      normalizeRenderPayload({ content: 42, title: '   ', theme: 'sepia' }),
    ).toEqual(DEFAULT_RENDER_PAYLOAD);
    expect(normalizeRenderPayload(null)).toEqual(DEFAULT_RENDER_PAYLOAD);
  });

  it('把相对图片映射到隔离的原生资源 scheme', () => {
    expect(resolveMacOSImageSource('../images/封面 1.png', 'doc token')).toBe(
      'flux-reader-resource://image/doc%20token?path=..%2Fimages%2F%E5%B0%81%E9%9D%A2%201.png',
    );
    expect(resolveMacOSImageSource('https://example.com/a.png', 'doc')).toBe(
      'https://example.com/a.png',
    );
    expect(resolveMacOSImageSource('file:///etc/passwd', 'doc')).toBeNull();
    expect(resolveMacOSImageSource('javascript:alert(1)', 'doc')).toBeNull();
  });
});
