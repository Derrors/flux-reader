import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  instance: null,
  construct: vi.fn(),
}));

vi.mock('@trimjs/web-app', () => ({
  TrimApp: class TrimAppMock {
    constructor() {
      harness.construct();
      return harness.instance;
    }
  },
}));

async function loadSdkWrapper() {
  return import('./trim-sdk');
}

beforeEach(() => {
  vi.resetModules();
  harness.construct.mockReset();
  harness.instance = {
    ready: vi.fn().mockResolvedValue(undefined),
    pickFile: vi.fn(),
    setTitle: vi.fn().mockResolvedValue(undefined),
    isStandaloneWeb: false,
  };
});

describe('trim-sdk 文件选择器封装', () => {
  it('打开文件夹只选择一个目录，不改写带末尾空格的路径', async () => {
    harness.instance.pickFile.mockResolvedValueOnce(['/share/项目 ']);
    const { pickFolder } = await loadSdkWrapper();

    await expect(pickFolder()).resolves.toBe('/share/项目 ');
    expect(harness.instance.pickFile).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '打开文件夹',
      okText: '打开',
      creatable: false,
    });
  });

  it('打开文件限制 Markdown 扩展名并保留特殊字符', async () => {
    harness.instance.pickFile.mockResolvedValueOnce(['/share/A%20 + #?.MDX']);
    const { pickMarkdownFile } = await loadSdkWrapper();

    await expect(pickMarkdownFile()).resolves.toBe('/share/A%20 + #?.MDX');
    expect(harness.instance.pickFile).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      accept: ['.md', '.markdown', '.mdx'],
      title: '打开 Markdown 文件',
      okText: '打开',
    });
  });

  it.each([undefined, null, []])('把宿主无结果 %s 视为用户取消', async (result) => {
    harness.instance.pickFile.mockResolvedValueOnce(result);
    const { pickMarkdownFile } = await loadSdkWrapper();

    await expect(pickMarkdownFile()).resolves.toBeNull();
  });

  it.each([
    [{ path: '/share/a.md' }, '文件选择器返回格式异常'],
    [['/share/a.md', '/share/b.md'], '文件选择器返回了多个文件'],
    [['share/a.md'], '文件选择器返回了无效的文件路径'],
    [['/share/a\0.md'], '文件选择器返回了无效的文件路径'],
    [['/share/a.txt'], '请选择 Markdown 文件'],
  ])('拒绝异常或越界的宿主返回值：%s', async (result, message) => {
    harness.instance.pickFile.mockResolvedValueOnce(result);
    const { pickMarkdownFile } = await loadSdkWrapper();

    await expect(pickMarkdownFile()).rejects.toThrow(message);
  });

  it('独立浏览器明确拒绝选择器且不调用宿主方法', async () => {
    harness.instance.isStandaloneWeb = true;
    const { pickFolder } = await loadSdkWrapper();

    await expect(pickFolder()).rejects.toThrow('请从 fnOS 桌面打开');
    expect(harness.instance.pickFile).not.toHaveBeenCalled();
  });

  it('桥接错误向上抛出，不能伪装成用户取消', async () => {
    harness.instance.pickFile.mockRejectedValueOnce(new Error('bridge failed'));
    const { pickMarkdownFile } = await loadSdkWrapper();

    await expect(pickMarkdownFile()).rejects.toThrow('bridge failed');
  });

  it('SDK ready 失败时把错误作为降级结果返回，并让选择操作明确失败', async () => {
    harness.instance.ready.mockRejectedValueOnce(new Error('ready failed'));
    const { initSdk, pickMarkdownFile } = await loadSdkWrapper();

    await expect(initSdk()).resolves.toEqual({ sdk: null, error: 'ready failed' });
    await expect(pickMarkdownFile()).rejects.toThrow('fnOS 文件选择器不可用：ready failed');
    expect(harness.instance.pickFile).not.toHaveBeenCalled();
  });

  it('SDK 初始化在多个选择操作之间复用，标题桥接失败不影响阅读', async () => {
    harness.instance.pickFile
      .mockResolvedValueOnce(['/share/docs'])
      .mockResolvedValueOnce(['/share/a.md']);
    harness.instance.setTitle.mockRejectedValueOnce(new Error('title bridge failed'));
    const { pickFolder, pickMarkdownFile, setTitle } = await loadSdkWrapper();

    await pickFolder();
    await pickMarkdownFile();
    await expect(setTitle('a.md')).resolves.toBeUndefined();

    expect(harness.construct).toHaveBeenCalledTimes(1);
    expect(harness.instance.ready).toHaveBeenCalledTimes(1);
  });
});
