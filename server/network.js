import { getSettings, saveSettings } from './db.js';

/**
 * 网络 / 代理设置：代理规则通过 Chromium(session.setProxy) 生效，
 * 因此采集、AI、缩略图下载全部走同一出口。
 */

export const PROXY_MODES = [
  { key: 'off', label: '关闭（直连）' },
  { key: 'system', label: '系统代理（自动）' },
  { key: 'http', label: 'HTTP' },
  { key: 'https', label: 'HTTPS' },
  { key: 'socks5', label: 'SOCKS5' },
  { key: 'socks4', label: 'SOCKS4' },
];

let electronSession = null;
async function session() {
  if (!electronSession) {
    electronSession = import('electron')
      .then((m) => (m && m.session ? m.session : null))
      .catch(() => null);
  }
  return electronSession;
}

export function getNetwork() {
  const s = getSettings().network || {};
  return {
    mode: s.mode || 'off',
    host: s.host || '127.0.0.1',
    port: Number(s.port) || 7890,
    username: s.username || '',
    password: s.password || '',
    bypass: s.bypass || '<local>',
  };
}

export function proxyRules(net = getNetwork()) {
  if (net.mode === 'off' || net.mode === 'system') return '';
  return `${net.mode}://${net.host}:${net.port}`;
}

/** 应用代理到 Chromium 会话（桌面端） */
export async function applyProxy() {
  const ses = await session();
  if (!ses) return false;
  const net = getNetwork();
  try {
    if (net.mode === 'off') {
      await ses.defaultSession.setProxy({ mode: 'direct' });
    } else if (net.mode === 'system') {
      await ses.defaultSession.setProxy({ mode: 'system' });
    } else {
      await ses.defaultSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxyRules(net),
        proxyBypassRules: net.bypass || '<local>',
      });
    }
    return true;
  } catch (err) {
    console.error('[network] 应用代理失败', err.message);
    return false;
  }
}

/** 代理需要账号密码时，由 Chromium 触发 login 事件 */
export function registerProxyAuth() {
  import('electron')
    .then((m) => {
      if (!m?.app) return;
      m.app.on('login', (event, _webContents, _details, authInfo, callback) => {
        if (!authInfo.isProxy) return;
        const net = getNetwork();
        if (net.username || net.password) {
          event.preventDefault();
          callback(net.username, net.password);
        }
      });
    })
    .catch(() => {});
}

export function saveNetwork(patch) {
  const current = getNetwork();
  const next = { ...current, ...(patch || {}) };
  next.port = Number(next.port) || 7890;
  saveSettings({ network: next });
  return getNetwork();
}

/** 通过当前代理测试连通性 */
export async function testNetwork() {
  const { httpFetch } = await import('./http.js');
  const net = getNetwork();
  const started = Date.now();
  const targets = ['https://www.bing.com/images/search?q=test', 'https://wallhaven.cc/api/v1/search?q=test'];
  const results = [];
  for (const url of targets) {
    const t0 = Date.now();
    try {
      const res = await httpFetch(url, { signal: AbortSignal.timeout(15000) });
      results.push({
        url,
        ok: res.ok,
        status: res.status,
        ms: Date.now() - t0,
      });
    } catch (err) {
      results.push({ url, ok: false, error: err.message, ms: Date.now() - t0 });
    }
  }
  const ok = results.some((r) => r.ok);
  return {
    ok,
    mode: net.mode,
    proxy: proxyRules(net) || '直连',
    elapsed: Date.now() - started,
    results,
  };
}
