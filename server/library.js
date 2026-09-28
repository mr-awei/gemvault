import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import jpegtranPkg from 'jpegtran-bin';
import { db, getSettings } from './db.js';
import { IMAGE_DIR, THUMB_DIR } from './config.js';
import { computePHash, hammingHex } from './phash.js';
import * as clip from './clip.js';
import { getSharpness, invalidateQuality } from './quality.js';
import { scoreImage } from './kb.js';
import { aiModelOf, isAiModel, runUpscale, isCommunityModel, communityModelOf, cuganInstalled, listCuganModels } from './ai-upscale.js';
import { srModelOf, runSr } from './sr-deep.js';
import { httpFetch } from './http.js';

const jpegtran = typeof jpegtranPkg === 'string' ? jpegtranPkg : jpegtranPkg.default;

const ALLOWED_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows 下刚写入的文件可能被杀毒软件短暂锁定，删除失败时重试 */
async function removeFileRetry(p, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(p, { force: true });
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (i === attempts - 1) throw err;
      await sleep(120 * (i + 1));
    }
  }
  return false;
}

/** 标记为「已翻译」，避免被二次包装 */
function markFriendly(err) {
  err.friendly = true;
  return err;
}

/**
 * 回收站目录：放在被删文件「同目录下」的 trash 子文件夹，
 * 这样与源文件同盘，rename 不会因跨盘而报 EXDEV（图库常放在与软件不同的磁盘/分区上）。
 */
function trashDirFor(absPath) {
  const dir = path.dirname(absPath || '');
  const t = path.join(dir || '.', 'trash');
  try {
    fs.mkdirSync(t, { recursive: true });
  } catch {
    /* 创建失败交给上层 rename 报错 */
  }
  return t;
}

const OCCUPIED_HINT = '请关闭正在打开这张图的程序（看图软件 / PS / 资源管理器的预览窗格），或临时关闭杀毒软件实时防护后重试。';

/** 把底层文件系统错误翻译成能看懂的中文提示 */
function friendlyFsError(err, target, action) {
  const code = err?.code || '';
  const name = target ? path.basename(target) : '';
  if (code === 'EBUSY' || code === 'UNKNOWN' || code === 'EPERM' || code === 'EACCES') {
    return markFriendly(new Error(`${action}失败：文件「${name}」正被其他程序占用或拒绝访问。${OCCUPIED_HINT}`));
  }
  if (code === 'ENOENT') return markFriendly(new Error(`${action}失败：文件「${name}」已不存在（可能被移动或删除）。`));
  if (code === 'ENOSPC') return markFriendly(new Error(`${action}失败：磁盘空间不足。`));
  if (code === 'EROFS') return markFriendly(new Error(`${action}失败：目标磁盘为只读。`));
  return markFriendly(new Error(`${action}失败：${err?.message || code || '未知错误'}`));
}

/** 读取阶段的失败（sharp / libvips 的报错对用户毫无意义，必须翻译） */
function friendlyReadError(err, target) {
  const name = target ? path.basename(target) : '';
  const m = String(err?.message || '');
  if (err?.code === 'ENOENT' || /no such file|cannot open/i.test(m)) {
    return markFriendly(new Error(`读取失败：文件「${name}」已不存在（可能被移动或删除）。`));
  }
  if (/unsupported image format|unable to open|VipsForeign|Input file|premature end|corrupt/i.test(m)) {
    return markFriendly(new Error(`读取失败：无法打开「${name}」——文件正被其他程序占用，或文件已损坏 / 不是有效图片。${OCCUPIED_HINT}`));
  }
  return markFriendly(new Error(`读取失败：${m}`));
}

