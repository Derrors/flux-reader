import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MediaFrame from './MediaFrame';

describe('MediaFrame 媒体交互', () => {
  it('通过遮罩视图放大、缩放并用 Escape 关闭', async () => {
    const user = userEvent.setup();
    render(
      <MediaFrame label="图片“架构图”">
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="架构图" />
      </MediaFrame>,
    );

    await user.click(screen.getByRole('button', { name: '放大查看图片“架构图”' }));
    expect(screen.getByRole('dialog', { name: '图片“架构图”放大视图' }))
      .toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByRole('button', { name: '恢复 100% 缩放' }))
      .toHaveTextContent('125%');
    await user.click(screen.getByRole('button', { name: '恢复 100% 缩放' }));
    expect(screen.getByRole('button', { name: '恢复 100% 缩放' }))
      .toHaveTextContent('100%');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(screen.getByRole('button', { name: '放大查看图片“架构图”' }))
      .toHaveFocus();
  });

  it('支持拖拽和键盘按比例调整正文媒体宽度', () => {
    const { container } = render(
      <div data-testid="parent">
        <MediaFrame label="流程图">
          <svg aria-label="流程图内容" />
        </MediaFrame>
      </div>,
    );
    const frame = container.querySelector('.resizable-media');
    const parent = screen.getByTestId('parent');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 200,
      top: 0,
      right: 400,
      bottom: 200,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const handle = screen.getByRole('button', { name: '调整流程图大小' });
    fireEvent.pointerDown(handle, { clientX: 400, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 150 });
    fireEvent.pointerUp(window);
    expect(frame).toHaveStyle({ width: '300px' });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(frame).toHaveStyle({ width: '324px' });
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(frame.style.width).toBe('');
    expect(frame).not.toHaveAttribute('data-resized');
  });
});
