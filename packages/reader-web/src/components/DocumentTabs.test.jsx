import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import DocumentTabs from './DocumentTabs';

describe('DocumentTabs', () => {
  it('标记活动标签与未保存文稿，并转发切换和关闭操作', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <DocumentTabs
        tabs={[
          { id: 'a', path: '/share/a.md', name: 'a.md', content: 'A', draft: 'A' },
          { id: 'b', path: '/share/b.md', name: 'b.md', content: 'B', draft: 'B dirty' },
        ]}
        activeId="a"
        onActivate={onActivate}
        onClose={onClose}
      />,
    );

    const tablist = screen.getByRole('tablist', { name: '打开的文稿' });
    expect(within(tablist).getByRole('tab', { name: 'a.md' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tablist).getByRole('tab', { name: /b\.md/ })).toHaveTextContent('●');

    await user.click(within(tablist).getByRole('tab', { name: /b\.md/ }));
    await user.click(screen.getByRole('button', { name: '关闭 b.md' }));
    expect(onActivate).toHaveBeenCalledWith('b');
    expect(onClose).toHaveBeenCalledWith('b');
  });
});
