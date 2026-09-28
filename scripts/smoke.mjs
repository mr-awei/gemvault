#!/usr/bin/env node
/**
 * 服务端冒烟测试（零依赖）：
 *  - 用临时用户目录 + 随机端口启动真实服务（真实 SQLite 迁移、鉴权、静态托管）
 *  - 校验：健康检查 / 鉴权 401 / 带 token 200 / 首页含 CSP / SSE 事件流 / settings 脱敏
 * 用法：npm run smoke（先 build web 亦可，dist 不存在时跳过首页 CSP 校验）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 38790 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'gemvault-smoke-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    GEM_USER_DATA: tmpUser,
    GEM_DATA_DIR: path.join(tmpUser, 'data'),
    GEM_DEFAULT_STORAGE_DIR: path.join(tmpUser, 'storage'),
    NO_COLOR: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(deadlineMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status < 500) return true; // 服务已应答即就绪（health 可能要求鉴权）
    } catch {
      /* not yet */
    }
    await sleep(300);
  }
  return false;
}

try {
  check('服务启动', await waitReady());

  // 读自动生成的 API token（wx 独占创建）
  const tokenFile = path.join(tmpUser, '.api-token');
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  check('API token 自动生成', token.length >= 20);

  // 鉴权：无 token → 401；带 token → 200
  const noAuth = await fetch(`${BASE}/api/stats`);
  check('无令牌访问被拒绝 (401)', noAuth.status === 401);
  const withAuth = await fetch(`${BASE}/api/stats`, { headers: { Authorization: `Bearer ${token}` } });
  check('带令牌访问 (200)', withAuth.status === 200);

  // settings 脱敏：weiboCookie 永不回传
  const settings = await (await fetch(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check('settings 脱敏（无 weiboCookie 明文）', !settings.weiboCookie && 'hasWeiboCookie' in settings);

  // SSE 事件流：能收到 hello 事件
  const sse = await fetch(`${BASE}/api/events?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' },
  });
  let gotHello = false;
  if (sse.ok && sse.body) {
    const reader = sse.body.getReader();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const { value, done } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes('event: hello')) {
        gotHello = true;
        break;
      }
    }
    reader.cancel().catch(() => {});
  }
  check('SSE 事件流可用（hello）', gotHello);

  // 首页与安全头（web dist 未构建时跳过 CSP 断言）
  const home = await fetch(`${BASE}/`);
  check('首页可访问', home.status === 200);
  const csp = home.headers.get('content-security-policy');
  const xcto = home.headers.get('x-content-type-options');
  if (home.status === 200 && (await home.text()).includes('<div id="root">')) {
    check('HTML 响应带 CSP 头', !!csp, csp?.slice(0, 60));
  }
  check('安全头 nosniff', xcto === 'nosniff');
} catch (err) {
  check('冒烟过程异常', false, String(err));
} finally {
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error('\n----- 服务端日志（末 2000 字符）-----');
  console.error(serverLog.slice(-2000));
  try { try { fs.rmSync(tmpUser, { recursive: true, force: true }); } catch { /* 句柄延迟释放 */ } } catch { /* Windows 下句柄释放可能有延迟 */ }
  process.exit(1);
}
try { fs.rmSync(tmpUser, { recursive: true, force: true }); } catch { /* 句柄延迟释放 */ }
