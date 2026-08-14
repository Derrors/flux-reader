import React from 'react';
import { createRoot } from 'react-dom/client';
import FnOSApp from './apps/FnOSApp';
import { applyRenderFeatureFlags } from './renderFeatures';
import './styles/app.css';
import './styles/markdown.css';

applyRenderFeatureFlags();
const root = createRoot(document.getElementById('root'));

if (import.meta.env.MODE === 'contract-fnos') {
  import('./render-contract/RenderContractHarness').then(({ default: Harness }) => {
    root.render(<Harness entry="fnos" />);
  });
} else {
  root.render(
    <React.StrictMode>
      <FnOSApp />
    </React.StrictMode>,
  );
}
