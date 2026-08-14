// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./macos.css', import.meta.url), 'utf8');

describe('macOS 玻璃拟态渲染布局', () => {
  it('正文独立滚动，目录固定在其外侧', () => {
    expect(css).toMatch(
      /\.macos-renderer-shell\s*\{[^}]*display:\s*flex;[^}]*height:\s*100%;/s,
    );
    expect(css).toMatch(
      /\.macos-renderer-scroll\s*\{[^}]*flex:\s*1;[^}]*overflow:\s*auto;/s,
    );
  });

  it('覆盖 App 窄屏规则并始终保留目录折叠按钮', () => {
    expect(css).toMatch(
      /\.macos-renderer-shell\s*>\s*\.app-toc\s*\{[^}]*display:\s*block;[^}]*height:\s*28px;/s,
    );
  });

  it('正文容器四边距一致且纸张完整填充可用高度', () => {
    expect(css).toMatch(/--f-macos-page-inset:\s*10px;/);
    expect(css).toMatch(
      /\.macos-renderer-scroll\s*\{[^}]*padding:\s*var\(--f-macos-page-inset\);/s,
    );
    expect(css).toMatch(
      /\.macos-renderer\s*\{[^}]*min-height:\s*100%;/s,
    );
  });

  it('折叠目录只显示悬浮按钮，固定后才恢复布局占位', () => {
    expect(css).toMatch(
      /\.macos-renderer-shell\s*\{[^}]*position:\s*relative;/s,
    );
    expect(css).toMatch(
      /\.macos-renderer-shell\s*>\s*\.app-toc\s*\{[^}]*position:\s*absolute;[^}]*right:\s*var\(--f-macos-page-inset\);[^}]*height:\s*28px;[^}]*margin:\s*0;/s,
    );
    expect(css).toMatch(
      /\.macos-renderer-shell\s*>\s*\.app-toc\.is-pinned\s*\{[^}]*position:\s*relative;[^}]*height:\s*calc\(100%\s*-\s*var\(--f-macos-page-inset-total\)\);/s,
    );
    expect(css).toMatch(
      /\.app-toc:not\(\.is-pinned\):not\(:hover\):not\(:focus-within\)[^{]*\.app-toc-panel\s*\{[^}]*height:\s*28px;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
    );
  });

  it('只让 WebView 外壳透明，正文使用高可读玻璃纸张卡片', () => {
    expect(css).toMatch(
      /html,\s*body,\s*#root\s*\{[^}]*background:\s*transparent\s*!important;/s,
    );
    expect(css).toMatch(
      /\.macos-renderer\s*\{[^}]*border-radius:\s*22px;[^}]*background:\s*var\(--f-macos-paper-bg\);[^}]*box-shadow:\s*var\(--f-macos-paper-shadow\);/s,
    );
  });

  it('不在 WebView 中叠加实时背景模糊，并为减少透明度提供实色回退', () => {
    expect(css).not.toContain('backdrop-filter');
    expect(css).toMatch(/@media\s*\(prefers-reduced-transparency:\s*reduce\)/);
    expect(css).toMatch(/--f-macos-paper-bg:\s*#ffffff;/);
    expect(css).toMatch(/--f-macos-paper-bg:\s*#0d0f12;/);
  });
});
