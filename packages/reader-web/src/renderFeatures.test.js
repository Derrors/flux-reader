import { describe, expect, it } from 'vitest';
import { resolveRenderFeatureFlags } from './renderFeatures';

describe('渲染 feature flags', () => {
  it('只在浏览器支持时启用 content-visibility', () => {
    expect(resolveRenderFeatureFlags({
      env: {},
      css: { supports: () => true },
    }).contentVisibility).toBe(true);
    expect(resolveRenderFeatureFlags({
      env: {},
      css: { supports: () => false },
    }).contentVisibility).toBe(false);
  });

  it('支持构建开关和当前会话紧急覆盖', () => {
    const flags = resolveRenderFeatureFlags({
      env: {
        VITE_FLUX_VIEWPORT_HIGHLIGHTING: 'false',
        VITE_FLUX_HIGHLIGHT_CACHE: '0',
      },
      overrides: { highlightCache: true, contentVisibility: false },
      css: { supports: () => true },
    });

    expect(flags).toEqual({
      viewportHighlighting: false,
      highlightCache: true,
      contentVisibility: false,
    });
  });
});
