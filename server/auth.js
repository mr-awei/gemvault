/**
 * 本地 API 鉴权中间件。
 *
 * 威胁模型：服务监听 127.0.0.1，但"只监听回环"不等于安全——
 * 用户浏览器里打开的任意网页都可以向 http://127.0.0.1:3001 发起跨站请求
 * （CSRF、no-cors 探测、DNS rebinding），读取图库内容甚至改写设置/凭据。
 *
 * 放行规则（满足其一）：
 * 1. 携带有效令牌：`Authorization: Bearer <token>` / `x-api-token` / `?token=`
 *    （query 形式供 EventSource、下载直链等无法自定义 header 的场景）。
 * 2. 浏览器同源请求：`Sec-Fetch-Site` 为 same-origin / same-site / none。
 *    该头由浏览器（含 Electron）自动附加，页面 JS 无法伪造，覆盖本应用
 *    主窗口、动态壁纸 /live 页、Vite dev 代理等全部正常使用方式。
 * 3. 浏览器扩展采集端点：Origin 为 chrome-extension://（同上不可伪造）。
 *
 * 其余调用方（MCP server、调试脚本）从 GEM_API_TOKEN 环境变量或
 * .api-token 文件读取令牌后以 Bearer 头调用。
 */
import { API_TOKEN } from './config.js';

/** 请求是否携带有效令牌（API_TOKEN 为空时视为未启用，仅靠回环监听兜底） */
export function hasValidToken(req) {
  if (!API_TOKEN) return true;
  const auth = String(req.headers['authorization'] || '');
  if (auth.startsWith('Bearer ') && auth.slice(7) === API_TOKEN) return true;
  if (String(req.headers['x-api-token'] || '') === API_TOKEN) return true;
  if (String(req.query?.token || '') === API_TOKEN) return true;
  return false;
}

/** 是否浏览器视角的同源请求（Sec-Fetch-Site 由浏览器设置，页面 JS 不可伪造） */
function isSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  return site === 'same-origin' || site === 'same-site' || site === 'none';
}

/** 挂在全局，内部只拦 /api/*：静态页面与 /live 渲染页本身不含敏感数据 */
export function apiAuth(req, res, next) {
  if (!req.path.startsWith('/api/') && req.path !== '/api') return next();
  if (req.method === 'OPTIONS') return next();
  if (hasValidToken(req)) return next();
  if (isSameOrigin(req)) return next();
  const origin = String(req.headers['origin'] || '');
  if (req.path === '/api/extension/ingest' && /^chrome-extension:\/\//i.test(origin)) return next();
  return res.status(401).json({ error: '未授权：缺少或无效的 API 令牌' });
}
