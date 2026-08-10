// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./macos.css', import.meta.url), 'utf8');

describe('macOS 右侧目录布局', () => {
  it('正文独立滚动，目录固定在其外侧', () => {
    expect(css).toMatch(
      /\.macos-renderer-shell\s*\{[^}]*display:\s*flex;[^}]*height:\s*100%;/s,
    );
    expect(css).toMatch(
      /\.macos-renderer-scroll\s*\{[^}]*flex:\s*1;[^}]*overflow:\s*auto;/s,
    );
  });

  it('覆盖 App 窄屏规则并始终保留目录折叠触发区', () => {
    expect(css).toMatch(
      /\.macos-renderer-shell\s*>\s*\.app-toc\s*\{[^}]*display:\s*block;[^}]*height:\s*100%;/s,
    );
  });
});
