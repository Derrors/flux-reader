import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const mocks = vi.hoisted(() => ({
  api: {
    env: vi.fn(),
    list: vi.fn(),
    file: vi.fn(),
    sample: vi.fn(),
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
  default: ({ content }) => <article data-testid="markdown-view">{content}</article>,
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

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  for (const fn of Object.values(mocks.trim)) fn.mockReset();

  mocks.trim.initSdk.mockResolvedValue({ sdk: {}, error: null });
  mocks.trim.pickFolder.mockResolvedValue(null);
  mocks.trim.pickMarkdownFile.mockResolvedValue(null);
  mocks.trim.setTitle.mockResolvedValue(undefined);
  mocks.api.env.mockResolvedValue({ openApiAvailable: true });
  mocks.api.sample.mockResolvedValue({ content: '# 示例' });

  window.history.replaceState({}, '', '/app/flux-reader/');
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
    window.dispatchEvent(new Event('focus'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));

    expect(await screen.findByTestId('markdown-view')).toHaveTextContent('授权后内容');
    expect(mocks.api.file).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
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
