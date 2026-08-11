import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RenderContractHarness from './RenderContractHarness';

describe('RenderContractHarness readiness', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.renderContractEntry;
    delete document.documentElement.dataset.renderContractCase;
    delete document.documentElement.dataset.renderContractState;
    delete globalThis.__FLUX_READER_RENDER_CONTRACT__;
  });

  it('settles through the timer fallback when animation frames are suspended', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    render(<RenderContractHarness entry="macos" />);
    expect(document.documentElement.dataset.renderContractState).toBe('running');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(document.documentElement.dataset.renderContractState).toBe('passed');
    expect(globalThis.__FLUX_READER_RENDER_CONTRACT__).toMatchObject({
      entry: 'macos',
      file: 'gfm.md',
      failures: [],
    });
  });
});
