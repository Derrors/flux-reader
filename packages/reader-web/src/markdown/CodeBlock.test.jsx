import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodeBlock from './CodeBlock';
import { highlightCode } from './highlight';

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
});