/** 统一把底层异常翻译成可读提示 */
function translateError(err, target) {
  if (err?.friendly) return err;
  if (err?.code) return friendlyFsError(err, target, '处理文件');
  const m = String(err?.message || '');
  if (/unsupported image format|unable to open|VipsForeign|Input file|premature end|corrupt|magick|sharp/i.test(m)) {
    return friendlyReadError(err, target);
  }
  return err;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 原子写回原文件：先写同目录临时文件，再改名覆盖。
 * 目的：
 *  1. 直接写原文件会先被截断，中途失败（被占用/断电/杀毒拦截）会把原图毁成 0 字节 —— 不可逆；
 *  2. 改名在 Windows 上是原子替换，失败时原图完好无损；
 *  3. 临时文件与改名都对常见的瞬时占用做重试。
 */
async function writeFileAtomic(target, data, attempts = 5) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.gem-tmp-${process.pid}-${Date.now()}`);
  try {
    for (let i = 0; ; i++) {
      try {
        await fsp.writeFile(tmp, data);
        break;
      } catch (err) {
        if (i >= attempts - 1) throw friendlyFsError(err, target, '写入文件');
        await sleepMs(150 * (i + 1));
      }
    }
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(tmp, target);
        return;
      } catch (err) {
        if (i >= attempts - 1) throw friendlyFsError(err, target, '覆盖原图');
        await sleepMs(150 * (i + 1));
      }
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** 内存中的 pHash 索引（id -> hex），启动时载入 */
const phashIndex = new Map();

export function initPhashIndex() {
  phashIndex.clear();
  const rows = db.prepare('SELECT id, phash FROM images').all();
  for (const r of rows) {
    if (r.phash) phashIndex.set(r.id, r.phash);
  }
  return phashIndex.size;
}

export function findDuplicateByPhash(hex, threshold) {
  if (!hex) return null;
  const target = BigInt('0x' + hex);
  for (const [id, value] of phashIndex) {
    let x = target ^ BigInt('0x' + value);
    let count = 0;
    while (x) {
      x &= x - 1n;
      count++;
      if (count > threshold) break;
    }
    if (count <= threshold) return id;
  }
  return null;
}

function extOf(format) {
  if (format === 'jpeg') return 'jpg';
  if (format === 'jpg') return 'jpg';
  return format || 'jpg';
}

const INVALID_CHARS = /[\\/:*?"<>|\r\n\t]/g;

/** 采集到的图片直接写入用户指定的本地文件夹，并使用可读文件名 */
export function resolveStorageDir(settings = getSettings()) {
  const dir = settings.storageDir || IMAGE_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildFileName({ keyword, source, width, height, format }) {
  const safe = (s) => String(s || '').replace(INVALID_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  // 6 位随机后缀：秒级时间戳 + 相同尺寸仍可能撞名（同一批两张不同图会生成同名文件，
  // 仅扩展名不同，曾被误当成「同名 jpg/png 同一张照片」）
  const suffix = crypto.randomBytes(3).toString('hex');
  const parts = [safe(keyword) || '邓紫棋', source, `${width}x${height}`, stamp, suffix];
  return `${parts.join('_')}.${extOf(format)}`;
}

/** 是否由本应用管理（可随图库一起删除）的文件 */
export function isManagedPath(p, settings = getSettings()) {
  if (!p) return false;
  const dirs = [IMAGE_DIR, settings.storageDir].filter(Boolean);
  return dirs.some((d) => p.startsWith(d));
}

export async function ensureThumb(id, absPath) {
  const target = path.join(THUMB_DIR, `${id}.jpg`);
  if (fs.existsSync(target)) return target;
  try {
    await sharp(absPath, { failOn: 'none' })
      .rotate()
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(target);
    return target;
  } catch (err) {
    console.error('[thumb] 生成缩略图失败', id, err.message);
    return null;
  }
}

/**
 * 物理旋转图片并写回原文件（其他软件打开即为旋转后的效果）
 * 关键：保持原画质——JPEG 走无损变换（仅调整角度，像素零损失），
 *      PNG/WebP 走无损编解码；只有尺寸不满足无损条件的 JPEG 才回退到 quality 100。
 * 同步更新宽高 / 文件大小 / pHash / 缩略图
 */
/** 物理旋转（对外入口）：统一把底层报错翻译成可读提示 */
export async function rotateImage(id, dir = 'cw') {
  const row = getImage(id);
  try {
    return await rotateImageInner(id, dir);
  } catch (err) {
    throw translateError(err, row?.abs_path);
  }
}

async function rotateImageInner(id, dir = 'cw') {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在');

  const angle = dir === 'ccw' ? -90 : 90;
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';

  let data;
  let info;

  if (format === 'jpeg') {
    // 无损旋转：不改像素，只改角度。要求宽高为 MCU 整数倍，否则回退 re-encode
    const tmp = `${row.abs_path}.rotated`;
    try {
      execFileSync(jpegtran, [
        '-rotate',
        String(angle === -90 ? 270 : 90),
        '-copy',
        'comments', // 丢弃 EXIF（含可能的 Orientation），避免部分软件二次旋转
        '-outfile',
        tmp,
        row.abs_path,
      ]);
      const buf = await fsp.readFile(tmp);
      const m = await sharp(buf, { failOn: 'none' }).metadata();
      data = buf;
      info = { width: m.width, height: m.height };
    } catch {
      // 极少数尺寸不满足无损条件的 JPEG：回退到最高质量重编码
      const r = await sharp(row.abs_path, { failOn: 'none' })
        .rotate(angle)
        .jpeg({ quality: 100, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      data = r.data;
      info = r.info;
    } finally {
      await removeFileRetry(tmp);
    }
  } else if (format === 'png') {
    const r = await sharp(row.abs_path, { failOn: 'none' })
      .rotate(angle)
      .png()
      .toBuffer({ resolveWithObject: true });
    data = r.data;
    info = r.info;
  } else if (format === 'webp') {
    const r = await sharp(row.abs_path, { failOn: 'none' })
      .rotate(angle)
      .webp({ lossless: true })
      .toBuffer({ resolveWithObject: true });
    data = r.data;
    info = r.info;
  } else {
    const r = await sharp(row.abs_path, { failOn: 'none' })
      .rotate(angle)
      .jpeg({ quality: 100, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    data = r.data;
    info = r.info;
  }

  await writeFileAtomic(row.abs_path, data);

  const newHash = await computePHash(data).catch(() => '');
  db.prepare('UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ? WHERE id = ?').run(
    info.width,
    info.height,
    data.length,
    newHash,
    id
  );
  if (newHash) phashIndex.set(id, newHash);
  if (clip.clipReady()) clip.reembed(id, row.abs_path); // 内容已改变，重建深度特征
  invalidateQuality(id); // 清晰度缓存同步失效，下次分组时重算

  // 旧的缩略图已过期，删除后按需重新生成
  await removeFileRetry(path.join(THUMB_DIR, `${id}.jpg`));
  if (row.thumb && row.thumb !== path.join(THUMB_DIR, `${id}.jpg`)) {
    await removeFileRetry(row.thumb);
  }

  return toDTO(getImage(id));
}

/* ------------------------------- 画质增强 ------------------------------- */

/** 内置增强模型：全部基于 sharp 的插值 + 锐化，离线可用、无外部依赖。
 *  放大倍数按「目标标准」动态计算，保证增强后达到标准以上；
 *  模型只决定插值核与锐化风格，maxScale 为安全上限（防极端小图爆内存）。 */
export const ENHANCE_MODELS = [
  { id: 'sharp-standard', label: '标准增强', desc: '通用清晰放大，保留细节，适合大多数照片', kernel: 'lanczos3', sharpen: 0.6, blur: 0, maxScale: 16 },
  { id: 'sharp-anime', label: '二次元增强', desc: '保边去糊，线条更利落，适合插画/写真', kernel: 'lanczos3', sharpen: 1.0, blur: 0, maxScale: 16 },
  { id: 'sharp-soft', label: '柔和增强', desc: '照片风，抑制噪点与锯齿，过渡更平滑', kernel: 'cubic', sharpen: 0.2, blur: 0.5, maxScale: 16 },
  { id: 'sharp-detail', label: '细节强化', desc: '锐度更强，观感更锐利（可能略显生硬）', kernel: 'lanczos3', sharpen: 1.4, blur: 0, maxScale: 16 },
];

/** 增强后输出的像素上限，避免极端小图放大到几十亿像素导致内存爆掉 */
const MAX_OUTPUT_PIXELS = 50_000_000;

/** 标准预设：键 -> 目标分辨率（宽 × 高）。低于该尺寸的图片视为「待增强」 */
export const ENHANCE_STANDARDS = {
  '480p': { width: 854, height: 480, label: '480P（854×480）' },
  '720p': { width: 1280, height: 720, label: '720P（1280×720）' },
  '1080p': { width: 1920, height: 1080, label: '1080P（1920×1080）' },
  '2k': { width: 2560, height: 1440, label: '2K（2560×1440）' },
  '4k': { width: 3840, height: 2160, label: '4K（3840×2160）' },
  custom: { width: 0, height: 0, label: '自定义' },
};

export function getStandardResolution(standardKey, enhanceCfg = {}) {
  const key = ENHANCE_STANDARDS[standardKey] ? standardKey : '1080p';
  if (key === 'custom') {
    return {
      width: Number(enhanceCfg.customWidth) || 1920,
      height: Number(enhanceCfg.customHeight) || 1080,
    };
  }
  return { width: ENHANCE_STANDARDS[key].width, height: ENHANCE_STANDARDS[key].height };
}

/** 低于标准的图片总数 */
export function countBelowStandard(standardKey) {
  const target = getStandardResolution(standardKey, getSettings().enhance || {});
  return db.prepare('SELECT COUNT(*) AS c FROM images WHERE width < ? OR height < ?').get(target.width, target.height).c;
}

/** 低于标准的图片（自动收录），升序排列（最小的优先处理） */
export function listBelowStandard(standardKey, limit = 1200) {
  const target = getStandardResolution(standardKey, getSettings().enhance || {});
  const rows = db
    .prepare('SELECT * FROM images WHERE width < ? OR height < ? ORDER BY width * height ASC LIMIT ?')
    .all(target.width, target.height, limit);
  return rows.map(toDTO);
}

/**
 * 本地增强：按目标标准动态放大，锐化后写回原文件（与 rotateImage 一样覆盖原图）。
 * 其他软件打开即为增强后的效果；同步更新宽高 / 大小 / pHash / 缩略图。
 */
/** 画质增强（对外入口）：统一把底层报错翻译成可读提示 */
export async function enhanceImage(id, modelId, opts = {}) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  try {
    return await enhanceImageInner(id, modelId, opts);
  } catch (err) {
    throw translateError(err, row.abs_path);
  }
}

/**
 * 把库记录与磁盘文件重新同步（文件被手动替换 / 修改后调用）：
 * 更新宽高、体积、pHash，重建深度特征与清晰度缓存，并删除过期缩略图。
 * @returns 是否发生过变化
 */
export async function resyncImageMeta(id) {
  const row = getImage(id);
  if (!row || !row.abs_path || !fs.existsSync(row.abs_path)) return false;
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const stat = fs.statSync(row.abs_path);
  const unchanged =
    meta.width === row.width && meta.height === row.height && stat.size === row.size_bytes;
  if (unchanged) return false;
  const phash = await computePHash(row.abs_path).catch(() => '');
  db.prepare('UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ? WHERE id = ?').run(
    meta.width || 0,
    meta.height || 0,
    stat.size,
    phash,
    id
  );
  if (phash) phashIndex.set(id, phash);
  if (clip.clipReady()) clip.reembed(id, row.abs_path);
  invalidateQuality(id);
  await removeFileRetry(path.join(THUMB_DIR, `${id}.jpg`));
  if (row.thumb && row.thumb !== path.join(THUMB_DIR, `${id}.jpg`)) {
    await removeFileRetry(row.thumb);
  }
  return true;
}

async function enhanceImageInner(id, modelId, opts = {}) {
  // 磁盘文件可能被手动替换过：先与库记录同步，否则会用旧尺寸误判「已达标」
  await resyncImageMeta(id);
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在（可能已被移动或删除）');

  const settings = getSettings();
  const target = getStandardResolution(
    opts.standard || settings.enhance?.standard || '1080p',
    settings.enhance || {}
  );

  // 真·AI 超分走独立分支：内置 Real-ESRGAN / 社区 ESRGAN 模型 / Real-CUGAN / Transformer（Swin2SR）
  const isAiUpscale =
    isAiModel(modelId) ||
    isCommunityModel(modelId) ||
    String(modelId || '').startsWith('cugan:') ||
    String(modelId || '').startsWith('onnx:');
  if (String(modelId || '').startsWith('onnx:')) {
    return enhanceImageTransformer(id, row, target, modelId, opts.onProgress);
  }
  if (isAiUpscale) return enhanceImageAi(id, row, target, modelId, opts.onProgress);

  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';
  const curW = meta.width || row.width;
  const curH = meta.height || row.height;

  const model = ENHANCE_MODELS.find((m) => m.id === modelId) || ENHANCE_MODELS[0];
  // 放大到「刚好达到标准」所需的倍数，并受输出像素上限与模型上限约束
  const needed = Math.max(target.width / (curW || 1), target.height / (curH || 1));
  const maxByPixels = Math.sqrt(MAX_OUTPUT_PIXELS / Math.max(1, curW * curH));
  const scale = Math.min(needed, maxByPixels, model.maxScale || 8);
  if (scale <= 1.001) return toDTO(row); // 已达标，无需增强

  const newW = Math.round(curW * scale);
  const newH = Math.round(curH * scale);
  let pipeline = sharp(row.abs_path, { failOn: 'none' }).resize(newW, newH, { kernel: model.kernel });
  if (model.sharpen) pipeline = pipeline.sharpen({ sigma: model.sharpen, m1: 0.5, m2: 0.2 });
  if (model.blur) pipeline = pipeline.blur(model.blur);
  if (format === 'png') pipeline = pipeline.png();
  else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 });
  else pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  await writeFileAtomic(row.abs_path, data);

  const newHash = await computePHash(data).catch(() => '');
  db.prepare('UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ? WHERE id = ?').run(
    info.width,
    info.height,
    data.length,
    newHash,
    id
  );
  if (newHash) phashIndex.set(id, newHash);
  if (clip.clipReady()) clip.reembed(id, row.abs_path); // 内容已改变，重建深度特征
  invalidateQuality(id); // 清晰度缓存同步失效，下次分组时重算

  await removeFileRetry(path.join(THUMB_DIR, `${id}.jpg`));
  if (row.thumb && row.thumb !== path.join(THUMB_DIR, `${id}.jpg`)) {
    await removeFileRetry(row.thumb);
  }

  return toDTO(getImage(id));
}

/**
 * Transformer 系超分（Swin2SR）：重建更自然、伪影更少，但比 ESRGAN/CUGAN 慢一个量级。
 * 流程：Swin2SR 放大 → sharp 精确贴合到「刚好达到标准」→ 覆盖原文件。
 */
async function enhanceImageTransformer(id, row, target, modelId, onProgress) {
  const model = srModelOf(modelId);
  if (!model) throw new Error('未指定 Transformer 超分模型');
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';
  const curW = meta.width || row.width;
  const curH = meta.height || row.height;

  const needed = Math.max(target.width / (curW || 1), target.height / (curH || 1));
  if (needed <= 1.001) return toDTO(row);

  const tmpOut = `${row.abs_path}.sr-out.png`;
  try {
    const { width, height } = await runSr({ repo: model.repo, inputPath: row.abs_path, outputPath: tmpOut, onProgress });
    const f = Math.max(target.width / width, target.height / height);
    let pipeline = sharp(tmpOut, { failOn: 'none' });
    if (Math.abs(f - 1) > 0.01) {
      pipeline = pipeline.resize(Math.max(1, Math.round(width * f)), Math.max(1, Math.round(height * f)), {
        kernel: 'lanczos3',
      });
    }
    if (format === 'png') pipeline = pipeline.png();
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 });
    else pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return await writeEnhancedBuffer(id, row, data, info);
  } finally {
    await removeFileRetry(tmpOut);
  }
}

/** 解析模型标识：esrgan:<社区模型名> / cugan:<模型名> / 内置 ai-realesrgan-* */
function parseAiModel(modelId) {
  if (isCommunityModel(modelId)) {
    const m = communityModelOf(modelId);
    return { engine: 'realesrgan', name: m.name, scalable: false, maxScale: m.scale };
  }
  if (String(modelId).startsWith('cugan:')) {
    const name = String(modelId).slice(6);
    return { engine: 'realcugan', name, scalable: false, maxScale: 4 };
  }
  const builtin = aiModelOf(modelId);
  return { engine: 'realesrgan', name: builtin.name, scalable: builtin.scalable, maxScale: builtin.maxScale || 4 };
}

/** 压缩噪点 / 低质图的判据：每像素字节数越低，说明 JPEG 压缩越狠、噪点越重 */
function isNoisyImage(row, curW, curH) {
  const px = Math.max(1, (curW || row.width) * (curH || row.height));
  const bpp = (row.size_bytes || 0) / px;
  return bpp < 0.3; // 典型高质量 JPEG 约 0.5~1.5 B/像素
}

/** 单次超分：返回 { outPath, isTemp } */
async function runOneStage({ engine, name, scale, denoise, conservative }, inputPath, curW, curH, onProgress) {
  const tmpOut = `${inputPath}.stage-${engine}.png`;
  const tile = curW * curH > 1_500_000 ? 256 : 0;
  await runUpscale({ inputPath, outputPath: tmpOut, modelName: name, scale, tile, onProgress, engine, denoise, conservative });
  return tmpOut;
}

/**
 * AI 超分增强：
 * - 噪点重 / 压缩狠的图（bpp < 0.3）且已装 Real-CUGAN → 两级流程：
 *   ① Real-CUGAN 2× 降噪（保守修复，先把 JPEG 噪点压掉）
 *   ② 主模型（默认 NMKD-Siax 200k）补到「刚好达到标准」
 * - 其余图单级：主模型放大 → sharp 精确贴合到标准 → 覆盖原文件
 */
async function enhanceImageAi(id, row, target, modelId, onProgress) {
  const spec = parseAiModel(modelId);
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';
  const curW = meta.width || row.width;
  const curH = meta.height || row.height;

  const needed = Math.max(target.width / (curW || 1), target.height / (curH || 1));
  if (needed <= 1.001) return toDTO(row);

  // 两级：先降噪再放大（Real-CUGAN 可用 + 判定为噪点重的图）
  const cuganModels = cuganInstalled() ? listCuganModels() : [];
  const preDenoise = isNoisyImage(row, curW, curH) && cuganModels.length > 0;

  const tmps = [];
  try {
    let inputPath = row.abs_path;
    let stageW = curW;
    let stageH = curH;

    if (preDenoise) {
      // 2× 模型优先（包内 2× 模型通常支持多档降噪），找不到就用第一个
      const twoX = cuganModels.find((m) => /2x/i.test(m)) || cuganModels[0];
      const denoised = await runOneStage(
        { engine: 'realcugan', name: twoX, scale: 2, denoise: 2, conservative: true },
        inputPath,
        stageW,
        stageH,
        onProgress
      );
      tmps.push(denoised);
      const dm = await sharp(denoised, { failOn: 'none' }).metadata();
      inputPath = denoised;
      stageW = dm.width || stageW * 2;
      stageH = dm.height || stageH * 2;
    }

    // 主模型：放大到「刚好达到标准」所需的倍数
    const rest = Math.max(target.width / (stageW || 1), target.height / (stageH || 1));
    if (rest > 1.001) {
      const aiScale = spec.scalable ? Math.max(2, Math.min(4, Math.ceil(rest))) : Math.min(spec.maxScale, 4);
      const outPixels = stageW * stageH * aiScale * aiScale;
      if (outPixels > MAX_OUTPUT_PIXELS) {
        const k = Math.sqrt(MAX_OUTPUT_PIXELS / outPixels);
        const preTmp = `${inputPath}.ai-src.png`;
        await sharp(inputPath, { failOn: 'none' })
          .resize(Math.max(64, Math.round(stageW * k)), Math.max(64, Math.round(stageH * k)), { kernel: 'lanczos3' })
          .png()
          .toFile(preTmp);
        tmps.push(preTmp);
        inputPath = preTmp;
      }
      const upscaled = await runOneStage(
        { engine: spec.engine, name: spec.name, scale: aiScale },
        inputPath,
        stageW,
        stageH,
        onProgress
      );
      tmps.push(upscaled);
      const upMeta = await sharp(upscaled, { failOn: 'none' }).metadata();
      inputPath = upscaled;
      stageW = upMeta.width || stageW * aiScale;
      stageH = upMeta.height || stageH * aiScale;
    }

    // 精确贴合到标准
    const f = Math.max(target.width / stageW, target.height / stageH);
    let pipeline = sharp(inputPath, { failOn: 'none' });
    if (Math.abs(f - 1) > 0.01) {
      pipeline = pipeline.resize(Math.max(1, Math.round(stageW * f)), Math.max(1, Math.round(stageH * f)), {
        kernel: 'lanczos3',
      });
    }
    if (format === 'png') pipeline = pipeline.png();
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 });
    else pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return await writeEnhancedBuffer(id, row, data, info);
  } finally {
    for (const t of tmps) await removeFileRetry(t);
  }
}

/** 把 Buffer 写回原文件，复用增强后的元数据更新逻辑 */
async function writeEnhancedBuffer(id, row, data, info) {
  await writeFileAtomic(row.abs_path, data);
  const newHash = await computePHash(data).catch(() => '');
  db.prepare('UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ? WHERE id = ?').run(
    info.width,
    info.height,
    data.length,
    newHash,
    id
  );
  if (newHash) phashIndex.set(id, newHash);
  if (clip.clipReady()) clip.reembed(id, row.abs_path); // 内容已改变，重建深度特征
  invalidateQuality(id); // 清晰度缓存同步失效，下次分组时重算
  await removeFileRetry(path.join(THUMB_DIR, `${id}.jpg`));
  if (row.thumb && row.thumb !== path.join(THUMB_DIR, `${id}.jpg`)) await removeFileRetry(row.thumb);
  return toDTO(getImage(id));
}

/** 按 "a.b.c" 路径取嵌套字段 */
function getByPath(obj, p) {
  return String(p)
    .split('.')
    .filter(Boolean)
    .reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * 手工拼 multipart 表单体。
 * 不用 FormData：Electron 的 net.fetch 走 Chromium 实现，与 Node 的 FormData/File 不互通。
 */
function buildMultipart(parts, file) {
  const boundary = `----GemEnhance${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.key}"\r\n\r\n${p.value}\r\n`, 'utf8')
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.mime}\r\n\r\n`,
      'utf8'
    )
  );
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 调用线上增强服务：上传 → （可选）取回结果地址 → 下载结果。
 * 走 httpFetch（桌面端用 Electron 网络栈，自动跟随应用内代理设置）。
 */
async function callRemoteService(service, buf, mime) {
  if (!service?.uploadUrl) throw new Error('未配置上传地址');

  const headers = {};
  if (service.apiKey) headers.Authorization = `Bearer ${service.apiKey}`;
  for (const h of service.headers || []) {
    if (h && h.key) headers[h.key] = h.value;
  }

  const method = service.method || 'POST';
  let body;
  if (service.bodyMode === 'binary') {
    headers['Content-Type'] = mime;
    body = buf;
  } else {
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const mp = buildMultipart(service.params || [], {
      field: service.fileField || 'file',
      filename: `image.${ext}`, // 固定 ASCII 文件名，避免中文名在部分服务端出问题
      mime,
      buffer: buf,
    });
    headers['Content-Type'] = mp.contentType;
    body = mp.body;
  }

  const up = await httpFetch(service.uploadUrl, { method, headers, body });
  const status = up.status;
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    throw new Error(`上传失败（HTTP ${status}）：${text.slice(0, 240)}`);
  }

  let resultBuf;
  if ((service.resultType || 'json') === 'direct') {
    resultBuf = Buffer.from(await up.arrayBuffer());
  } else {
    const text = await up.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`服务未返回 JSON：${text.slice(0, 240)}`);
    }
    const url = service.resultUrlPath
      ? getByPath(json, service.resultUrlPath)
      : json.url || json.result || json.output || json.output_url;
    if (!url) throw new Error(`未找到结果地址（可在服务配置里指定字段路径）：${text.slice(0, 240)}`);
    const dl = await httpFetch(String(url), {
      headers: service.apiKey ? { Authorization: `Bearer ${service.apiKey}` } : {},
    });
    if (!dl.ok) throw new Error(`下载结果失败（HTTP ${dl.status}）`);
    resultBuf = Buffer.from(await dl.arrayBuffer());
  }

  if (!resultBuf?.length) throw new Error('服务返回内容为空');
  const info = await sharp(resultBuf, { failOn: 'none' }).metadata().catch(() => null);
  if (!info?.width) throw new Error(`返回内容不是可识别的图片（${resultBuf.length} 字节）`);
  return { resultBuf, info };
}

/**
 * 线上增强：软件负责「上传图片 → 设置参数 → 下载结果 → 覆盖原文件」全流程。
 * service 配置见 web 端「设置 → 画质增强 → 线上增强服务」。
 */
export async function enhanceImageRemote(id, service) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  try {
    return await enhanceImageRemoteInner(id, service);
  } catch (err) {
    throw translateError(err, row.abs_path);
  }
}

async function enhanceImageRemoteInner(id, service) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在（可能已被移动或删除）');

  const buf = await fsp.readFile(row.abs_path);
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const mime = meta.format === 'png' ? 'image/png' : meta.format === 'webp' ? 'image/webp' : 'image/jpeg';

  const { resultBuf, info } = await callRemoteService(service, buf, mime);
  // 写入统一交给 writeEnhancedBuffer（避免重复写同一文件、加大被占用概率）
  return writeEnhancedBuffer(id, row, resultBuf, {
    width: info.width || row.width,
    height: info.height || row.height,
  });
}

/** 连通性测试：用一张合成小图走完整流程，返回耗时与返回体摘要（不触碰任何真实图片） */
export async function testRemoteService(service) {
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 60, b: 160 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  const t0 = Date.now();
  try {
    const { resultBuf, info } = await callRemoteService(service, buf, 'image/jpeg');
    return {
      ok: true,
      elapsed: Date.now() - t0,
      bytes: resultBuf.length,
      width: info.width,
      height: info.height,
      message: `成功：返回 ${info.width}×${info.height}（${Math.round(resultBuf.length / 1024)} KB）`,
    };
  } catch (err) {
    return { ok: false, elapsed: Date.now() - t0, message: String(err.message || err) };
  }
}

function orientationOf(w, h) {
  if (!w || !h) return 'unknown';
  const ratio = w / h;
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'square';
}

function bucketOf(w, h) {
  const long = Math.max(w || 0, h || 0);
  if (long < 1080) return 'sd';
  if (long < 2048) return 'fhd';
  if (long < 3840) return '2k';
  return '4k';
}

/**
 * 文件名里带着采集时的分辨率（关键词_来源_宽x高_时间.jpg），且增强/旋转不会改名。
 * 因此「当前尺寸 > 文件名里的尺寸」就说明这张图被放大过，可用于展示"增强前 → 后"。
 */
function originalSizeOf(row) {
  const m = path.basename(row.abs_path || '').match(/_(\d+)x(\d+)_/);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!width || !height) return null;
  if (row.width > width * 1.02 || row.height > height * 1.02) return { width, height };
  return null;
}

export function toDTO(row) {
  const tags = row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  // 以文件修改时间作版本号，文件被修改后（如旋转）浏览器缓存自动失效
  let ver = '';
  try {
    ver = `?v=${Math.floor(fs.statSync(row.abs_path).mtimeMs)}`;
  } catch {}
  const orig = originalSizeOf(row);
  return {
    enhanced: !!orig,
    originalWidth: orig ? orig.width : 0,
    originalHeight: orig ? orig.height : 0,
    enhanceScale: orig && orig.width ? Math.round((row.width / orig.width) * 10) / 10 : 0,
    id: row.id,
    title: row.title,
    source: row.source,
    keyword: row.keyword,
    sourceUrl: row.source_url,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    mime: row.mime,
    favorite: row.favorite === 1,
    viewed: !!row.viewed_at,
    viewCount: row.view_count || 0,
    viewedAt: row.viewed_at || '',
    rating: row.rating || 0,
    note: row.note || '',
    dominant: row.dominant || '',
    hue: row.hue ?? '',
    tags,
    createdAt: row.created_at,
    score: row.score ?? 100,
    scoreReason: row.score_reason || '',
    orientation: orientationOf(row.width, row.height),
    bucket: bucketOf(row.width, row.height),
    path: row.abs_path,
    thumbUrl: `/api/images/${row.id}/thumb${ver}`,
    url: `/api/images/${row.id}/file${ver}`,
    downloadUrl: `/api/images/${row.id}/download${ver}`,
  };
}

export function getImage(id) {
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id);
}

export const KEEP_REASONS = {
  ok: 'ok',
  tooSmall: 'lowres',
  tooLight: 'small',
  badFormat: 'format',
  duplicate: 'duplicate',
  failed: 'failed',
  tooLarge: 'oversize',
  aiFilter: 'aiFilter',
};

/**
 * 把一张图片纳入图库（含过滤与去重）
 * @param {Object} params
 * @param {string} [params.absPath] 已存在于磁盘的文件（不复制）
 * @param {Buffer} [params.buffer] 内存中的图片数据（会落盘）
 */
export async function ingest(params, settings = getSettings()) {
  const {
    absPath = null,
    buffer = null,
    source = 'local',
    keyword = '',
    sourceUrl = '',
    title = '',
    tags = '',
    copyToStorage = false,
    // 本地导入用：跳过 pHash 查重。磁盘上真实存在的文件都应登记入库（内容相同的不同文件
    // 如同名 jpg/png 对，正是后续去重工具要处理的对象，若在这里拦截反而配不成对）
    skipPhashDupe = false,
  } = params;

  const minBytes = Number(settings.minFileSize) * 1024;
  const maxBytes = Number(settings.maxFileSize) * 1024 * 1024;
  const minLong = Number(settings.minResolution);
  const threshold = Number(settings.phashThreshold);

  let finalPath = absPath;
  let sizeBytes = 0;

  if (buffer) {
    sizeBytes = buffer.length;
    if (sizeBytes < minBytes) return { ok: false, reason: KEEP_REASONS.tooLight };
    if (sizeBytes > maxBytes) return { ok: false, reason: KEEP_REASONS.tooLarge };
  } else if (absPath) {
    const stat = fs.statSync(absPath);
    sizeBytes = stat.size;
    if (sizeBytes < minBytes) return { ok: false, reason: KEEP_REASONS.tooLight };
    if (sizeBytes > maxBytes) return { ok: false, reason: KEEP_REASONS.tooLarge };
  } else {
    return { ok: false, reason: KEEP_REASONS.failed };
  }

  let meta;
  try {
    const pipeline = sharp(buffer || absPath, { failOn: 'none' });
    meta = await pipeline.metadata();
  } catch {
    return { ok: false, reason: KEEP_REASONS.badFormat };
  }

  const format = (meta.format || '').toLowerCase();
  if (!ALLOWED_FORMATS.has(format)) return { ok: false, reason: KEEP_REASONS.badFormat };

  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) return { ok: false, reason: KEEP_REASONS.badFormat };
  if (Math.max(width, height) < minLong) return { ok: false, reason: KEEP_REASONS.tooSmall };

  // 落盘：采集到的图片直接写入本地保存文件夹
  if (buffer || (copyToStorage && absPath)) {
    const dir = resolveStorageDir(settings);
    const name = buildFileName({ keyword, source, width, height, format });
    let finalPathCandidate = path.join(dir, name);
    if (fs.existsSync(finalPathCandidate)) {
      finalPathCandidate = path.join(dir, name.replace(/(\.\w+)$/, `_${crypto.randomBytes(2).toString('hex')}$1`));
    }
    finalPath = finalPathCandidate;
    if (buffer) await fsp.writeFile(finalPath, buffer);
    else await fsp.copyFile(absPath, finalPath);
  }

  let phash = '';
  try {
    phash = await computePHash(finalPath);
  } catch (err) {
    console.error('[phash] 计算失败', finalPath, err.message);
  }

  if (phash && !skipPhashDupe) {
    const dupId = findDuplicateByPhash(phash, threshold);
    if (dupId) {
      if (buffer || copyToStorage) await removeFileRetry(finalPath);
      return { ok: false, reason: KEEP_REASONS.duplicate, duplicateOf: dupId };
    }
  }

  // CLIP 深度特征查重（第二道防线）：裁剪/旋转/加滤镜的图 pHash 挡不住，向量余弦能识别。
  // 模型未就绪时跳过（首次启动后台加载，加载完成前入库的图由「补算」任务覆盖）。
  if (!skipPhashDupe && clip.clipReady()) {
    try {
      const vec = await clip.embedImage(finalPath);
      const dup = clip.topSimilar(vec, { k: 1, minCos: 0.965 });
      if (dup.length) {
        if (buffer || copyToStorage) await removeFileRetry(finalPath);
        return { ok: false, reason: KEEP_REASONS.duplicate, duplicateOf: dup[0].id, clipCos: +dup[0].cos.toFixed(4) };
      }
    } catch (err) {
      console.error('[clip] 入库查重失败（忽略）', finalPath, err?.message || err);
    }
  }

  const info = db
    .prepare(
      `INSERT INTO images (title, abs_path, thumb, source, keyword, source_url, width, height,
        size_bytes, mime, phash, favorite, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      title || path.basename(finalPath),
      finalPath,
      null,
      source,
      keyword,
      sourceUrl,
      width,
      height,
      sizeBytes,
      `image/${format === 'jpg' ? 'jpeg' : format}`,
      phash,
      tags,
      new Date().toISOString()
    );

  // 智能评分：命中知识库负面规则且低于阈值时直接丢弃
  const { score, reasons } = scoreImage(
    { source, keyword, width, height, tags, phash },
    undefined,
    ''
  );
  if (settings.aiFilterEnabled !== false && score < Number(settings.scoreThreshold)) {
    if (buffer || copyToStorage) await removeFileRetry(finalPath);
    return { ok: false, reason: KEEP_REASONS.aiFilter, score, reasons };
  }

  const id = Number(info.lastInsertRowid);
  if (phash) phashIndex.set(id, phash);
  if (clip.clipReady()) clip.reembed(id, finalPath); // 深度特征入库（异步）
  db.prepare('UPDATE images SET score = ?, score_reason = ? WHERE id = ?').run(
    score,
    reasons.join('；'),
    id
  );
  const thumb = await ensureThumb(id, finalPath);
  if (thumb) db.prepare('UPDATE images SET thumb = ? WHERE id = ?').run(thumb, id);

  // 主色与色系（用于「找同色」与颜色筛选）
  try {
    const color = await computeDominant(finalPath);
    db.prepare('UPDATE images SET dominant = ?, hue = ?, palette = ? WHERE id = ?').run(
      color.dominant,
      color.hue,
      JSON.stringify(color.palette || [color.dominant]),
      id
    );
  } catch {
    /* 主色提取失败不影响入库 */
  }

  return { ok: true, id, image: toDTO(getImage(id)) };
}

