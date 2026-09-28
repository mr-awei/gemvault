import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, DEFAULT_STORAGE_DIR } from './config.js';
import { encryptSecret, decryptSecret } from './secret.js';

export const db = new DatabaseSync(DB_FILE);

// 先设 busy_timeout：应用是双进程（Electron 主进程 + node server）共用一个库，
// 启动时两边可能同时初始化，遇到锁应自动等待而不是直接抛 database is locked
db.exec('PRAGMA busy_timeout = 8000;');

// journal_mode 切换需要瞬时独占锁；双进程同时启动时仍可能撞上，重试几次
for (let attempt = 0; ; attempt++) {
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    break;
  } catch (err) {
    if (attempt >= 10 || !String(err?.message || '').includes('locked')) throw err;
    const wait = 300 * (attempt + 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); // 同步等待
  }
}
// WAL 下 NORMAL 是标准配置：提交不再逐次强制 fsync（此前每次独立写库 ~150ms，
// 连续十几次小写入的流程会被拖慢数秒），断电最多丢最后几笔写入，不会损坏数据库
db.exec('PRAGMA synchronous = NORMAL;');

/** 可嵌套事务：已在事务内则直接执行（由外层提交），否则自行 BEGIN/COMMIT */
export function withTransaction(fn) {
  let own = false;
  try {
    db.exec('BEGIN');
    own = true;
  } catch {
    /* 已在事务内 */
  }
  try {
    const result = fn();
    if (own) db.exec('COMMIT');
    return result;
  } catch (err) {
    if (own) {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
    throw err;
  }
}
db.exec(`
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  abs_path TEXT NOT NULL,
  thumb TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  keyword TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  phash TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  viewed_at TEXT NOT NULL DEFAULT '',
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_source ON images(source);
CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 用户删除图片时的不满意反馈（AI 学习素材）
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  created_at TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  ai_analysis TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT ''
);

-- AI 从反馈中归纳出的知识库规则
CREATE TABLE IF NOT EXISTS kb_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 12,
  hits INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'user',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 应用内回收站（移动而非删除，可一键恢复）
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  origin_path TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  phash TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL
);

-- 自定义清单（播放列表）
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE(playlist_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_playlist_items ON playlist_items(playlist_id);

-- 整理页「这组不处理」：记录被跳过的相似组（以组推荐保留项的 id 为标识）
CREATE TABLE IF NOT EXISTS tidy_skip (
  recommend_id INTEGER PRIMARY KEY
);

-- 壁纸自动切换历史
CREATE TABLE IF NOT EXISTS wallpaper_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  scope TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL
);

-- AI 看图描述缓存
CREATE TABLE IF NOT EXISTS ai_desc (
  image_id INTEGER PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '',
  quality INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- CLIP 深度特征（512 维浮点向量，Blob 存储；用于高精度相似判定）
CREATE TABLE IF NOT EXISTS clip_vec (
  image_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- 清晰度缓存（拉普拉斯方差，组内画质排序用）
CREATE TABLE IF NOT EXISTS image_quality (
  image_id INTEGER PRIMARY KEY,
  sharpness REAL NOT NULL,
  created_at TEXT NOT NULL
);

-- 壁纸适配度：本地启发式 / AI 视觉判定结果 + 用户喜欢·不喜欢计数（AI 壁纸闭环）
CREATE TABLE IF NOT EXISTS wallpaper_fit (
  image_id INTEGER PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 60,
  safe_area TEXT NOT NULL DEFAULT 'center',
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'local',
  brightness INTEGER,
  likes INTEGER NOT NULL DEFAULT 0,
  dislikes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 智能文件夹（按条件自动归类 + 文件夹标签继承）
CREATE TABLE IF NOT EXISTS smart_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rules TEXT NOT NULL DEFAULT '{}',
  auto_tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 标签倒排表：tags 列是逗号串，LIKE '%x%' 无法走索引（每次筛选全表扫）。
-- 这里拆成一行一 tag，触发器自动同步（含绕过应用层的直接 SQL 写入），查询走主键索引。
CREATE TABLE IF NOT EXISTS item_tags (
  tag TEXT NOT NULL,
  image_id INTEGER NOT NULL,
  PRIMARY KEY (tag, image_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_image ON item_tags(image_id);
`);

// 触发器依赖的拆分/清理函数（必须在任何写入前注册）
db.function('sync_item_tags', (id, tagsStr) => {
  const tags = String(tagsStr || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  db.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
  for (const t of tags) ins.run(t, id);
});
db.function('delete_item_tags', (id) => {
  db.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
});
db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_item_tags_insert AFTER INSERT ON images BEGIN
  SELECT sync_item_tags(NEW.id, NEW.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_item_tags_update AFTER UPDATE OF tags ON images BEGIN
  SELECT sync_item_tags(NEW.id, NEW.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_item_tags_delete AFTER DELETE ON images BEGIN
  SELECT delete_item_tags(OLD.id);
END;
`);

/** 全量重建标签倒排表（结构升级 / 怀疑不同步时可用） */
export function rebuildItemTags() {
  return withTransaction(() => {
    db.prepare('DELETE FROM item_tags').run();
    const rows = db.prepare("SELECT id, tags FROM images WHERE tags <> ''").all();
    const ins = db.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
    let n = 0;
    for (const r of rows) {
      for (const t of String(r.tags).split(',')) {
        const tag = t.trim();
        if (!tag) continue;
        ins.run(tag, r.id);
        n++;
      }
    }
    return { images: rows.length, pairs: n };
  });
}
{
  // 迁移：老库首次升级时倒排表为空 → 一次性重建
  const need = db.prepare("SELECT count(*) c FROM images WHERE tags <> ''").get().c;
  const have = db.prepare('SELECT count(DISTINCT image_id) c FROM item_tags').get().c;
  if (need > 0 && have === 0) rebuildItemTags();
}

// 迁移：为 images 增加智能评分列
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('images', 'score', 'score INTEGER NOT NULL DEFAULT 100');
ensureColumn('images', 'score_reason', "score_reason TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS idx_images_score ON images(score)');
// 迁移：已读标记（用于「未看过」筛选与幻灯片放映）
ensureColumn('images', 'viewed_at', "viewed_at TEXT NOT NULL DEFAULT ''");
ensureColumn('images', 'view_count', 'view_count INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_images_viewed ON images(view_count)');
// 迁移：整理用的自定义字段（星级 / 备注 / 主色）
ensureColumn('images', 'rating', 'rating INTEGER NOT NULL DEFAULT 0');
ensureColumn('images', 'note', "note TEXT NOT NULL DEFAULT ''");
ensureColumn('images', 'dominant', "dominant TEXT NOT NULL DEFAULT ''");
ensureColumn('images', 'hue', "hue TEXT NOT NULL DEFAULT ''");
ensureColumn('images', 'palette', "palette TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating)');
// 迁移：本地偏好模型打分（0-100，由 preference.js 训练后写入；用于「推荐排序」与壁纸挑选）
ensureColumn('images', 'pref', 'pref INTEGER NOT NULL DEFAULT 50');
db.exec('CREATE INDEX IF NOT EXISTS idx_images_pref ON images(pref)');
db.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
db.exec('CREATE INDEX IF NOT EXISTS idx_images_palette ON images(palette)');

// 迁移：hue 由单列整数改为多值文本（逗号分隔，最多 3 个色系；空串 = 黑白灰）。
// 旧数据 -1 记为 ''，0-11 记为单值字符串；之后由 backfillDominant 用调色板重算为多值。
{
  const hueCol = db.prepare("SELECT name, type FROM pragma_table_info('images') WHERE name='hue'").get();
  if (hueCol && /INT/i.test(hueCol.type || '')) {
    db.exec("ALTER TABLE images ADD COLUMN hue_txt TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE images SET hue_txt = CASE WHEN hue IS NULL OR hue < 0 THEN '' ELSE CAST(hue AS TEXT) END");
    db.exec('DROP INDEX IF EXISTS idx_images_hue');
    try {
      db.exec('ALTER TABLE images DROP COLUMN hue');
      db.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue');
    } catch {
      // 老版本 SQLite 不支持 DROP COLUMN：保留旧整数列（改名），再把新列命名回 hue
      try { db.exec('ALTER TABLE images RENAME COLUMN hue TO hue_old'); } catch {}
      try { db.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue'); } catch {}
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
  }
}

export const DEFAULT_SETTINGS = {
  minResolution: 800, // 长边最小像素
  minFileSize: 30, // 最小 KB
  phashThreshold: 8, // 汉明距离阈值
  pagesPerKeyword: 3, // 每个关键词采集页数
  maxFileSize: 25, // 单张最大 MB
  concurrency: 5,
  sources: {
    bing: true,
    baidu: true,
    sogou: true,
    image360: true,
    duitang: true,
    weibo: false, // 需要登录 Cookie，默认不开，填好后可在采集页勾选
    wallhaven: true,
  },
  wallhavenApiKey: '',
  // 更新源（GitHub owner/repo）：设置页「检查更新」用，留空则提示未配置
  updateRepo: '',
  // 开机自启（桌面端）：应用启动时写入系统登录项
  autoLaunch: false,
  // 微博登录 Cookie（微博接口已关闭游客访问，填了才能用微博源）
  weiboCookie: '',
  // 微博登录会话的 User-Agent：微博风控把登录态与 UA 绑定，采集请求必须复用同一 UA
  weiboUserAgent: '',
  // 桌面端壁纸库文件夹（软件可直接管理其中的图片）
  storageDir: DEFAULT_STORAGE_DIR,
  // 删除策略：trash 回收站 / permanent 彻底删除 / unlink 仅移出图库
  deletePolicy: 'trash',
  // 智能评分：低于该分数的图片在采集时自动丢弃
  scoreThreshold: 40,
  // AI 打标后自动按智能文件夹规则归类（打标 → 自动分类 的联动）
  autoSmartFolder: true,
  // 竖版图设为横屏壁纸时的留白填充方式：blur 模糊同图 / solid 主色 / black 纯黑
  wallpaperFill: 'blur',
  // 壁纸模式：single 单屏 / span 跨屏合成一张 / per-monitor 每屏不同图
  wallpaperMode: 'single',
  // 动态壁纸（把窗口挂到桌面 WorkerW 层，做成真正的动态桌面）
  liveWallpaper: {
    enabled: false,
    mode: 'slideshow', // slideshow 相册轮播 / video 本地视频 / web 网页
    intervalSec: 15,
    videoPath: '',
    webUrl: '',
    mute: true,
    volume: 0,
    kenBurns: true, // 缓慢缩放（Ken Burns 效果）
    scope: 'favorites', // all / favorites / playlist
    playlistId: null,
    minScore: 0,
    pauseOnFullscreen: true, // 有全屏应用/游戏时暂停
    pauseOnBattery: false, // 用电池时暂停
  },
  // 定时自动切换壁纸
  autoWallpaper: {
    enabled: false,
    mode: 'day', // day 每天 / week 每周 / month 每月 / custom 自定义间隔
    atTime: '09:00', // day|week|month 的执行时刻
    weekday: 1, // 每周：1=周一 … 7=周日
    dayOfMonth: 1, // 每月几号
    minutes: 60, // custom 模式的间隔分钟数
    scope: 'favorites', // all 全库 / favorites 收藏 / playlist 指定清单
    playlistId: null,
    order: 'smart', // smart 评分加权随机（优先高分）/ random 等概率 / sequential 顺序
    minScore: 0, // 低于该评分的图片不参与壁纸（0 = 不限）
    excluded: [], // 点过「不喜欢」的图片 id，不再抽中
    perMonitorDifferent: true, // 多屏模式：每个屏幕放不同的图
    lastRunAt: null,
    lastImageId: null,
    cursor: 0,
    // —— AI 壁纸闭环 ——
    useAiFit: true, // 用 AI / 本地启发式评估「适不适合做壁纸」并参与排序
    useTimeAware: true, // 按时间挑：白天偏明亮、夜间偏暗色
    feedbackToKb: true, // 「不喜欢」自动沉淀为知识库规则，越用越准
    autoEnhance: false, // 抽到的图低于画质标准时，先自动增强再设为壁纸
  },
  // 网络代理（走 Chromium 网络栈，采集 / AI / 下载统一生效）
  network: {
    mode: 'off', // off | system | http | https | socks5 | socks4
    host: '127.0.0.1',
    port: 7890,
    username: '',
    password: '',
    bypass: '<local>',
  },
  // 界面主题：dark 暗色（默认）/ light 明亮
  theme: 'dark',
  // 画质增强：低于标准的图片自动收录，可一键增强至标准以上
  enhance: {
    standard: '1080p', // 目标标准（低于该分辨率的图片视为待增强）：480p|720p|1080p|2k|4k|custom
    customWidth: 1920, // standard='custom' 时生效
    customHeight: 1080,
    model: 'sharp-standard', // 默认增强模型（见 server/enhance.js 内置模型）
    remoteServices: [], // 用户配置的线上免费增强服务（可选，软件负责上传/下载/覆盖原文件）
  },
  // AI 接入（OpenAI 兼容）
  ai: {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    visionModel: '',
  },
};

// 默认不预置任何采集关键词——软件是通用图库，搜什么由用户在「采集」页自己填。
// （旧版曾预置邓紫棋系列关键词，已移除；已有安装里遗留的关键词保留，可自行删除。）
const DEFAULT_KEYWORDS = [];

let settingsCache = null;

export function getSettings() {
  // 热路径缓存：getSettings 在服务端被高频调用（请求、调度、AI 流程内部都有），
  // 每次全表 SELECT + JSON.parse + 解密纯属浪费。写路径统一走 saveSettings，会同步失效缓存。
  if (settingsCache) return structuredClone(settingsCache);
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // 采集源是「键值开关」，老版本存下的对象里没有新加的源，这里补齐默认值，
  // 让升级后新增的源也能出现在界面里（已有的开关状态不受影响）
  merged.sources = { ...DEFAULT_SETTINGS.sources, ...(stored.sources || {}) };
  // 微博 Cookie 入库为密文（见 saveSettings），这里解密成明文供服务端内部使用；
  // HTTP 出口由 /api/settings 脱敏，明文永不下发前端
  if (merged.weiboCookie) merged.weiboCookie = decryptSecret(merged.weiboCookie);
  settingsCache = merged;
  return structuredClone(settingsCache);
}

export function saveSettings(patch) {
  const current = getSettings();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // 脱敏辅助字段（服务端生成，不入库）
    if (k === 'hasWeiboCookie' || k === 'hasAiApiKey') continue;
    if (typeof DEFAULT_SETTINGS[k] === 'object' && v && typeof v === 'object') {
      next[k] = { ...DEFAULT_SETTINGS[k], ...current[k], ...v };
    } else {
      next[k] = v;
    }
  }
  // 微博 Cookie 保护规则：
  // 1) 前端拿到的是脱敏值（weiboCookie 恒为空串），全量回传保存时空串视为
  //    「未修改」，绝不能把真实凭据清掉；显式清除必须带 weiboCookieClear: true。
  // 2) 入库统一加密（AES-256-GCM，密钥见 secret.js），数据库文件单独泄露时凭据不落地。
  if (patch.weiboCookieClear) {
    next.weiboCookie = '';
  } else if ('weiboCookie' in patch && !String(patch.weiboCookie || '').trim()) {
    next.weiboCookie = current.weiboCookie;
  }
  // AI API Key 同规则：前端拿到的是脱敏值，空串 = 未修改；显式清除走 aiApiKeyClear
  if (patch.aiApiKeyClear) {
    next.ai = { ...(next.ai || {}), apiKey: '' };
  } else if (next.ai && !String(next.ai.apiKey || '').trim()) {
    next.ai = { ...next.ai, apiKey: current.ai?.apiKey || '' };
  }
  const upsert = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(next)) {
    // 指令键只用于本次保存，不落库
    if (k === 'weiboCookieClear' || k === 'aiApiKeyClear') continue;
    const value = k === 'weiboCookie' ? encryptSecret(String(v || '')) : v;
    upsert.run(k, JSON.stringify(value));
  }
  settingsCache = null; // 下次读取重建缓存
  return next;
}

export function listKeywords() {
  return db.prepare('SELECT * FROM keywords ORDER BY id ASC').all();
}

export function addKeyword(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('关键词不能为空');
  const exists = db.prepare('SELECT id FROM keywords WHERE text = ?').get(value);
  if (exists) return exists.id;
  const info = db
    .prepare('INSERT INTO keywords(text, enabled, created_at) VALUES (?, 1, ?)')
    .run(value, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function updateKeyword(id, patch) {
  const fields = [];
  const values = [];
  if (patch.text !== undefined) {
    fields.push('text = ?');
    values.push(String(patch.text).trim());
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE keywords SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteKeyword(id) {
  db.prepare('DELETE FROM keywords WHERE id = ?').run(id);
}

export function listEnabledKeywords() {
  return db.prepare('SELECT * FROM keywords WHERE enabled = 1 ORDER BY id ASC').all();
}

export function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM keywords').get().c;
  if (count === 0) {
    for (const kw of DEFAULT_KEYWORDS) addKeyword(kw);
  }
}

seedDefaults();
