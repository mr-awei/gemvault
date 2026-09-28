/**
 * 服务端推送订阅（SSE）。
 * 后端在 /api/events 上推送：
 *  - job：任务状态快照 { crawl, import, enhance, clip, sr, aiUp, matting }（变化才推）
 *  - library：发生写操作（图片/设置/清单/回收站等变更）
 *  - live：动态壁纸配置变更
 * 全部页面共用一条连接（引用计数），组件卸载时退订即可。
 */
import { getApiToken } from './api';

type Handler = (data: any) => void;

const handlersByType = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let connecting: Promise<void> | null = null;

function attach(type: string) {
  if (!source) return;
  source.addEventListener(type, (e) => {
    let data: any = {};
    try {
      data = JSON.parse((e as MessageEvent).data);
    } catch {
      /* 心跳等非 JSON 帧 */
    }
    handlersByType.get(type)?.forEach((fn) => {
      try {
        fn(data);
      } catch {
        /* 单个订阅者异常不拖垮其他 */
      }
    });
  });
}

async function ensure(): Promise<void> {
  if (source) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const token = await getApiToken();
    const es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    // 断线兜底：EventSource 默认自动重连；若连接被永久关闭则 10s 后重建
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        source = null;
        setTimeout(() => {
          if (handlersByType.size) void ensure();
        }, 10000);
      }
    };
    for (const type of handlersByType.keys()) attach(type);
    source = es;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** 订阅某类事件；返回退订函数 */
export async function subscribeEvents(type: 'job' | 'library' | 'live' | 'hello', fn: Handler): Promise<() => void> {
  let set = handlersByType.get(type);
  if (!set) {
    set = new Set();
    handlersByType.set(type, set);
  }
  set.add(fn);
  try {
    await ensure();
  } catch {
    /* 建连失败不抛给组件，静默退化为无推送（页面仍有初次加载与手动刷新） */
  }
  return () => {
    set?.delete(fn);
    if (set && !set.size) handlersByType.delete(type);
  };
}
