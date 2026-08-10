import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MacOSDocumentView } from './macos-main';

vi.mock('./markdown/MarkdownView', () => ({
  default: ({ content }) => (
    <article data-testid="markdown-view">
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
});