export function setFavorite(id, favorite) {
  db.prepare('UPDATE images SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
  return toDTO(getImage(id));
}

export function setTags(id, tags) {
  const value = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).join(',') : String(tags || '');
  db.prepare('UPDATE images SET tags = ? WHERE id = ?').run(value, id);
  return toDTO(getImage(id));
}

export function renameTitle(id, title) {
  db.prepare('UPDATE images SET title = ? WHERE id = ?').run(String(title || ''), id);
  return toDTO(getImage(id));
}

/** 标记「已看过」（进入大图预览时调用），供「未看过」筛选使用 */
export function markViewed(id) {
  db.prepare('UPDATE images SET view_count = view_count + 1, viewed_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id
  );
  return toDTO(getImage(id));
}

/** 星级评分（0-5，0 表示未评分） */
export function setRating(id, rating) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  db.prepare('UPDATE images SET rating = ? WHERE id = ?').run(value, id);
  return toDTO(getImage(id));
}

/** 备注 */
export function setNote(id, note) {
  db.prepare('UPDATE images SET note = ? WHERE id = ?').run(String(note || '').slice(0, 1000), id);
  return toDTO(getImage(id));
}

/* ------------------------------- 标签管理 ------------------------------- */

/** 列出所有标签及出现次数（用于标签云 / 筛选） */
export function listTags() {
  const counter = new Map();
  for (const row of db.prepare("SELECT tags FROM images WHERE tags <> ''").all()) {
    for (const tag of String(row.tags).split(',')) {
      const t = tag.trim();
      if (t) counter.set(t, (counter.get(t) || 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/** 重命名标签（在所有图片上替换，保持单一事实来源：images.tags 逗号串） */
export function renameTag(oldName, newName) {
  const o = String(oldName || '').trim();
  const n = String(newName || '').trim();
  if (!o || !n) throw new Error('标签名不能为空');
  const rows = db
    .prepare('SELECT id, tags FROM images WHERE id IN (SELECT image_id FROM item_tags WHERE tag = ?)')
    .all(o);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const tags = String(r.tags)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t === o ? n : t));
      stmt.run(tags.join(','), r.id);
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  return rows.length;
}

/** 删除标签（从所有图片上摘除） */
export function deleteTag(name) {
  const t = String(name || '').trim();
  if (!t) throw new Error('标签名不能为空');
  const rows = db
    .prepare('SELECT id, tags FROM images WHERE id IN (SELECT image_id FROM item_tags WHERE tag = ?)')
    .all(t);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const tags = String(r.tags)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x) => x !== t);
      stmt.run(tags.join(','), r.id);
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  return rows.length;
}

/** 合并标签：把 from 全部改名为 to（去重） */
export function mergeTags(from, to) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!f || !t) throw new Error('标签名不能为空');
  const rows = db
    .prepare('SELECT id, tags FROM images WHERE id IN (SELECT image_id FROM item_tags WHERE tag = ?)')
    .all(f);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const set = new Set(
        String(r.tags)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      );
      set.delete(f);
      set.add(t);
      stmt.run([...set].join(','), r.id);
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  return rows.length;
}

