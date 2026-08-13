import { describe, expect, it } from 'vitest';
import {
  createMarkdownSnapshot,
  extractToc,
  getCachedMarkdownSnapshot,
  getMarkdownPipelineDiagnostics,
  getMarkdownSnapshotCacheDiagnostics,
  resetMarkdownPipelineDiagnostics,
  resetMarkdownSnapshotCache,
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

  it('跨标签返回时复用同一份 Markdown 快照', () => {
    resetMarkdownPipelineDiagnostics();
    resetMarkdownSnapshotCache();

    const first = getCachedMarkdownSnapshot('# First');
    getCachedMarkdownSnapshot('# Second');
    const returned = getCachedMarkdownSnapshot('# First');

    expect(returned).toBe(first);
    expect(getMarkdownPipelineDiagnostics()).toEqual({
      preprocessCount: 2,
      lexCount: 2,
      renderCount: 2,
      sanitizeCount: 2,
    });
    expect(getMarkdownSnapshotCacheDiagnostics()).toMatchObject({
      entries: 2,
      hits: 1,
      misses: 2,
    });
  });
});
