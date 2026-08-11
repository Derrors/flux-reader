import { describe, expect, it } from 'vitest';
import {
  createMarkdownSnapshot,
  extractToc,
  getMarkdownPipelineDiagnostics,
  resetMarkdownPipelineDiagnostics,
} from './pipeline';

describe('Markdown token snapshot', () => {
  it('用一次预处理和词法分析同时生成正文与 TOC', () => {
    resetMarkdownPipelineDiagnostics();
    const snapshot = createMarkdownSnapshot(`---
title: Demo
---

# Heading

Paragraph
---

## Child`);

    expect(snapshot.safeHtml).toContain('<h1 id="heading">Heading</h1>');
    expect(snapshot.safeHtml).toContain('<table>');
    expect(snapshot.toc).toEqual([
      { level: 1, text: 'Heading', id: 'heading' },
      { level: 2, text: 'Child', id: 'child' },
    ]);
    expect(getMarkdownPipelineDiagnostics()).toEqual({
      preprocessCount: 1,
      lexCount: 1,
      renderCount: 1,
      sanitizeCount: 1,
    });
  });

  it('保留 extractToc 兼容入口', () => {
    expect(extractToc('# One\n\n## Two')).toEqual([
      { level: 1, text: 'One', id: 'one' },
      { level: 2, text: 'Two', id: 'two' },
    ]);
  });
});