/* ------------------------------- 智能文件夹 ------------------------------- */

export function listSmartFolders() {
  return db
    .prepare('SELECT * FROM smart_folders ORDER BY updated_at DESC')
    .all()
    .map((f) => ({ ...f, rules: safeParse(f.rules, {}), autoTags: splitTags(f.auto_tags) }));
}

export function getSmartFolder(id) {
  const f = db.prepare('SELECT * FROM smart_folders WHERE id = ?').get(id);
  if (!f) return null;
  return { ...f, rules: safeParse(f.rules, {}), autoTags: splitTags(f.auto_tags) };
}

export function createSmartFolder({ name, rules = {}, autoTags = [] }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('智能文件夹名称不能为空');
  const now = new Date().toISOString();
  try {
    db.prepare(
      'INSERT INTO smart_folders(name, rules, auto_tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(n, JSON.stringify(rules || {}), joinTags(autoTags), now, now);
  } catch {
    throw new Error('已存在同名智能文件夹');
  }
  return listSmartFolders();
}

export function updateSmartFolder(id, patch = {}) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const now = new Date().toISOString();
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error('名称不能为空');
    db.prepare('UPDATE smart_folders SET name = ?, updated_at = ? WHERE id = ?').run(n, now, id);
  }
  if (patch.rules !== undefined) {
    db.prepare('UPDATE smart_folders SET rules = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(patch.rules || {}),
      now,
      id
    );
  }
  if (patch.autoTags !== undefined) {
    db.prepare('UPDATE smart_folders SET auto_tags = ?, updated_at = ? WHERE id = ?').run(
      joinTags(patch.autoTags),
      now,
      id
    );
  }
  return listSmartFolders();
}

