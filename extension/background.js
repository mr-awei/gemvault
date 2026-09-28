/**
 * 图库采集助手（Chrome MV3）
 * - 右键单图采集 / 右键批量采集（页面内所有图）
 * - 截图（可见区域）
 * 统一 POST 到本地服务 http://127.0.0.1:3001/api/extension/ingest
 */
const PORT = 3001;
const BASE = `http://127.0.0.1:${PORT}`;
const MENU_SINGLE = 'gem-pick-one';
const MENU_BATCH = 'gem-pick-all';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_SINGLE, title: '采集这张图片到图库', contexts: ['image'] });
  chrome.contextMenus.create({ id: MENU_BATCH, title: '采集本页所有图片到图库', contexts: ['page'] });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === MENU_SINGLE) {
      await send({ urls: [info.srcUrl], pageUrl: info.pageUrl, keyword: '', tags: '' });
      return;
    }
    if (info.menuItemId === MENU_BATCH && tab?.id) {
      const urls = await collectImages(tab.id);
      await send({ urls, pageUrl: info.pageUrl, keyword: tab.title || '', tags: '' });
    }
  });
});

/** 收集页面内所有图片地址（去重、过滤过小的图） */
async function collectImages(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const out = new Set();
      const push = (u) => {
        if (!u) return;
        if (u.startsWith('//')) u = location.protocol + u;
        if (/^https?:\/\//i.test(u)) out.add(u);
      };
      document.querySelectorAll('img').forEach((img) => {
        if (img.naturalWidth >= 400 && img.naturalHeight >= 400) {
          push(img.currentSrc || img.src);
        }
      });
      // 背景图
      document.querySelectorAll('*').forEach((el) => {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\("?(https?:[^")]+)/);
        if (m) push(m[1]);
      });
      return [...out].slice(0, 30);
    },
  });
  return result || [];
}

/** 截图（可见区域），返回 dataURL */
async function captureVisible(tabId) {
  return await chrome.tabs.captureVisibleTab(null, { format: 'png' });
}

async function send(payload) {
  try {
    const res = await fetch(`${BASE}/api/extension/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    notify(`已入库 ${j.saved || 0} 张（共 ${j.total || 0}）`);
  } catch (err) {
    notify('本地图库未启动或端口不通：' + (err?.message || err));
  }
}

function notify(text) {
  // 没有图标资源时用扩展默认图标，避免 iconUrl 不存在导致通知报错
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon48.png'),
      title: '图库采集助手',
      message: String(text).slice(0, 120),
    });
  } catch {
    /* 图标缺失时静默 */
  }
}

// 供 popup 调用
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'batch') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const urls = await collectImages(tab.id);
        const res = await fetch(`${BASE}/api/extension/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls, pageUrl: tab.url, keyword: msg.keyword || tab.title || '', tags: msg.tags || '' }),
        });
        const j = await res.json();
        sendResponse({ ok: true, saved: j.saved || 0, total: j.total || 0 });
      } else if (msg?.type === 'shot') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const dataUrl = await captureVisible(tab.id);
        const res = await fetch(`${BASE}/api/extension/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrls: [dataUrl], pageUrl: tab.url, keyword: msg.keyword || tab.title || '', tags: msg.tags || '' }),
        });
        const j = await res.json();
        sendResponse({ ok: true, saved: j.saved || 0, total: j.total || 0 });
      } else {
        sendResponse({ ok: false, error: '未知操作' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // 异步响应
});
