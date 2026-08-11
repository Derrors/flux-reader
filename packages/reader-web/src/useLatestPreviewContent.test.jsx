import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLatestPreviewContent } from './useLatestPreviewContent';

describe('useLatestPreviewContent', () => {
  afterEach(() => vi.useRealTimers());

  it('分栏连续输入 latest-wins，并在停顿后只发布最终值', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ content }) => useLatestPreviewContent(content, true, 100),
      { initialProps: { content: 'a' } },
    );

    rerender({ content: 'ab' });
    rerender({ content: 'abc' });
    expect(result.current.previewContent).toBe('a');

    act(() => vi.advanceTimersByTime(99));
    expect(result.current.previewContent).toBe('a');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.previewContent).toBe('abc');
  });

  it('显式 flush 与退出分栏立即返回最新正文', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ content, deferred }) => useLatestPreviewContent(content, deferred, 100),
      { initialProps: { content: 'a', deferred: true } },
    );

    rerender({ content: 'latest', deferred: true });
    act(() => result.current.flushPreviewContent());
    expect(result.current.previewContent).toBe('latest');

    rerender({ content: 'immediate', deferred: false });
    expect(result.current.previewContent).toBe('immediate');
  });
});
