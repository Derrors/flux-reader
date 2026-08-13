import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Mermaid from './Mermaid';

const { initialize, renderDiagram } = vi.hoisted(() => ({
  initialize: vi.fn(),
  renderDiagram: vi.fn(() => Promise.resolve({
    svg: '<svg viewBox="0 0 400 200" aria-label="测试流程图"><text>Flow</text></svg>',
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
});
