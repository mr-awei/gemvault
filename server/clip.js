/**
 * CLIP 深度特征：把每张图编码成 512 维归一化向量，余弦相似度判定「看起来是不是同一张」。
 *
 * 为什么需要它：pHash/dHash 只看低频结构，裁剪、旋转、加滤镜、换画幅都会让哈希面目全非；
 * CLIP 向量对这些变换几乎无感（cos > 0.9 仍是同一张），能补上哈希查重的最大盲区。
 *
 * 模型：CLIP ViT-B/32（约 150MB，首次使用自动下载到 models 缓存目录，之后离线可用）。
 * 索引：全量暴力余弦（778 张 ≈ 每次查询几十毫秒），万张以内无需 ANN。
 */
import fs from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';
import { db } from './db.js';
import { MODEL_CACHE_DIR } from './config.js';

// 模型缓存放可写目录：打包版代码在只读 asar 内，指向 asar 会导致首次下载必挂
env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;
// 国内直连 huggingface.co 基本不通，默认走 hf-mirror 镜像；需要切换时设环境变量 CLIP_HUB_HOST
env.remoteHost = process.env.CLIP_HUB_HOST || 'https://hf-mirror.com';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const DIM = 512;

let extractorPromise = null;
let loadError = '';

/** 懒加载特征提取器（首次调用触发模型下载） */
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('image-feature-extraction', MODEL_ID, { dtype: 'q8' }).catch((err) => {
      loadError = err?.message || String(err);
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

/** 模型是否可用（已成功加载过） */
export function clipReady() {
  return extractorPromise !== null;
}

/** 加载状态：ready / loading / error */
export async function clipLoad() {
  try {
    await getExtractor();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: loadError || err?.message || String(err) };
  }
}

/** 原地归一化（pooling normalize 选项在该管线不生效，手动做，保证点积即余弦） */
function normalizeInPlace(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Buffer / 路径 → 512 维归一化 Float32Array */
export async function embedImage(input) {
  const extractor = await getExtractor();
  const blob = Buffer.isBuffer(input) ? new Blob([input]) : input;
  const out = await extractor(blob, { pooling: 'cls', normalize: true });
  const data = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  return normalizeInPlace(data);
}

export function saveEmbedding(imageId, vec) {
  db.prepare(
    'INSERT INTO clip_vec(image_id, dim, vec, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(image_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec'
  ).run(imageId, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), new Date().toISOString());
  invalidateVecCache();
}

export function getEmbedding(imageId) {
  const row = db.prepare('SELECT dim, vec FROM clip_vec WHERE image_id = ?').get(imageId);
  if (!row) return null;
  // 读回时归一化：兼容归一化修复前入库的未归一化向量（点积即余弦）
  return normalizeInPlace(new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim));
}

export function deleteEmbedding(imageId) {
  db.prepare('DELETE FROM clip_vec WHERE image_id = ?').run(imageId);
  invalidateVecCache();
}

/** 重新建模（图片内容被旋转/增强覆盖后调用），失败静默（补算任务会兜底） */
export async function reembed(imageId, input) {
  try {
    saveEmbedding(imageId, await embedImage(input));
  } catch (err) {
    console.error('[clip] 建模失败', imageId, err?.message || err);
  }
}

export function embeddingCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM clip_vec').get().c;
}

/** 全库向量内存缓存：预归一化 + 按维度分组连续存储。
 *  每次相似检索免掉「全表 SELECT BLOB → new Float32Array → 重算范数」，
 *  查询只剩纯点积循环。写删向量时整体失效（懒重建，成本一次全表读）。 */
let vecCache = null; // Map<dim, { ids: Int32Array, data: Float32Array, count: number }>

function invalidateVecCache() {
  vecCache = null;
}

function loadVecCache() {
  const rows = db.prepare('SELECT image_id, dim, vec FROM clip_vec').all();
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.dim);
    if (!g) {
      g = { ids: [], vecs: [] };
      groups.set(r.dim, g);
    }
    g.ids.push(r.image_id);
    // 读回即归一化：兼容归一化修复前入库的向量
    g.vecs.push(normalizeInPlace(new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim)));
  }
  for (const [dim, g] of groups) {
    const count = g.ids.length;
    const data = new Float32Array(count * dim);
    for (let i = 0; i < count; i++) data.set(g.vecs[i], i * dim);
    groups.set(dim, { ids: Int32Array.from(g.ids), data, count });
  }
  vecCache = groups;
}

/** 全库中与 vec 余弦最高的前 k 个（排除自身），返回 [{ id, cos }] */
export function topSimilar(vec, { k = 24, minCos = 0.8, excludeId = 0 } = {}) {
  if (!vecCache) loadVecCache();
  const group = vecCache.get(vec.length);
  const scored = [];
  if (group && group.count) {
    const { ids, data, count } = group;
    for (let i = 0; i < count; i++) {
      const id = ids[i];
      if (id === excludeId) continue;
      let dot = 0;
      const base = i * vec.length;
      for (let j = 0; j < vec.length; j++) dot += vec[j] * data[base + j];
      if (dot >= minCos) scored.push({ id, cos: dot });
    }
    scored.sort((a, b) => b.cos - a.cos);
  }
  return scored.slice(0, k);
}

/* ------------------------------- 全库补算 ------------------------------- */

const backfillState = { running: false, done: 0, total: 0, error: '' };

export function backfillStatus() {
  return {
    running: backfillState.running,
    done: backfillState.done,
    total: backfillState.total,
    error: backfillState.error,
    indexed: embeddingCount(),
    model: MODEL_ID,
    loadError,
  };
}

/** 为所有缺失特征的图片补算（异步后台跑，进度见 backfillStatus） */
export async function startBackfill() {
  if (backfillState.running) return { ok: false, message: '补算正在进行中' };
  const ids = db
    .prepare(
      `SELECT id, abs_path FROM images WHERE id NOT IN (SELECT image_id FROM clip_vec) ORDER BY id`
    )
    .all();
  backfillState.running = true;
  backfillState.done = 0;
  backfillState.total = ids.length;
  backfillState.error = '';
  (async () => {
    try {
      await getExtractor();
      for (const { id, abs_path } of ids) {
        try {
          if (fs.existsSync(abs_path)) {
            const vec = await embedImage(abs_path);
            saveEmbedding(id, vec);
          }
        } catch (err) {
          console.error('[clip] 建模失败', id, err?.message || err);
        }
        backfillState.done++;
        // 节流：给主线程留喘息，避免推理高峰期拖慢同一进程的 HTTP 出图与删图
        await new Promise((r) => setTimeout(r, 40));
      }
    } catch (err) {
      backfillState.error = err?.message || String(err);
    } finally {
      backfillState.running = false;
    }
  })();
  return { ok: true, total: ids.length };
}
