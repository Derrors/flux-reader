import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { recentStorageKey, writeRecentDocuments } from './recent-documents';

const mocks = vi.hoisted(() => ({
  api: {
    env: vi.fn(),
    list: vi.fn(),
    file: vi.fn(),
    fileState: vi.fn(),
    search: vi.fn(),
    workspaceState: vi.fn(),
    resourceUrl: vi.fn(),
  },
  trim: {
    initSdk: vi.fn(),
    pickFolder: vi.fn(),
    pickMarkdownFile: vi.fn(),
    setTitle: vi.fn(),
  },
}));

vi.mock('./api', () => ({ api: mocks.api }));
vi.mock('./trim-sdk', () => mocks.trim);
vi.mock('./markdown/MarkdownView', () => ({
  default: ({ content, resolveImageSource }) => (
    <article
      data-testid="markdown-view"
      data-resolved-image={resolveImageSource?.('images/cover.png') || ''}
    >
      {content}
    </article>
  ),
}));
vi.mock('./markdown/pipeline', () => ({ extractToc: vi.fn(() => []) }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function httpError(message, status, code = 'TEST_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const docsEntries = [
  { path: '/share/docs/a.md', name: 'a.md', type: 'file', isFile: true },
  { path: '/share/docs/b.md', name: 'b.md', type: 'file', isFile: true },
];

async function renderReady(url = '/app/flux-reader/') {
  window.history.replaceState({}, '', url);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: '打开文件' });
  return user;
}

async function openDocsFolder(user, entries = docsEntries) {
  mocks.trim.pickFolder.mockResolvedValueOnce('/share/docs');
  mocks.api.list.mockResolvedValueOnce({ entries });
  await user.click(screen.getByRole('button', { name: '打开文件夹' }));
  return screen.findByRole('navigation');
}

async function openWorkspace(user, path, entries = []) {
  mocks.trim.pickFolder.mockResolvedValueOnce(path);
  mocks.api.list.mockResolvedValueOnce({ entries });
  await user.click(screen.getByRole('button', { name: '打开文件夹' }));
  return screen.findByRole('region', { name: `工作区 ${path.split('/').filter(Boolean).pop()}` });
}

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  for (const fn of Object.values(mocks.trim)) fn.mockReset();

  mocks.trim.initSdk.mockResolvedValue({ sdk: {}, error: null });
  mocks.trim.pickFolder.mockResolvedValue(null);
  mocks.trim.pickMarkdownFile.mockResolvedValue(null);
  mocks.trim.setTitle.mockResolvedValue(undefined);
  mocks.api.env.mockResolvedValue({ openApiAvailable: true });
  mocks.api.search.mockResolvedValue({ results: [] });
  mocks.api.fileState.mockImplementation(async (path) => ({
    actualPath: path,
    size: 1,
    mtime: 1,
    ctime: 1,
  }));
  mocks.api.workspaceState.mockImplementation(async (path) => ({
    path,
    revision: `revision:${path}`,
  }));
  mocks.api.resourceUrl.mockImplementation((documentPath, resourcePath, workspacePath, revision) => (
    `/resource?document=${documentPath}&path=${resourcePath}&workspace=${workspacePath || ''}&v=${revision}`
  ));
  window.history.replaceState({}, '', '/app/flux-reader/');
  const storedValues = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key) => storedValues.get(key) ?? null),
      setItem: vi.fn((key, value) => storedValues.set(key, String(value))),
      removeItem: vi.fn((key) => storedValues.delete(key)),
      clear: vi.fn(() => storedValues.clear()),
    },
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  window.scrollTo.mockClear();
});

