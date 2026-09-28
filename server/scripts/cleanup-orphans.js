import fs from 'node:fs';
import path from 'node:path';
import { getSettings, STORAGE_DIR } from '../db.js';
import { db } from '../db.js';

/** 把壁纸库文件夹里"下载过但未入库"的孤儿文件移到同目录的回收站子目录（同盘，避免跨盘 rename 失败） */
const storageDir = getSettings().storageDir || STORAGE_DIR;
const known = new Set(db.prepare('SELECT abs_path FROM images').all().map((r) => r.abs_path));
const trashDir = path.join(storageDir, 'trash');
fs.mkdirSync(trashDir, { recursive: true });

// 应用下载的文件名形如 <关键词>_<来源>_<宽x高>_<YYYYMMDD-HHMMSS>.ext
const files = fs
  .readdirSync(storageDir)
  .filter((f) => /_.+_\d{8}-\d{6}\./.test(f))
  .map((f) => path.join(storageDir, f))
  .filter((f) => !known.has(f));

for (const f of files) {
  try {
    const dest = path.join(trashDir, path.basename(f));
    fs.renameSync(f, fs.existsSync(dest) ? path.join(trashDir, `${Date.now().toString(36)}_${path.basename(f)}`) : dest);
    console.log('已移入回收站目录:', path.basename(f));
  } catch (err) {
    console.log('跳过:', path.basename(f), err.message);
  }
}
console.log('共处理', files.length, '个孤儿文件');
