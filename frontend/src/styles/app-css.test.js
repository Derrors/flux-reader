// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1],
  declarations: match[2],
}));

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
    const contentRule = rules.find(({ declarations }) => /opacity:\s*1;/.test(declarations));
    expect(contentRule?.declarations).toMatch(
      /visibility:\s*visible;[^}]*pointer-events:\s*auto;/s,
    );
    for (const selector of [
      '.app-toc:hover .toc-title',
      '.app-toc:hover .toc-list',
      '.app-toc:focus-within .toc-title',
      '.app-toc:focus-within .toc-list',
      '.app-toc.is-pinned .toc-title',
      '.app-toc.is-pinned .toc-list',
    ]) {
      expect(contentRule?.selectors).toContain(selector);
    }

    const autoPanelRule = rules.find(({ selectors }) => (
      selectors.includes('.app-toc:hover .app-toc-panel')
    ));
    expect(autoPanelRule?.selectors).toContain('.app-toc:focus-within .app-toc-panel');
    expect(autoPanelRule?.declarations).toMatch(/overflow-y:\s*auto;/);

    const pinnedPanelRule = rules.find(({ selectors }) => (
      selectors.trim() === '.app-toc.is-pinned .app-toc-panel'
    ));
    expect(pinnedPanelRule?.declarations).toMatch(/overflow-y:\s*auto;/);
  });
});
