import React, { useEffect, useRef, useState } from 'react';
import { api, downloadFile, quiet } from '../api';
import type { Filters, ImageItem, Playlist } from '../types';
import FilterBar from '../components/FilterBar';
import ImageCard from '../components/ImageCard';
import { promptDialog } from '../components/Dialogs';
import MasonryGrid from '../components/MasonryGrid';
import { IconDownload, IconFolder, IconHeart, IconRefresh, IconTrash } from '../components/Icons';

interface Props {
  title: string;
  subtitle: string;
  filters: Filters;
  onFiltersChange: (patch: Partial<Filters>) => void;
  items: ImageItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  selected: Set<number>;
  onToggleSelect: (id: number) => void;
  onClearSelection: () => void;
  onBulk: (action: string, tag?: string) => void;
  onOpen: (item: ImageItem) => void;
  onToggleFavorite: (item: ImageItem) => void;
  onDownload: (item: ImageItem) => void;
  viewMode: 'masonry' | 'grid';
  onViewMode: (mode: 'masonry' | 'grid') => void;
  tags: { tag: string; count: number }[];
  hideFavorite?: boolean;
  onStartCrawl: () => void;
  onRefresh: () => void;
  onToast?: (msg: string) => void;
  importing?: boolean;
  missingCount?: number;
  /** 手动刷新序号：变化时清除图片卡片加载失败的残留状态（不再重挂载整页卡片） */
  refreshSeq?: number;
  /** 刷新进行中：按钮转圈并禁用 */
  refreshing?: boolean;
  onRelocateMissing?: () => void;
  onPurgeMissing?: () => void;
  onAddToPlaylist?: (playlistId: number | string) => void;
  /** 把当前筛选结果整体标记为已看 */
  onMarkAllSeen?: () => void;
}

export default function Gallery(props: Props) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const [missingDismissed, setMissingDismissed] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [showPlaylistPick, setShowPlaylistPick] = useState(false);
  const {
    items,
    hasMore,
    loading,
    onLoadMore,
    selected,
    onClearSelection,
    onBulk,
    viewMode,
    tags,
    total,
  } = props;

  // 多选操作栏出现时拉取清单列表，供「加入清单」选择
  useEffect(() => {
    if (selected.size > 0) api.playlists().then(setPlaylists).catch(quiet);
  }, [selected.size]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) onLoadMore();
      },
      { rootMargin: '600px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onLoadMore]);

  const downloadZip = () => {
    const ids = [...selected].join(',');
    if (ids) downloadFile(`/api/download/zip?ids=${ids}`);
  };

  return (
    <div>
      <div className="sticky-head">
        <div className="page-head">
        <div>
          <h1 className="page-title">{props.title}</h1>
          <div className="page-sub">{props.subtitle}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            onClick={props.onRefresh}
            disabled={props.refreshing}
            title="重新加载当前筛选下的图片"
          >
            <span className={props.refreshing ? 'spinning' : ''}>
              <IconRefresh />
            </span>{' '}
            刷新
          </button>
          <button
            className="btn"
            onClick={() => props.onPurgeMissing?.()}
            disabled={!props.missingCount}
            title="把文件已丢失的图片记录从数据库中移除"
          >
            <IconTrash /> 清理缺失{props.missingCount ? `（${props.missingCount}）` : ''}
          </button>
          <button className="btn" onClick={props.onStartCrawl}>
            去采集
          </button>
          <button
            className="btn primary"
            onClick={() => {
              props.onFiltersChange({
                favorite: 'all',
                q: '',
                source: [],
                bucket: [],
                tag: '',
                seen: 'all',
                orientation: 'all',
                minRating: 0,
                hue: '',
                colorHex: '',
                colorTol: 48,
              });
            }}
          >
            重置筛选
          </button>
        </div>
      </div>

      {!!props.missingCount && !missingDismissed && (
        <div className="missing-banner">
          <div className="missing-banner-text">
            <b>⚠ {props.missingCount} 张图片的文件在磁盘上找不到了</b>
            <p>
              如果你只是移动或更换了保存文件夹，点「尝试重新定位」可按文件名自动找回；
              确认文件已彻底删除的话，可清理这些记录，避免白白占位。
            </p>
          </div>
          <div className="missing-banner-actions">
            <button className="btn sm primary" onClick={props.onRelocateMissing}>
              尝试重新定位
            </button>
            <button className="btn sm danger" onClick={props.onPurgeMissing}>
              清理这些记录
            </button>
            <button className="btn sm ghost" onClick={() => setMissingDismissed(true)}>
              忽略
            </button>
          </div>
        </div>
      )}

        <FilterBar
          filters={props.filters}
          onChange={props.onFiltersChange}
          tags={tags}
          viewMode={viewMode}
          onViewMode={props.onViewMode}
          total={total}
          hideFavorite={props.hideFavorite}
          onMarkAllSeen={props.onMarkAllSeen}
        />
      </div>

      {!items.length && !loading && (
        <div className="empty">
          <div className="big">🖼️</div>
          <h3>{props.importing ? '正在导入本地素材…' : '还没有符合条件的图片'}</h3>
          <p>
            前往「采集」页面，选择关键词与来源开始自动采集全网邓紫棋高清图，
            <br />
            采集结果会自动去重并按分辨率筛选后进入图库。
          </p>
          <button className="btn primary" onClick={props.onStartCrawl}>
            立即开始采集
          </button>
        </div>
      )}

      {/* 绝对定位瀑布流 + 虚拟滚动：大图库只渲染视口附近卡片，滚动不整列重排 */}
      <MasonryGrid
        items={items}
        mode={viewMode === 'grid' ? 'grid' : 'masonry'}
        renderItem={(item) => (
          <ImageCard
            item={item}
            selected={selected.has(item.id)}
            onOpen={props.onOpen}
            onToggleSelect={props.onToggleSelect}
            onToggleFavorite={props.onToggleFavorite}
            onDownload={props.onDownload}
            resetKey={props.refreshSeq}
          />
        )}
      />

      <div className="load-more" ref={sentinel}>
        {loading ? (
          <span className="spinner" />
        ) : hasMore ? (
          <button className="btn sm" onClick={onLoadMore}>
            加载更多
          </button>
        ) : items.length ? (
          '已经到底啦'
        ) : null}
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <b>已选中 {selected.size} 张</b>
          <button className="btn sm" onClick={downloadZip}>
            <IconDownload /> 打包下载 ZIP
          </button>
          <button className="btn sm" onClick={() => onBulk('favorite')}>
            <IconHeart filled /> 收藏
          </button>
          <button className="btn sm" onClick={() => onBulk('unfavorite')}>
            取消收藏
          </button>
          {props.onAddToPlaylist && (
            <button className="btn sm" onClick={() => setShowPlaylistPick((v) => !v)}>
              <IconFolder /> 加入清单
            </button>
          )}
          {props.onAddToPlaylist && showPlaylistPick && (
            <select
              className="input"
              style={{ width: 170, padding: '5px 9px', fontSize: 12.5 }}
              autoFocus
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                void (async () => {
                  const name = v === '__new__' ? await promptDialog('新清单名称') : '';
                  props.onAddToPlaylist!(v === '__new__' ? `__new__:${name || ''}` : Number(v));
                  setShowPlaylistPick(false);
                })();
              }}
            >
              <option value="">选择清单…</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.count ?? 0}）
                </option>
              ))}
              <option value="__new__">＋ 新建清单…</option>
            </select>
          )}
          <button className="btn sm danger" onClick={() => onBulk('delete')}>
            <IconTrash /> 删除
          </button>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn sm ghost" onClick={onClearSelection}>
              取消选择
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
