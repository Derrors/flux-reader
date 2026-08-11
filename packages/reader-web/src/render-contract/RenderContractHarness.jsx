import { useEffect, useRef } from 'react';
import MarkdownView from '../markdown/MarkdownView';
import {
  assertRenderContract,
  renderContractCase,
  renderContractManifest,
} from './fixtures';

const FIXED_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function selectedFile() {
  const requested = new URLSearchParams(globalThis.location?.search || '').get('case');
  return requested || renderContractManifest.cases[0]?.file || '';
}

function hasPendingAsyncRenderer(root) {
  return Boolean(root.querySelector('[data-render-state="loading"], [data-render-state="deferred"]'));
}

export default function RenderContractHarness({ entry }) {
  const rootRef = useRef(null);
  const contractCase = renderContractCase(selectedFile());

  useEffect(() => {
    const root = rootRef.current;
    const documentRoot = globalThis.document?.documentElement;
    if (!root || !documentRoot) return undefined;

    documentRoot.dataset.renderContractEntry = entry;
    documentRoot.dataset.renderContractCase = contractCase?.file || 'missing';
    documentRoot.dataset.renderContractState = 'running';

    let settled = false;
    let frame = 0;
    let fallbackTimer = 0;
    let timeout = 0;
    const cancelScheduledInspection = () => {
      if (frame) globalThis.cancelAnimationFrame(frame);
      if (fallbackTimer) globalThis.clearTimeout(fallbackTimer);
      frame = 0;
      fallbackTimer = 0;
    };
    const finish = (failures) => {
      if (settled) return;
      settled = true;
      cancelScheduledInspection();
      if (timeout) globalThis.clearTimeout(timeout);
      timeout = 0;
      const result = {
        version: renderContractManifest.version,
        entry,
        file: contractCase?.file || null,
        failures,
      };
      globalThis.__FLUX_READER_RENDER_CONTRACT__ = result;
      documentRoot.dataset.renderContractState = failures.length ? 'failed' : 'passed';
    };

    if (!contractCase) {
      finish([`unknown fixture: ${selectedFile()}`]);
      return undefined;
    }

    const settle = () => {
      if (settled || hasPendingAsyncRenderer(root)) return;
      finish(assertRenderContract(root, contractCase, { terminal: true }));
    };
    const inspect = () => {
      if (settled || hasPendingAsyncRenderer(root)) return;
      cancelScheduledInspection();
      // Prefer a painted frame, but keep a timer fallback because an offscreen
      // WKWebView can suspend requestAnimationFrame indefinitely in XCTest.
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        settle();
      });
      fallbackTimer = globalThis.setTimeout(() => {
        fallbackTimer = 0;
        settle();
      }, 100);
    };

    const observer = new MutationObserver(inspect);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'data-render-state'],
    });
    inspect();
    timeout = globalThis.setTimeout(() => {
      finish([
        'renderer did not reach a terminal state',
        ...assertRenderContract(root, contractCase, { terminal: false }),
      ]);
    }, 15_000);

    return () => {
      observer.disconnect();
      globalThis.clearTimeout(timeout);
      cancelScheduledInspection();
    };
  }, [contractCase, entry]);

  if (!contractCase) {
    return <main ref={rootRef}>Unknown render-contract fixture.</main>;
  }

  return (
    <main ref={rootRef} data-testid="render-contract-root">
      <MarkdownView
        content={contractCase.content}
        theme="light"
        resolveImageSource={() => FIXED_IMAGE}
        findQuery={contractCase.props?.findQuery || ''}
        findCaseSensitive={contractCase.props?.findCaseSensitive || false}
        activeFindMatch={contractCase.props?.activeFindMatch || 0}
      />
    </main>
  );
}
