import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarkdownView, {
  getParsedSnapshotCacheDiagnostics,
  resetParsedSnapshotCache,
} from './MarkdownView';
import {
  getCachedMarkdownSnapshot,
  resetMarkdownSnapshotCache,
} from './pipeline';

describe('MarkdownView 图片资源', () => {
  it('只在提供解析器时保留相对图片', () => {
    const resolveImageSource = vi.fn(
      (source) => `flux-reader-resource://image/doc?path=${encodeURIComponent(source)}`,
    );

    const { rerender } = render(
      <MarkdownView
        content="![封面](images/cover.png)"
        resolveImageSource={resolveImageSource}
      />,
    );

    expect(screen.getByRole('img', { name: '封面' })).toHaveAttribute(
      'src',
      'flux-reader-resource://image/doc?path=images%2Fcover.png',
    );
    expect(resolveImageSource).toHaveBeenCalledWith('images/cover.png');

    rerender(<MarkdownView content="![封面](images/cover.png)" />);
    expect(screen.queryByRole('img', { name: '封面' })).not.toBeInTheDocument();
  });

  it('保留 https 与图片 data URI，同时拒绝主动内容协议', () => {
    const { container } = render(
      <MarkdownView
        content={'![远程](https://example.com/a.png)\n\n<img alt="恶意" src="javascript:alert(1)">'}
      />,
    );

    expect(screen.getByRole('img', { name: '远程' })).toHaveAttribute(
      'src',
      'https://example.com/a.png',
    );
    expect(container.querySelector('img[alt="恶意"]')).toBeNull();
  });
});

describe('MarkdownView 文档内查找', () => {
  it('高亮可见正文并报告匹配数量与活动项', () => {
    const onMatchCountChange = vi.fn();
    const { container, rerender } = render(
      <MarkdownView
        content={'# Needle\n\nneedle and NEEDLE'}
        findQuery="needle"
        activeFindMatch={1}
        onFindMatchCountChange={onMatchCountChange}
      />,
    );

    expect(container.querySelectorAll('mark.markdown-find-match')).toHaveLength(3);
    expect(container.querySelector('[data-find-match="1"]')).toHaveClass('is-active');
    expect(onMatchCountChange).toHaveBeenLastCalledWith(3);

    rerender(
      <MarkdownView
        content={'# Needle\n\nneedle and NEEDLE'}
        findQuery="needle"
        findCaseSensitive
        activeFindMatch={0}
        onFindMatchCountChange={onMatchCountChange}
      />,
    );
    expect(container.querySelectorAll('mark.markdown-find-match')).toHaveLength(1);
    expect(onMatchCountChange).toHaveBeenLastCalledWith(1);
  });

  it('切换活动匹配只移动 class，不重建已解析 DOM', () => {
    const { container, rerender } = render(
      <MarkdownView
        content="needle needle"
        findQuery="needle"
        activeFindMatch={0}
      />,
    );
    const firstBefore = container.querySelector('[data-find-match="0"]');
    const secondBefore = container.querySelector('[data-find-match="1"]');

    rerender(
      <MarkdownView
        content="needle needle"
        findQuery="needle"
        activeFindMatch={1}
      />,
    );

    expect(container.querySelector('[data-find-match="0"]')).toBe(firstBefore);
    expect(container.querySelector('[data-find-match="1"]')).toBe(secondBefore);
    expect(firstBefore).not.toHaveClass('is-active');
    expect(secondBefore).toHaveClass('is-active');
  });
});

describe('MarkdownView 多标签缓存', () => {
  it('返回已打开标签时复用解析后的 React 元素树', () => {
    resetMarkdownSnapshotCache();
    resetParsedSnapshotCache();
    const firstSnapshot = getCachedMarkdownSnapshot('# First');
    const secondSnapshot = getCachedMarkdownSnapshot('# Second');
    const { rerender } = render(
      <MarkdownView content="# First" snapshot={firstSnapshot} />,
    );

    rerender(<MarkdownView content="# Second" snapshot={secondSnapshot} />);
    rerender(
      <MarkdownView
        content="# First"
        snapshot={getCachedMarkdownSnapshot('# First')}
      />,
    );

    expect(getParsedSnapshotCacheDiagnostics()).toEqual({ hits: 1, misses: 2 });
  });
});
