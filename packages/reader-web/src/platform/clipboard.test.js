import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeClipboardText } from './clipboard';

const originalWebkit = Object.getOwnPropertyDescriptor(globalThis, 'webkit');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWebkit) {
    Object.defineProperty(globalThis, 'webkit', originalWebkit);
  } else {
    Reflect.deleteProperty(globalThis, 'webkit');
  }
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('writeClipboardText', () => {
  it('优先使用 macOS 原生剪贴板 bridge', async () => {
    const postMessage = vi.fn();
    Object.defineProperty(globalThis, 'webkit', {
      configurable: true,
      value: { messageHandlers: { copyText: { postMessage } } },
    });

    await writeClipboardText('native copy');

    expect(postMessage).toHaveBeenCalledWith('native copy');
  });

  it('在浏览器中回退到 Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await writeClipboardText('browser copy');

    expect(writeText).toHaveBeenCalledWith('browser copy');
  });
});
