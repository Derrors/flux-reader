import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Mermaid, { getMermaidCacheDiagnostics, resetMermaidCache } from './Mermaid';

const { initialize, renderDiagram } = vi.hoisted(() => ({
  initialize: vi.fn(),
  renderDiagram: vi.fn((_id, code) => Promise.resolve({
    svg: `<svg viewBox="0 0 400 200" aria-label="测试流程图"><text>${code}</text></svg>`,
  })),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render: renderDiagram,
  },
}));

describe('Mermaid 图表交互', () => {
  beforeEach(() => {
    resetMermaidCache();
    initialize.mockClear();
    renderDiagram.mockClear();
  });

  it('渲染后提供放大、下载和拖拽调整入口', async () => {
    const { container } = render(<Mermaid code="flowchart LR; A-->B" theme="light" />);

    expect(await screen.findByRole('button', { name: '放大查看Mermaid 图表' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载 SVG' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '调整Mermaid 图表大小' }))
      .toBeInTheDocument();
    expect(container.querySelector('.mermaid-block')).toHaveAttribute(
      'data-render-state',
      'rendered',
    );
    expect(renderDiagram).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      'flowchart LR; A-->B',
      expect.any(HTMLElement),
    );
  });

  it('返回之前的标签时直接复用已渲染 SVG', async () => {
    const { rerender } = render(<Mermaid code="flowchart LR; A-->B" theme="light" />);
    expect(await screen.findByText('flowchart LR; A-->B')).toBeInTheDocument();

    rerender(<Mermaid code="flowchart TD; C-->D" theme="light" />);
    expect(await screen.findByText('flowchart TD; C-->D')).toBeInTheDocument();
    expect(renderDiagram).toHaveBeenCalledTimes(2);

    rerender(<Mermaid code="flowchart LR; A-->B" theme="light" />);
    expect(screen.getByText('flowchart LR; A-->B')).toBeInTheDocument();
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(2));
    expect(getMermaidCacheDiagnostics().hits).toBeGreaterThan(0);
  });

  it('可为单个流程图选择左中右对齐并同步到放大视图', async () => {
    const user = userEvent.setup();
    const { container } = render(<Mermaid code="flowchart LR; A-->B" theme="light" />);
    await screen.findByText('flowchart LR; A-->B');

    await user.click(screen.getByRole('button', { name: 'Mermaid 图表左对齐' }));
    expect(container.querySelector('.mermaid-block')).toHaveAttribute(
      'data-media-align',
      'left',
    );
    expect(container.querySelector('.mermaid-canvas svg')).toHaveAttribute(
      'preserveAspectRatio',
      'xMinYMid meet',
    );

    await user.click(screen.getByRole('button', { name: '放大查看Mermaid 图表' }));
    const dialog = screen.getByRole('dialog', { name: 'Mermaid 图表放大视图' });
    expect(dialog.querySelector('.media-lightbox-content')).toHaveAttribute(
      'data-media-align',
      'left',
    );

    await user.click(screen.getByRole('button', { name: 'Mermaid 图表右对齐' }));
    expect(dialog.querySelector('.media-lightbox-content')).toHaveAttribute(
      'data-media-align',
      'right',
    );
    expect(dialog.querySelector('.mermaid-canvas svg')).toHaveAttribute(
      'preserveAspectRatio',
      'xMaxYMid meet',
    );
  });
});
