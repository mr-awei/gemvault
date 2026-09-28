import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { PORT, WEB_DIST, SEED_URLS } from './config.js';
import {
  db,
  getSettings,
  saveSettings,
  listKeywords,
  addKeyword,
  updateKeyword,
  deleteKeyword,
} from './db.js';
import * as lib from './library.js';
import { getJobStatus, startCrawl, stopCrawl, ingestUrls, SOURCES } from './crawler.js';
import * as clip from './clip.js';
import { importLocalImages, findMissing, purgeMissing, relocateMissing, watchStorageDir } from './importer.js';
import { openFolder, revealFile, setWallpaper, platform, listMonitors, isFullscreenAppRunning } from './desktop.js';
import { LIVE_HTML } from './live-page.js';
import * as ai from './ai.js';
import * as kb from './kb.js';
import * as search from './search.js';
import * as wallpaper from './wallpaper.js';
import * as aiUpscale from './ai-upscale.js';
import * as srDeep from './sr-deep.js';
import * as fit from './wallpaper-fit.js';
import * as pref from './preference.js';
import * as matting from './matting.js';
import * as enhanceJob from './enhance-job.js';
import { getNetwork, saveNetwork, applyProxy, testNetwork, PROXY_MODES } from './network.js';
import * as auto from './auto.js';
import { httpFetch } from './http.js';
import { liveBus } from './live-bus.js';
import { apiAuth } from './auth.js';

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** AI 运行库自检去重标记 */
let upscaleChecking = false;

/* ---------------------------------- 工具 ---------------------------------- */

