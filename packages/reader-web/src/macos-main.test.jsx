import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MacOSDocumentView, MacOSRenderer } from './macos-main';

vi.mock('./markdown/MarkdownView', () => ({
  default: ({ content, findQuery, findCaseSensitive, activeFindMatch }) => (
    <article
      data-testid="markdown-view"
      data-find-query={findQuery}
      data-find-case-sensitive={String(findCaseSensitive)}
      data-active-find-match={activeFindMatch}
    >
      <h1 id="first">First</h1>
      {content.includes('## Second') && <h2 id="second">Second</h2>}
      {content.includes('[deferred]') && (
        <div data-testid="deferred-code" data-render-state="deferred" />
      )}
    </article>
  ),
}));

function renderState(content) {
  return {
    generation: 'generation-1',
    content,
    title: 'Test.md',
    theme: 'light',
    resourceToken: 'resource-token',
  };
}

describe('macOS 文档目录', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView.mockClear();
  });

  afterEach(() => {
    delete globalThis.webkit;
  });

  it('仅在文档包含两个以上标题时展示目录', () => {
    const { rerender } = render(
      <MacOSDocumentView renderState={renderState('# First')} />,
    );

    expect(screen.queryByRole('complementary', { name: '文档目录' }))
      .not.toBeInTheDocument();

    rerender(
      <MacOSDocumentView renderState={renderState('# First\n\n## Second')} />,
    );

    expect(screen.getByRole('complementary', { name: '文档目录' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'First' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Second' })).toBeInTheDocument();
  });

  it('支持固定、恢复自动隐藏及标题跳转', async () => {
    const user = userEvent.setup();
    render(
      <MacOSDocumentView renderState={renderState('# First\n\n## Second')} />,
    );
    const directory = screen.getByRole('complementary', { name: '文档目录' });

    await user.click(screen.getByRole('button', { name: '固定展开目录' }));
    expect(directory).toHaveClass('is-pinned');
    expect(screen.getByRole('button', { name: '恢复目录自动隐藏' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: '恢复目录自动隐藏' }));
    expect(directory).not.toHaveClass('is-pinned');

    await user.click(screen.getByRole('button', { name: 'Second' }));
    expect(document.getElementById('second').scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
  });

  it('把原生查找状态交给预览并支持归一化滚动定位', () => {
    const state = {
      ...renderState('# First\n\n## Second'),
      findQuery: 'second',
      findCaseSensitive: true,
      activeFindMatch: 1,
    };
    render(<MacOSDocumentView renderState={state} />);

    expect(screen.getByTestId('markdown-view')).toHaveAttribute(
      'data-find-query',
      'second',
    );
    expect(screen.getByTestId('markdown-view')).toHaveAttribute(
      'data-find-case-sensitive',
      'true',
    );
    expect(screen.getByTestId('markdown-view')).toHaveAttribute(
      'data-active-find-match',
      '1',
    );

    const scrollElement = document.querySelector('.macos-renderer-scroll');
    Object.defineProperty(scrollElement, 'clientHeight', { value: 200 });
    Object.defineProperty(scrollElement, 'scrollHeight', { value: 1_000 });
    expect(globalThis.fluxReader.setScrollFraction(0.25)).toBe(true);
    expect(scrollElement.scrollTop).toBe(200);
  });

  it('程序同步滚动不回传，用户滚动才通知原生端', async () => {
    const scrollPosition = vi.fn();
    const contentDidPaint = vi.fn();
    globalThis.webkit = {
      messageHandlers: {
        rendererReady: { postMessage: vi.fn() },
        contentDidPaint: { postMessage: contentDidPaint },
        scrollPosition: { postMessage: scrollPosition },
      },
    };
    render(<MacOSRenderer />);
    globalThis.fluxReader.render(renderState('# First'));
    await screen.findByTestId('markdown-view');
    await waitFor(() => expect(contentDidPaint).toHaveBeenCalled());
    contentDidPaint.mockClear();

    const scrollElement = document.querySelector('.macos-renderer-scroll');
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    });

    expect(globalThis.fluxReader.setScrollFraction(0.25)).toBe(true);
    fireEvent.scroll(scrollElement);
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
    expect(scrollPosition).not.toHaveBeenCalled();

    scrollElement.scrollTop = 400;
    fireEvent.scroll(scrollElement);
    await waitFor(() => {
      expect(scrollPosition).toHaveBeenCalledWith({
        kind: 'user',
        generation: 'generation-1',
        fraction: 0.5,
      });
    });
    expect(contentDidPaint).not.toHaveBeenCalled();
  });

  it('只在真实文档 commit 后回传带 generation 的首次绘制消息', async () => {
    const contentDidPaint = vi.fn();
    globalThis.webkit = {
      messageHandlers: {
        contentDidPaint: { postMessage: contentDidPaint },
      },
    };

    const { rerender } = render(
      <MacOSDocumentView renderState={renderState('# First')} />,
    );
    await waitFor(() => {
      expect(contentDidPaint).toHaveBeenLastCalledWith({
        generation: 'generation-1',
        theme: 'light',
        hasContent: true,
      });
    });

    rerender(
      <MacOSDocumentView
        renderState={{
          ...renderState('# Second'),
          generation: 'generation-2',
          theme: 'dark',
        }}
      />,
    );
    await waitFor(() => {
      expect(contentDidPaint).toHaveBeenLastCalledWith({
        generation: 'generation-2',
        theme: 'dark',
        hasContent: true,
      });
    });
  });

  it('首屏代码仍在等待高亮时不提前揭开纯文本预览', async () => {
    const contentDidPaint = vi.fn();
    globalThis.webkit = {
      messageHandlers: {
        contentDidPaint: { postMessage: contentDidPaint },
      },
    };

    render(<MacOSDocumentView renderState={renderState('# First\n\n[deferred]')} />);
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
    expect(contentDidPaint).not.toHaveBeenCalled();

    screen.getByTestId('deferred-code').dataset.renderState = 'highlighted';
    await waitFor(() => {
      expect(contentDidPaint).toHaveBeenCalledWith({
        generation: 'generation-1',
        theme: 'light',
        hasContent: true,
      });
    });
  });
});
