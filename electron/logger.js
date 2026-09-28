/**
 * 日志落盘：console.* 全量重定向到 userData/logs/app-YYYY-MM-DD.log。
 * 打包后窗口看不见，崩溃与异常只有这里能留下线索；单文件超 5MB 轮转为 .old。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_SIZE = 5 * 1024 * 1024;
let logDir = '';
let inited = false;

function currentFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(logDir, `app-${day}.log`);
}

function append(line) {
  try {
    const file = currentFile();
    fs.appendFileSync(file, line);
    if (fs.statSync(file).size > MAX_LOG_SIZE) {
      fs.renameSync(file, `${file}.old`);
    }
  } catch {
    /* 磁盘满等场景下不能让日志拖垮应用 */
  }
}

function fmt(level, args) {
  const body = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || String(a);
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  return `[${new Date().toISOString()}] [${level}] ${body}\n`;
}

export function initLogger(userDataDir) {
  if (inited) return;
  inited = true;
  logDir = path.join(userDataDir, 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    /* 拿不到可写目录就只在控制台输出 */
  }
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      if (logDir) append(fmt(level, args));
    };
  }
}

export function getLogDir() {
  return logDir;
}
