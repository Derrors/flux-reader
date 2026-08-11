import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarkdownView from './MarkdownView';
import {
  assertRenderContract,
  renderContractCase,
  renderContractManifest,
} from '../render-contract/fixtures';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => new Promise(() => {})),
  },
}));

const FIXED_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

describe('shared Markdown DOM contract', () => {
  for (const manifestCase of renderContractManifest.cases) {
    it(`renders ${manifestCase.file}`, () => {
      const contractCase = renderContractCase(manifestCase.file);
      expect(contractCase).not.toBeNull();
      const { container, unmount } = render(
        <MarkdownView
          content={contractCase.content}
          theme="light"
          resolveImageSource={() => FIXED_IMAGE}
          findQuery={contractCase.props?.findQuery || ''}
          findCaseSensitive={contractCase.props?.findCaseSensitive || false}
          activeFindMatch={contractCase.props?.activeFindMatch || 0}
        />,
      );

      expect(
        assertRenderContract(container, contractCase, { terminal: false }),
        `${manifestCase.file} contract failures`,
      ).toEqual([]);
      if (manifestCase.file === 'code.md') {
        expect(container.querySelectorAll('.code-plain')).toHaveLength(2);
      }
      if (manifestCase.file === 'images.md') {
        expect(
          [...container.querySelectorAll('.image-group img')]
            .every((image) => image.src === FIXED_IMAGE),
        ).toBe(true);
      }
      unmount();
    });
  }
});
