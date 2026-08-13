import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodeBlock from './CodeBlock';
import { highlightCode } from './highlight';

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));

vi.mock('../platform/clipboard', () => ({
  writeClipboardText: (...args) => writeClipboardText(...args),
}));

vi.mock('./highlight', () => ({
  highlightCode: vi.fn(() => Promise.resolve('<pre class="shiki">highlighted</pre>')),
  isHugeCode: vi.fn(() => false),
}));

let intersectionCallback;

class ControlledIntersectionObserver {
  constructor(callback) {
    intersectionCallback = callback;
  }

  observe() {}

  disconnect() {}
}

describe('CodeBlock 视口调度', () => {
  beforeEach(() => {
    highlightCode.mockClear();
    writeClipboardText.mockClear();
    intersectionCallback = null;
    vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);
  });

  it('先显示纯文本，接近视口后才请求高亮', async () => {
    const { container } = render(
      <CodeBlock
        code="const answer = 42;"
        language="javascript"
        theme="light"
        highlightSessionId="session-test"
      />,
    );

    expect(container.querySelector('.code-plain')).toHaveTextContent('const answer = 42;');
    expect(highlightCode).not.toHaveBeenCalled();

    act(() => intersectionCallback([{ isIntersecting: true }]));

    await waitFor(() => expect(highlightCode).toHaveBeenCalledWith(
      'const answer = 42;',
      'javascript',
      'light',
      { sessionId: 'session-test', priority: 100 },
    ));
    expect(await screen.findByText('highlighted')).toBeInTheDocument();
  });

  it('打印前会启动尚未进入视口的高亮', async () => {
    render(
      <CodeBlock
        code="let printable = true;"
        language="javascript"
        theme="dark"
        highlightSessionId="session-print"
      />,
    );

    act(() => window.dispatchEvent(new Event('beforeprint')));

    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(1));
  });

  it('用图标按钮复制代码并保留可访问状态', async () => {
    render(
      <CodeBlock
        code="let copied = true;"
        language="javascript"
        theme="light"
        highlightSessionId="session-copy"
      />,
    );

    const copyButton = screen.getByRole('button', { name: '复制代码' });
    expect(copyButton).toHaveClass('code-copy-button');
    expect(copyButton).not.toHaveTextContent('复制');
    expect(copyButton.querySelector('svg')).toBeInTheDocument();

    fireEvent.click(copyButton);
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('let copied = true;'));
    expect(await screen.findByRole('button', { name: '代码已复制' }))
      .toHaveClass('is-copied');
  });
});
