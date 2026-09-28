/**
 * 模型文件下载：流式落盘 + 真实进度 + sha256 完整性校验 + 原子替换。
 * - 先写 <dest>.part，全部校验通过后再 rename：网络断 / 进程中断不会留下半截「完整」模型
 * - sha256 校验两层：KNOWN_SHA256 显式清单；首次成功下载自动写入 <dest>.sha256，
 *   之后重装 / 换源都会对齐这份记录，防镜像投毒或传输损坏
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpFetch } from './http.js';

/** 已知模型的强校验哈希（hex）。留空 = 仅做大小 + 历史记录（sidecar）校验。 */
export const KNOWN_SHA256 = {
  // 'sunseeker001/U-2-Net-Human-Seg/onnx/model.onnx': '<sha256 hex>',
};

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function readSidecar(dest) {
  try {
    const hex = (await fsp.readFile(`${dest}.sha256`, 'utf8')).trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : '';
  } catch {
    return '';
  }
}

/**
 * 下载单个模型文件。
 * @param {object} opts
 * @param {string[]} opts.mirrors   完整 URL 前缀列表（含 repo 路径，逐个尝试）
 * @param {string}   opts.repoPath  镜像内相对路径（拼在 mirror 后）
 * @param {string}   opts.dest      目标文件
 * @param {number}  [opts.minBytes] 最小合法体积（默认 16）
 * @param {number}  [opts.maxBytes] 最大合法体积（0 = 不限，防超大响应写爆磁盘）
 * @param {string}  [opts.sha256]   期望哈希（空则回退 sidecar 记录）
 * @param {(p:number, done:number, total:number)=>void} [opts.onProgress] 0~1
 */
export async function downloadModelFile({ mirrors, repoPath, dest, minBytes = 16, maxBytes = 0, sha256 = '', onProgress }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastErr = null;

  for (const base of mirrors) {
    try {
      const res = await httpFetch(`${base}${repoPath}`, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (maxBytes && total > maxBytes) throw new Error('文件超出预期大小');

      let done = 0;
      const hash = crypto.createHash('sha256');
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (source) {
          for await (const chunk of source) {
            done += chunk.length;
            if (maxBytes && done > maxBytes) throw new Error('文件超出预期大小');
            hash.update(chunk);
            onProgress?.(total ? Math.min(1, done / total) : 0, done, total);
            yield chunk;
          }
        },
        fs.createWriteStream(part)
      );

      const size = fs.statSync(part).size;
      if (size < minBytes) throw new Error(`文件不完整（仅 ${size} 字节）`);

      const digest = hash.digest('hex');
      const expect = sha256 || (await readSidecar(dest));
      if (expect && digest !== expect) throw new Error('sha256 校验失败：文件损坏或来源异常');

      await fsp.rename(part, dest);
      await fsp.writeFile(`${dest}.sha256`, `${digest}\n`, 'utf8').catch(() => {});
      return { size, sha256: digest };
    } catch (err) {
      lastErr = err;
      await fsp.rm(part, { force: true }).catch(() => {});
    }
  }
  throw new Error(`模型下载失败：${lastErr?.message || '镜像与官方源都不可达'}`);
}

/** 供既有模块核对已存在文件是否可信（体积 + sidecar/清单哈希） */
export async function verifyModelFile(dest, { minBytes = 16, sha256 = '' } = {}) {
  try {
    const st = await fsp.stat(dest);
    if (st.size < minBytes) return false;
    const expect = sha256 || (await readSidecar(dest));
    if (!expect) return true; // 无参照：只做体积校验
    return (await sha256File(dest)) === expect;
  } catch {
    return false;
  }
}
