import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyRenderFeatureFlags } from './renderFeatures';
import './styles/app.css';
import './styles/markdown.css';

// Windows 与 fnOS 共用完整 React App；平台差异只位于 transport 与宿主 bridge。
applyRenderFeatureFlags();
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