export function deleteSmartFolder(id) {
  db.prepare('DELETE FROM smart_folders WHERE id = ?').run(id);
  return listSmartFolders();
}

/** 判断一张图是否命中智能文件夹的规则 */
export function matchSmartFolder(row, rules = {}) {
  if (rules.favorite === 'yes' && row.favorite !== 1) return false;
  if (rules.favorite === 'no' && row.favorite === 1) return false;
  if (rules.minRating && (row.rating || 0) < rules.minRating) return false;
  if (rules.minScore && (row.score ?? 100) < rules.minScore) return false;
  if (rules.minWidth && Math.max(row.width || 0, row.height || 0) < rules.minWidth) return false;
  if (rules.orientation === 'landscape' && !(row.width > (row.height || 0) * 1.15)) return false;
  if (rules.orientation === 'portrait' && !((row.width || 0) > 0 && row.height > row.width * 1.15)) return false;
  if (rules.orientation === 'square' && Math.abs((row.width || 0) - (row.height || 0)) > (row.width || 1) * 0.15)
    return false;
  if (Array.isArray(rules.tagsInclude) && rules.tagsInclude.length) {
    const tags = splitTags(row.tags);
    if (!rules.tagsInclude.every((t) => tags.includes(String(t).trim()))) return false;
  }
  if (Array.isArray(rules.tagsExclude) && rules.tagsExclude.length) {
    const tags = splitTags(row.tags);
    if (rules.tagsExclude.some((t) => tags.includes(String(t).trim()))) return false;
  }
  if (Array.isArray(rules.keywords) && rules.keywords.length) {
    const hay = `${row.title} ${row.tags} ${row.keyword} ${row.note}`.toLowerCase();
    if (!rules.keywords.every((k) => hay.includes(String(k).toLowerCase()))) return false;
  }
  if (Array.isArray(rules.aiKeywords) && rules.aiKeywords.length) {
    const desc = (aiDescText(row.id) || '').toLowerCase();
    if (!rules.aiKeywords.every((k) => desc.includes(String(k).toLowerCase()))) return false;
  }
  return true;
}

