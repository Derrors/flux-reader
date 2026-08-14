import React from 'react';
import { createRoot } from 'react-dom/client';
import WindowsApp from './apps/WindowsApp';
import { applyRenderFeatureFlags } from './renderFeatures';
import './styles/app.css';
import './styles/markdown.css';

// Windows 组合入口显式注入平台体验；Markdown 渲染与文档工作流仍复用共享内核。
applyRenderFeatureFlags();
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WindowsApp />
  </React.StrictMode>,
);
