import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile, isDesktop, openFolder, quiet } from './api';
import { subscribeEvents } from './events';
import type { Filters, ImageItem, Stats } from './types';
import Dashboard from './pages/Dashboard';
import GalleryPage from './pages/Gallery';
import Crawl from './pages/Crawl';
import SettingsPage from './pages/Settings';
import Knowledge from './pages/Knowledge';
import Playlists from './pages/Playlists';
import Tidy from './pages/Tidy';
import EnhancePage from './pages/Enhance';
import Search from './pages/Search';
import Smart from './pages/Smart';
import Lightbox from './components/Lightbox';
import DeleteReasonDialog, { reasonLabel } from './components/DeleteReasonDialog';
import DialogHost, { confirmDialog } from './components/Dialogs';
import {
  IconDashboard,
  IconFolder,
  IconGear,
  IconHeart,
  IconImages,
  IconBrain,
  IconMoon,
  IconSpider,
  IconSun,
  IconLayers,
  IconWand,
  IconSearch,
  IconGrid,
} from './components/Icons';
import { applyTheme, getStoredTheme, type Theme } from './theme';

type View =
  | 'dashboard'
  | 'gallery'
  | 'favorites'
  | 'tidy'
  | 'playlists'
  | 'crawl'
  | 'knowledge'
  | 'search'
  | 'smart'
  | 'enhance'
  | 'settings';

const PAGE_SIZE = 48;

const defaultFilters: Filters = {
  q: '',
  source: [],
  favorite: 'all',
  orientation: 'all',
  bucket: [],
  tag: '',
  sort: 'newest',
  seen: 'all',
  minRating: 0,
  hue: '',
  colorHex: '',
  colorTol: 48,
};

