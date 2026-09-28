import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, getStoredTheme } from './theme';
import './styles.css';

// 渲染前先定好主题，避免启动瞬间闪成暗色
applyTheme(getStoredTheme());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
