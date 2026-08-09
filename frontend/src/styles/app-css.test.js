// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

describe('右侧目录折叠样式契约', () => {
  it('折叠面板不显示目录滚动条', () => {
    expect(css).toMatch(/\.app-toc-panel\s*\{[^}]*overflow:\s*hidden;/s);
  });

  it('折叠时隐藏标题和目录项，并禁用点击', () => {
    expect(css).toMatch(
      /\.app-toc \.toc-title,\s*\.app-toc \.toc-list\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s,
    );
  });

  it('hover、键盘焦点或固定展开时恢复目录内容与滚动', () => {
    expect(css).toMatch(
      /\.app-toc:hover \.toc-title,[\s\S]*?\.app-toc\.is-pinned \.toc-list\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/,
    );
    expect(css).toMatch(
      /\.app-toc:hover \.app-toc-panel,\s*\.app-toc:focus-within \.app-toc-panel\s*\{[^}]*overflow-y:\s*auto;/s,
    );
    expect(css).toMatch(
      /\.app-toc\.is-pinned \.app-toc-panel\s*\{[^}]*overflow-y:\s*auto;/s,
    );
  });
});
