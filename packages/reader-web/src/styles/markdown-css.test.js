// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8');

describe('媒体预览布局', () => {
  it('全屏内容较小时双向居中，放大溢出时仍由视口滚动', () => {
    expect(css).toMatch(
      /\.media-lightbox-viewport\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*auto;/s,
    );
    expect(css).toMatch(
      /\.media-lightbox-content\s*\{[^}]*flex:\s*0 0 auto;[^}]*margin:\s*auto;/s,
    );
  });

  it('流程图支持左、中、右对齐', () => {
    expect(css).toContain(".mermaid-block[data-media-align='left'] .mermaid-canvas");
    expect(css).toContain(".mermaid-block[data-media-align='right'] .mermaid-canvas");
    expect(css).toMatch(/\.mermaid-canvas\s*\{[^}]*justify-content:\s*center;/s);
  });
});
