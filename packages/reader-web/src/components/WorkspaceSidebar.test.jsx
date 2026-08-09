import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceSidebar from './WorkspaceSidebar';

function props(overrides = {}) {
  return {
    workspaces: [{
      path: '/share/docs',
      actualPath: '/real/docs',
      name: 'docs',
      type: 'directory',
      revision: 1,
      initialChildren: [],
    }],
    currentPath: null,
    refreshingPaths: new Set(),
    onOpenFile: vi.fn(),
    onRefreshWorkspace: vi.fn(),
    onCloseWorkspace: vi.fn(),
    recents: [],
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onClearRecents: vi.fn(),
    searchQuery: 'needle',
    onSearchQueryChange: vi.fn(),
    searching: false,
    searchResults: [{
      path: '/real/docs/guide.md',
      name: 'guide.md',
      displayPath: 'guide.md',
      snippet: 'needle context',
      matchKind: 'content',
      workspaceName: 'docs',
      workspacePath: '/share/docs',
    }],
    searchError: '',
    ...overrides,
  };
}

describe('WorkspaceSidebar 搜索状态', () => {
  it('重跑搜索时保留结果按钮与焦点，并通过 busy/status 报告进度', () => {
    const { container, rerender } = render(<WorkspaceSidebar {...props()} />);
    const resultButton = screen.getByRole('button', { name: /guide\.md/ });
    resultButton.focus();
    expect(resultButton).toHaveFocus();

    rerender(<WorkspaceSidebar {...props({ searching: true })} />);

    const retainedButton = screen.getByRole('button', { name: /guide\.md/ });
    expect(retainedButton).toBe(resultButton);
    expect(retainedButton).toHaveFocus();
    expect(container.querySelector('.search-results')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('搜索中…');
  });
});
