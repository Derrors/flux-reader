import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MacOSDocumentView } from './macos-main';

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
    </article>
  ),
}));

function renderState(content) {
  return {
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
});