function buildFilter(query, colorIds) {
  const where = [];
  const params = [];

  if (query.q) {
    const like = `%${String(query.q).trim()}%`;
    // 关键词除了匹配文件名 / 标签 / 采集词，也匹配 AI 看图描述与备注（自然语言搜索）
    where.push(
      `(title LIKE ? OR tags LIKE ? OR keyword LIKE ? OR note LIKE ?
        OR id IN (SELECT image_id FROM ai_desc WHERE description LIKE ? OR issues LIKE ?))`
    );
    params.push(like, like, like, like, like, like);
  }
  const source = String(query.source || '').trim();
  if (source && source !== 'all') {
    const list = source.split(',').filter(Boolean);
    where.push(`source IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  const favorite = String(query.favorite || 'all');
  if (favorite === 'yes') where.push('favorite = 1');
  if (favorite === 'no') where.push('favorite = 0');

  const orientation = String(query.orientation || 'all');
  if (orientation && orientation !== 'all') {
    if (orientation === 'portrait') where.push('height > width * 1.15');
    else if (orientation === 'landscape') where.push('width > height * 1.15');
    else if (orientation === 'square') where.push('ABS(width - height) <= width * 0.15');
  }

  const bucket = String(query.bucket || '').trim();
  if (bucket && bucket !== 'all') {
    const list = bucket.split(',').filter(Boolean);
    const clauses = [];
    for (const b of list) {
      if (b === 'sd') clauses.push('MAX(width, height) < 1080');
      else if (b === 'fhd') clauses.push('MAX(width, height) >= 1080 AND MAX(width, height) < 2048');
      else if (b === '2k') clauses.push('MAX(width, height) >= 2048 AND MAX(width, height) < 3840');
      else if (b === '4k') clauses.push('MAX(width, height) >= 3840');
    }
    if (clauses.length) where.push(`(${clauses.join(' OR ')})`);
  }

  const tag = String(query.tag || '').trim();
  if (tag) {
    // 标签倒排表精确命中（触发器自动同步），替代 LIKE 全表扫
    where.push('id IN (SELECT image_id FROM item_tags WHERE tag = ?)');
    params.push(tag);
  }

  // 已看 / 未看过
  const seen = String(query.seen || 'all');
  if (seen === 'unseen') where.push('view_count = 0');
  else if (seen === 'seen') where.push('view_count > 0');

  // 星级（至少 N 星）
  const minRating = Number(query.minRating) || 0;
  if (minRating > 0) {
    where.push('rating >= ?');
    params.push(minRating);
  }

  // 色系（0-11，逗号分隔可多选；gray 表示接近黑白灰）。
  // hue 现已为多值文本（逗号分隔，最多 3 个），任意一项命中即匹配。
  const hue = String(query.hue || '').trim();
  if (hue && hue !== 'all') {
    const list = hue.split(',').filter(Boolean);
    const clauses = [];
    const hues = list.filter((h) => h !== 'gray').map(Number).filter((n) => !Number.isNaN(n));
    if (hues.length) {
      // 用 '%,N,%' 包围匹配，避免 '2' 误中 '12' 之类
      const sub = hues.map(() => `',' || hue || ',' LIKE '%,' || ? || ',%'`).join(' OR ');
      clauses.push(`(${sub})`);
    }
    if (list.includes('gray')) clauses.push(`(hue = '' OR hue IS NULL)`);
    if (clauses.length) {
      where.push(`(${clauses.join(' OR ')})`);
      params.push(...hues.map(String)); // 必须传字符串：node:sqlite 在 || 拼接里会把整数参数当数字，导致 LIKE 匹配失效
    }
  }

  // 精确颜色筛选（Eagle 式色盘）：调用方已用 scoreByColor 算好按相似度排序的 id 列表
  if (colorIds) {
    if (!colorIds.length) where.push('0 = 1');
    else {
      where.push(`id IN (${colorIds.map(() => '?').join(',')})`);
      params.push(...colorIds);
    }
  }

  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

/** 精确颜色筛选：解析 colorHex/colorTol，返回按颜色质量降序的全量 id；未启用时返回 null */
function colorFilterIds(query) {
  const hex = String(query.colorHex || '').trim();
  if (!hex) return null;
  const tol = Number(query.colorTol);
  return search.scoreByColor(hex, Number.isFinite(tol) ? tol : 48).map((s) => s.id);
}

const SORTS = {
  newest: 'created_at DESC, id DESC',
  oldest: 'created_at ASC, id ASC',
  largest: 'size_bytes DESC',
  resolution: '(width * height) DESC',
  smart: 'score DESC, created_at DESC',
  worst: 'score ASC, created_at DESC',
  rating: 'rating DESC, score DESC, created_at DESC',
  // 本地偏好模型：按「你可能更喜欢」排序（preference.js 训练后写入 images.pref）
  recommend: 'pref DESC, score DESC, created_at DESC',
  random: 'RANDOM()',
};

/** 启动时的初始化：载入 pHash 索引，图库为空则导入本地素材 */
function bootstrap() {
  const imageCount = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  console.log(`[db] 图片 ${imageCount} 张，pHash 索引 ${lib.initPhashIndex()} 条`);
  // 后台预加载 CLIP 模型（首次会下载 ~150MB，之后走本地缓存）；就绪后补算缺失特征
  clip
    .clipLoad()
    .then((r) => {
      if (!r.ok) return console.log('[clip] 模型加载失败（CLIP 功能暂不可用）：', r.error);
      console.log('[clip] 模型就绪，已建模', clip.embeddingCount(), '张');
      if (clip.embeddingCount() < imageCount) clip.startBackfill();
    })
    .catch(() => {});
  if (imageCount === 0) {
    console.log('[启动] 图库为空，开始导入工作区内已有素材…');
    importLocalImages({
      onProgress: (progress, _file, result) => {
        if (progress % 20 === 0) console.log(`[导入] ${progress}% 已保存 ${result.saved}`);
      },
    })
      .then(async (result) => {
        console.log('[导入] 完成', result);
        const seeds = await ingestUrls(SEED_URLS);
        console.log('[种子素材]', seeds.map((s) => (s.ok ? 'ok' : s.reason)).join(', '));
      })
      .catch((err) => console.error('[导入] 失败', err));
  }
}

export function buildApp({ desktop = false } = {}) {
  const app = express();
  // 本地 API 鉴权：拦住本机任意网页的跨站调用与无令牌的裸调用（规则见 auth.js）
  app.use(apiAuth);
  // 基础安全头：防 MIME 嗅探 / 点击劫持 / 引用泄漏（CSP 由 meta 承担 dev，生产 HTML 再叠加严格头）
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  // 限制请求体大小：50MB 足够大图 base64 导入，同时防止恶意超大请求打爆内存
  app.use(express.json({ limit: '50mb' }));

  /* ----------------------------- 实时事件（SSE） ----------------------------- */
  // 前端所有任务进度 / 库变化由此推送，替代各页面散落的 setInterval 轮询。

  const sseClients = new Set();
  let sseSeq = 0;

  function sseBroadcast(type, data) {
    if (!sseClients.size) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`id: ${++sseSeq}\nevent: hello\ndata: {"time":${Date.now()}}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        /* close 时由 req close 统一清理 */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // 动态壁纸配置变更：Electron 主进程已在监听，这里转发给网页端
  liveBus.on('changed', (cfg) => sseBroadcast('live', { mode: cfg?.mode || '' }));

  // 服务端单点采样：任务状态全在进程内存里，1.5s 对比一次，变化才广播。
  // 此前是「N 个页面 × 各自 setInterval × HTTP 请求」，现在收敛为进程内一次快照对比。
  const jobSnapshot = () => ({
    crawl: getJobStatus(),
    import: importState,
    enhance: enhanceJob.jobStatus(),
    clip: clip.backfillStatus(),
    sr: srDeep.srStatus(),
    aiUp: aiUpscale.aiStatus(),
    matting: matting.mattingStatus(),
  });
  let lastJobJson = '';
  setInterval(() => {
    if (!sseClients.size) return;
    let snap;
    try {
      snap = jobSnapshot();
    } catch {
      return;
    }
    const json = JSON.stringify(snap);
    if (json !== lastJobJson) {
      lastJobJson = json;
      sseBroadcast('job', snap);
    }
  }, 1500).unref?.();

  // 写操作统一广播「库已变化」：App 端据此刷新统计/列表，无需页面各自轮询
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400 && body && body.ok !== false) {
        setImmediate(() => sseBroadcast('library', { path: req.path }));
      }
      return originalJson(body);
    };
    next();
  });

  /* -------------------------------- 系统能力 ------------------------------- */

  app.get('/api/system/info', (_req, res) => {
    const settings = getSettings();
    res.json({
      platform,
      desktop,
      storageDir: settings.storageDir,
      hasBuild: fs.existsSync(WEB_DIST),
    });
  });

  app.post(
    '/api/system/open-folder',
    asyncRoute(async (req, res) => {
      const dir = req.body?.path || getSettings().storageDir;
      lib.resolveStorageDir(getSettings());
      openFolder(dir);
      res.json({ ok: true, path: dir });
    })
  );

  app.post(
    '/api/system/reveal',
    asyncRoute(async (req, res) => {
      const target = req.body?.path;
      if (!target) return res.status(400).json({ error: '缺少路径' });
      revealFile(target);
      res.json({ ok: true });
    })
  );

  /** 设为桌面壁纸：竖版图会合成「完整竖图居中 + 氛围底」，不裁切 */
  app.post(
    '/api/images/:id/wallpaper',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).json({ error: '图片不存在' });
      try {
        const style = req.body?.style || getSettings().wallpaperFill || 'blur';
        const result = await wallpaper.buildWallpaper(Number(req.params.id), style);
        await setWallpaper(result.path);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: `设置壁纸失败：${err.message}` });
      }
    })
  );

  /** 预览合成后的壁纸（不会真的设置） */
  app.get(
    '/api/images/:id/wallpaper-preview',
    asyncRoute(async (req, res) => {
      const style = String(req.query.style || getSettings().wallpaperFill || 'blur');
      const result = await wallpaper.buildWallpaper(Number(req.params.id), style);
      res.set('Cache-Control', 'no-store');
      res.sendFile(result.path);
    })
  );

  /* --------------------------------- 图片 API ------------------------------- */

  app.get(
    '/api/images',
    asyncRoute(async (req, res) => {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(120, Math.max(12, Number(req.query.pageSize || 48)));
      const colorIds = colorFilterIds(req.query);
      const { sql, params } = buildFilter(req.query, colorIds);
      // 颜色筛选：结果需按颜色相似度排序，取全量后在内存里按质量序分页
      if (colorIds) {
        if (!colorIds.length) {
          return res.json({ items: [], total: 0, page, pageSize, hasMore: false });
        }
        const rank = new Map(colorIds.map((id, i) => [id, i]));
        const all = db.prepare(`SELECT * FROM images ${sql}`).all(...params);
        all.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
        const total = all.length;
        const items = all.slice((page - 1) * pageSize, page * pageSize).map(lib.toDTO);
        return res.json({ items, total, page, pageSize, hasMore: page * pageSize < total });
      }
      const order = SORTS[req.query.sort] || SORTS.newest;
      const total = db.prepare(`SELECT COUNT(*) AS c FROM images ${sql}`).get(...params).c;
      const rows = db
        .prepare(`SELECT * FROM images ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize);
      res.json({
        items: rows.map(lib.toDTO),
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total,
      });
    })
  );

  app.get(
    '/api/images/:id',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      res.json(lib.toDTO(row));
    })
  );

  // 找出与某张图相似的其他图（CLIP 余弦，阈值可调；缺特征时现算并入库）
  app.get(
    '/api/images/:id/similar',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const minCos = Math.max(0.5, Math.min(0.999, Number(req.query.minCos) || 0.9));
      const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
      if (!clip.clipReady()) {
        return res.status(503).json({ error: 'CLIP 模型尚未加载完成，稍后再试' });
      }
      let vec = clip.getEmbedding(id);
      if (!vec) {
        vec = await clip.embedImage(row.abs_path);
        clip.saveEmbedding(id, vec);
      }
      const hits = clip.topSimilar(vec, { k: limit, minCos, excludeId: id });
      const cosById = new Map(hits.map((h) => [h.id, h.cos]));
      const items = hits.length
        ? db
            .prepare(`SELECT * FROM images WHERE id IN (${hits.map(() => '?').join(',')})`)
            .all(...hits.map((h) => h.id))
            .sort((a, b) => cosById.get(b.id) - cosById.get(a.id))
            .map((r) => ({ ...lib.toDTO(r), cos: +cosById.get(r.id).toFixed(4) }))
        : [];
      res.json({ minCos, count: items.length, items });
    })
  );

  app.patch(
    '/api/images/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      if (req.body.favorite !== undefined) lib.setFavorite(id, !!req.body.favorite);
      if (req.body.tags !== undefined) lib.setTags(id, req.body.tags);
      if (req.body.title !== undefined) lib.renameTitle(id, req.body.title);
      if (req.body.rating !== undefined) lib.setRating(id, req.body.rating);
      if (req.body.note !== undefined) lib.setNote(id, req.body.note);
      res.json(lib.toDTO(lib.getImage(id)));
    })
  );

  app.delete(
    '/api/images/:id',
    asyncRoute(async (req, res) => {
      const result = await lib.removeImage(Number(req.params.id));
      res.json(result);
    })
  );

  /** 删除并留下「为什么不满意」的反馈（只记录原因，AI 归纳在知识库页手动触发） */
  app.post(
    '/api/images/:id/delete-reason',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const { reasons = [], note = '', aiAnalysis = '' } = req.body || {};
      const feedbackId = kb.addFeedback({ imageId: id, reasons, note, aiAnalysis });
      const removed = await lib.removeImage(id, { reason: (reasons || []).join('/') });
      if (!removed.ok) return res.status(500).json({ error: removed.error, feedbackId });
      res.json({ ok: removed.ok, feedbackId });
    })
  );

  app.post(
    '/api/images/:id/rename',
    asyncRoute(async (req, res) => {
      const updated = await lib.renameImage(Number(req.params.id), req.body?.title || '');
      res.json(updated);
    })
  );

  /** 物理旋转图片（写回原文件），其他软件打开即为旋转后效果 */
  /* 已读标记（大图预览时调用，用于「未看过」筛选） */
  app.post(
    '/api/images/:id/viewed',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      res.json({ ok: true, item: lib.markViewed(id) });
    })
  );

  /* ------------------------------ 整理概览 ------------------------------ */
  app.get('/api/tidy/stats', (_req, res) => {
    const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
    const noDominant = db.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant = ''").get().c;
    const noAiDesc = db
      .prepare('SELECT COUNT(*) AS c FROM images WHERE id NOT IN (SELECT image_id FROM ai_desc)')
      .get().c;
    const noRating = db.prepare('SELECT COUNT(*) AS c FROM images WHERE rating = 0').get().c;
    const rated = db.prepare('SELECT COUNT(*) AS c FROM images WHERE rating > 0').get().c;
    res.json({ total, noDominant, noAiDesc, noRating, rated });
  });

  /* ------------------------------ 相似图整理 ------------------------------ */
  app.get(
    '/api/similar',
    asyncRoute(async (req, res) => {
      const threshold = Math.max(
        0,
        Math.min(24, Number(req.query.threshold) || getSettings().phashThreshold || 10)
      );
      const groups = lib.listSimilarGroups(threshold);
      res.json({ threshold, count: groups.length, groups });
    })
  );

  // CLIP 深度特征相似分组：能抓住 pHash 漏掉的裁剪/旋转/滤镜变体
  app.get(
    '/api/similar/clip',
    asyncRoute(async (req, res) => {
      const minCos = Math.max(0.8, Math.min(0.999, Number(req.query.minCos) || 0.92));
      if (!clip.clipReady()) {
        return res.status(503).json({ error: 'CLIP 模型尚未加载完成，稍后再试（首次需下载模型）' });
      }
      const groups = await lib.listClipSimilarGroups(minCos);
      res.json({ minCos, count: groups.length, groups });
    })
  );

  // CLIP 状态与全库补算
  app.get('/api/clip/status', (_req, res) => res.json(clip.backfillStatus()));
  app.post('/api/clip/backfill', (_req, res) => res.json(clip.startBackfill()));

  // 同名跨格式去重：同目录同名（如 5.jpg 与 5.png）视为同一张，推荐保留 PNG；删除复用 /api/similar/resolve
  app.get('/api/dupes/format', (_req, res) => {
    const groups = lib.listFormatDupes();
    res.json({ count: groups.length, groups });
  });

  app.post(
    '/api/similar/resolve',
    asyncRoute(async (req, res) => {
      const keepId = Number(req.body?.keepId);
      if (!keepId) return res.status(400).json({ error: '缺少要保留的图片' });
      const result = await lib.resolveSimilar(keepId, req.body?.removeIds || []);
      res.json({ ok: true, ...result });
    })
  );

  // 整理页「这组不处理」：持久化跳过的相似组（基于组推荐保留项 id）
  app.get(
    '/api/tidy/skip',
    asyncRoute(async (_req, res) => {
      res.json({ ids: lib.getTidySkips() });
    })
  );
  app.post(
    '/api/tidy/skip',
    asyncRoute(async (req, res) => {
      const id = Number(req.body?.id);
      if (!id) return res.status(400).json({ error: '缺少组标识' });
      res.json({ ok: true, ids: lib.addTidySkip(id) });
    })
  );
  app.post(
    '/api/tidy/skip/reset',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ids: lib.resetTidySkips() });
    })
  );

  /* 老图片补算主色（分次执行，前端可重复调用）。force=true 时重算全部（修正旧调色板） */
  app.post(
    '/api/maintenance/dominant',
    asyncRoute(async (req, res) => {
      const result = await lib.backfillDominant(
        Number(req.body?.limit) || 300,
        req.body?.force === true || req.body?.force === 'true'
      );
      res.json({ ok: true, ...result });
    })
  );

  /* AI 看图打标：给还没分析过的图生成描述，供「自然语言搜索」用 */
  app.post(
    '/api/ai/tag-batch',
    asyncRoute(async (req, res) => {
      const limit = Math.max(1, Math.min(40, Number(req.body?.limit) || 6));
      const rows = db
        .prepare(
          `SELECT id FROM images WHERE id NOT IN (SELECT image_id FROM ai_desc)
           ORDER BY rating DESC, score DESC LIMIT ?`
        )
        .all(limit);
      const results = [];
      const autoFolder = getSettings().autoSmartFolder !== false;
      for (const r of rows) {
        try {
          const d = await ai.analyzeImage(r.id);
          // 打标后自动按智能文件夹规则归类（可被设置关闭）
          let folderChanges = 0;
          if (autoFolder) folderChanges = lib.applySmartFolderTags(r.id);
          results.push({ id: r.id, ok: true, description: d.description, folderChanges });
        } catch (err) {
          results.push({ id: r.id, ok: false, error: err.message });
          break; // AI 没配置好就不必继续
        }
      }
      const remain = db
        .prepare('SELECT COUNT(*) AS c FROM images WHERE id NOT IN (SELECT image_id FROM ai_desc)')
        .get().c;
      res.json({ ok: true, done: results.filter((r) => r.ok).length, remain, results });
    })
  );

  /* 单张 AI 识图（读缓存 / 重新分析） */
  app.get(
    '/api/images/:id/ai',
    asyncRoute(async (req, res) => {
      res.json(ai.getAiDesc(Number(req.params.id)) || {});
    })
  );

  app.post(
    '/api/images/:id/ai',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      try {
        res.json({ ok: true, ...(await ai.analyzeImage(id)) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })
  );

  /* 把当前筛选结果整体标记为已看 */
  app.post(
    '/api/images/viewed-all',
    asyncRoute(async (req, res) => {
      const { sql, params } = buildFilter(req.body || {}, colorFilterIds(req.body || {}));
      const rows = db.prepare(`SELECT id FROM images ${sql}`).all(...params);
      res.json({ ok: true, affected: lib.markAllViewed(rows.map((r) => r.id)) });
    })
  );

  app.post(
    '/api/images/:id/rotate',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const dir = req.body?.dir === 'ccw' ? 'ccw' : 'cw';
      try {
        const item = await lib.rotateImage(id, dir);
        res.json({ ok: true, item });
      } catch (err) {
        res.status(500).json({ error: err.message || '旋转失败' });
      }
    })
  );

  /* ------------------------------ 画质增强 ------------------------------ */
  app.get(
    '/api/enhance/standards',
    (_req, res) => {
      res.json({
        standards: Object.entries(lib.ENHANCE_STANDARDS).map(([key, v]) => ({ key, label: v.label })),
        config: getSettings().enhance || {},
      });
    }
  );

  app.get(
    '/api/enhance/candidates',
    asyncRoute(async (req, res) => {
      const standard = String(req.query.standard || getSettings().enhance?.standard || '1080p');
      const items = lib.listBelowStandard(standard);
      // 尺寸会随增强变化，禁止任何缓存
      res.set('Cache-Control', 'no-store');
      // count 是真实总数（items 可能因上限被截断）
      res.json({ standard, count: lib.countBelowStandard(standard), items });
    })
  );

  app.get(
    '/api/enhance/models',
    (_req, res) => {
      const cfg = getSettings().enhance || {};
      const ai = aiUpscale.aiStatus();
      const aiUsable = ai.installed && ai.usable !== false;
      res.json({
        builtin: lib.ENHANCE_MODELS,
        remote: cfg.remoteServices || [],
        // 内置 Real-ESRGAN 模型 + 社区模型（未安装的会标注，可在设置页一键安装）
        ai: [
          ...ai.models.map((m) => ({ ...m, available: aiUsable })),
          ...ai.community.map((m) => ({ ...m, available: aiUsable && m.installed })),
          ...ai.cugan.models.map((name) => ({
            id: `cugan:${name}`,
            name,
            label: `Real-CUGAN · ${name}`,
            desc: '带降噪档位，适合噪点重的图（两级流程自动使用）',
            maxScale: 4,
            available: aiUsable && ai.cugan.installed,
          })),
          // 第二档：Transformer 系（高画质·慢），首次使用自动下载模型
          ...srDeep.srStatus().models.map((m) => ({
            id: m.id,
            name: m.repo,
            label: m.label,
            desc: `${m.desc}（高画质·慢${m.downloaded ? '' : '，首次使用需下载'}）`,
            maxScale: m.scale,
            available: true,
          })),
        ],
        aiInstalled: ai.installed,
        cugan: ai.cugan,
      });
    }
  );

  // AI 超分运行库状态 / 安装 / 自检
  app.get('/api/ai/upscale/status', (_req, res) => {
    const st = aiUpscale.aiStatus();
    // 已安装但还没自检过 → 后台补一次自检（记录显卡名与可用性）
    if (st.installed && st.usable === null && !upscaleChecking) {
      upscaleChecking = true;
      aiUpscale.selfTest().finally(() => {
        upscaleChecking = false;
      });
    }
    res.json(st);
  });

  // 安装社区模型（param + bin，各几 MB）
  app.post(
    '/api/ai/upscale/install-model',
    asyncRoute(async (req, res) => {
      const modelId = String(req.body?.id || '');
      if (!modelId) return res.status(400).json({ error: '缺少模型 id' });
      res.json({ ok: true, ...(await aiUpscale.installCommunityModel(modelId)) });
    })
  );

  // Transformer 超分（Swin2SR）状态与模型下载 / 预热
  app.get('/api/ai/sr/status', (_req, res) => res.json(srDeep.srStatus()));
  app.post(
    '/api/ai/sr/load',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, ...(await srDeep.loadSrModel(String(req.body?.id || ''))) });
    })
  );

  // 安装 Real-CUGAN 运行库（两级增强的降噪前置引擎）
  app.post(
    '/api/ai/upscale/install-cugan',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await aiUpscale.installCuganRuntime()) });
    })
  );

  app.post(
    '/api/ai/upscale/install',
    asyncRoute(async (_req, res) => {
      const st = aiUpscale.aiStatus();
      if (st.downloading) return res.json({ ok: true, ...st });
      // 后台安装，前端轮询状态
      aiUpscale.installRuntime().catch((err) => console.error('[ai] 安装失败', err.message));
      res.json({ ok: true, ...aiUpscale.aiStatus() });
    })
  );

  app.post(
    '/api/ai/upscale/selftest',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await aiUpscale.selfTest()) });
    })
  );

  // 线上服务连通性测试（用合成小图跑完整流程，不动真实图片）
  app.post(
    '/api/enhance/remote/test',
    asyncRoute(async (req, res) => {
      res.json(await lib.testRemoteService(req.body?.service || req.body || {}));
    })
  );

  // 增强后台任务（AI 单张耗时较长，批量异步 + 轮询）
  app.get('/api/enhance/job', (_req, res) => res.json(enhanceJob.jobStatus()));

  app.post(
    '/api/enhance/job/start',
    asyncRoute(async (req, res) => {
      const ids = (req.body?.ids || []).map(Number).filter(Boolean);
      const model = String(req.body?.model || getSettings().enhance?.model || 'sharp-standard');
      const standard = req.body?.standard;
      res.json({ ok: true, ...enhanceJob.startJob(ids, model, standard) });
    })
  );

  app.post('/api/enhance/job/cancel', (_req, res) => res.json({ ok: true, ...enhanceJob.cancelJob() }));

  app.post(
    '/api/enhance/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const model = String(req.body?.model || '');
      try {
        const settings = getSettings().enhance || {};
        let item;
        if (model.startsWith('remote:')) {
          const svc = (settings.remoteServices || []).find((s) => `remote:${s.id}` === model);
          if (!svc) return res.status(400).json({ error: '指定的线上服务不存在' });
          item = await lib.enhanceImageRemote(id, svc);
        } else {
          item = await lib.enhanceImage(id, model || settings.model || 'sharp-standard', {
            standard: req.body?.standard,
          });
        }
        res.json({ ok: true, item });
      } catch (err) {
        res.status(500).json({ error: err.message || '增强失败' });
      }
    })
  );

  app.post(
    '/api/enhance/batch',
    asyncRoute(async (req, res) => {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      const model = String(req.body?.model || getSettings().enhance?.model || 'sharp-standard');
      const standard = req.body?.standard;
      const results = [];
      let success = 0;
      for (const id of ids) {
        try {
          const settings = getSettings().enhance || {};
          let item;
          if (model.startsWith('remote:')) {
            const svc = (settings.remoteServices || []).find((s) => `remote:${s.id}` === model);
            if (!svc) throw new Error('线上服务不存在');
            item = await lib.enhanceImageRemote(id, svc);
          } else {
            item = await lib.enhanceImage(id, model, { standard });
          }
          results.push({ id, ok: true, item });
          success++;
        } catch (err) {
          results.push({ id, ok: false, error: String((err && err.message) || err) });
        }
      }
      res.json({ ok: true, success, total: ids.length, results });
    })
  );

  app.post(
    '/api/images/batch',
    asyncRoute(async (req, res) => {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      const action = req.body.action;
      let affected = 0;
      for (const id of ids) {
        if (!lib.getImage(id)) continue;
        if (action === 'favorite') lib.setFavorite(id, true);
        else if (action === 'unfavorite') lib.setFavorite(id, false);
        else if (action === 'delete') await lib.removeImage(id);
        else if (action === 'addTag' && req.body.tag) {
          const row = lib.getImage(id);
          const tags = row.tags ? row.tags.split(',').filter(Boolean) : [];
          const tag = String(req.body.tag).trim();
          if (tag && !tags.includes(tag)) lib.setTags(id, [...tags, tag]);
        }
        affected++;
      }
      res.json({ ok: true, affected });
    })
  );

  /* -------------------------------- 文件服务 -------------------------------- */

  app.get(
    '/api/images/:id/thumb',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).end('not found');
      // 缩略图按需生成：增强/旋转后旧缩略图会被删除，这里负责重建
      // （否则会退回发送整张大图，图库加载会变成每张几百 KB）
      const thumb = await lib.ensureThumb(id, row.abs_path);
      const file = thumb && fs.existsSync(thumb) ? thumb : row.abs_path;
      if (!fs.existsSync(file)) return res.status(404).end('file missing');
      res.set('Cache-Control', 'public, max-age=604800');
      res.type(file); // 按真实扩展名给 Content-Type（原来是硬写 image/jpeg）
      res.sendFile(file);
    })
  );

  app.get(
    '/api/images/:id/file',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).end('not found');
      res.set('Cache-Control', 'public, max-age=604800');
      res.sendFile(row.abs_path);
    })
  );

  app.get(
    '/api/images/:id/download',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).end('not found');
      const ext = path.extname(row.abs_path) || '.jpg';
      const name = `邓紫棋_${row.id}_${row.width}x${row.height}${ext}`;
      res.set(
        'Content-Disposition',
        `attachment; filename="gem_${row.id}${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`
      );
      res.sendFile(row.abs_path);
    })
  );

  async function streamZip(ids, res) {
    const rows = ids.map((id) => lib.getImage(id)).filter((r) => r && fs.existsSync(r.abs_path));
    if (!rows.length) {
      res.status(400).json({ error: '没有可下载的图片' });
      return;
    }
    res.set(
      'Content-Disposition',
      `attachment; filename="gem-wallpapers.zip"; filename*=UTF-8''${encodeURIComponent('邓紫棋壁纸合集.zip')}`
    );
    res.set('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => res.status(500).end(err.message));
    archive.pipe(res);
    const used = new Set();
    for (const row of rows) {
      const ext = path.extname(row.abs_path) || '.jpg';
      let base = `邓紫棋_${row.width}x${row.height}_${row.id}`;
      let name = base + ext;
      let i = 1;
      while (used.has(name)) name = `${base}_${++i}${ext}`;
      used.add(name);
      archive.file(row.abs_path, { name });
    }
    await archive.finalize();
  }

  app.post(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      await streamZip((req.body.ids || []).map(Number).filter(Boolean), res);
    })
  );

  app.get(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter(Boolean);
      await streamZip(ids, res);
    })
  );

  /* --------------------------------- 统计 ---------------------------------- */

  app.get(
    '/api/stats',
    asyncRoute(async (_req, res) => {
      const bucketExpr = `CASE
        WHEN MAX(width, height) < 1080 THEN 'sd'
        WHEN MAX(width, height) < 2048 THEN 'fhd'
        WHEN MAX(width, height) < 3840 THEN '2k'
        ELSE '4k' END`;
      const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
      const favorite = db.prepare('SELECT COUNT(*) AS c FROM images WHERE favorite = 1').get().c;
      const sizeRow = db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS s FROM images').get();
      const bySource = db
        .prepare('SELECT source, COUNT(*) AS count FROM images GROUP BY source ORDER BY count DESC')
        .all();
      const byBucket = db
        .prepare(`SELECT ${bucketExpr} AS bucket, COUNT(*) AS count FROM images GROUP BY bucket`)
        .all();
      const byOrientation = db
        .prepare(
          `SELECT CASE
            WHEN height > width * 1.15 THEN 'portrait'
            WHEN width > height * 1.15 THEN 'landscape'
            ELSE 'square' END AS orientation,
            COUNT(*) AS count FROM images GROUP BY orientation`
        )
        .all();
      const trendRows = db
        .prepare(
          'SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count FROM images GROUP BY date ORDER BY date DESC LIMIT 14'
        )
        .all();

      const tagCounter = new Map();
      for (const row of db.prepare("SELECT tags FROM images WHERE tags <> ''").all()) {
        for (const tag of row.tags.split(',')) {
          const t = tag.trim();
          if (t) tagCounter.set(t, (tagCounter.get(t) || 0) + 1);
        }
      }
      const topTags = [...tagCounter.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);

      const recent = db
        .prepare('SELECT * FROM images ORDER BY created_at DESC, id DESC LIMIT 12')
        .all()
        .map(lib.toDTO);
      const largest = db
        .prepare('SELECT * FROM images ORDER BY (width * height) DESC LIMIT 4')
        .all()
        .map(lib.toDTO);

      res.json({
        total,
        favorite,
        totalSize: sizeRow.s,
        bySource,
        byBucket,
        byOrientation,
        trend: trendRows.slice().reverse(),
        topTags,
        recent,
        largest,
        crawling: getJobStatus().running,
      });
    })
  );

  app.get('/api/tags', (_req, res) => {
    const counter = new Map();
    for (const row of db.prepare("SELECT tags FROM images WHERE tags <> ''").all()) {
      for (const tag of row.tags.split(',')) {
        const t = tag.trim();
        if (t) counter.set(t, (counter.get(t) || 0) + 1);
      }
    }
    res.json([...counter.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count));
  });

  /* ----------------------------------- AI ---------------------------------- */

  app.get('/api/ai/presets', (_req, res) => res.json(ai.AI_PRESETS));
  app.get('/api/ai/status', (_req, res) => res.json(ai.aiStatus()));

  app.post(
    '/api/ai/test',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await ai.testConnection()) });
    })
  );

  app.post(
    '/api/ai/models',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, models: await ai.listModels() });
    })
  );

  app.post(
    '/api/ai/analyze',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, ...(await ai.analyzeImage(Number(req.body?.id))) });
    })
  );

  app.get('/api/ai/desc/:id', (req, res) => res.json(ai.getAiDesc(Number(req.params.id)) || null));

  /* ------------------------------ 检索：颜色 / AI / 以图 ------------------------------ */

  /** 颜色搜索：给定 #rrggbb，返回主色/调色板相近的图片，tol 越大越宽松 */
  app.get(
    '/api/search/color',
    asyncRoute(async (req, res) => {
      const hex = String(req.query.hex || '').trim();
      if (!hex) return res.status(400).json({ error: '缺少 hex 参数（如 #aabbcc）' });
      const tol = Math.max(0, Math.min(160, Number(req.query.tol) || 48));
      const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));
      try {
        const items = search.searchByColor(hex, tol, limit);
        res.json({ hex, tolerance: tol, total: items.length, items });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /** AI 语义搜索：自然语言 → 结构化过滤 + 关键词，复用现有 OpenAI 兼容 AI（无需 embedding） */
  app.post(
    '/api/search/ai',
    asyncRoute(async (req, res) => {
      const query = String(req.body?.query || req.body?.q || '').trim();
      if (!query) return res.status(400).json({ error: '缺少 query 参数' });
      const limit = Math.min(300, Math.max(1, Number(req.body?.limit) || 60));
      try {
        const items = await search.aiSearch(query, { limit });
        res.json({ query, total: items.length, items });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })
  );

  /** 以图搜图（视觉搜索）：上传 base64 图片，按感知哈希找最相似的图 */
  app.post(
    '/api/search/by-image',
    asyncRoute(async (req, res) => {
      const dataUrl = req.body?.image || req.body?.dataUrl || req.body?.url;
      const maxHamming = Math.max(0, Math.min(32, Number(req.body?.maxHamming) ?? 10));
      const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 24));
      if (!dataUrl) return res.status(400).json({ error: '缺少 image（base64 data url）' });
      try {
        const items = await search.searchByImageDataUrl(dataUrl, { limit, maxHamming });
        res.json({ total: items.length, items });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /* ------------------------------ 标签管理 ------------------------------ */

  app.post(
    '/api/tags/rename',
    asyncRoute(async (req, res) => {
      const n = lib.renameTag(req.body?.oldName, req.body?.newName);
      res.json({ ok: true, affected: n, tags: lib.listTags() });
    })
  );

  app.post(
    '/api/tags/delete',
    asyncRoute(async (req, res) => {
      const n = lib.deleteTag(req.body?.name);
      res.json({ ok: true, affected: n, tags: lib.listTags() });
    })
  );

  app.post(
    '/api/tags/merge',
    asyncRoute(async (req, res) => {
      const n = lib.mergeTags(req.body?.from, req.body?.to);
      res.json({ ok: true, affected: n, tags: lib.listTags() });
    })
  );

  /* ------------------------------ 智能文件夹 ------------------------------ */

  app.get('/api/smart-folders', (_req, res) => res.json(lib.listSmartFolders()));

  app.post(
    '/api/smart-folders',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, folders: lib.createSmartFolder(req.body || {}) });
    })
  );

  app.put(
    '/api/smart-folders/:id',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, folders: lib.updateSmartFolder(Number(req.params.id), req.body || {}) });
    })
  );

  app.delete(
    '/api/smart-folders/:id',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, folders: lib.deleteSmartFolder(Number(req.params.id)) });
    })
  );

  app.get(
    '/api/smart-folders/:id/images',
    asyncRoute(async (req, res) => {
      const r = lib.previewSmartFolder(Number(req.params.id));
      res.json({ folder: r.folder, total: r.total, items: r.items });
    })
  );

  /** 文件夹标签继承：把智能文件夹的 autoTags 同步到所有命中图片 */
  app.post(
    '/api/smart-folders/:id/apply-tags',
    asyncRoute(async (req, res) => {
      const changed = lib.applySmartFolderTags(Number(req.params.id));
      res.json({ ok: true, changed, tags: lib.listTags() });
    })
  );

  app.post(
    '/api/ai/summarize',
    asyncRoute(async (_req, res) => {
      res.json(await kb.summarizeWithAI());
    })
  );

  app.post(
    '/api/ai/suggest',
    asyncRoute(async (_req, res) => {
      res.json(await kb.suggestions());
    })
  );

  /* --------------------------------- 知识库 --------------------------------- */

  app.get('/api/kb/rules', (_req, res) => res.json(kb.listRules()));

  app.put(
    '/api/kb/rules/:id',
    asyncRoute(async (req, res) => {
      kb.setRule(Number(req.params.id), req.body || {});
      kb.rescoreAll();
      res.json({ ok: true, rules: kb.listRules() });
    })
  );

  app.delete(
    '/api/kb/rules/:id',
    asyncRoute(async (req, res) => {
      kb.deleteRule(Number(req.params.id));
      kb.rescoreAll();
      res.json({ ok: true, rules: kb.listRules() });
    })
  );

  app.get('/api/kb/feedback', (_req, res) => res.json(kb.listFeedback(100)));

  app.delete(
    '/api/kb/feedback/:id',
    asyncRoute(async (req, res) => {
      kb.deleteFeedback(Number(req.params.id));
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/kb/rescore',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...kb.rescoreAll() });
    })
  );

  app.get('/api/kb/stats', (_req, res) => res.json(kb.feedbackStats()));

  /* ------------------------------ 壁纸库文件夹管理 --------------------------- */

  app.post(
    '/api/library/scan',
    asyncRoute(async (_req, res) => {
      if (importState.running) return res.json({ ok: false, message: '导入任务正在运行' });
      const result = await importLocalImages();
      res.json({ ok: true, ...result });
    })
  );

  app.get('/api/library/missing', (_req, res) => {
    const missing = findMissing();
    res.json({ count: missing.length, ids: missing.map((m) => m.id) });
  });

  app.post(
    '/api/library/purge-missing',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, removed: purgeMissing() });
    })
  );

  /** 尝试按文件名找回丢失的图片（用户移动/更换保存文件夹后修复路径） */
  app.post(
    '/api/library/relocate-missing',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...relocateMissing() });
    })
  );

  /* --------------------------------- 回收站 --------------------------------- */

  app.get('/api/trash', (_req, res) => res.json(lib.listTrash()));

  app.post(
    '/api/trash/:id/restore',
    asyncRoute(async (req, res) => {
      res.json(await lib.restoreFromTrash(Number(req.params.id)));
    })
  );

  app.delete(
    '/api/trash/:id',
    asyncRoute(async (req, res) => {
      res.json({ ok: await lib.deleteTrashItem(Number(req.params.id)) });
    })
  );

  app.post(
    '/api/trash/empty',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, removed: await lib.emptyTrash() });
    })
  );

  /* -------------------------------- 网络 / 代理 ------------------------------ */

  app.get('/api/network', (_req, res) => res.json({ ...getNetwork(), modes: PROXY_MODES }));

  app.put(
    '/api/network',
    asyncRoute(async (req, res) => {
      const net = saveNetwork(req.body || {});
      const applied = await applyProxy();
      res.json({ ...net, applied });
    })
  );

  app.post(
    '/api/network/test',
    asyncRoute(async (_req, res) => {
      res.json(await testNetwork());
    })
  );

  /* ---------------------------------- 清单 ---------------------------------- */

  const listPlaylists = () =>
    db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS count
         FROM playlists p ORDER BY p.updated_at DESC`
      )
      .all();

  app.get('/api/playlists', (_req, res) => res.json(listPlaylists()));

  app.post(
    '/api/playlists',
    asyncRoute(async (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: '清单名称不能为空' });
      const now = new Date().toISOString();
      try {
        db.prepare('INSERT INTO playlists(name, description, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
          name,
          String(req.body?.description || ''),
          now,
          now
        );
      } catch {
        return res.status(400).json({ error: '已存在同名清单' });
      }
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );

  app.put(
    '/api/playlists/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (req.body?.name !== undefined) {
        db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(
          String(req.body.name).trim(),
          new Date().toISOString(),
          id
        );
      }
      if (req.body?.description !== undefined) {
        db.prepare('UPDATE playlists SET description = ?, updated_at = ? WHERE id = ?').run(
          String(req.body.description),
          new Date().toISOString(),
          id
        );
      }
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );

  app.delete(
    '/api/playlists/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
      db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );

  app.get(
    '/api/playlists/:id/images',
    asyncRoute(async (req, res) => {
      const rows = db
        .prepare(
          `SELECT i.* FROM playlist_items pi JOIN images i ON i.id = pi.image_id
           WHERE pi.playlist_id = ? ORDER BY pi.id DESC`
        )
        .all(Number(req.params.id));
      res.json(rows.map(lib.toDTO));
    })
  );

  app.post(
    '/api/playlists/:id/images',
    asyncRoute(async (req, res) => {
      const playlistId = Number(req.params.id);
      const ids = (req.body?.ids || []).map(Number).filter(Boolean);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO playlist_items(playlist_id, image_id, added_at) VALUES (?, ?, ?)'
      );
      let added = 0;
      const now = new Date().toISOString();
      for (const imageId of ids) {
        if (!lib.getImage(imageId)) continue;
        const info = insert.run(playlistId, imageId, now);
        added += Number(info.changes || 0);
      }
      db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId);
      res.json({ ok: true, added, playlists: listPlaylists() });
    })
  );

  app.delete(
    '/api/playlists/:id/images/:imageId',
    asyncRoute(async (req, res) => {
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND image_id = ?').run(
        Number(req.params.id),
        Number(req.params.imageId)
      );
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );

  /* ------------------------------ 定时切换壁纸 ------------------------------ */

  app.get('/api/wallpaper/auto', (_req, res) => res.json(auto.getAutoStatus()));

  app.put(
    '/api/wallpaper/auto',
    asyncRoute(async (req, res) => {
      const current = getSettings().autoWallpaper || {};
      saveSettings({ autoWallpaper: { ...current, ...(req.body || {}) } });
      res.json(auto.getAutoStatus());
    })
  );

  // AI 壁纸闭环：适配度查询 / 批量补算 / 用户反馈（喜欢·不喜欢）
  app.get(
    '/api/wallpaper/fit/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const useAi = String(req.query.ai || '') === '1';
      res.json({ ok: true, fit: await fit.ensureFit(id, { useAi }) });
    })
  );
  app.post(
    '/api/wallpaper/scan-fit',
    asyncRoute(async (req, res) => {
      const limit = Math.max(1, Math.min(500, Number(req.body?.limit) || 120));
      const useAi = req.body?.ai === true;
      res.json({ ok: true, ...(await fit.scanFits(limit, useAi)) });
    })
  );
  app.post(
    '/api/wallpaper/feedback',
    asyncRoute(async (req, res) => {
      const id = Number(req.body?.imageId);
      if (!id) return res.status(400).json({ error: '缺少图片 id' });
      const like = req.body?.like !== false;
      res.json({ ok: true, fit: fit.recordFeedback(id, like) });
    })
  );
  app.post('/api/wallpaper/like', (_req, res) => res.json({ ok: true, ...auto.likeCurrent() }));

  /* 浏览器插件采集：接收图片 URL 列表 / base64 数据，本地下载后入库 */
  app.post(
    '/api/extension/ingest',
    asyncRoute(async (req, res) => {
      const settings = getSettings();
      const keyword = String(req.body?.keyword || '浏览器采集').slice(0, 80);
      const tags = String(req.body?.tags || '').slice(0, 200);
      const pageUrl = String(req.body?.pageUrl || '').slice(0, 500);
      const results = [];
      const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 30) : [];
      const dataUrls = Array.isArray(req.body?.dataUrls) ? req.body.dataUrls.slice(0, 10) : [];

      for (const u of urls) {
        try {
          // 带页面来源下载（很多站点有防盗链），httpFetch 会把 Referer 转成标准 referrer
          const res = await httpFetch(String(u), {
            headers: pageUrl ? { Referer: pageUrl } : {},
            timeout: 25000,
            retries: 2,
          });
          const buffer = Buffer.from(await res.arrayBuffer());
          const r = await lib.ingest(
            { buffer, source: 'browser', keyword, tags, sourceUrl: String(u), copyToStorage: true },
            settings
          );
          results.push({ ...r, url: String(u) });
        } catch (err) {
          results.push({ ok: false, reason: 'failed', url: String(u), error: String(err?.message || err).slice(0, 120) });
        }
      }
      for (const d of dataUrls) {
        try {
          const m = String(d).match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/);
          if (!m) throw new Error('不是图片 data URL');
          const buf = Buffer.from(m[1], 'base64');
          const r = await lib.ingest(
            { buffer: buf, source: 'browser', keyword, tags, sourceUrl: pageUrl, copyToStorage: true },
            settings
          );
          results.push(r);
        } catch (err) {
          results.push({ ok: false, reason: 'failed', error: String(err?.message || err).slice(0, 120) });
        }
      }
      res.json({
        ok: true,
        saved: results.filter((r) => r.ok).length,
        total: results.length,
        results: results.slice(0, 30),
      });
    })
  );

  // AI 去背景（U-2-Net ONNX）
  app.get('/api/ai/matting/status', (_req, res) => res.json(matting.mattingStatus()));
  app.post(
    '/api/ai/matting/install',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await matting.installMatting()) });
    })
  );
  app.post(
    '/api/images/:id/remove-bg',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const { buffer } = await matting.removeBackgroundBuffer(row.abs_path);
      // 存为新文件（原图不动），走标准入库流程
      const settings = getSettings();
      const dir = lib.resolveStorageDir(settings);
      const ext = path.extname(row.abs_path);
      const stem = path.basename(row.abs_path, ext);
      let out = path.join(dir, `${stem}.nobg.png`);
      let n = 1;
      while (fs.existsSync(out)) out = path.join(dir, `${stem}.nobg-${++n}.png`);
      await fs.promises.writeFile(out, buffer);
      const res2 = await lib.ingest(
        {
          absPath: out,
          source: 'local',
          keyword: row.keyword || '去背景',
          title: `${row.title || stem}（去背景）`,
          tags: row.tags ? `${row.tags},去背景` : '去背景',
          skipPhashDupe: true, // 内容与原图同源，仍需能登记（后续由去重工具处理）
        },
        settings
      );
      res.json({ ok: true, ...res2 });
    })
  );

  // 本地偏好模型（个性化推荐）：状态 / 训练
  app.get('/api/pref/status', (_req, res) => res.json(pref.prefStatus()));
  app.post(
    '/api/pref/train',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...pref.trainPreference() });
    })
  );

  app.post(
    '/api/wallpaper/now',
    asyncRoute(async (req, res) => {
      const result = await auto.applyNow(req.body?.scope || null, req.body?.playlistId ?? null);
      res.json({ ok: true, ...result });
    })
  );

  app.get('/api/wallpaper/history', (_req, res) => res.json(auto.history(20)));

  /* 多显示器：列出屏幕（每屏可放不同壁纸 / 跨屏合成） */
  app.get(
    '/api/wallpaper/monitors',
    asyncRoute(async (_req, res) => {
      const monitors = await listMonitors();
      res.json({
        monitors,
        count: monitors.length,
        mode: getSettings().wallpaperMode || 'single',
        modes: wallpaper.WALLPAPER_MODES,
      });
    })
  );

  /* ------------------------------ 动态壁纸 ------------------------------ */
  app.get('/api/wallpaper/live', (_req, res) => res.json(getSettings().liveWallpaper || {}));

  app.put(
    '/api/wallpaper/live',
    asyncRoute(async (req, res) => {
      const cur = getSettings().liveWallpaper || {};
      const next = { ...cur, ...(req.body || {}) };
      saveSettings({ liveWallpaper: next });
      // 通知主进程（创建 / 销毁桌面层窗口）
      liveBus.emit('changed', next);
      res.json(next);
    })
  );

  app.post(
    '/api/wallpaper/live/toggle',
    asyncRoute(async (req, res) => {
      const cur = getSettings().liveWallpaper || {};
      const enabled = req.body?.enabled === undefined ? !cur.enabled : !!req.body.enabled;
      saveSettings({ liveWallpaper: { ...cur, enabled } });
      res.json({ ok: true, ...getSettings().liveWallpaper });
    })
  );

  /** 轮播清单（与定时壁纸同样的范围 / 分数过滤） */
  app.get(
    '/api/wallpaper/live/playlist',
    asyncRoute(async (_req, res) => {
      const cfg = getSettings().liveWallpaper || {};
      const minScore = Math.max(0, Number(cfg.minScore) || 0);
      const scope = cfg.scope || 'favorites';
      let rows;
      if (scope === 'playlist' && cfg.playlistId) {
        rows = db
          .prepare(
            `SELECT i.* FROM images i JOIN playlist_items pi ON pi.image_id = i.id
             WHERE pi.playlist_id = ?${minScore ? ' AND i.score >= ?' : ''}
             ORDER BY i.score DESC, i.id DESC LIMIT 80`
          )
          .all(...(minScore ? [Number(cfg.playlistId), minScore] : [Number(cfg.playlistId)]));
      } else if (scope === 'all') {
        rows = db
          .prepare(
            `SELECT * FROM images${minScore ? ' WHERE score >= ?' : ''} ORDER BY score DESC, RANDOM() LIMIT 80`
          )
          .all(...(minScore ? [minScore] : []));
      } else {
        rows = db
          .prepare(
            `SELECT * FROM images WHERE favorite = 1${minScore ? ' AND score >= ?' : ''}
             ORDER BY score DESC, RANDOM() LIMIT 80`
          )
          .all(...(minScore ? [minScore] : []));
      }
      res.json({
        interval: Math.max(5, Number(cfg.intervalSec) || 15),
        kenBurns: cfg.kenBurns !== false,
        total: rows.length,
        items: rows.map((r) => ({ id: r.id, url: `/api/images/${r.id}/file`, title: r.title })),
      });
    })
  );

  /** 本地视频流（sendFile 自带 Range 支持，循环播放更顺） */
  app.get(
    '/api/wallpaper/live/video',
    asyncRoute(async (_req, res) => {
      const p = String(getSettings().liveWallpaper?.videoPath || '');
      if (!p || !fs.existsSync(p)) return res.status(404).json({ error: '视频文件不存在' });
      res.sendFile(p);
    })
  );

  /** 动态壁纸渲染页（桌面层窗口加载它） */
  app.get('/live', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(LIVE_HTML);
  });

  /** 调试用：当前是否有全屏应用运行（动态壁纸据此暂停） */
  app.get('/api/wallpaper/live/fscheck', async (_req, res) => {
    try {
      res.json({ fullscreen: await isFullscreenAppRunning() });
    } catch (err) {
      res.json({ fullscreen: false, error: err.message });
    }
  });

  /* 当前壁纸：托盘菜单与悬浮操作使用 */
  app.get('/api/wallpaper/current', (_req, res) => res.json(auto.currentWallpaper() || {}));

  app.post(
    '/api/wallpaper/current/favorite',
    asyncRoute((_req, res) => {
      try {
        res.json({ ok: true, ...auto.favoriteCurrent() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /* 不喜欢这张：排除并立刻换一张 */
  app.post(
    '/api/wallpaper/current/dislike',
    asyncRoute(async (_req, res) => {
      const result = await auto.dislikeCurrent();
      res.json({ ok: true, ...result });
    })
  );

  /* ------------------------------- 关键词 / 设置 ----------------------------- */

  app.get('/api/keywords', (_req, res) => res.json(listKeywords()));

  app.post(
    '/api/keywords',
    asyncRoute(async (req, res) => {
      const id = addKeyword(req.body.text);
      res.json({ ok: true, id, keywords: listKeywords() });
    })
  );

  app.put(
    '/api/keywords/:id',
    asyncRoute(async (req, res) => {
      updateKeyword(Number(req.params.id), req.body);
      res.json({ ok: true, keywords: listKeywords() });
    })
  );

  app.delete(
    '/api/keywords/:id',
    asyncRoute(async (req, res) => {
      deleteKeyword(Number(req.params.id));
      res.json({ ok: true, keywords: listKeywords() });
    })
  );

  /** settings 对外输出脱敏：凭据（微博 Cookie / AI API Key）永不下发前端，只回报「是否已配置」 */
  function maskSettings(s) {
    const { weiboCookie, ...rest } = s;
    const ai = rest.ai ? { ...rest.ai, apiKey: '' } : rest.ai;
    return {
      ...rest,
      ai,
      weiboCookie: '',
      hasWeiboCookie: !!String(weiboCookie || '').trim(),
      hasAiApiKey: !!String(rest.ai?.apiKey || '').trim(),
    };
  }

  app.get('/api/settings', (_req, res) => res.json(maskSettings(getSettings())));

  app.put(
    '/api/settings',
    asyncRoute(async (req, res) => {
      const next = saveSettings(req.body || {});
      if (next.storageDir) lib.resolveStorageDir(next);
      await applyProxy();
      watchStorageDir(); // 素材文件夹变了就切换监听目标
      res.json(maskSettings(next));
    })
  );

  app.get('/api/sources', (_req, res) => {
    const settings = getSettings();
    res.json(
      Object.values(SOURCES).map((s) => ({
        key: s.key,
        label: s.label,
        enabled: !!settings.sources?.[s.key],
      }))
    );
  });

  /* --------------------------------- 采集 ---------------------------------- */

  app.get('/api/crawl/status', (_req, res) => res.json(getJobStatus()));

  app.post(
    '/api/crawl/start',
    asyncRoute(async (req, res) => {
      const settings = getSettings();
      const body = req.body || {};
      let keywords = body.keywords;
      if (!Array.isArray(keywords) || !keywords.length) {
        keywords = listKeywords()
          .filter((k) => k.enabled)
          .map((k) => k.text);
      }
      const sources =
        Array.isArray(body.sources) && body.sources.length
          ? body.sources
          : Object.keys(settings.sources || {}).filter((k) => settings.sources[k]);
      const result = startCrawl({ keywords, sources, pages: body.pages ?? settings.pagesPerKeyword });
      res.json(result);
    })
  );

  app.post('/api/crawl/stop', (_req, res) => {
    stopCrawl();
    res.json({ ok: true });
  });

  /* ------------------------------- 导入 / 维护 ------------------------------ */

  let importState = { running: false, progress: 0, message: '', result: null };

  app.get('/api/import/status', (_req, res) => res.json(importState));

  app.post(
    '/api/import/local',
    asyncRoute(async (_req, res) => {
      if (importState.running) return res.json({ ok: false, message: '导入任务正在运行' });
      importState = { running: true, progress: 0, message: '扫描本地图片…', result: null };
      res.json({ ok: true });
      importLocalImages({
        onProgress: (progress, file, result) => {
          importState = {
            running: true,
            progress,
            message: `导入 ${path.basename(file)}（已保存 ${result.saved}）`,
            result,
          };
        },
      })
        .then((result) => {
          importState = { running: false, progress: 100, message: '导入完成', result };
        })
        .catch((err) => {
          importState = { running: false, progress: 100, message: `导入失败：${err.message}`, result: null };
        });
    })
  );

  app.post(
    '/api/seed',
    asyncRoute(async (_req, res) => {
      const results = await ingestUrls(SEED_URLS);
      res.json({ ok: true, results });
    })
  );

  app.delete(
    '/api/library',
    asyncRoute(async (_req, res) => {
      const removed = lib.clearLibrary();
      res.json({ ok: true, removed });
    })
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  /* -------------------------------- 前端托管 -------------------------------- */

  if (fs.existsSync(WEB_DIST)) {
    // 静态直出也要带 CSP（生产前端无内联脚本、无 eval，可收紧到 self）
    const htmlCsp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
    app.use(
      express.static(WEB_DIST, {
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          if (String(filePath).endsWith('.html')) res.setHeader('Content-Security-Policy', htmlCsp);
        },
      })
    );
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      // 生产托管的 HTML 叠加更严格的 CSP 响应头
      res.setHeader('Content-Security-Policy', htmlCsp);
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('html')
        .send(
          '<h2>前端尚未构建</h2><p>请先运行 <code>npm run build</code>（桌面端用 <code>npm run desktop</code> 会自动构建）。</p>'
        );
    });
  }

  app.use((err, _req, res, _next) => {
    console.error('[api error]', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}

/** 启动 HTTP 服务，返回 { server, port } */
export function startServer(port = PORT, options = {}) {
  const app = buildApp(options);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      bootstrap();
      auto.startScheduler();
      resolve({ server, port: actualPort });
    });
    server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE' && port !== 0 && options.desktop) {
        // 桌面端兜底：固定端口被占（比如残留实例）就换随机端口，不让整个应用起不来
        console.warn(`[server] 端口 ${port} 被占用，改用随机端口`);
        server.removeAllListeners('error');
        startServer(0, options).then(resolve, reject);
        return;
      }
      reject(err);
    });
  });
}