const NAV: { key: View; label: string; icon: React.ReactNode }[] = [
  { key: 'dashboard', label: '仪表盘', icon: <IconDashboard /> },
  { key: 'gallery', label: '图库', icon: <IconImages /> },
  { key: 'favorites', label: '收藏', icon: <IconHeart /> },
  { key: 'tidy', label: '整理', icon: <IconLayers /> },
  { key: 'playlists', label: '清单', icon: <IconFolder /> },
  { key: 'crawl', label: '采集', icon: <IconSpider /> },
  { key: 'knowledge', label: 'AI 知识库', icon: <IconBrain /> },
  { key: 'search', label: '智能检索', icon: <IconSearch /> },
  { key: 'smart', label: '标签·智能夹', icon: <IconGrid /> },
  { key: 'enhance', label: '画质增强', icon: <IconWand /> },
  { key: 'settings', label: '设置', icon: <IconGear /> },
];

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [stats, setStats] = useState<Stats | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<'masonry' | 'grid'>('masonry');
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [lb, setLb] = useState<{ items: ImageItem[]; index: number } | null>(null);
  const [toast, setToast] = useState('');
  const [importing, setImporting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ImageItem | null>(null);
  const [missingCount, setMissingCount] = useState(0);
  // 手动刷新序号：每次刷新自增，作为图片卡片的 key 之一，强制重挂载以清除
  // 「缩略图加载失败」的残留状态（否则卡片复用实例，刷新也无法恢复显示）
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const totalRef = useRef(0);
  // 退出大图后要滚动定位到的图片 id（图库页补载页面后滚动过去）
  const [scrollTargetId, setScrollTargetId] = useState<number | null>(null);
  const [enhanceModel, setEnhanceModel] = useState('');
  const [enhancingId, setEnhancingId] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  // 主题：立即生效 + 持久化到设置（换机器/清缓存后仍保留）
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        if (s.theme === 'light' || s.theme === 'dark') setTheme((cur) => (cur === s.theme ? cur : s.theme));
      })
      .catch(quiet);
    // 仅在启动时同步一次服务端设置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === 'dark' ? 'light' : 'dark';
      api.saveSettings({ theme: next }).catch(quiet);
      return next;
    });
  }, []);

  const pageRef = useRef(1);
  const reqId = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const filtersRef = useRef<Filters>(filters);

  const effectiveFilters = useMemo<Filters>(
    () => (view === 'favorites' ? { ...filters, favorite: 'yes' } : filters),
    [view, filters]
  );
  filtersRef.current = effectiveFilters;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    // 较长的是可操作报错（如「文件被占用，请关闭看图软件」），给足阅读时间
    const duration = msg.length > 40 ? 9000 : 2600;
    window.setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), duration);
  }, []);

  const refreshStats = useCallback(() => {
    api.stats().then(setStats).catch(quiet);
    api.tags().then(setTags).catch(quiet);
    api.missingFiles().then((m) => setMissingCount(m.count)).catch(quiet);
  }, []);

  const load = useCallback(async (page: number, reset: boolean) => {
    const id = ++reqId.current;
    // 切筛选 / 翻页时取消上一个还在路上的列表请求，避免旧结果占用连接与状态
    loadAbort.current?.abort();
    loadAbort.current = new AbortController();
    const signal = loadAbort.current.signal;
    setLoading(true);
    try {
      const res = await api.images(filtersRef.current, page, PAGE_SIZE, { signal });
      if (id !== reqId.current) return;
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setTotal(res.total);
      totalRef.current = res.total;
      setHasMore(res.hasMore);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // 被新请求取代，不算错误
      showToast((err as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [showToast]);

  const queryKey = JSON.stringify(effectiveFilters);

  useEffect(() => {
    pageRef.current = 1;
    load(1, true);
  }, [queryKey, load]);

  const loadMore = useCallback(() => {
    const next = pageRef.current + 1;
    pageRef.current = next;
    load(next, false);
  }, [load]);

  useEffect(() => {
    refreshStats();
    // 服务端写操作会推 library 事件；这里防抖刷新统计。
    // 60s 低频兜底覆盖推送遗漏（如多标签页）场景。
    const timer = setInterval(refreshStats, 60000);
    let pending = 0;
    let off = () => {};
    subscribeEvents('library', () => {
      pending++;
      window.setTimeout(() => {
        if (--pending <= 0) {
          pending = 0;
          refreshStats();
        }
      }, 400);
    }).then((o) => {
      off = o;
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [refreshStats]);

  useEffect(() => {
    // 导入状态改为订阅 job 事件（原 3s 轮询）；导入进行中顺带刷新统计
    let off = () => {};
    subscribeEvents('job', (d) => {
      const imp = d?.import;
      if (!imp) return;
      setImporting(!!imp.running);
      if (imp.running) refreshStats();
    }).then((o) => {
      off = o;
    });
    api.importStatus().then((s) => setImporting(s.running)).catch(quiet);
    return () => {
      off();
    };
  }, [refreshStats]);

  const patchItem = useCallback((updated: ImageItem) => {
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
    setLb((prev) =>
      prev
        ? {
            items: prev.items.map((it) => (it.id === updated.id ? updated : it)),
            index: prev.index,
          }
        : prev
    );
  }, []);

  const toggleFavorite = useCallback(
    async (item: ImageItem) => {
      const updated = await api.patch(item.id, { favorite: !item.favorite });
      patchItem(updated);
      setStats((prev) =>
        prev ? { ...prev, favorite: prev.favorite + (updated.favorite ? 1 : -1) } : prev
      );
    },
    [patchItem]
  );

  const saveTags = useCallback(
    async (item: ImageItem, tagList: string[]) => {
      const updated = await api.patch(item.id, { tags: tagList });
      patchItem(updated);
      api.tags().then(setTags).catch(quiet);
    },
    [patchItem]
  );

  /** 请求删除：弹出「为什么不满意」对话框，让 AI 学习 */
  const requestDelete = useCallback((item: ImageItem) => {
    setPendingDelete(item);
  }, []);

  const confirmDelete = useCallback(
    async (payload: { reasons: string[]; note: string; aiAnalysis: string; learn: boolean }) => {
      const item = pendingDelete;
      if (!item) return;
      setPendingDelete(null);
      try {
        if (!payload.learn) {
          await api.remove(item.id);
          showToast('已删除（未记录反馈）');
        } else {
          await api.deleteWithReason(item.id, payload);
          showToast(
            payload.reasons.length
              ? `已删除并记录：${payload.reasons.map(reasonLabel).join('、')}（可在 AI 知识库一键归纳）`
              : '已删除'
          );
        }
      } catch (err) {
        showToast((err as Error).message);
      }
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      setLb((prev) => {
        if (!prev) return prev;
        const rest = prev.items.filter((it) => it.id !== item.id);
        if (!rest.length) return null;
        return { items: rest, index: Math.min(prev.index, rest.length - 1) };
      });
      refreshStats();
    },
    [pendingDelete, refreshStats, showToast]
  );

  const setWallpaper = useCallback(
    async (item: ImageItem) => {
      try {
        const res = await api.wallpaper(item.id);
        showToast(
          res.generated
            ? `已设为壁纸：按屏幕 ${res.screen.width}×${res.screen.height} 合成，竖版完整居中不裁切`
            : '已设为桌面壁纸（原图铺满）'
        );
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  const openItem = useCallback((item: ImageItem, pool?: ImageItem[], full = false) => {
    const list = pool && pool.some((x) => x.id === item.id) ? pool : [item];
    const index = list.findIndex((x) => x.id === item.id);
    setLb({ items: list, index: Math.max(0, index) });
    // 图库打开时，后台把当前筛选的全量列表补进导航池：
    // 平时只加载第一页（48 张），大图浏览若只在这页里导航，数量和范围都会误导
    if (full && pool) {
      (async () => {
        const first = await api.images(filtersRef.current, 1, 120);
        const all = [...first.items];
        for (let p = 2; all.length < first.total && p <= Math.ceil(first.total / 120); p++) {
          const res = await api.images(filtersRef.current, p, 120);
          all.push(...res.items);
        }
        if (all.length <= list.length) return; // 本来就是全量，无需替换
        setLb((prev) => {
          if (!prev) return prev; // 用户已关闭
          const curId = prev.items[prev.index]?.id;
          const nextIndex = Math.max(0, all.findIndex((x) => x.id === curId));
          return { items: all, index: nextIndex };
        });
      })().catch(quiet);
    }
  }, []);

  const download = useCallback((item: ImageItem) => {
    downloadFile(item.downloadUrl);
  }, []);

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const bulk = useCallback(
    async (action: string, tag?: string) => {
      const ids = [...selected];
      if (!ids.length) return;
      if (action === 'delete' && !(await confirmDialog(`确定删除选中的 ${ids.length} 张图片？`))) return;
      await api.batch(ids, action, tag);
      showToast(action === 'delete' ? `已删除 ${ids.length} 张` : `已更新 ${ids.length} 张`);
      setSelected(new Set());
      pageRef.current = 1;
      load(1, true);
      refreshStats();
    },
    [selected, load, refreshStats, showToast]
  );

  const onFiltersChange = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  // 读取默认增强模型（大图预览里的「画质增强」用它，与设置里保持一致）
  useEffect(() => {
    api
      .enhanceStandards()
      .then((s) => setEnhanceModel(s.config?.model || 'sharp-standard'))
      .catch(quiet);
  }, []);

  /** 大图预览中直接增强：按默认模型放大到标准以上并覆盖原文件 */
  const enhanceOne = useCallback(
    async (item: ImageItem) => {
      setEnhancingId(item.id);
      try {
        const { item: updated } = await api.enhanceImage(item.id, enhanceModel || 'sharp-standard');
        patchItem(updated);
        showToast(`已增强至 ${updated.width}×${updated.height}`);
        refreshStats();
      } catch (err) {
        showToast(`增强失败：${(err as Error).message}`);
      } finally {
        setEnhancingId(null);
      }
    },
    [enhanceModel, patchItem, refreshStats, showToast]
  );

  /** 把选中的图片加入清单（传入 '__new__:名称' 时先建清单） */
  const addToPlaylist = useCallback(
    async (playlistId: number | string) => {
      const ids = [...selected];
      if (!ids.length) return;
      try {
        let pid = playlistId;
        if (typeof pid === 'string' && pid.startsWith('__new__:')) {
          const name = pid.slice(8).trim();
          if (!name) return;
          const created = await api.createPlaylist(name);
          const pl = created.playlists.find((p) => p.name === name);
          if (!pl) throw new Error('创建清单失败');
          pid = pl.id;
        }
        const res = await api.addToPlaylist(pid as number, ids);
        showToast(`已加入清单（新增 ${res.added} 张）`);
      } catch (err) {
        showToast((err as Error).message);
      }
      setSelected(new Set());
    },
    [selected, showToast]
  );

  /** 手动刷新：回到第 1 页按当前筛选重新拉取，并更新统计与标签 */
  const refreshGallery = useCallback(async () => {
    pageRef.current = 1;
    setRefreshSeq((n) => n + 1);
    setRefreshing(true);
    try {
      await load(1, true);
      refreshStats();
      showToast(`已刷新（当前筛选 ${totalRef.current} 张）`);
    } finally {
      setRefreshing(false);
    }
  }, [load, refreshStats, showToast]);

  /** 退出大图时：把图库列表补载到最后浏览的那张所在位置，并滚动过去 */
  const revealGalleryItem = useCallback(
    async (id: number, pool: ImageItem[]) => {
      const pos = pool.findIndex((x) => x.id === id);
      if (pos < 0) return;
      // 该图已在已加载列表里（浏览范围没超出第一屏加载量）→ 直接滚动
      if (document.querySelector(`[data-image-id="${id}"]`)) {
        setScrollTargetId(id);
        return;
      }
      const pages = Math.floor(pos / PAGE_SIZE) + 1;
      setLoading(true);
      const req = ++reqId.current;
      try {
        const all: ImageItem[] = [];
        let lastTotal = 0;
        for (let p = 1; p <= pages; p++) {
          const res = await api.images(filtersRef.current, p, PAGE_SIZE);
          if (req !== reqId.current) return; // 期间用户触发了其他加载，放弃
          all.push(...res.items);
          lastTotal = res.total;
          if (all.length >= res.total) break;
        }
        setItems(all);
        setTotal(lastTotal);
        totalRef.current = lastTotal;
        setHasMore(all.length < lastTotal);
        pageRef.current = pages;
        setRefreshSeq((n) => n + 1);
        setScrollTargetId(id);
      } catch (err) {
        showToast((err as Error).message);
      } finally {
        if (req === reqId.current) setLoading(false);
      }
    },
    [showToast]
  );

  // 补载完成后等卡片渲染出来，再滚动居中（节点尚未渲染时重试几帧）
  useEffect(() => {
    if (!scrollTargetId) return;
    let tries = 0;
    const tick = () => {
      const el = document.querySelector(`[data-image-id="${scrollTargetId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        setScrollTargetId(null);
        return;
      }
      if (++tries < 30) requestAnimationFrame(tick);
      else setScrollTargetId(null);
    };
    requestAnimationFrame(tick);
  }, [scrollTargetId]);

  /** 把当前筛选结果整体标记为已看（整理「未看过」时用） */
  const markAllSeen = useCallback(async () => {
    try {
      const res = await api.markAllViewed(effectiveFilters);
      showToast(res.affected ? `已标记 ${res.affected} 张为已看` : '当前筛选下没有图片');
      pageRef.current = 1;
      load(1, true);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [effectiveFilters, load, showToast]);

  /** 文件丢失处理：先尝试按文件名在新路径找回，找不回可清理记录 */
  const relocateMissing = useCallback(async () => {
    try {
      const res = await api.relocateMissing();
      showToast(
        res.relocated
          ? `已找回 ${res.relocated} 张图片的路径${res.remaining ? `，仍有 ${res.remaining} 张未找到` : ''}`
          : `没有找回任何图片（${res.remaining} 张仍未找到，可能已被删除）`
      );
    } catch (err) {
      showToast((err as Error).message);
    }
    refreshGallery();
  }, [refreshGallery, showToast]);

  const purgeMissing = useCallback(async () => {
    if (!(await confirmDialog(`确定清理这 ${missingCount} 条文件缺失的记录吗？图片记录将被移除。`))) return;
    try {
      const res = await api.purgeMissing();
      showToast(`已清理 ${res.removed} 条缺失记录`);
    } catch (err) {
      showToast((err as Error).message);
    }
    refreshGallery();
  }, [missingCount, refreshGallery, showToast]);

  const crawling = !!stats?.crawling || importing;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-mark">图</div>
          <div className="logo-text">
            <b>图库</b>
            <span>图片管理与壁纸工具</span>
          </div>
        </div>
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item${view === n.key ? ' active' : ''}`}
            onClick={() => setView(n.key)}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.key === 'gallery' && stats?.total ? <span className="badge">{stats.total}</span> : null}
            {n.key === 'favorites' && stats?.favorite ? (
              <span className="badge">{stats.favorite}</span>
            ) : null}
          </button>
        ))}
        <div className="sidebar-footer">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
            <span>{theme === 'dark' ? '明亮模式' : '暗色模式'}</span>
          </button>
          多源采集 · pHash 去重
          <br />
          壁纸图库 v1.0
        </div>
      </aside>

      <main className="main">
        <div className="content">
          {view === 'dashboard' && (
            <Dashboard
              stats={stats}
              onOpen={(item, pool) => openItem(item, pool)}
              onNavigate={(v) => setView(v as View)}
            />
          )}

          {(view === 'gallery' || view === 'favorites') && (
            <GalleryPage
              title={view === 'favorites' ? '收藏夹' : '图库'}
              subtitle={
                view === 'favorites'
                  ? '所有已收藏的邓紫棋照片'
                  : '瀑布流浏览 · 悬停操作 · 点击进入大图预览'
              }
              filters={effectiveFilters}
              onFiltersChange={onFiltersChange}
              items={items}
              total={total}
              hasMore={hasMore}
              loading={loading}
              onLoadMore={loadMore}
              selected={selected}
              onToggleSelect={toggleSelect}
              onClearSelection={() => setSelected(new Set())}
              onBulk={bulk}
              onOpen={(item) => openItem(item, items, true)}
              onToggleFavorite={toggleFavorite}
              onDownload={download}
              viewMode={viewMode}
              onViewMode={setViewMode}
              tags={tags}
              hideFavorite={view === 'favorites'}
              onStartCrawl={() => setView('crawl')}
              onRefresh={refreshGallery}
              importing={importing}
              missingCount={missingCount}
              refreshSeq={refreshSeq}
              refreshing={refreshing}
              onRelocateMissing={relocateMissing}
              onPurgeMissing={purgeMissing}
              onAddToPlaylist={addToPlaylist}
              onMarkAllSeen={markAllSeen}
            />
          )}

          {view === 'tidy' && (
            <Tidy
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
              }}
            />
          )}

          {view === 'crawl' && <Crawl onToast={showToast} />}

          {view === 'playlists' && (
            <Playlists onToast={showToast} onOpen={openItem} onSetWallpaper={setWallpaper} />
          )}

          {view === 'knowledge' && (
            <Knowledge
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
              }}
            />
          )}

          {view === 'search' && <Search onToast={showToast} onOpenItem={(item, pool) => openItem(item, pool, true)} />}

          {view === 'smart' && <Smart onToast={showToast} onOpenItem={openItem} />}

          {view === 'enhance' && (
            <EnhancePage
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
              }}
            />
          )}

          {view === 'settings' && (
            <SettingsPage
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
              }}
            />
          )}
        </div>

        <footer className="statusbar">
          <span>
            <i className={`dot${crawling ? ' busy' : ''}`} />
            {crawling ? '采集进行中' : '空闲'}
          </span>
          <span>总图片 {stats?.total ?? 0}</span>
          <span>收藏 {stats?.favorite ?? 0}</span>
          {importing && <span>本地素材导入中…</span>}
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => openFolder()}>
            打开保存文件夹
          </button>
          {!isDesktop && <span>网页模式 http://localhost:3001</span>}
        </footer>
      </main>

      {lb && (
        <Lightbox
          items={lb.items}
          index={lb.index}
          onClose={() => {
            const last = lb.items[lb.index];
            setLb(null);
            // 图库/收藏页打开的大图：退出后把列表定位到最后浏览的那张
            if (last && (view === 'gallery' || view === 'favorites')) revealGalleryItem(last.id, lb.items);
          }}
          onIndex={(index) => setLb((prev) => (prev ? { ...prev, index } : prev))}
          onToggleFavorite={toggleFavorite}
          onSaveTags={saveTags}
          onDelete={requestDelete}
          onSetWallpaper={setWallpaper}
          onEnhance={enhanceOne}
          enhancing={enhancingId === lb.items[lb.index]?.id}
          onViewed={patchItem}
          onDownload={download}
          onPatch={async (target, patch) => {
            try {
              patchItem(await api.patch(target.id, patch));
            } catch (err) {
              showToast((err as Error).message);
            }
          }}
          onOpenSimilar={(pool, id) => setLb({ items: pool, index: Math.max(0, pool.findIndex((x) => x.id === id)) })}
          onChangeToast={(msg) => {
            showToast(msg);
            refreshStats();
            pageRef.current = 1;
            load(1, true);
          }}
          onFindColor={(hue) => {
            onFiltersChange({ hue: String(hue) });
            setLb(null);
            setView('gallery');
          }}
          onReplaceItem={(updated) => {
            setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
            setLb((prev) =>
              prev
                ? {
                    ...prev,
                    items: prev.items.map((it) => (it.id === updated.id ? updated : it)),
                  }
                : prev
            );
          }}
        />
      )}

      {pendingDelete && (
        <DeleteReasonDialog
          item={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          onToast={showToast}
        />
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* 应用内 prompt/confirm 对话框（替代原生弹窗，全局唯一挂载点） */}
      <DialogHost />
    </div>
  );
}