/** 预览智能文件夹命中的图片（按评分/时间排序） */
export function previewSmartFolder(id, limit = 200) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const rows = db.prepare('SELECT * FROM images').all();
  const matched = rows.filter((r) => matchSmartFolder(r, f.rules));
  const sorted = matched
    .sort((a, b) => (b.score ?? 100) - (a.score ?? 100) || b.id - a.id)
    .slice(0, limit);
  return { folder: f, total: matched.length, items: sorted.map(toDTO) };
}

/** 文件夹标签继承：把该智能文件夹的 autoTags 应用到所有命中图片（一次性同步） */
export function applySmartFolderTags(id) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const autoTags = f.autoTags;
  if (!autoTags.length) return 0;
  const rows = db.prepare('SELECT * FROM images').all();
  let changed = 0;
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!matchSmartFolder(r, f.rules)) continue;
      const set = new Set(splitTags(r.tags));
      autoTags.forEach((t) => set.add(String(t).trim()));
      stmt.run([...set].join(','), r.id);
      changed++;
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  return changed;
}

/* ------------------------------- 内部工具 ------------------------------- */

function splitTags(s) {
  return String(s || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}
function joinTags(arr) {
  return Array.isArray(arr) ? arr.map((t) => String(t).trim()).filter(Boolean).join(',') : '';
}
function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}
function aiDescText(id) {
  const row = db.prepare('SELECT description FROM ai_desc WHERE image_id = ?').get(id);
  return row ? row.description : '';
}

/* ------------------------------- 主色提取 ------------------------------- */

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 主色提取采用业界主流的「修正中值切割量化（MMCQ / Modified Median Cut Quantization，
 * 与 color-thief、Android Palette 同源）」：在缩略图上对每个像素建箱，递归地沿「最长通道」在
 * 中位数处把箱子一分为二，得到至多 maxColors 个感知差异明显、且彼此不重叠的代表色。
 * 每个代表色自带「像素占比 pop」，与 MPEG-7 DominantColor 描述符（至多 8 个主簇 + 各自占比）
 * 一致，便于后续按“颜色占比”加权排序，让“画面主色就是该颜色”的图排在最前。
 */
function medianCutQuantize(pixels, maxColors) {
  if (!pixels.length) return [];
  const makeBox = (px) => {
    const min = [255, 255, 255];
    const max = [0, 0, 0];
    for (const p of px) {
      for (let c = 0; c < 3; c++) {
        if (p[c] < min[c]) min[c] = p[c];
        if (p[c] > max[c]) max[c] = p[c];
      }
    }
    const volume =
      (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
    return {
      px,
      min,
      max,
      volume,
      population: px.length,
      // 优先切“体积大且像素多”的箱，保证切出来的都是画面里真正存在的主体色
      score: volume * Math.log(1 + px.length),
    };
  };
  // 沿像素数最多的通道、在中位数处切分；若中点两侧同色则滑到第一个不同色边界
  const splitBox = (box) => {
    let ch = 0;
    let range = -1;
    for (let c = 0; c < 3; c++) {
      const r = box.max[c] - box.min[c];
      if (r > range) {
        range = r;
        ch = c;
      }
    }
    if (range <= 0) return null; // 箱内颜色完全一致，无法再分
    const sorted = box.px.slice().sort((a, b) => a[ch] - b[ch]);
    let cut = Math.floor(sorted.length / 2);
    while (cut > 0 && sorted[cut][ch] === sorted[cut - 1][ch]) cut--;
    if (cut === 0) {
      let k = Math.floor(sorted.length / 2);
      while (k < sorted.length && sorted[k][ch] === sorted[0][ch]) k++;
      if (k >= sorted.length) return null;
      cut = k;
    }
    return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
  };
  let boxes = [makeBox(pixels)];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => b.score - a.score);
    const box = boxes.shift();
    if (!box || box.score <= 0) break;
    const parts = splitBox(box);
    if (!parts) {
      boxes.push(box); // 不可再分，保留为最终色
      break;
    }
    boxes.push(parts[0], parts[1]);
  }
  return boxes
    .map((box) => {
      let r = 0, g = 0, b = 0;
      for (const p of box.px) {
        r += p[0];
        g += p[1];
        b += p[2];
      }
      const n = box.px.length;
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), pop: n };
    })
    .sort((a, b) => b.pop - a.pop);
}

/* 感知均匀颜色空间 OKLab（Björn Ottosson）。色相判断比 HSV 准得多：
 * HSV 会把棕红/褐色/肤色判进「红」（0-30°），而 OKLCH 里它们落在 40-76°（橙），
 * 与人眼一致；且与颜色搜索用的 OKLab 距离保持同一色彩空间。 */