describe('App 文件与目录工作流', () => {
  it('等待 SDK 初始化完成后再加载环境，普通启动不枚举或展示目录', async () => {
    const sdkReady = deferred();
    mocks.trim.initSdk.mockReturnValueOnce(sdkReady.promise);

    render(<App />);
    expect(mocks.api.env).not.toHaveBeenCalled();

    await act(async () => sdkReady.resolve({ sdk: {}, error: null }));

    expect(await screen.findByRole('button', { name: '打开文件' })).toBeVisible();
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeVisible();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(mocks.api.list).not.toHaveBeenCalled();
  });

  it('OpenAPI 不可用时隐藏宿主文件入口并显示环境提示', async () => {
    mocks.api.env.mockResolvedValueOnce({ openApiAvailable: false });
    render(<App />);

    expect(await screen.findByText(/请安装到 fnOS 后打开已授权的 Markdown 文档。$/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '打开文件' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开文件夹' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '渲染示例' })).not.toBeInTheDocument();
  });

  it('打开文件夹后自动展示目录，并可隐藏和恢复', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);

    expect(mocks.api.list).toHaveBeenCalledWith('/share/docs');
    expect(within(navigation).getByRole('button', { name: /a\.md/ })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '隐藏文件目录' }));
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '显示文件目录' }));
    expect(screen.getByRole('navigation')).toBeVisible();
  });

  it('取消或校验失败时保留此前打开的目录', async () => {
    const user = await renderReady();
    await openDocsFolder(user);

    mocks.trim.pickFolder.mockResolvedValueOnce(null);
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '打开文件夹' })).toBeEnabled());
    expect(mocks.api.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('navigation')).toHaveTextContent('a.md');

    mocks.trim.pickFolder.mockResolvedValueOnce('/share/denied');
    mocks.api.list.mockRejectedValueOnce(httpError('没有目录权限', 403));
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));

    expect(await screen.findByText('没有目录权限')).toBeVisible();
    expect(screen.getByRole('navigation')).toHaveTextContent('a.md');
    expect(screen.getByRole('navigation')).not.toHaveTextContent('denied');
  });

  it('从目录树打开文件时保留左侧目录', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({ content: '来自目录树' });

    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));

    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('来自目录树');
    expect(screen.getByRole('navigation')).toBeVisible();
    expect(screen.getByRole('button', { name: '隐藏文件目录' })).toBeVisible();
  });

  it('直接打开文件成功后进入单文件态并清除左侧目录', async () => {
    const user = await renderReady();
    await openDocsFolder(user);
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/one.md');
    mocks.api.file.mockResolvedValueOnce({ content: '单文件内容' });

    await user.click(screen.getByRole('button', { name: '打开文件' }));

    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('单文件内容');
    await waitFor(() => expect(screen.queryByRole('navigation')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /文件目录/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeVisible();
  });

  it('直接文件选择取消或读取失败时保留原文档和目录', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({ content: '原文档' });
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await screen.findByText('原文档');

    mocks.trim.pickMarkdownFile.mockResolvedValueOnce(null);
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '打开文件' })).toBeEnabled());
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('原文档');
    expect(screen.getByRole('navigation')).toBeVisible();

    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/broken.md');
    mocks.api.file.mockRejectedValueOnce(httpError('读取失败', 500));
    await user.click(screen.getByRole('button', { name: '打开文件' }));

    expect(await screen.findByText('读取失败')).toBeVisible();
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('原文档');
    expect(screen.getByRole('navigation')).toBeVisible();
  });

  it.each([
    ['path', '/app/flux-reader/?path=%2Fshare%2Fa%2520b.md', '/share/a%20b.md'],
    ['file', '/app/flux-reader/?file=%2Fshare%2F%E4%B8%AD%E6%96%87.MDX', '/share/中文.MDX'],
  ])('通过 %s 参数启动时只展示目标文件且不二次解码路径', async (_key, url, expectedPath) => {
    mocks.api.file.mockResolvedValueOnce({ content: '关联打开' });
    await renderReady(url);

    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('关联打开');
    expect(mocks.api.file).toHaveBeenCalledWith(expectedPath);
    expect(screen.queryByRole('button', { name: '打开文件夹' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开文件' })).toBeVisible();
  });

  it.each([
    '/app/flux-reader/?path=docs%2Fa.md',
    '/app/flux-reader/?path=%2Fshare%2Fa.txt',
    '/app/flux-reader/?path=%2Fshare%2Fa%00.md',
  ])('忽略非法文件关联参数：%s', async (url) => {
    await renderReady(url);

    expect(mocks.api.file).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '还没有打开文档' })).toBeVisible();
  });

  it('文件 403 后从系统设置返回会重试，并保持单文件语义', async () => {
    const user = await renderReady();
    await openDocsFolder(user);
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/private.md');
    mocks.api.file
      .mockRejectedValueOnce(httpError('尚未授权', 403))
      .mockResolvedValueOnce({ content: '授权后内容' });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    expect(await screen.findByText('尚未授权')).toBeVisible();

    mocks.api.list.mockResolvedValueOnce({ entries: docsEntries });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mocks.api.file).toHaveBeenCalledTimes(2));

    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('授权后内容');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('当前目录授权被撤销后，从系统设置返回会隐藏失效目录', async () => {
    const user = await renderReady();
    await openDocsFolder(user);
    mocks.api.list.mockRejectedValueOnce(httpError('目录授权已撤销', 403));

    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText('目录授权已撤销')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('navigation')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /文件目录/ })).not.toBeInTheDocument();
  });

  it('并发打开两个目录文件时只提交最后一次请求', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    const first = deferred();
    const second = deferred();
    mocks.api.file.mockImplementation((filePath) => (
      filePath.endsWith('/a.md') ? first.promise : second.promise
    ));

    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await user.click(within(navigation).getByRole('button', { name: /b\.md/ }));
    await act(async () => second.resolve({ content: '第二个文件' }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('第二个文件');

    await act(async () => first.resolve({ content: '过期的第一个文件' }));
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('第二个文件');
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument();
  });

  it('旧单文件请求等待标题时，后来的目录文件请求可胜出且目录不会被清除', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user, [docsEntries[0]]);
    const oldTitle = deferred();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/direct.md');
    mocks.api.file.mockImplementation((filePath) => Promise.resolve({
      content: filePath.endsWith('/direct.md') ? '旧单文件' : '后来目录文件',
    }));
    mocks.trim.setTitle.mockImplementation((title) => (
      title === 'direct.md' ? oldTitle.promise : Promise.resolve()
    ));

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('旧单文件');
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await waitFor(() => expect(screen.getByTestId('markdown-view')).toHaveTextContent('后来目录文件'));

    await act(async () => oldTitle.resolve());
    await waitFor(() => expect(screen.getByRole('button', { name: '打开文件' })).toBeEnabled());
    expect(screen.getByRole('navigation')).toBeVisible();
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('后来目录文件');
  });

  it('一个选择器打开期间禁用两个入口，避免文件与目录选择器并发', async () => {
    const user = await renderReady();
    const picker = deferred();
    mocks.trim.pickMarkdownFile.mockReturnValueOnce(picker.promise);

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择中…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '打开文件夹' })).toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(mocks.trim.pickFolder).not.toHaveBeenCalled();

    await act(async () => picker.resolve(null));
    await waitFor(() => expect(screen.getByRole('button', { name: '打开文件' })).toBeEnabled());
  });

  it('0 字节 Markdown 仍视为已成功打开的文档', async () => {
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/empty.md');
    mocks.api.file.mockResolvedValueOnce({ content: '' });

    await user.click(screen.getByRole('button', { name: '打开文件' }));

    expect(await screen.findByTestId('markdown-view')).toBeEmptyDOMElement();
    expect(screen.queryByRole('heading', { name: '还没有打开文档' })).not.toBeInTheDocument();
  });

  it('环境探测失败时显示错误且不暴露宿主文件入口', async () => {
    mocks.api.env.mockRejectedValueOnce(new Error('环境不可用'));
    render(<App />);

    expect(await screen.findByText('环境不可用')).toBeVisible();
    expect(screen.queryByRole('button', { name: '打开文件' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开文件夹' })).not.toBeInTheDocument();
  });
});

describe('App fnOS 能力补齐', () => {
  it('同时保留多个工作区，规范化重复路径，并可独立刷新和关闭', async () => {
    const user = await renderReady();
    const oneEntries = [
      { path: '/share/one/a.md', name: 'a.md', type: 'file', isFile: true },
    ];
    const twoEntries = [
      { path: '/share/two/b.md', name: 'b.md', type: 'file', isFile: true },
    ];
    await openWorkspace(user, '/share/one', oneEntries);
    await openWorkspace(user, '/share/two/', twoEntries);

    expect(screen.getByRole('region', { name: '工作区 one' })).toHaveTextContent('a.md');
    expect(screen.getByRole('region', { name: '工作区 two' })).toHaveTextContent('b.md');

    // A trailing slash identifies the same workspace and replaces its snapshot.
    mocks.trim.pickFolder.mockResolvedValueOnce('/share/one/');
    mocks.api.list.mockResolvedValueOnce({
      entries: [{ path: '/share/one/new.md', name: 'new.md', type: 'file', isFile: true }],
    });
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(screen.getAllByRole('region', { name: '工作区 one' })).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: '工作区 one' })).toHaveTextContent('new.md');
    });

    mocks.api.file.mockResolvedValueOnce({ content: '工作区一的文档', mtime: 1 });
    await user.click(within(screen.getByRole('region', { name: '工作区 one' }))
      .getByRole('button', { name: /new\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('工作区一的文档');

    mocks.api.workspaceState.mockResolvedValueOnce({ revision: 'two:2' });
    mocks.api.list.mockResolvedValueOnce({
      entries: [{ path: '/share/two/c.md', name: 'c.md', type: 'file', isFile: true }],
    });
    await user.click(screen.getByRole('button', { name: '刷新工作区 two' }));
    expect(await within(screen.getByRole('region', { name: '工作区 two' }))
      .findByRole('button', { name: /c\.md/ })).toBeVisible();
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('工作区一的文档');

    await user.click(screen.getByRole('button', { name: '关闭工作区 two' }));
    expect(screen.queryByRole('region', { name: '工作区 two' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '工作区 one' })).toBeVisible();
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('工作区一的文档');
  });

  it('第九个或读取失败的工作区不会破坏现有八个工作区', async () => {
    const user = await renderReady();
    for (let index = 1; index <= 8; index += 1) {
      await openWorkspace(user, `/share/w${index}`);
    }
    expect(screen.getAllByRole('region', { name: /^工作区 w/ })).toHaveLength(8);

    mocks.trim.pickFolder.mockResolvedValueOnce('/share/alias-w1');
    mocks.api.list.mockResolvedValueOnce({ actualPath: '/share/w1', entries: [] });
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(screen.getAllByRole('region', { name: /^工作区 / })).toHaveLength(8);
    expect(screen.getByRole('region', { name: '工作区 alias-w1' })).toBeVisible();

    mocks.trim.pickFolder.mockResolvedValueOnce('/share/w9');
    mocks.api.list.mockResolvedValueOnce({ actualPath: '/share/w9', entries: [] });
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(await screen.findByText(/最多同时打开 8 个工作区/)).toBeVisible();
    expect(mocks.api.list).toHaveBeenCalledTimes(10);
    expect(screen.getAllByRole('region', { name: /^工作区 / })).toHaveLength(8);

    await user.click(screen.getByRole('button', { name: '关闭工作区 w8' }));
    mocks.trim.pickFolder.mockResolvedValueOnce('/share/broken');
    mocks.api.list.mockRejectedValueOnce(httpError('工作区读取失败', 500));
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(await screen.findByText('工作区读取失败')).toBeVisible();
    expect(screen.getAllByRole('region', { name: /^工作区 / })).toHaveLength(7);
  });

  it('跨所有工作区搜索文件名与正文，较旧响应不能覆盖新查询', async () => {
    const user = await renderReady();
    await openWorkspace(user, '/share/one');
    await openWorkspace(user, '/share/two');

    const oldSearch = deferred();
    mocks.api.search.mockImplementation((_paths, query) => {
      if (query === 'old') return oldSearch.promise;
      return Promise.resolve({
        results: [{
          path: '/share/two/New.md',
          name: 'New.md',
          displayPath: 'New.md',
          snippet: '正文里包含 new needle',
          matchKind: 'content',
          workspacePath: '/share/two',
        }],
      });
    });

    const searchbox = screen.getByRole('searchbox', { name: '搜索文件名和正文' });
    await user.type(searchbox, 'old');
    await waitFor(() => expect(mocks.api.search).toHaveBeenCalledWith(
      ['/share/one', '/share/two'],
      'old',
      100,
      { signal: expect.any(AbortSignal) },
    ));
    const oldSignal = mocks.api.search.mock.calls.at(-1)[3].signal;
    await user.clear(searchbox);
    await user.type(searchbox, 'new');

    expect(await screen.findByText('正文里包含 new needle')).toBeVisible();
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByText('正文 · two · New.md')).toBeVisible();
    await act(async () => oldSearch.resolve({
      results: [{
        path: '/share/one/Old.md',
        name: 'Old.md',
        snippet: '过期结果',
        matchKind: 'fileName',
        workspacePath: '/share/one',
      }],
    }));
    expect(screen.queryByText('过期结果')).not.toBeInTheDocument();

    mocks.api.file.mockResolvedValueOnce({ content: '搜索打开的文档', mtime: 2 });
    await user.click(screen.getByRole('button', { name: /New\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('搜索打开的文档');
    expect(screen.getByRole('region', { name: '工作区 one' })).toBeVisible();
    expect(screen.getByRole('region', { name: '工作区 two' })).toBeVisible();
  });

  it('使用后端规范路径关联别名工作区、搜索结果与相对图片', async () => {
    const user = await renderReady();
    mocks.trim.pickFolder.mockResolvedValueOnce('/share/docs-link');
    mocks.api.list.mockResolvedValueOnce({
      actualPath: '/volume/real/docs',
      entries: [{
        path: '/volume/real/docs/a.md', name: 'a.md', type: 'file', isFile: true,
      }],
    });
    mocks.api.workspaceState.mockResolvedValueOnce({
      path: '/share/docs-link',
      actualPath: '/volume/real/docs',
      revision: 'tree:1',
    });
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(await screen.findByRole('region', { name: '工作区 docs-link' })).toBeVisible();

    mocks.api.search.mockResolvedValueOnce({
      results: [{
        path: '/volume/real/docs/a.md',
        name: 'a.md',
        displayPath: 'a.md',
        snippet: '来自规范目录的命中',
        matchKind: 'content',
        workspacePath: '/share/docs-link',
      }],
    });
    await user.type(screen.getByRole('searchbox', { name: '搜索文件名和正文' }), 'needle');
    expect(await screen.findByText('来自规范目录的命中')).toBeVisible();
    expect(mocks.api.search).toHaveBeenLastCalledWith(
      ['/share/docs-link'],
      'needle',
      100,
      { signal: expect.any(AbortSignal) },
    );

    mocks.api.file.mockResolvedValueOnce({
      content: '![封面](images/cover.png)',
      actualPath: '/volume/real/docs/a.md',
      size: 5,
      mtime: 5,
      ctime: 5,
    });
    await user.click(screen.getByText('来自规范目录的命中').closest('button'));

    await waitFor(() => expect(mocks.api.resourceUrl).toHaveBeenLastCalledWith(
      '/volume/real/docs/a.md',
      'images/cover.png',
      '/volume/real/docs',
      '5:tree:1',
    ));
    expect(screen.getByRole('region', { name: '工作区 docs-link' })).toBeVisible();
  });

  it('最近文稿按 uid 校验后恢复，移除与清空会同步持久化', async () => {
    mocks.api.env.mockResolvedValueOnce({ openApiAvailable: true, uid: 'user-a' });
    writeRecentDocuments('user-a', [
      { path: '/share/valid.md', name: 'valid.md', displayPath: '/share/valid.md', type: 'file', openedAt: 3 },
      { path: '/share/revoked.md', name: 'revoked.md', displayPath: '/share/revoked.md', type: 'file', openedAt: 2 },
      { path: '/share/transient.md', name: 'transient.md', displayPath: '/share/transient.md', type: 'file', openedAt: 1 },
    ]);
    mocks.api.fileState.mockImplementation((path) => {
      if (path.endsWith('/revoked.md')) return Promise.reject(httpError('已撤权', 403));
      if (path.endsWith('/transient.md')) return Promise.reject(httpError('暂时不可用', 500));
      return Promise.resolve({ actualPath: path, size: 3, mtime: 3, ctime: 3 });
    });
    mocks.api.file.mockResolvedValue({
      content: '有效内容', actualPath: '/share/valid.md', size: 3, mtime: 3, ctime: 3,
    });

    const user = await renderReady();
    const toggle = await screen.findByRole('button', { name: '显示最近文稿' });
    await user.click(toggle);
    const navigation = screen.getByRole('navigation');
    expect(within(navigation).getByTitle('/share/valid.md')).toBeVisible();
    expect(within(navigation).queryByText('revoked.md')).not.toBeInTheDocument();
    expect(within(navigation).queryByText('transient.md')).not.toBeInTheDocument();

    const storedAfterValidation = JSON.parse(
      window.localStorage.getItem(recentStorageKey('user-a')),
    );
    expect(storedAfterValidation.map((item) => item.path)).toEqual([
      '/share/valid.md',
      '/share/transient.md',
    ]);

    await user.click(within(navigation).getByTitle('/share/valid.md'));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('有效内容');
    await user.click(screen.getByRole('button', { name: '从最近文稿移除 valid.md' }));
    expect(screen.queryByTitle('/share/valid.md')).not.toBeInTheDocument();

    // A newly and successfully read document is persisted; failed reads are not.
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/new.md');
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    await user.click(screen.getByRole('button', { name: '显示最近文稿' }));
    expect(screen.getByTitle('/share/new.md')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '清空' }));
    expect(JSON.parse(window.localStorage.getItem(recentStorageKey('user-a')))).toEqual([]);
  });

  it('文件关联启动与最近文稿校验并发时，新打开文件保持首位且不被覆盖', async () => {
    mocks.api.env.mockResolvedValueOnce({ openApiAvailable: true, uid: 'user-a' });
    writeRecentDocuments('user-a', [{
      path: '/share/old.md',
      name: 'old.md',
      displayPath: '/share/old.md',
      type: 'file',
      openedAt: 1,
    }]);
    const oldValidation = deferred();
    mocks.api.fileState.mockReturnValue(oldValidation.promise);
    mocks.api.file.mockResolvedValue({
      content: '关联打开的新文件',
      actualPath: '/share/new.md',
      size: 10,
      mtime: 10,
      ctime: 10,
    });

    await renderReady('/app/flux-reader/?path=%2Fshare%2Fnew.md');
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('关联打开的新文件');
    await act(async () => oldValidation.resolve({
      actualPath: '/share/old.md', size: 1, mtime: 1, ctime: 1,
    }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(recentStorageKey('user-a')));
      expect(stored.map((item) => item.path)).toEqual(['/share/new.md', '/share/old.md']);
    });
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('关联打开的新文件');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('最近文稿元数据校验最多并发三个请求', async () => {
    mocks.api.env.mockResolvedValueOnce({ openApiAvailable: true, uid: 'user-a' });
    const paths = Array.from({ length: 6 }, (_value, index) => `/share/${index}.md`);
    writeRecentDocuments('user-a', paths.map((path, index) => ({
      path,
      name: `${index}.md`,
      displayPath: path,
      type: 'file',
      openedAt: paths.length - index,
    })));
    const validations = paths.map(() => deferred());
    let active = 0;
    let maximumActive = 0;
    mocks.api.fileState.mockImplementation((path) => {
      const index = paths.indexOf(path);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return validations[index].promise.finally(() => { active -= 1; });
    });

    await renderReady();
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledTimes(3));
    expect(maximumActive).toBe(3);

    await act(async () => validations[0].resolve({
      actualPath: paths[0], size: 1, mtime: 1, ctime: 1,
    }));
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledTimes(4));
    expect(maximumActive).toBe(3);

    await act(async () => {
      for (const [index, validation] of validations.entries()) {
        validation.resolve({ actualPath: paths[index], size: 1, mtime: 1, ctime: 1 });
      }
    });
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledTimes(6));
    expect(maximumActive).toBe(3);
  });

  it('hydration 按后端规范路径合并同一文稿的多个别名', async () => {
    mocks.api.env.mockResolvedValueOnce({ openApiAvailable: true, uid: 'user-a' });
    writeRecentDocuments('user-a', [
      {
        path: '/share/link.md',
        name: 'link.md',
        displayPath: '/share/link.md',
        type: 'file',
        openedAt: 2,
      },
      {
        path: '/volume/docs/readme.md',
        name: 'readme.md',
        displayPath: '/volume/docs/readme.md',
        type: 'file',
        openedAt: 1,
      },
    ]);
    mocks.api.fileState.mockResolvedValue({
      actualPath: '/volume/docs/readme.md', size: 1, mtime: 1, ctime: 1,
    });

    const user = await renderReady();
    await user.click(await screen.findByRole('button', { name: '显示最近文稿' }));

    expect(screen.getAllByRole('button', { name: /从最近文稿移除/ })).toHaveLength(1);
    expect(screen.getByTitle('/share/link.md')).toBeVisible();
    expect(screen.queryByTitle('/volume/docs/readme.md')).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(recentStorageKey('user-a')))
      .map((item) => item.path)).toEqual(['/share/link.md']);
  });

  it('移除手动打开的文稿后，慢速 hydration 不会把它重新写回', async () => {
    mocks.api.env.mockResolvedValueOnce({ openApiAvailable: true, uid: 'user-a' });
    writeRecentDocuments('user-a', [{
      path: '/share/slow.md',
      name: 'slow.md',
      displayPath: '/share/slow.md',
      type: 'file',
      openedAt: 1,
    }]);
    const validation = deferred();
    mocks.api.fileState.mockReturnValueOnce(validation.promise);
    mocks.api.file.mockResolvedValueOnce({
      content: '手动打开',
      actualPath: '/share/slow.md',
      size: 2,
      mtime: 2,
      ctime: 2,
    });

    const user = await renderReady();
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledWith('/share/slow.md'));
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/slow.md');
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('手动打开');
    await user.click(screen.getByRole('button', { name: '显示最近文稿' }));
    await user.click(screen.getByRole('button', { name: '从最近文稿移除 slow.md' }));

    await act(async () => validation.resolve({
      actualPath: '/share/slow.md', size: 2, mtime: 2, ctime: 2,
    }));
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(recentStorageKey('user-a')))).toEqual([]);
    });
    expect(screen.queryByRole('button', {
      name: '从最近文稿移除 slow.md',
    })).not.toBeInTheDocument();
  });

  it('相对图片始终使用当前最深工作区，关闭后回退到外层与单文件语义', async () => {
    const user = await renderReady();
    await openWorkspace(user, '/share', [{
      path: '/share/outer.md', name: 'outer.md', type: 'file', isFile: true,
    }]);
    const nested = await openWorkspace(user, '/share/docs', [{
      path: '/share/docs/a.md', name: 'a.md', type: 'file', isFile: true,
    }]);
    mocks.api.file.mockResolvedValueOnce({ content: '![封面](images/cover.png)', mtime: 10 });
    await user.click(within(nested).getByRole('button', { name: /a\.md/ }));

    await waitFor(() => expect(mocks.api.resourceUrl).toHaveBeenLastCalledWith(
      '/share/docs/a.md',
      'images/cover.png',
      '/share/docs',
      '10:revision:/share/docs',
    ));
    await user.click(screen.getByRole('button', { name: '关闭工作区 docs' }));
    expect(mocks.api.resourceUrl).toHaveBeenLastCalledWith(
      '/share/docs/a.md',
      'images/cover.png',
      '/share',
      '10:revision:/share',
    );
    await user.click(screen.getByRole('button', { name: '关闭工作区 share' }));
    expect(mocks.api.resourceUrl).toHaveBeenLastCalledWith(
      '/share/docs/a.md',
      'images/cover.png',
      undefined,
      '10:',
    );
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('![封面]');
  });

  it.each([
    [403, '当前文稿授权已撤销'],
    [413, '当前文稿已超过大小限制'],
  ])('轮询当前文稿遇到明确不可读状态 %s 时清除旧正文', async (status, message) => {
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/a.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '不应残留的旧正文',
      actualPath: '/share/a.md',
      size: 1,
      mtime: 1,
      ctime: 1,
    });
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('不应残留的旧正文');

    mocks.api.fileState.mockRejectedValueOnce(httpError(message, status));
    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText(message)).toBeVisible();
    await waitFor(() => expect(screen.queryByTestId('markdown-view')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Flux Reader' })).toBeVisible();
    expect(mocks.trim.setTitle).toHaveBeenLastCalledWith('Flux Reader');
  });

  it('独立文稿正文未变但同目录图片变化时，只按资源树 revision 刷新图片 URL', async () => {
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/link/a.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '![封面](images/cover.png)',
      actualPath: '/volume/docs/a.md',
      size: 8,
      mtime: 1,
      ctime: 1,
    });
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    expect(await screen.findByTestId('markdown-view')).toHaveAttribute(
      'data-resolved-image',
      '/resource?document=/share/link/a.md&path=images/cover.png&workspace=&v=1:',
    );
    mocks.api.fileState.mockResolvedValue({
      actualPath: '/volume/docs/a.md', size: 8, mtime: 1, ctime: 1,
    });

    mocks.api.workspaceState.mockResolvedValueOnce({
      actualPath: '/volume/docs', revision: 'tree:1',
    });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.getByTestId('markdown-view')).toHaveAttribute(
      'data-resolved-image',
      '/resource?document=/share/link/a.md&path=images/cover.png&workspace=&v=1:tree:1',
    ));
    expect(mocks.api.workspaceState).toHaveBeenLastCalledWith('/volume/docs');
    expect(mocks.api.file).toHaveBeenCalledTimes(1);

    mocks.api.workspaceState.mockResolvedValueOnce({
      actualPath: '/volume/docs', revision: 'tree:1',
    });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mocks.api.workspaceState).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('markdown-view')).toHaveAttribute(
      'data-resolved-image',
      '/resource?document=/share/link/a.md&path=images/cover.png&workspace=&v=1:tree:1',
    );
    expect(mocks.api.file).toHaveBeenCalledTimes(1);

    mocks.api.workspaceState.mockResolvedValueOnce({
      actualPath: '/volume/docs', revision: 'tree:2',
    });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.getByTestId('markdown-view')).toHaveAttribute(
      'data-resolved-image',
      '/resource?document=/share/link/a.md&path=images/cover.png&workspace=&v=2:tree:2',
    ));
    expect(mocks.api.file).toHaveBeenCalledTimes(1);
  });

  it('15 秒轮询按 workspace revision 更新文件树和当前文档，隐藏页面暂停', async () => {
    const realSetTimeout = window.setTimeout.bind(window);
    let pollCallback = null;
    const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 15_000) {
        pollCallback = () => callback(...args);
        return 987_654;
      }
      return realSetTimeout(callback, delay, ...args);
    });
    const user = await renderReady();
    try {
      await waitFor(() => expect(pollCallback).toBeTypeOf('function'));

      mocks.trim.pickFolder.mockResolvedValueOnce('/share/docs');
      mocks.api.list.mockResolvedValueOnce({ entries: docsEntries });
      await user.click(screen.getByRole('button', { name: '打开文件夹' }));
      mocks.api.file.mockResolvedValueOnce({ content: '轮询前', mtime: 1 });
      await user.click(screen.getByRole('button', { name: /a\.md/ }));
      expect(screen.getByTestId('markdown-view')).toHaveTextContent('轮询前');

      mocks.api.workspaceState.mockResolvedValueOnce({ revision: 'changed:2' });
      mocks.api.list.mockResolvedValueOnce({
        entries: [{ path: '/share/docs/c.md', name: 'c.md', type: 'file', isFile: true }],
      });
      mocks.api.file.mockResolvedValueOnce({ content: '轮询后', mtime: 2 });
      mocks.api.fileState.mockResolvedValueOnce({
        actualPath: '/share/docs/a.md', size: 2, mtime: 2, ctime: 2,
      });
      await act(async () => pollCallback());

      expect(screen.getByRole('button', { name: /c\.md/ })).toBeVisible();
      expect(screen.queryByRole('button', { name: /b\.md/ })).not.toBeInTheDocument();
      expect(screen.getByTestId('markdown-view')).toHaveTextContent('轮询后');

      const stateCalls = mocks.api.workspaceState.mock.calls.length;
      const fileCalls = mocks.api.file.mock.calls.length;
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      await act(async () => pollCallback());
      expect(mocks.api.workspaceState).toHaveBeenCalledTimes(stateCalls);
      expect(mocks.api.file).toHaveBeenCalledTimes(fileCalls);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('在途自动刷新不重叠，且旧文档响应不能覆盖用户后来打开的文件', async () => {
    const realSetTimeout = window.setTimeout.bind(window);
    let pollCallback = null;
    const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 15_000) {
        pollCallback = () => callback(...args);
        return 987_655;
      }
      return realSetTimeout(callback, delay, ...args);
    });
    const user = await renderReady();
    try {
      await waitFor(() => expect(pollCallback).toBeTypeOf('function'));
      mocks.trim.pickFolder.mockResolvedValueOnce('/share/docs');
      mocks.api.list.mockResolvedValueOnce({ entries: docsEntries });
      await user.click(screen.getByRole('button', { name: '打开文件夹' }));

      const stalePoll = deferred();
      let aReads = 0;
      mocks.api.file.mockImplementation((path) => {
        if (path.endsWith('/b.md')) return Promise.resolve({ content: '用户选择的 B', mtime: 3 });
        aReads += 1;
        return aReads === 1
          ? Promise.resolve({ content: '原来的 A', mtime: 1 })
          : stalePoll.promise;
      });
      await user.click(screen.getByRole('button', { name: /a\.md/ }));
      expect(screen.getByTestId('markdown-view')).toHaveTextContent('原来的 A');

      // Unchanged workspace token means the cycle proceeds directly to /file.
      mocks.api.workspaceState.mockResolvedValueOnce({ revision: 'revision:/share/docs' });
      mocks.api.fileState.mockResolvedValueOnce({
        actualPath: '/share/docs/a.md', size: 2, mtime: 2, ctime: 2,
      });
      let cyclePromise;
      act(() => {
        cyclePromise = pollCallback();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(aReads).toBe(2);

      // The recursive scheduler does not enqueue its next tick while this one
      // still awaits /file, so two cycles can never overlap.
      expect(timeoutSpy.mock.calls.filter((call) => call[1] === 15_000)).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: /b\.md/ }));
      expect(screen.getByTestId('markdown-view')).toHaveTextContent('用户选择的 B');
      await act(async () => {
        stalePoll.resolve({ content: '过期轮询 A', mtime: 2 });
        await cyclePromise;
      });
      expect(screen.getByTestId('markdown-view')).toHaveTextContent('用户选择的 B');
      expect(timeoutSpy.mock.calls.filter((call) => call[1] === 15_000)).toHaveLength(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
