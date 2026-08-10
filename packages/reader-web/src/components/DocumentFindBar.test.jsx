import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import DocumentFindBar, { findTextMatches, replaceTextMatch } from './DocumentFindBar';

describe('DocumentFindBar', () => {
  it('按非重叠顺序查找并支持区分大小写', () => {
    expect(findTextMatches('Alpha alpha ALPHA', 'alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
    expect(findTextMatches('Alpha alpha ALPHA', 'alpha', true)).toEqual([
      { start: 6, end: 11 },
    ]);
    expect(findTextMatches('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('只替换指定匹配范围', () => {
    expect(replaceTextMatch('one two one', { start: 4, end: 7 }, '2')).toBe('one 2 one');
  });

  it('回车导航、Shift+回车反向导航并可展开替换', async () => {
    const user = userEvent.setup();
    const actions = {
      onQueryChange: vi.fn(),
      onReplacementChange: vi.fn(),
      onToggleReplace: vi.fn(),
      onToggleCase: vi.fn(),
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onReplace: vi.fn(),
      onReplaceAll: vi.fn(),
      onClose: vi.fn(),
    };
    render(
      <DocumentFindBar
        query="needle"
        replacement=""
        replaceVisible={false}
        caseSensitive={false}
        currentIndex={1}
        matchCount={3}
        canReplace
        {...actions}
      />,
    );

    const query = screen.getByRole('searchbox', { name: '查找内容' });
    await user.type(query, '{Enter}');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(actions.onNext).toHaveBeenCalledOnce();
    expect(actions.onPrevious).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('2 / 3');

    await user.click(screen.getByRole('button', { name: '显示替换' }));
    expect(actions.onToggleReplace).toHaveBeenCalledOnce();
  });
});