function srgbToLinear(x) {
  x /= 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function hexToRgb(hex) {
  if (!hex) return null;
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
function rgbToOklab(hex) {
  const c = hexToRgb(hex);
  if (!c) return null;
  const r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}
function oklabHue(lab) {
  const h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

/** 12 个色系的原型色（与 web/src/components/FilterBar.tsx 的 HUES 保持一致，0红..11玫粉） */
const HUE_PROTOS = [
  '#ff4d4d', '#ff9a4d', '#ffe04d', '#c8ff4d', '#4dff6a', '#4dffcf',
  '#4defff', '#4da6ff', '#5c4dff', '#a64dff', '#ff4dd2', '#ff4d88',
];
// 桶边界 = 相邻原型色 OKLCH 色相角的平分线（bounds[i] 为桶 i 与桶 i+1 的分界）。
// 注意 OKLCH 色相角与 HSV 不同（纯红≈25° 而非 0°），不能用 i*30° 等分，否则会错桶。
const OKLAB_HUE_BOUNDS = HUE_PROTOS.map((hex, i) => {
  const hi = oklabHue(rgbToOklab(hex));
  const nx = oklabHue(rgbToOklab(HUE_PROTOS[(i + 1) % HUE_PROTOS.length]));
  let d = nx - hi;
  if (d < 0) d += 360;
  return (hi + d / 2) % 360;
});

const OKLAB_HUE_CHROMA_MIN = 0.03; // OKLCH 彩度基准门槛，低于此视为无色相（灰/黑/白）
const OKLAB_HUE_POP_MIN = 0.08;    // 占比低于此的代表色只是点缀，不足以定义整图色系

/** 彩度门槛随明度调整：越接近纯白/纯黑，人眼越难感知出色相，
 *  需要更高彩度才算「有色」。否则奶油色会被算成黄/橙、近黑被算成蓝。 */
function chromaFloorFor(L) {
  return (
    OKLAB_HUE_CHROMA_MIN +
    Math.max(0, L - 0.88) * 0.3 +  // 浅端：L 0.88→1.00 门槛 0.030→0.066
    Math.max(0, 0.2 - L) * 0.15    // 暗端：L 0.20→0.00 门槛 0.030→0.060
  );
}

/**
 * 由调色板推色系（0-11；最多 3 种，按占比从高到低；某色系不足 8% 占比则不计入）。
 * 用 OKLCH 色相分桶，桶边界由前端 12 个原型色（FilterBar HUES）的 OKLCH 色相角平分得到，
 * 因此棕发/肤色/米色正确落入「橙」而非被 HSV 误判成「红」，奶油/淡粉等近白颜色归入黑白灰。
 * 返回空数组表示整图接近黑白灰（无色系）。
 */
const MAX_HUES = 3;
export function hueFromPalette(palette) {
  const arr = Array.isArray(palette) ? palette : [];
  const cands = [];
  for (const c of arr) {
    const hex = typeof c === 'string' ? c : c && typeof c.h === 'string' ? c.h : null;
    if (!hex) continue;
    const pop = typeof c === 'string' ? 1 : typeof c.p === 'number' ? c.p : 0;
    if (pop < OKLAB_HUE_POP_MIN) continue; // 占比太低只是点缀，不定义整图色系
    const lab = rgbToOklab(hex);
    if (!lab) continue;
    if (Math.hypot(lab.a, lab.b) < chromaFloorFor(lab.L)) continue; // 太灰不算有色相
    cands.push({ pop, lab });
  }
  cands.sort((a, b) => b.pop - a.pop);
  const hues = [];
  for (const c of cands) {
    if (hues.length >= MAX_HUES) break;
    const hue = oklabHue(c.lab);
    for (let i = 0; i < OKLAB_HUE_BOUNDS.length; i++) {
      const lo = OKLAB_HUE_BOUNDS[(i + 11) % 12];
      let rel = hue - lo;
      if (rel < 0) rel += 360;
      let span = OKLAB_HUE_BOUNDS[i] - lo;
      if (span < 0) span += 360;
      if (rel <= span) {
        if (!hues.includes(i)) hues.push(i); // 同一色系只记一次
        break;
      }
    }
  }
  return hues;
}

/**
 * 取图片主色 + 色系（0-11 对应 12 个色系，-1 表示接近黑白灰）+ 至多 8 色带占比的调色板。
 * palette 用于「按颜色搜图」时与查询色做“感知距离 × 颜色占比”的匹配，比单一主色更准。
 */
export async function computeDominant(file) {
  // 颜色搜索（对标 Eagle 调色板 + MPEG-7 DominantColor）：用 MMCQ 提取“画面占比最多的代表色”，不接 AI。
  const s = await sharp(file, { failOn: 'none' })
    .rotate()
    .resize(160, 160, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = s.data;
  const ch = s.info.channels;
  const samples = [];
  // 每 2 像素取 1 个，兼顾速度与代表性
  const step = 2 * ch;
  for (let i = 0; i + 2 < px.length; i += step) {
    if (ch >= 4 && px[i + 3] < 128) continue; // 跳过透明像素
    samples.push([px[i], px[i + 1], px[i + 2]]);
  }
  if (!samples.length) {
    return { dominant: '#808080', hue: '', palette: [{ h: '#808080', p: 1 }] };
  }
  const MAX_COLORS = 8; // MPEG-7 DominantColor 至多 8 个主簇
  const boxes = medianCutQuantize(samples, MAX_COLORS);
  const total = samples.length;
  const palette = boxes.map((b) => ({
    h: rgbToHex(b.r, b.g, b.b),
    p: b.pop / total,
  }));
  const dom = boxes[0];
  const dominant = rgbToHex(dom.r, dom.g, dom.b);
  // 色系：由调色板里“彩度达标且占比≥8%”的代表色各按 OKLCH 色相分桶，
  // 取占比最高的至多 3 种（去重）；整体都是灰/白/黑则记为空串。
  const hue = hueFromPalette(palette).join(',');
  return {
    dominant,
    hue,
    palette: palette.map((p) => ({ h: p.h, p: p.p })),
  };
}

/** 给图片补算主色/调色板（一次处理一批，可重复调用）。
 *  force=true 时重算全部（用于修正已有的旧调色板数据），否则只补算缺失的。 */
export async function backfillDominant(limit = 300, force = false) {
  const rows = db
    .prepare(
      force
        ? 'SELECT id, abs_path FROM images LIMIT ?'
        : "SELECT id, abs_path FROM images WHERE dominant = '' LIMIT ?"
    )
    .all(Math.max(1, Math.min(5000, limit)));
  let done = 0;
  for (const row of rows) {
    try {
      if (!fs.existsSync(row.abs_path)) continue;
      const c = await computeDominant(row.abs_path);
      db.prepare('UPDATE images SET dominant = ?, hue = ?, palette = ? WHERE id = ?').run(
        c.dominant,
        c.hue,
        JSON.stringify(c.palette || [c.dominant]),
        row.id
      );
      done++;
    } catch {
      db.prepare("UPDATE images SET dominant = '#808080', hue = '', palette = '[]' WHERE id = ?").run(row.id);
    }
  }
  const remain = force
    ? 0
    : db.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant = ''").get().c;
  return { done, remain };
}

/* ---------------------------- 相似图分组（整理） ---------------------------- */

/**
 * 按感知哈希把「看起来是同一张」的图聚成组，供人工审查合并。
 * 组内按分辨率×评分排序，并给出推荐保留的那张。
 */
/**
 * CLIP 深度特征相似分组（双档，业界通行做法）：
 * - 组内最高余弦 ≥ 0.98 → tier='exact' 完全重复：同一张的转存/压缩版，可放心自动清理
 * - 否则 → tier='series' 系列照：同一场拍摄的多帧（连拍/pose 微调），只聚组折叠，默认不删
 * 组内推荐按「清晰度（拉普拉斯方差）× 分辨率」综合画质排序，最佳帧置顶。
 */
export async function listClipSimilarGroups(minCos = 0.92, maxGroups = 80) {
  const EXACT_COS = 0.98;
  const rows = db
    .prepare(
      `SELECT i.* FROM images i JOIN clip_vec c ON c.image_id = i.id ORDER BY i.id DESC`
    )
    .all();
  const vecs = rows.map((r) => ({
    row: r,
    vec: clip.getEmbedding(r.id),
  }));
  const n = vecs.length;
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const edges = []; // 组内最高余弦要按「边」统计，合并后才知道每簇的 tier
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      const va = vecs[i].vec;
      const vb = vecs[j].vec;
      let dot = 0;
      for (let d = 0; d < va.length; d++) dot += va[d] * vb[d];
      if (dot >= minCos) {
        edges.push({ a: i, b: j, cos: dot });
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[rb] = ra;
      }
    }
  }
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(vecs[i]);
  }
  const rootMaxCos = new Map();
  for (const { a, b, cos } of edges) {
    const root = find(a);
    rootMaxCos.set(root, Math.max(rootMaxCos.get(root) || 0, cos));
  }
  const groups = [];
  for (const [root, list] of clusters.entries()) {
    if (list.length < 2) continue;
    if (groups.length >= maxGroups) break;
    const maxCos = rootMaxCos.get(root) || 0;
    const tier = maxCos >= EXACT_COS ? 'exact' : 'series';
    // 组内画质：清晰度（相对组内最高）65% + 分辨率（相对组内最高）35%
    const sharpness = [];
    let maxSharp = 0;
    for (const v of list) {
      const s = await getSharpness(v.row.id, v.row.abs_path);
      sharpness.push(s);
      if (s > maxSharp) maxSharp = s;
    }
    const maxPixels = Math.max(...list.map((v) => v.row.width * v.row.height));
    const scored = list.map((v, i) => {
      const relSharp = maxSharp > 0 ? sharpness[i] / maxSharp : 0;
      const relRes = (v.row.width * v.row.height) / maxPixels;
      return { ...toDTO(v.row), quality: Math.round((0.65 * relSharp + 0.35 * relRes) * 100) };
    });
    scored.sort((a, b) => b.quality - a.quality || b.width * b.height - a.width * a.height);
    groups.push({
      key: `c${scored[0].id}`,
      recommendId: scored[0].id,
      count: list.length,
      tier,
      maxCos: +maxCos.toFixed(4),
      items: scored,
    });
  }
  groups.sort((a, b) => (a.tier === b.tier ? b.maxCos - a.maxCos : a.tier === 'exact' ? -1 : 1));
  return groups;
}

/**
 * 按感知哈希把「看起来是同一张」的图聚成组，供人工审查合并。
 * 组内按分辨率×评分排序，并给出推荐保留的那张。
 */
export function listSimilarGroups(threshold = 10, maxGroups = 60, scanLimit = 4000) {
  const rows = db
    .prepare("SELECT * FROM images WHERE phash != '' ORDER BY id DESC LIMIT ?")
    .all(Math.max(50, Math.min(20000, scanLimit)));
  const used = new Set();
  const groups = [];
  for (let i = 0; i < rows.length; i++) {
    if (used.has(rows[i].id)) continue;
    const group = [rows[i]];
    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(rows[j].id)) continue;
      if (hammingHex(rows[i].phash, rows[j].phash) <= threshold) {
        used.add(rows[j].id);
        group.push(rows[j]);
      }
    }
    if (group.length > 1) {
      used.add(rows[i].id);
      const weight = (r) => r.width * r.height * Math.max(1, (r.score ?? 100) / 50);
      const best = [...group].sort((a, b) => weight(b) - weight(a))[0];
      groups.push({
        key: `g${best.id}`,
        recommendId: best.id,
        count: group.length,
        items: group
          .map(toDTO)
          .sort((a, b) => b.width * b.height - a.width * a.height),
      });
      if (groups.length >= maxGroups) break;
    }
  }
  return groups;
}

/**
 * 同名跨格式去重：同一目录下主文件名相同、扩展名不同（如 5.jpg 与 5.png）视为同一张照片。
 * 推荐保留更清晰的 PNG（用户策略）；都没有 PNG 时保留分辨率更大的那张。
 */
