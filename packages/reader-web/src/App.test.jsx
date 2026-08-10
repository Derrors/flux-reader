import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { writeDocumentSession } from './document-session';
import { recentStorageKey, writeRecentDocuments } from './recent-documents';
import { draftStorageKey, readDraft, writeDraft } from './draft-storage';

const mocks = vi.hoisted(() => ({
  api: {
    env: vi.fn(),
    list: vi.fn(),
    file: vi.fn(),
    saveFile: vi.fn(),
    recoveryState: vi.fn(),
    recoveryVersion: vi.fn(),
    commitRecovery: vi.fn(),
    discardRecovery: vi.fn(),
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

function abortOptions() {
  return expect.objectContaining({ signal: expect.any(Object) });
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

async function openEditableFile(user, {
  path = '/share/a.md',
  content = '磁盘正文',
  revision = 'a'.repeat(64),
  actualPath = path,
} = {}) {
  mocks.trim.pickMarkdownFile.mockResolvedValueOnce(path);
  mocks.api.file.mockResolvedValueOnce({
    content,
    actualPath,
    size: new TextEncoder().encode(content).byteLength,
    mtime: 1,
    ctime: 1,
    revision,
  });
  await user.click(screen.getByRole('button', { name: '打开文件' }));
  await screen.findByTestId('markdown-view');
  await user.click(screen.getByRole('button', { name: '编辑' }));
  return screen.findByRole('textbox', { name: 'Markdown 编辑器' });
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
  mocks.api.saveFile.mockImplementation(async (path, content) => ({
    content,
    actualPath: path,
    size: new TextEncoder().encode(content).byteLength,
    mtime: 2,
    ctime: 2,
    revision: 'b'.repeat(64),
  }));
  mocks.api.recoveryState.mockResolvedValue({ available: false, records: [] });
  mocks.api.recoveryVersion.mockResolvedValue({ content: '' });
  mocks.api.commitRecovery.mockImplementation(async (path) => ({
    actualPath: path,
    size: 1,
    mtime: 2,
    ctime: 2,
    revision: 'b'.repeat(64),
    writable: true,
  }));
  mocks.api.discardRecovery.mockResolvedValue({ discarded: true });
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
    expect(mocks.api.file).toHaveBeenCalledWith(expectedPath, abortOptions());
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

  it('授权回程把新文稿打开为标签页，并保留原标签的 dirty 草稿', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user, { content: 'A' });
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/private.md');
    mocks.api.file.mockRejectedValueOnce(httpError('尚未授权', 403));
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    expect(await screen.findByText('尚未授权')).toBeVisible();

    await user.type(editor, ' dirty');
    mocks.api.fileState.mockResolvedValue({
      actualPath: '/share/a.md',
      size: 1,
      mtime: 1,
      ctime: 1,
      revision: 'a'.repeat(64),
    });
    mocks.api.file.mockResolvedValueOnce({
      content: '授权后内容',
      actualPath: '/share/private.md',
      size: 5,
      mtime: 1,
      ctime: 1,
      revision: 'b'.repeat(64),
    });
    act(() => window.dispatchEvent(new Event('focus')));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('授权后内容');
    expect(mocks.api.file.mock.calls.filter(([path]) => path === '/share/private.md')).toHaveLength(2);
    expect(screen.queryByRole('dialog', { name: '保存修改？' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /a\.md/ }));
    expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('A dirty');
    expect(screen.getByRole('tab', { name: /a\.md/ })).toHaveTextContent('●');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledWith(
      '/share/a.md',
      abortOptions(),
    ));
    expect(mocks.api.file.mock.calls.filter(([path]) => path === '/share/private.md')).toHaveLength(2);
    expect(screen.queryByRole('dialog', { name: '保存修改？' })).not.toBeInTheDocument();
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
    let firstSignal;
    mocks.api.file.mockImplementation((filePath, options) => {
      if (filePath.endsWith('/a.md')) {
        firstSignal = options?.signal;
        return first.promise;
      }
      return second.promise;
    });

    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await user.click(within(navigation).getByRole('button', { name: /b\.md/ }));
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => second.resolve({ content: '第二个文件' }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('第二个文件');

    await act(async () => first.resolve({ content: '过期的第一个文件' }));
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('第二个文件');
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument();
  });

  it('组件卸载会取消尚未完成的文档读取', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let signal;
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/pending.md');
    mocks.api.file.mockImplementationOnce((_path, options) => {
      signal = options?.signal;
      return pending.promise;
    });

    const rendered = render(<App />);
    await screen.findByRole('button', { name: '打开文件' });
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal.aborted).toBe(false);

    rendered.unmount();
    expect(signal.aborted).toBe(true);
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
    expect(within(navigation).queryByTitle('/share/valid.md')).not.toBeInTheDocument();

    // A newly and successfully read document is persisted; failed reads are not.
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/new.md');
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    await user.click(screen.getByRole('button', { name: '显示最近文稿' }));
    expect(within(screen.getByRole('navigation', { name: '工作区与最近文稿' }))
      .getByTitle('/share/new.md')).toBeVisible();
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
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledWith(
      '/share/slow.md',
      abortOptions(),
    ));
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

describe('App fnOS 编辑、保存与恢复', () => {
  it('只读文稿不允许进入编辑或保存', async () => {
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/read-only.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '# 只读',
      actualPath: '/share/read-only.md',
      size: 8,
      mtime: 1,
      ctime: 1,
      revision: 'a'.repeat(64),
      writable: false,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));

    expect(await screen.findByRole('button', { name: '只读' })).toBeDisabled();
    expect(screen.getByText(/当前文稿只读/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Markdown 编辑器' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
  });

  it('编辑空文档并通过按钮或 Cmd/Ctrl+S 安全保存', async () => {
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    const user = await renderReady();
    const editor = await openEditableFile(user, { content: '' });
    expect(editor).toHaveValue('');

    await user.type(editor, '# 新文稿');
    expect(screen.getByRole('heading', { name: /a\.md •/ })).toBeVisible();
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => expect(mocks.api.saveFile).toHaveBeenCalledWith(
      '/share/a.md',
      '# 新文稿',
      'a'.repeat(64),
    ));
    expect(await screen.findByText('已保存')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(window.localStorage.removeItem).toHaveBeenCalledWith(
      draftStorageKey('user-a', '/share/a.md'),
    );

    await user.click(screen.getByRole('button', { name: '预览' }));
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('# 新文稿');
  });

  it('保存中继续编辑时只提交快照并保留后续草稿', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user);
    await user.clear(editor);
    await user.type(editor, '第一次修改');
    const save = deferred();
    mocks.api.saveFile.mockReturnValueOnce(save.promise);

    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(mocks.api.saveFile).toHaveBeenCalledWith(
      '/share/a.md', '第一次修改', 'a'.repeat(64),
    );
    fireEvent.change(editor, { target: { value: '保存期间的第二次修改' } });
    await act(async () => save.resolve({
      content: '第一次修改',
      actualPath: '/share/a.md',
      size: 6,
      mtime: 2,
      ctime: 2,
      revision: 'b'.repeat(64),
    }));

    expect(editor).toHaveValue('保存期间的第二次修改');
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: /a\.md •/ })).toBeVisible();
  });

  it('发送保存请求前同步落盘当前草稿快照', async () => {
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    const user = await renderReady();
    const editor = await openEditableFile(user, { actualPath: '/volume/docs/a.md' });
    await user.clear(editor);
    await user.type(editor, '立即保存的草稿');
    const save = deferred();
    mocks.api.saveFile.mockReturnValueOnce(save.promise);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(readDraft('user-a', '/volume/docs/a.md')).toMatchObject({
      content: '立即保存的草稿',
      sourceRevision: 'a'.repeat(64),
    });
    await act(async () => save.reject(httpError('后端中断', 503)));
    expect(readDraft('user-a', '/volume/docs/a.md')?.content).toBe('立即保存的草稿');
  });

  it('多标签切换保留草稿；保存期间禁止切换且新编辑继续保持 dirty', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({
      content: 'A', actualPath: '/share/docs/a.md', size: 1, mtime: 1, ctime: 1,
      revision: 'a'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: 'Markdown 编辑器' });
    await user.clear(editor);
    await user.type(editor, 'A 草稿');

    mocks.api.file.mockResolvedValueOnce({
      content: 'B', actualPath: '/share/docs/b.md', size: 1, mtime: 1, ctime: 1,
      revision: 'c'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /b\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('B');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    await user.click(screen.getByRole('tab', { name: /a\.md/ }));
    const activeEditor = screen.getByRole('textbox', { name: 'Markdown 编辑器' });
    expect(activeEditor).toHaveValue('A 草稿');

    const save = deferred();
    mocks.api.saveFile.mockReturnValueOnce(save.promise);
    await user.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.change(activeEditor, { target: { value: '保存中的新草稿' } });
    expect(screen.getByRole('tab', { name: /b\.md/ })).toBeDisabled();
    await act(async () => save.resolve({
      content: 'A 草稿', actualPath: '/share/docs/a.md', size: 7, mtime: 2, ctime: 2,
      revision: 'b'.repeat(64),
    }));

    expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' }))
      .toHaveValue('保存中的新草稿');
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    await user.click(screen.getByRole('tab', { name: /b\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('B');
  });

  it('关闭 dirty 标签提供保存、放弃和取消防丢稿流程', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({
      content: 'A', actualPath: '/share/docs/a.md', size: 1, mtime: 1, ctime: 1,
      revision: 'a'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.type(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), ' dirty');

    mocks.api.file.mockResolvedValueOnce({
      content: 'B', actualPath: '/share/docs/b.md', size: 1, mtime: 1, ctime: 1,
      revision: 'b'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /b\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('B');
    await user.click(screen.getByRole('button', { name: '关闭 a.md' }));
    const dialog = await screen.findByRole('dialog', { name: '保存修改？' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('A dirty');
    expect(screen.getByRole('tab', { name: /a\.md/ })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '关闭 a.md' }));
    await user.click(within(await screen.findByRole('dialog', { name: '保存修改？' }))
      .getByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /a\.md/ }))
      .not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /b\.md/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('关闭未激活的干净标签不会切换当前文稿', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({
      content: 'A', actualPath: '/share/docs/a.md', size: 1, mtime: 1, ctime: 1,
      revision: 'a'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    mocks.api.file.mockResolvedValueOnce({
      content: 'B', actualPath: '/share/docs/b.md', size: 1, mtime: 1, ctime: 1,
      revision: 'b'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /b\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('B');

    await user.click(screen.getByRole('button', { name: '关闭 a.md' }));

    expect(screen.queryByRole('tab', { name: /a\.md/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /b\.md/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('B');
  });

  it('关闭工作区只移除导航，保留当前文稿和未保存草稿', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({
      content: 'A', actualPath: '/share/docs/a.md', size: 1, mtime: 1, ctime: 1,
      revision: 'a'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: 'Markdown 编辑器' });
    await user.type(editor, ' dirty');

    await user.click(screen.getByRole('button', { name: '关闭工作区 docs' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: '工作区 docs' }))
      .not.toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: '保存修改？' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('A dirty');
    expect(screen.getByRole('heading', { name: /a\.md •/ })).toBeVisible();
  });

  it('保存冲突时只显示一个模态框，并在处理前禁用标签切换', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({
      content: 'A', actualPath: '/share/docs/a.md', size: 1, mtime: 1, ctime: 1,
      revision: 'a'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.type(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), ' dirty');

    mocks.api.file.mockResolvedValueOnce({
      content: 'B', actualPath: '/share/docs/b.md', size: 1, mtime: 1, ctime: 1,
      revision: 'c'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /b\.md/ }));
    await screen.findByText('B');
    await user.click(screen.getByRole('tab', { name: /a\.md/ }));

    mocks.api.saveFile.mockRejectedValueOnce(httpError('文件已变化', 409, 'FILE_CONFLICT'));
    mocks.api.file.mockResolvedValueOnce({
      content: '磁盘新版本', actualPath: '/share/docs/a.md', size: 5, mtime: 2, ctime: 2,
      revision: 'b'.repeat(64),
    });
    await user.click(screen.getByRole('button', { name: '保存' }));

    const conflictDialog = await screen.findByRole('dialog', { name: '文稿已在其他位置修改' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /b\.md/ })).toBeDisabled();
    await user.click(within(conflictDialog).getByRole('button', { name: '保留草稿' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /b\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('B');
  });

  it('FILE_CONFLICT 后不覆盖磁盘，保留草稿会以最新 revision 再保存', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user);
    await user.clear(editor);
    await user.type(editor, '我的草稿');
    mocks.api.saveFile.mockRejectedValueOnce(httpError('文件已变化', 409, 'FILE_CONFLICT'));
    mocks.api.file.mockResolvedValueOnce({
      content: '外部新版本',
      actualPath: '/share/a.md',
      size: 5,
      mtime: 2,
      ctime: 2,
      revision: 'b'.repeat(64),
    });

    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByRole('dialog', { name: '文稿已在其他位置修改' });
    expect(editor).toHaveValue('我的草稿');
    await user.click(within(dialog).getByRole('button', { name: '保留草稿' }));
    expect(editor).toHaveValue('我的草稿');

    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(mocks.api.saveFile).toHaveBeenLastCalledWith(
      '/share/a.md', '我的草稿', 'b'.repeat(64),
    );
  });

  it('路径或授权在保存过程中变化时只报错，不把其他 409 当成可覆盖冲突', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user);
    await user.type(editor, ' dirty');
    mocks.api.saveFile.mockRejectedValueOnce(
      httpError('保存期间路径发生变化', 409, 'PATH_CHANGED_DURING_SAVE'),
    );

    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('保存期间路径发生变化')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: '文稿已在其他位置修改' }))
      .not.toBeInTheDocument();
    expect(mocks.api.file).toHaveBeenCalledTimes(1);
    expect(editor).toHaveValue('磁盘正文 dirty');
  });

  it('轮询发现外部更新时不覆盖 dirty 草稿，可明确重新加载磁盘版本', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user);
    await user.clear(editor);
    await user.type(editor, '本地草稿');
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/a.md', size: 5, mtime: 2, ctime: 2, revision: 'b'.repeat(64),
    });
    mocks.api.file.mockResolvedValueOnce({
      content: '外部版本', actualPath: '/share/a.md', size: 5, mtime: 2, ctime: 2,
      revision: 'b'.repeat(64),
    });

    act(() => window.dispatchEvent(new Event('focus')));
    const dialog = await screen.findByRole('dialog', { name: '文稿已在其他位置修改' });
    expect(editor).toHaveValue('本地草稿');
    await user.click(within(dialog).getByRole('button', { name: '重新加载' }));
    expect(editor).toHaveValue('外部版本');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('轮询读取途中切换标签会废弃旧轮询，不叠加外部冲突对话框', async () => {
    const user = await renderReady();
    const navigation = await openDocsFolder(user);
    mocks.api.file.mockResolvedValueOnce({
      content: 'A', actualPath: '/share/docs/a.md', size: 1, mtime: 1, ctime: 1,
      revision: 'a'.repeat(64),
    });
    await user.click(within(navigation).getByRole('button', { name: /a\.md/ }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.type(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), ' dirty');

    mocks.api.list.mockResolvedValueOnce({ entries: docsEntries });
    const state = deferred();
    mocks.api.fileState.mockReturnValueOnce(state.promise);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledWith(
      '/share/docs/a.md',
      abortOptions(),
    ));

    mocks.api.file.mockResolvedValueOnce({
      content: 'B', actualPath: '/share/docs/b.md', size: 1, mtime: 1, ctime: 1,
      revision: 'c'.repeat(64),
    });
    await user.click(screen.getByRole('button', { name: /b\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('B');
    await act(async () => state.resolve({
      actualPath: '/share/docs/a.md', size: 2, mtime: 2, ctime: 2,
      revision: 'b'.repeat(64),
    }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '文稿已在其他位置修改' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /a\.md/ })).toHaveTextContent('●');
  });

  it('旧轮询不会把刚保存的 revision 误判为外部冲突', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user);
    await user.clear(editor);
    await user.type(editor, '第一版草稿');

    const state = deferred();
    mocks.api.fileState.mockReturnValueOnce(state.promise);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mocks.api.fileState).toHaveBeenCalledWith(
      '/share/a.md',
      abortOptions(),
    ));

    const save = deferred();
    mocks.api.saveFile.mockReturnValueOnce(save.promise);
    await user.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.change(editor, { target: { value: '保存期间的新草稿' } });
    await act(async () => save.resolve({
      content: '第一版草稿',
      actualPath: '/share/a.md',
      size: 6,
      mtime: 2,
      ctime: 2,
      revision: 'b'.repeat(64),
    }));
    await act(async () => state.resolve({
      actualPath: '/share/a.md', size: 6, mtime: 2, ctime: 2,
      revision: 'b'.repeat(64),
    }));

    expect(screen.queryByRole('dialog', { name: '文稿已在其他位置修改' }))
      .not.toBeInTheDocument();
    expect(editor).toHaveValue('保存期间的新草稿');
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    expect(mocks.api.file).toHaveBeenCalledTimes(1);
  });

  it('同 revision 草稿自动恢复；磁盘变化时等待用户选择而不自动覆盖', async () => {
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    writeDraft('user-a', '/volume/docs/a.md', '恢复草稿', 'a'.repeat(64));
    const user = await renderReady();
    await openEditableFile(user, { actualPath: '/volume/docs/a.md' });
    expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('恢复草稿');
    expect(screen.getByText('已恢复未保存草稿')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('已保存');

    writeDraft('user-a', '/volume/docs/b.md', '旧 revision 草稿', 'a'.repeat(64));
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/b.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '磁盘新版本', actualPath: '/volume/docs/b.md', size: 5, mtime: 2, ctime: 2,
      revision: 'b'.repeat(64),
    });
    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const recovery = await screen.findByRole('dialog', { name: '发现未保存草稿' });
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('磁盘新版本');
    await user.click(within(recovery).getByRole('button', { name: '恢复草稿' }));
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('旧 revision 草稿');
  });

  it('服务端保存日志可恢复待保存版本，并在成功保存后清理 opaque 记录', async () => {
    const recoveryId = 'c'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/recover.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '当前磁盘版本',
      actualPath: '/share/recover.md',
      size: 6,
      mtime: 2,
      ctime: 2,
      revision: 'a'.repeat(64),
      writable: true,
      recovery: {
        available: true,
        records: [{
          recoveryId,
          phase: 'recovery-required',
          targetMatches: true,
          baselineAvailable: true,
          attemptedAvailable: true,
          observedAvailable: true,
        }],
      },
    });
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/recover.md',
      size: 6,
      mtime: 2,
      ctime: 2,
      revision: 'a'.repeat(64),
      writable: true,
    });
    mocks.api.file.mockResolvedValueOnce({
      content: '上次待保存版本',
      actualPath: '/share/recover.md',
      revision: 'b'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    await user.click(within(dialog).getByRole('button', { name: '恢复待保存版本' }));

    expect(mocks.api.commitRecovery).toHaveBeenCalledWith(
      '/share/recover.md',
      recoveryId,
      'attempted',
      'a'.repeat(64),
      abortOptions(),
    );
    expect(mocks.api.recoveryVersion).not.toHaveBeenCalled();
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      '/share/recover.md',
      recoveryId,
      abortOptions(),
    ));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('上次待保存版本');
    expect(screen.getByText(/通过 revision 校验并写入磁盘/)).toBeVisible();
  });

  it('服务端恢复始终使用用户请求路径，canonical actualPath 仅用于文稿身份', async () => {
    const recoveryId = '6'.repeat(48);
    const requestedPath = '/authorized-alias/docs/recover.md';
    const actualPath = '/volume1/real/docs/recover.md';
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce(requestedPath);
    mocks.api.file
      .mockResolvedValueOnce({
        content: '当前版本',
        actualPath,
        revision: 'a'.repeat(64),
        writable: true,
        recovery: {
          available: true,
          records: [{
            recoveryId,
            phase: 'recovery-required',
            targetMatches: true,
            baselineAvailable: true,
            attemptedAvailable: false,
          }],
        },
      })
      .mockResolvedValueOnce({
        content: '已恢复版本',
        actualPath,
        revision: 'b'.repeat(64),
        writable: true,
      });
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath,
      revision: 'a'.repeat(64),
      writable: true,
    });
    mocks.api.commitRecovery.mockResolvedValueOnce({
      actualPath,
      revision: 'b'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    await user.click(within(dialog).getByRole('button', { name: '恢复保存前版本' }));

    expect(mocks.api.fileState).toHaveBeenCalledWith(requestedPath, abortOptions());
    expect(mocks.api.commitRecovery).toHaveBeenCalledWith(
      requestedPath,
      recoveryId,
      'baseline',
      'a'.repeat(64),
      abortOptions(),
    );
    await waitFor(() => expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      requestedPath,
      recoveryId,
      abortOptions(),
    ));
    expect(mocks.api.commitRecovery).not.toHaveBeenCalledWith(
      actualPath,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('恢复操作失败会在遮罩内显示错误并允许原地重试', async () => {
    const recoveryId = '7'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/retry.md');
    mocks.api.file
      .mockResolvedValueOnce({
        content: '当前版本',
        actualPath: '/share/retry.md',
        revision: 'a'.repeat(64),
        writable: true,
        recovery: {
          available: true,
          records: [{
            recoveryId,
            phase: 'recovery-required',
            targetMatches: true,
            baselineAvailable: false,
            attemptedAvailable: true,
          }],
        },
      })
      .mockResolvedValueOnce({
        content: '重试后恢复',
        actualPath: '/share/retry.md',
        revision: 'b'.repeat(64),
        writable: true,
      });
    mocks.api.fileState.mockResolvedValue({
      actualPath: '/share/retry.md',
      revision: 'a'.repeat(64),
      writable: true,
    });
    mocks.api.commitRecovery.mockRejectedValueOnce(
      httpError('恢复提交暂时失败', 503, 'RECOVERY_COMMIT_FAILED'),
    );

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    const restoreButton = within(dialog).getByRole('button', { name: '恢复待保存版本' });
    await user.click(restoreButton);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('操作失败：恢复提交暂时失败');
    expect(alert).toHaveTextContent('可以修正问题后重试');
    expect(restoreButton).toBeEnabled();

    await user.click(restoreButton);
    await waitFor(() => expect(mocks.api.commitRecovery).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: '发现未完成的保存' }),
    ).not.toBeInTheDocument());
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('重试后恢复');
  });

  it('清理恢复记录失败也会在弹窗内反馈并保留重试入口', async () => {
    const recoveryId = '9'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/cleanup.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '当前版本',
      actualPath: '/share/cleanup.md',
      revision: 'a'.repeat(64),
      writable: true,
      recovery: {
        available: true,
        records: [{
          recoveryId,
          phase: 'recovery-required',
          targetMatches: false,
          baselineAvailable: true,
          attemptedAvailable: false,
        }],
      },
    });
    mocks.api.discardRecovery.mockRejectedValueOnce(
      httpError('清理服务暂时不可用', 503, 'RECOVERY_DISCARD_FAILED'),
    );

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    const cleanupButton = within(dialog).getByRole('button', { name: '清理旧记录' });
    await user.click(cleanupButton);

    expect(await within(dialog).findByRole('alert'))
      .toHaveTextContent('操作失败：清理服务暂时不可用');
    expect(cleanupButton).toBeEnabled();

    await user.click(cleanupButton);
    await waitFor(() => expect(mocks.api.discardRecovery).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: '发现未完成的保存' }),
    ).not.toBeInTheDocument());
  });

  it('非 UTF-8 恢复工件无需进入浏览器正文也能提交并清理', async () => {
    const recoveryId = '8'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/binary.md');
    mocks.api.file
      .mockResolvedValueOnce({
        content: '当前 UTF-8 版本',
        actualPath: '/share/binary.md',
        revision: 'a'.repeat(64),
        writable: true,
        recovery: {
          available: true,
          records: [{
            recoveryId,
            phase: 'recovery-required',
            targetMatches: true,
            baselineAvailable: true,
            attemptedAvailable: false,
          }],
        },
      })
      .mockRejectedValueOnce(httpError('正文不是有效 UTF-8', 422, 'INVALID_UTF8'));
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/binary.md',
      revision: 'a'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    await user.click(within(dialog).getByRole('button', { name: '恢复保存前版本' }));

    expect(mocks.api.commitRecovery).toHaveBeenCalledWith(
      '/share/binary.md',
      recoveryId,
      'baseline',
      'a'.repeat(64),
      abortOptions(),
    );
    expect(mocks.api.recoveryVersion).not.toHaveBeenCalled();
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      '/share/binary.md',
      recoveryId,
      abortOptions(),
    ));
    expect(await screen.findByText(/版本已恢复，但无法读取用于预览/)).toBeVisible();
  });

  it('恢复为非 UTF-8 后仍把本地草稿接回编辑器，并以 commit 后 revision 保存', async () => {
    const recoveryId = 'a'.repeat(48);
    const path = '/share/binary-with-draft.md';
    const localDraft = '不会丢失的 UTF-8 本地草稿';
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    writeDraft('user-a', path, localDraft, '1'.repeat(64));
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce(path);
    mocks.api.file
      .mockResolvedValueOnce({
        content: '恢复前可读正文',
        actualPath: path,
        revision: '1'.repeat(64),
        writable: true,
        recovery: {
          available: true,
          records: [{
            recoveryId,
            phase: 'recovery-required',
            targetMatches: true,
            baselineAvailable: true,
            attemptedAvailable: false,
          }],
        },
      })
      .mockRejectedValueOnce(httpError('正文不是有效 UTF-8', 422, 'INVALID_UTF8'));
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: path,
      revision: '2'.repeat(64),
      writable: true,
    });
    mocks.api.commitRecovery.mockResolvedValueOnce({
      actualPath: path,
      revision: '3'.repeat(64),
      writable: true,
    });
    mocks.api.saveFile.mockResolvedValueOnce({
      actualPath: path,
      revision: '4'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const serverDialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    await user.click(within(serverDialog).getByRole('button', { name: '恢复保存前版本' }));

    const localDialog = await screen.findByRole('dialog', { name: '发现未保存草稿' });
    expect(localDialog).toHaveTextContent('该磁盘正文超过阅读上限或不是有效 UTF-8');
    expect(localDialog).toHaveTextContent('磁盘正文不可预览：正文不是有效 UTF-8');
    expect(readDraft('user-a', path)).toMatchObject({
      content: localDraft,
      sourceRevision: '3'.repeat(64),
    });
    expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      path,
      recoveryId,
      abortOptions(),
    );

    await user.click(within(localDialog).getByRole('button', { name: '继续编辑本地草稿' }));
    const editor = await screen.findByRole('textbox', { name: 'Markdown 编辑器' });
    expect(editor).toHaveValue(localDraft);
    expect(screen.getByText(/当前显示本地草稿；保存时将用最新 revision/)).toBeVisible();
    fireEvent.change(editor, { target: { value: `${localDraft}\n继续编辑` } });
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(mocks.api.saveFile).toHaveBeenCalledWith(
      path,
      `${localDraft}\n继续编辑`,
      '3'.repeat(64),
    );
    await waitFor(() => expect(readDraft('user-a', path)).toBeNull());
  });

  it('重启后磁盘仍为 INVALID_UTF8 且服务端日志已清理时仍能找回本地草稿', async () => {
    const path = '/share/reopen-binary-draft.md';
    const localDraft = 'commit 后持久化的本地草稿';
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    writeDraft('user-a', path, localDraft, 'c'.repeat(64));
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce(path);
    mocks.api.file.mockRejectedValueOnce(
      httpError('正文不是有效 UTF-8', 422, 'INVALID_UTF8'),
    );
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: path,
      revision: 'c'.repeat(64),
      writable: true,
    });
    mocks.api.recoveryState.mockResolvedValueOnce({ available: false, records: [] });

    await user.click(screen.getByRole('button', { name: '打开文件' }));

    expect(screen.queryByRole('dialog', { name: '发现未完成的保存' }))
      .not.toBeInTheDocument();
    const localDialog = await screen.findByRole('dialog', { name: '发现未保存草稿' });
    expect(localDialog).toHaveTextContent('磁盘正文不可预览：正文不是有效 UTF-8');
    await user.click(within(localDialog).getByRole('button', { name: '继续编辑本地草稿' }));
    expect(await screen.findByRole('textbox', { name: 'Markdown 编辑器' }))
      .toHaveValue(localDraft);
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(mocks.api.saveFile).toHaveBeenCalledWith(
      path,
      localDraft,
      'c'.repeat(64),
    );
  });

  it('恢复记录属于已替换 inode 时只允许清理，不能读取旧正文', async () => {
    const recoveryId = 'd'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/reused.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '新文件正文',
      actualPath: '/share/reused.md',
      revision: 'b'.repeat(64),
      writable: true,
      recovery: {
        available: true,
        records: [{
          recoveryId,
          phase: 'recovery-required',
          targetMatches: false,
          baselineAvailable: true,
          attemptedAvailable: true,
        }],
      },
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    expect(within(dialog).queryByRole('button', { name: /恢复/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '清理旧记录' }));

    expect(mocks.api.recoveryVersion).not.toHaveBeenCalled();
    expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      '/share/reused.md',
      recoveryId,
      abortOptions(),
    );
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: '发现未完成的保存' }),
    ).not.toBeInTheDocument());
  });

  it('磁盘正文已损坏为非法 UTF-8 时仍可通过 metadata 与日志恢复', async () => {
    const recoveryId = '1'.repeat(48);
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    writeDraft('user-a', '/share/broken.md', '仍需保留的本地草稿', '9'.repeat(64));
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/broken.md');
    mocks.api.file.mockRejectedValueOnce(httpError('正文不是有效 UTF-8', 422, 'INVALID_UTF8'));
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/broken.md',
      revision: 'a'.repeat(64),
      writable: true,
    });
    mocks.api.recoveryState.mockResolvedValueOnce({
      available: true,
      records: [{
        recoveryId,
        phase: 'writing',
        targetMatches: true,
        baselineAvailable: true,
        attemptedAvailable: false,
      }],
    });
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/broken.md',
      revision: 'a'.repeat(64),
      writable: true,
    });
    mocks.api.file.mockResolvedValueOnce({
      content: '保存前的完整正文',
      actualPath: '/share/broken.md',
      revision: 'b'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    expect(within(dialog).queryByRole('button', { name: '放弃恢复记录' }))
      .not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '恢复保存前版本' }));

    expect(mocks.api.commitRecovery).toHaveBeenCalledWith(
      '/share/broken.md',
      recoveryId,
      'baseline',
      'a'.repeat(64),
      abortOptions(),
    );
    expect(mocks.api.recoveryVersion).not.toHaveBeenCalled();
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
    const localDialog = await screen.findByRole('dialog', { name: '发现未保存草稿' });
    expect(readDraft('user-a', '/share/broken.md')?.content).toBe('仍需保留的本地草稿');
    await user.click(within(localDialog).getByRole('button', { name: '使用磁盘版本' }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('保存前的完整正文');
  });

  it('当前 inode 超过 2 MiB 时仍可通过轻量 metadata 与专用 commit 恢复', async () => {
    const recoveryId = '5'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/oversized.md');
    mocks.api.file.mockRejectedValueOnce(
      httpError('文件超过 2 MiB 阅读上限', 413, 'FILE_TOO_LARGE'),
    );
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/oversized.md',
      size: 2 * 1024 * 1024 + 1,
      mtime: 2,
      ctime: 2,
      revision: 'b'.repeat(64),
      writable: true,
    });
    mocks.api.recoveryState.mockResolvedValueOnce({
      available: true,
      records: [{
        recoveryId,
        phase: 'recovery-required',
        targetMatches: true,
        baselineAvailable: false,
        attemptedAvailable: true,
      }],
    });
    // 用户点击恢复时必须重新取得当前 inode 的 revision，绝不复用日志 revision。
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/oversized.md',
      size: 2 * 1024 * 1024 + 1,
      mtime: 3,
      ctime: 3,
      revision: 'c'.repeat(64),
      writable: true,
    });
    mocks.api.file.mockResolvedValueOnce({
      content: '日志中的可恢复正文',
      actualPath: '/share/oversized.md',
      revision: 'd'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    expect(dialog).not.toHaveTextContent('尚未取得磁盘 metadata/revision');
    expect(mocks.api.recoveryState).toHaveBeenCalledWith(
      '/share/oversized.md',
      abortOptions(),
    );

    await user.click(within(dialog).getByRole('button', { name: '恢复待保存版本' }));
    expect(mocks.api.commitRecovery).toHaveBeenCalledWith(
      '/share/oversized.md',
      recoveryId,
      'attempted',
      'c'.repeat(64),
      abortOptions(),
    );
    expect(mocks.api.recoveryVersion).not.toHaveBeenCalled();
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      '/share/oversized.md',
      recoveryId,
      abortOptions(),
    ));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('日志中的可恢复正文');
  });

  it('commit 后磁盘仍超过 2 MiB 时保留本地草稿恢复入口并允许继续编辑', async () => {
    const recoveryId = '0'.repeat(48);
    const path = '/share/oversized-with-draft.md';
    const localDraft = '小于 2 MiB、仍可继续编辑的本地草稿';
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    writeDraft('user-a', path, localDraft, '9'.repeat(64));
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce(path);
    mocks.api.file
      .mockRejectedValueOnce(httpError('文件超过 2 MiB 阅读上限', 413, 'FILE_TOO_LARGE'))
      .mockRejectedValueOnce(httpError('恢复版本仍超过 2 MiB', 413, 'FILE_TOO_LARGE'));
    mocks.api.fileState
      .mockResolvedValueOnce({
        actualPath: path,
        size: 2 * 1024 * 1024 + 1,
        revision: 'a'.repeat(64),
        writable: true,
      })
      .mockResolvedValueOnce({
        actualPath: path,
        size: 2 * 1024 * 1024 + 1,
        revision: 'b'.repeat(64),
        writable: true,
      });
    mocks.api.recoveryState.mockResolvedValueOnce({
      available: true,
      records: [{
        recoveryId,
        phase: 'recovery-required',
        targetMatches: true,
        baselineAvailable: false,
        attemptedAvailable: true,
      }],
    });
    mocks.api.commitRecovery.mockResolvedValueOnce({
      actualPath: path,
      size: 2 * 1024 * 1024 + 1,
      revision: 'c'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const serverDialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    await user.click(within(serverDialog).getByRole('button', { name: '恢复待保存版本' }));

    const localDialog = await screen.findByRole('dialog', { name: '发现未保存草稿' });
    expect(localDialog).toHaveTextContent('磁盘正文不可预览：恢复版本仍超过 2 MiB');
    expect(readDraft('user-a', path)).toMatchObject({
      content: localDraft,
      sourceRevision: 'c'.repeat(64),
    });
    expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      path,
      recoveryId,
      abortOptions(),
    );

    await user.click(within(localDialog).getByRole('button', { name: '继续编辑本地草稿' }));
    const editor = await screen.findByRole('textbox', { name: 'Markdown 编辑器' });
    expect(editor).toHaveValue(localDraft);
    await user.type(editor, '，可以复制和修改');
    expect(editor).toHaveValue(`${localDraft}，可以复制和修改`);
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('本地草稿与服务端日志同时存在时先处理服务端，且不提前删除本地草稿', async () => {
    const recoveryId = '2'.repeat(48);
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    writeDraft('user-a', '/share/both.md', '唯一的本地待保存草稿', 'a'.repeat(64));
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/both.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '损坏后的磁盘正文',
      actualPath: '/share/both.md',
      revision: 'b'.repeat(64),
      writable: true,
      recovery: {
        available: true,
        records: [{
          recoveryId,
          phase: 'writing',
          targetMatches: true,
          baselineAvailable: true,
          attemptedAvailable: false,
        }],
      },
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const serverDialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    expect(screen.queryByRole('dialog', { name: '发现未保存草稿' })).not.toBeInTheDocument();
    expect(readDraft('user-a', '/share/both.md')?.content).toBe('唯一的本地待保存草稿');

    await user.click(within(serverDialog).getByRole('button', { name: '放弃恢复记录' }));
    expect(await screen.findByRole('dialog', { name: '发现未保存草稿' })).toBeVisible();
    expect(readDraft('user-a', '/share/both.md')?.content).toBe('唯一的本地待保存草稿');
  });

  it('恢复版本与当前显示字节相同时也必须先走 revision CAS 再清理日志', async () => {
    const recoveryId = '3'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/equal.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '相同正文',
      actualPath: '/share/equal.md',
      revision: 'a'.repeat(64),
      writable: true,
      recovery: {
        available: true,
        records: [{
          recoveryId,
          phase: 'auto-restored',
          targetMatches: true,
          baselineAvailable: true,
          attemptedAvailable: false,
        }],
      },
    });
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/equal.md',
      revision: 'a'.repeat(64),
      writable: true,
    });
    mocks.api.file.mockResolvedValueOnce({
      content: '相同正文',
      actualPath: '/share/equal.md',
      revision: 'b'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    await user.click(within(dialog).getByRole('button', { name: '恢复保存前版本' }));

    expect(mocks.api.commitRecovery).toHaveBeenCalledWith(
      '/share/equal.md',
      recoveryId,
      'baseline',
      'a'.repeat(64),
      abortOptions(),
    );
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      '/share/equal.md',
      recoveryId,
      abortOptions(),
    ));
  });

  it('恢复弹窗不固化旧只读状态，点击时重新检查权限', async () => {
    const recoveryId = '4'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/permission.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '旧正文',
      actualPath: '/share/permission.md',
      revision: 'a'.repeat(64),
      writable: false,
      recovery: {
        available: true,
        records: [{
          recoveryId,
          phase: 'recovery-required',
          targetMatches: true,
          baselineAvailable: true,
          attemptedAvailable: false,
        }],
      },
    });
    mocks.api.fileState.mockResolvedValueOnce({
      actualPath: '/share/permission.md',
      revision: 'a'.repeat(64),
      writable: true,
    });
    mocks.api.file.mockResolvedValueOnce({
      content: '恢复正文',
      actualPath: '/share/permission.md',
      revision: 'b'.repeat(64),
      writable: true,
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    const dialog = await screen.findByRole('dialog', { name: '发现未完成的保存' });
    const restoreButton = within(dialog).getByRole('button', { name: '恢复保存前版本' });
    expect(restoreButton).toBeEnabled();
    await user.click(restoreButton);

    expect(mocks.api.fileState).toHaveBeenCalledWith(
      '/share/permission.md',
      abortOptions(),
    );
    expect(mocks.api.commitRecovery).toHaveBeenCalledWith(
      '/share/permission.md',
      recoveryId,
      'baseline',
      'a'.repeat(64),
      abortOptions(),
    );
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
  });

  it('已提交但仅清理中断的恢复日志会自动清理，不重复提示恢复', async () => {
    const recoveryId = 'e'.repeat(48);
    const user = await renderReady();
    mocks.trim.pickMarkdownFile.mockResolvedValueOnce('/share/committed.md');
    mocks.api.file.mockResolvedValueOnce({
      content: '已经提交',
      actualPath: '/share/committed.md',
      revision: 'b'.repeat(64),
      writable: true,
      recovery: {
        available: true,
        records: [{
          recoveryId,
          phase: 'committed',
          targetMatches: true,
          currentMatchesAttempt: true,
          attemptedAvailable: true,
        }],
      },
    });

    await user.click(screen.getByRole('button', { name: '打开文件' }));
    await screen.findByTestId('markdown-view');
    expect(screen.queryByRole('dialog', { name: '发现未完成的保存' }))
      .not.toBeInTheDocument();
    await waitFor(() => expect(mocks.api.discardRecovery).toHaveBeenCalledWith(
      '/share/committed.md',
      recoveryId,
    ));
  });

  it('保存返回 recovery-required 时立即加载服务端日志并保留编辑草稿', async () => {
    const recoveryId = 'f'.repeat(48);
    const user = await renderReady();
    const editor = await openEditableFile(user);
    await user.clear(editor);
    await user.type(editor, '不能丢失的草稿');
    const error = httpError('保存中断，已保留恢复版本', 409, 'SAVE_RECOVERY_REQUIRED');
    error.details = {
      recoveryRequired: true,
      recovery: { recoveryId, phase: 'recovery-required' },
    };
    mocks.api.saveFile.mockRejectedValueOnce(error);
    mocks.api.file.mockResolvedValueOnce({
      content: '保存失败后的磁盘版本',
      actualPath: '/share/a.md',
      revision: 'b'.repeat(64),
      writable: true,
    });
    mocks.api.recoveryState.mockResolvedValueOnce({
      available: true,
      records: [{
        recoveryId,
        phase: 'recovery-required',
        targetMatches: true,
        baselineAvailable: true,
        attemptedAvailable: true,
      }],
    });

    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('dialog', { name: '发现未完成的保存' })).toBeVisible();
    expect(editor).toHaveValue('不能丢失的草稿');
    expect(mocks.api.recoveryState).toHaveBeenCalledWith('/share/a.md');
  });

  it('beforeunload 同步落盘草稿并触发浏览器离开确认', async () => {
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    const user = await renderReady();
    const editor = await openEditableFile(user);
    await user.clear(editor);
    await user.type(editor, '待恢复草稿');

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      draftStorageKey('user-a', '/share/a.md'),
      expect.stringContaining('待恢复草稿'),
    );
  });

  it('草稿节流持久化，手动改回磁盘正文后清除过期恢复记录', async () => {
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    const user = await renderReady();
    const editor = await openEditableFile(user);
    window.localStorage.removeItem.mockClear();
    await user.type(editor, ' dirty');

    await waitFor(() => expect(window.localStorage.setItem).toHaveBeenCalledWith(
      draftStorageKey('user-a', '/share/a.md'),
      expect.stringContaining('磁盘正文 dirty'),
    ), { timeout: 1_500 });
    await user.clear(editor);
    await user.type(editor, '磁盘正文');
    await waitFor(() => expect(window.localStorage.removeItem).toHaveBeenCalledWith(
      draftStorageKey('user-a', '/share/a.md'),
    ));
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('保存上限按 UTF-8 字节计算而不是 JavaScript 字符数', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user);
    fireEvent.change(editor, { target: { value: '你'.repeat(700_000) } });
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/超过 2 MB 保存上限/)).toBeVisible();
    expect(mocks.api.saveFile).not.toHaveBeenCalled();
    expect(editor).toHaveValue('你'.repeat(700_000));
  });

  it('在编辑器中查找、替换当前项和全部匹配，并更新未保存标记', async () => {
    const user = await renderReady();
    const editor = await openEditableFile(user, { content: 'one one' });

    await user.click(screen.getByRole('button', { name: '查找' }));
    await user.type(screen.getByRole('searchbox', { name: '查找内容' }), 'one');
    expect(screen.getByRole('status')).toHaveTextContent('1 / 2');
    await user.click(screen.getByRole('button', { name: '显示替换' }));
    await user.type(screen.getByRole('textbox', { name: '替换内容' }), 'two');
    await user.click(screen.getByRole('button', { name: '替换', exact: true }));
    expect(editor).toHaveValue('two one');
    expect(screen.getByRole('tab', { name: /a\.md/ })).toHaveTextContent('●');

    await user.click(screen.getByRole('button', { name: '全部替换' }));
    expect(editor).toHaveValue('two two');
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('编辑与预览分栏共享同一份实时草稿', async () => {
    const user = await renderReady();
    await openEditableFile(user, { content: '# 初始' });

    await user.click(screen.getByRole('button', { name: '分栏' }));
    expect(screen.getByRole('region', { name: '编辑器面板' })).toBeVisible();
    expect(screen.getByRole('region', { name: '预览面板' })).toBeVisible();
    const editor = screen.getByRole('textbox', { name: 'Markdown 编辑器' });
    await user.clear(editor);
    await user.type(editor, '# 实时预览');
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('# 实时预览');

    const previewPane = screen.getByRole('region', { name: '预览面板' });
    Object.defineProperties(editor, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });
    Object.defineProperties(previewPane, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 400 },
    });
    editor.scrollTop = 400;
    fireEvent.scroll(editor);
    expect(previewPane.scrollTop).toBe(800);
  });

  it('按 uid 恢复标签会话，并从独立草稿存储恢复活动标签的未保存内容', async () => {
    mocks.api.env.mockResolvedValue({ openApiAvailable: true, uid: 'user-a' });
    writeDocumentSession('user-a', [
      { path: '/share/a.md', name: 'a.md', displayPath: '/share/a.md' },
      { path: '/share/b.md', name: 'b.md', displayPath: '/share/b.md', dirty: true },
    ], '/share/b.md');
    writeDraft('user-a', '/share/b.md', 'B 恢复草稿', 'b'.repeat(64));
    mocks.api.file.mockImplementation(async (path) => ({
      content: path.endsWith('/b.md') ? 'B 磁盘' : 'A 磁盘',
      actualPath: path,
      size: 4,
      mtime: 1,
      ctime: 1,
      revision: path.endsWith('/b.md') ? 'b'.repeat(64) : 'a'.repeat(64),
      writable: true,
    }));

    const user = await renderReady();
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('B 恢复草稿');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /b\.md/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /b\.md/ })).toHaveTextContent('●');

    await user.click(screen.getByRole('tab', { name: /a\.md/ }));
    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('A 磁盘');
    await user.click(screen.getByRole('tab', { name: /b\.md/ }));
    expect(screen.getByTestId('markdown-view')).toHaveTextContent('B 恢复草稿');
  });
});
