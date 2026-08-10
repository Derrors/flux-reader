import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree, { createDirectoryRequestQueue } from './FileTree';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../api', () => ({ api: { list: mocks.list } }));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function file(path) {
  return { path, name: path.split('/').pop(), type: 'file', isFile: true };
}

function root(revision, initialChildren) {
  return {
    path: '/share/docs',
    name: 'docs',
    type: 'directory',
    revision,
    initialChildren,
  };
}

describe('FileTree 工作区刷新', () => {
  beforeEach(() => mocks.list.mockReset());

  it('刷新根快照和展开的子目录时保留展开状态', async () => {
    const user = userEvent.setup();
    const directory = { path: '/share/docs/nested', name: 'nested', type: 'directory' };
    mocks.list
      .mockResolvedValueOnce({ entries: [file('/share/docs/nested/old.md')] })
      .mockResolvedValueOnce({ entries: [file('/share/docs/nested/new.md')] });

    const { rerender } = render(
      <FileTree root={root(1, [directory])} currentPath={null} onOpenFile={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /nested/ }));
    expect(await screen.findByRole('button', { name: /old\.md/ })).toBeVisible();

    rerender(<FileTree
      root={root(2, [directory, file('/share/docs/root-new.md')])}
      currentPath={null}
      onOpenFile={vi.fn()}
    />);
    expect(await screen.findByRole('button', { name: /new\.md/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /root-new\.md/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /nested/ })).toHaveTextContent('▾');
  });

  it('旧 revision 的慢目录响应不能覆盖新 revision', async () => {
    const user = userEvent.setup();
    const first = deferred();
    const directory = { path: '/share/docs/nested', name: 'nested', type: 'directory' };
    let firstSignal;
    mocks.list
      .mockImplementationOnce((_path, { signal }) => {
        firstSignal = signal;
        return first.promise;
      })
      .mockResolvedValueOnce({ entries: [file('/share/docs/nested/latest.md')] });

    const { rerender } = render(
      <FileTree root={root(1, [directory])} currentPath={null} onOpenFile={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /nested/ }));
    rerender(<FileTree root={root(2, [directory])} currentPath={null} onOpenFile={vi.fn()} />);
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: /latest\.md/ })).toBeVisible();

    await act(async () => first.resolve({ entries: [file('/share/docs/nested/stale.md')] }));
    expect(screen.queryByRole('button', { name: /stale\.md/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /latest\.md/ })).toBeVisible();
  });

  it('一个工作区最多并发四个展开目录请求', async () => {
    const queue = createDirectoryRequestQueue(4);
    const requests = Array.from({ length: 6 }, () => deferred());
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const tasks = requests.map((request) => queue.run(async () => {
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await request.promise;
      } finally {
        active -= 1;
      }
    }));

    await waitFor(() => expect(started).toBe(4));
    expect(maximumActive).toBe(4);
    requests[0].resolve({ entries: [] });
    await waitFor(() => expect(started).toBe(5));
    requests[1].resolve({ entries: [] });
    await waitFor(() => expect(started).toBe(6));
    for (const request of requests) request.resolve({ entries: [] });
    await Promise.all(tasks);
    expect(maximumActive).toBe(4);
    queue.dispose();
  });

  it('运行中的取消请求在底层任务结束前仍占用并发槽位', async () => {
    const queue = createDirectoryRequestQueue(1);
    const controller = new AbortController();
    const first = deferred();
    let secondStarted = false;
    const firstTask = queue.run(() => first.promise, { signal: controller.signal });
    const secondTask = queue.run(async () => {
      secondStarted = true;
      return 'second';
    });

    controller.abort();
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    first.resolve('first');
    await firstTask;
    await waitFor(() => expect(secondStarted).toBe(true));
    await expect(secondTask).resolves.toBe('second');
    queue.dispose();
  });

  it('使用嵌套列表语义，并标记目录展开态与当前文件', async () => {
    const user = userEvent.setup();
    const directory = { path: '/share/docs/nested', name: 'nested', type: 'directory' };
    mocks.list.mockResolvedValueOnce({ entries: [] });
    const { container } = render(
      <FileTree
        root={root(1, [file('/share/docs/current.md'), directory])}
        currentPath="/share/docs/current.md"
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('list').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'docs' })).toHaveAttribute('aria-expanded', 'true');
    const nestedButton = screen.getByRole('button', { name: 'nested' });
    expect(nestedButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'current.md' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const icon of container.querySelectorAll('.tree-icon')) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }

    await user.click(nestedButton);
    expect(nestedButton).toHaveAttribute('aria-expanded', 'true');
  });
});