export function listFormatDupes() {
  const FORMAT_RANK = { '.png': 3, '.webp': 2, '.jpeg': 1, '.jpg': 1, '.bmp': 1 };
  // 内容一致性阈值：同名不等于同图（旧版采集器曾因「秒级时间戳 + 相同尺寸」撞名，
  // 把两张不同的图存成同名 png/jpg）。同一张照片换格式后 pHash 距离通常 ≤ 6，
  // 不同照片一般 > 20，取 max(10, phashThreshold) 兼容较重的 JPEG 压缩。
  const contentThreshold = Math.max(10, Number(getSettings().phashThreshold) || 10);
  const sameContent = (a, b) => {
    if (a.phash && b.phash) return hammingHex(a.phash, b.phash) <= contentThreshold;
    // 缺 pHash 时退化为尺寸比对（比纯文件名可靠）
    return (a.width || 0) === (b.width || 0) && (a.height || 0) === (b.height || 0);
  };
  const rows = db.prepare('SELECT * FROM images').all();
  const buckets = new Map();
  for (const r of rows) {
    const p = r.abs_path || '';
    const ext = path.extname(p).toLowerCase();
    const stem = path.basename(p, ext);
    if (!stem) continue;
    const key = `${path.dirname(p).toLowerCase()}::${stem.toLowerCase()}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const groups = [];
  for (const list of buckets.values()) {
    const exts = new Set(list.map((r) => path.extname(r.abs_path || '').toLowerCase()));
    if (list.length < 2 || exts.size < 2) continue;
    const rank = (r) =>
      (FORMAT_RANK[path.extname(r.abs_path || '').toLowerCase()] || 0) * 1e12 +
      (r.width || 0) * (r.height || 0);
    const sorted = [...list].sort((a, b) => rank(b) - rank(a));
    // 只保留与画质最高那张内容一致的照片，撞名但内容不同的不组成一组
    const base = sorted[0];
    const same = sorted.filter((r) => r.id === base.id || sameContent(base, r));
    if (same.length < 2 || new Set(same.map((r) => path.extname(r.abs_path || '').toLowerCase())).size < 2) continue;
    groups.push({
      key: `f${same[0].id}`,
      recommendId: same[0].id,
      count: same.length,
      items: same.map(toDTO),
    });
  }
  return groups.sort((a, b) => b.items[0].id - a.items[0].id);
}

/** 相似图审查结果落地：保留 keepId，其余按删除策略处理（默认进应用内回收站，可恢复） */
export async function resolveSimilar(keepId, removeIds) {
  const keep = Number(keepId) || 0;
  const list = (Array.isArray(removeIds) ? removeIds : []).map(Number).filter((id) => id && id !== keep);
  let removed = 0;
  const failures = [];
  for (const id of list) {
    const res = await removeImage(id);
    if (res?.ok) removed++;
    else failures.push({ id, error: res?.error || '删除失败' });
  }
  return { removed, failures };
}

/** 列出「这组不处理」已跳过的组标识（组推荐保留项的 id） */
export function getTidySkips() {
  return db.prepare('SELECT recommend_id FROM tidy_skip').all().map((r) => r.recommend_id);
}

/** 标记某相似组「不处理」，刷新/重扫后依旧隐藏 */
export function addTidySkip(recommendId) {
  db.prepare('INSERT OR IGNORE INTO tidy_skip(recommend_id) VALUES (?)').run(Number(recommendId));
  return getTidySkips();
}

/** 清空所有「不处理」标记，让被跳过的组重新出现 */
export function resetTidySkips() {
  db.prepare('DELETE FROM tidy_skip').run();
  return getTidySkips();
}

/** 批量标记已看（把当前筛选结果整体标记） */
export function markAllViewed(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!list.length) return 0;
  const stmt = db.prepare('UPDATE images SET view_count = view_count + 1, viewed_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  let affected = 0;
  db.exec('BEGIN');
  try {
    for (const id of list) affected += stmt.run(now, id).changes;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  return affected;
}

/**
 * 删除图片。默认策略 trash：把文件移动到应用内回收站（同盘移动，可一键恢复）
 * @returns {{ok:boolean, error?:string}}
 */
export async function removeImage(id, { reason = '' } = {}) {
  const row = getImage(id);
  if (!row) return { ok: false, error: '图片不存在' };
  await fsp.rm(row.thumb, { force: true }).catch(() => {});

  const settings = getSettings();
  const policy = settings.deletePolicy || 'trash';
  let fileError = null;

  if (isManagedPath(row.abs_path, settings) && fs.existsSync(row.abs_path)) {
    if (policy === 'trash') {
      try {
        await moveToAppTrash(row, reason);
      } catch (err) {
        fileError = `移到回收站失败：${err.message}`;
      }
    } else if (policy === 'permanent') {
      try {
        await fsp.rm(row.abs_path, { force: true });
      } catch (err) {
        fileError = `删除文件失败：${err.message}`;
      }
    }
    // unlink：仅移出图库，保留文件
  }

  if (fileError) return { ok: false, error: fileError };
  db.prepare('DELETE FROM images WHERE id = ?').run(id);
  phashIndex.delete(id);
  clip.deleteEmbedding(id);
  invalidateQuality(id);
  return { ok: true };
}

async function moveToAppTrash(row, reason) {
  const base = path.basename(row.abs_path);
  const trashDir = trashDirFor(row.abs_path);
  let target = path.join(trashDir, base);
  if (fs.existsSync(target)) target = path.join(trashDir, `${Date.now().toString(36)}_${base}`);
  await fsp.rename(row.abs_path, target);
  db.prepare(
    `INSERT INTO trash(image_id, title, origin_path, trash_path, source, keyword, width, height,
      size_bytes, mime, phash, tags, favorite, reason, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id,
    row.title,
    row.abs_path,
    target,
    row.source,
    row.keyword,
    row.width,
    row.height,
    row.size_bytes,
    row.mime,
    row.phash,
    row.tags,
    row.favorite,
    reason,
    new Date().toISOString()
  );
}

/* ------------------------------- 应用内回收站 ------------------------------ */

export function listTrash() {
  return db
    .prepare('SELECT * FROM trash ORDER BY id DESC')
    .all()
    .map((r) => ({
      id: r.id,
      imageId: r.image_id,
      title: r.title,
      originPath: r.origin_path,
      trashPath: r.trash_path,
      source: r.source,
      keyword: r.keyword,
      width: r.width,
      height: r.height,
      sizeBytes: r.size_bytes,
      phash: r.phash,
      reason: r.reason,
      deletedAt: r.deleted_at,
    }));
}

export async function restoreFromTrash(id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
  if (!row) throw new Error('回收站记录不存在');
  if (!fs.existsSync(row.trash_path)) throw new Error('回收站里的文件已丢失');
  let target = row.origin_path;
  if (fs.existsSync(target)) {
    target = target.replace(/(\.\w+)$/, `_恢复${Date.now().toString(36)}$1`);
  }
  await fsp.rename(row.trash_path, target);
  const info = db
    .prepare(
      `INSERT INTO images(title, abs_path, thumb, source, keyword, source_url, width, height,
        size_bytes, mime, phash, favorite, tags, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      row.title,
      target,
      null,
      row.source,
      row.keyword,
      '',
      row.width,
      row.height,
      row.size_bytes,
      row.mime,
      row.phash,
      row.favorite,
      row.tags,
      new Date().toISOString()
    );
  const newId = Number(info.lastInsertRowid);
  if (row.phash) phashIndex.set(newId, row.phash);
  const thumb = await ensureThumb(newId, target);
  if (thumb) db.prepare('UPDATE images SET thumb = ? WHERE id = ?').run(thumb, newId);
  db.prepare('DELETE FROM trash WHERE id = ?').run(id);
  return toDTO(getImage(newId));
}

export async function deleteTrashItem(id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
  if (!row) return false;
  await fsp.rm(row.trash_path, { force: true }).catch(() => {});
  db.prepare('DELETE FROM trash WHERE id = ?').run(id);
  return true;
}

export async function emptyTrash() {
  const rows = db.prepare('SELECT * FROM trash').all();
  for (const row of rows) await fsp.rm(row.trash_path, { force: true }).catch(() => {});
  db.prepare('DELETE FROM trash').run();
  return rows.length;
}

/** 重命名磁盘文件并同步标题（壁纸库文件夹管理） */
export async function renameImage(id, title) {
  const row = getImage(id);
  if (!row) throw new Error('图片不存在');
  const clean = String(title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim();
  if (!clean) throw new Error('名称不能为空');
  const ext = path.extname(row.abs_path) || '.jpg';
  const base = clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : clean + ext;
  const target = path.join(path.dirname(row.abs_path), base);
  if (target !== row.abs_path) {
    if (fs.existsSync(target)) throw new Error('该文件夹下已存在同名文件');
    await fsp.rename(row.abs_path, target);
  }
  db.prepare('UPDATE images SET abs_path = ?, title = ? WHERE id = ?').run(target, base, id);
  return toDTO(getImage(id));
}

/** 清空图库：文件移入应用内回收站，仍可恢复 */
export function clearLibrary() {
  const rows = db.prepare('SELECT * FROM images').all();
  const settings = getSettings();
  const insert = db.prepare(
    `INSERT INTO trash(image_id, title, origin_path, trash_path, source, keyword, width, height,
      size_bytes, mime, phash, tags, favorite, reason, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const row of rows) {
    if (row.thumb) fs.rmSync(row.thumb, { force: true });
    if (isManagedPath(row.abs_path, settings) && fs.existsSync(row.abs_path)) {
      const base = path.basename(row.abs_path);
      const trashDir = trashDirFor(row.abs_path);
      let target = path.join(trashDir, base);
      if (fs.existsSync(target)) target = path.join(trashDir, `${Date.now().toString(36)}_${base}`);
      try {
        fs.renameSync(row.abs_path, target);
        insert.run(
          row.id,
          row.title,
          row.abs_path,
          target,
          row.source,
          row.keyword,
          row.width,
          row.height,
          row.size_bytes,
          row.mime,
          row.phash,
          row.tags,
          row.favorite,
          '清空图库',
          new Date().toISOString()
        );
      } catch (err) {
        console.error('[trash] 清空图库时移动失败', row.abs_path, err.message);
      }
    }
  }
  db.prepare('DELETE FROM images').run();
  phashIndex.clear();
  return rows.length;
}
