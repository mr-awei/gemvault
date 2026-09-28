/**
 * 统一的网络出口：
 * - 桌面端（Electron）：走 Chromium 网络栈 net.fetch，自动跟随「网络设置」里的代理
 *   （HTTP / HTTPS / SOCKS5 / SOCKS4 / 系统代理），采集、AI、下载全部生效
 * - 网页模式：退回 Node 原生 fetch
 *
 * 注意：Electron 的 net.fetch 会把 headers 里的 Referer 当作禁用头直接拦截
 * （net::ERR_BLOCKED_BY_CLIENT），因此统一改用标准的 `referrer` 选项。
 */

let netPromise = null;

async function electronNet() {
  if (!netPromise) {
    netPromise = import('electron')
      .then((m) => (m && m.net && typeof m.net.fetch === 'function' ? m.net : null))
      .catch(() => null);
  }
  return netPromise;
}

function extractReferer(headers) {
  const value = headers?.Referer || headers?.referer;
  if (value) {
    delete headers.Referer;
    delete headers.referer;
  }
  return value;
}

export async function httpFetch(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  const referer = extractReferer(headers);
  const net = await electronNet();

  if (net) {
    return net.fetch(url, {
      ...init,
      headers,
      ...(referer ? { referrer: referer } : {}),
    });
  }

  // Node 原生 fetch：Referer 作为普通头即可
  return fetch(url, {
    ...init,
    headers: referer ? { ...headers, Referer: referer } : headers,
  });
}
