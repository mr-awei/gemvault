import React, { useEffect, useRef, useState } from 'react';
import type { ImageItem } from '../types';
import { BASE, SOURCE_LABELS, api } from '../api';
import { IconDownload, IconExpand, IconHeart } from './Icons';

interface Props {
  item: ImageItem;
  selected: boolean;
  /** 可选的附加标注（如以图搜图的「几乎相同 / 高度相似」） */
  note?: string;
  onOpen: (item: ImageItem) => void;
  onToggleSelect: (id: number) => void;
  onToggleFavorite: (item: ImageItem) => void;
  onDownload: (item: ImageItem) => void;
  /** 右键菜单 / 拖拽等操作的提示（可选；未传则静默） */
  onToast?: (msg: string) => void;
  /** 手动刷新序号：变化时只对「失败过」的卡片清态重试（URL 加参数绕过缓存），
   * 正常卡片不受影响——取代旧的「整网格重挂载」方案，刷新不再闪屏 */
  resetKey?: number;
}

const ImageCard = React.memo(function ImageCard({
  item,
  selected,
  note,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  onDownload,
  onToast,
  resetKey,
}: Props) {
  const [broken, setBroken] = useState(false);
  // 加载失败先重试一次（采集高峰期缩略图请求可能瞬时失败），重试仍失败才判定缺失
  const [retrying, setRetrying] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 是否失败过 + 重载令牌：手动刷新时据此重试，正常卡片 URL 保持不变（不触发重新请求）
  const failedEverRef = useRef(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (resetKey == null || !failedEverRef.current) return;
    failedEverRef.current = false;
    setBroken(false);
    setRetrying(false);
    setReloadToken(resetKey);
  }, [resetKey]);

  const fullUrl = BASE + (item.downloadUrl || item.url);

  const params: string[] = [];
  if (reloadToken) params.push(`gemr=${reloadToken}`);
  if (retrying) params.push('retry=1');
  const thumbSrc = params.length
    ? `${item.thumbUrl}${item.thumbUrl.includes('?') ? '&' : '?'}${params.join('&')}`
    : item.thumbUrl;

  /* 右键菜单：点击任意处 / Esc / 窗口尺寸变化时关闭 */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  /* 键盘操作：Enter 打开 · Space 勾选 · F 收藏 · D 下载 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(item);
    } else if (e.key === ' ') {
      e.preventDefault();
      onToggleSelect(item.id);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      onToggleFavorite(item);
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      onDownload(item);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      onToast?.('图片链接已复制');
    } catch {
      onToast?.('复制失败：浏览器拒绝了剪贴板访问');
    }
  };

  const setWall = async () => {
    try {
      await api.wallpaper(item.id);
      onToast?.('已设为壁纸');
    } catch (err) {
      onToast?.((err as Error).message);
    }
  };

  return (
    <div
      className={`card-img${selected ? ' selected' : ''}`}
      data-image-id={item.id}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        // 让菜单尽量留在视口内
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - 172),
          y: Math.min(e.clientY, window.innerHeight - 208),
        });
      }}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="button"
      aria-label={item.title}
      aria-pressed={selected}
      draggable
      onDragStart={(e) => {
        // 原生拖拽：可拖入浏览器其他标签页 / 支持图片直链的目标；
        // 应用内目标可读自定义类型拿到图片 id
        e.dataTransfer.setData('text/uri-list', fullUrl);
        e.dataTransfer.setData('text/plain', fullUrl);
        e.dataTransfer.setData('application/x-gem-image-id', String(item.id));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={item.title}
    >
      {broken ? (
        <div className="card-broken" title={`${item.title}（缩略图加载失败，可点「刷新」重试；文件确实丢失时到设置 → 数据维护清理）`}>
          <span>⚠</span>
          文件缺失
          <small>
            {item.width}×{item.height}
          </small>
        </div>
      ) : (
        <img
          src={thumbSrc}
          alt={item.title}
          loading="lazy"
          decoding="async"
          onError={() => {
            failedEverRef.current = true;
            if (retrying) setBroken(true);
            else setRetrying(true);
          }}
        />
      )}
      {!item.viewed && <span className="unseen-dot" title="还没在大图预览里看过" />}
      <div
        className={`check-box${selected ? ' on' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(item.id);
        }}
      >
        {selected ? '✓' : ''}
      </div>
      <div className="card-overlay">
        <div className="card-meta" style={{ alignSelf: 'flex-end' }}>
          {note && <span className="tag-pill">{note}</span>}
          {item.matchHex && (
            <span
              className="tag-pill"
              title={`命中色 ${item.matchHex}${typeof item.dist === 'number' ? ` · OKLab 距离 ${item.dist}` : ''}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 3,
                  background: item.matchHex,
                  boxShadow: '0 0 0 1px rgba(255,255,255,.35)',
                }}
              />
              同色
            </span>
          )}
          <span className="tag-pill">{SOURCE_LABELS[item.source] || item.source}</span>
          <span className="tag-pill">
            {item.width}×{item.height}
          </span>
          {item.enhanced && (
            <span className="tag-pill enhanced" title={`已放大 ${item.enhanceScale} 倍（原 ${item.originalWidth}×${item.originalHeight}）`}>
              ✨{item.enhanceScale}×
            </span>
          )}
          {item.score < 60 && (
            <span className="tag-pill score-warn" title={item.scoreReason}>
              ⚠ {item.score}
            </span>
          )}
        </div>
        <div className="card-actions">
          <button
            className={`icon-btn${item.favorite ? ' on' : ''}`}
            title={item.favorite ? '取消收藏' : '收藏'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(item);
            }}
          >
            <IconHeart filled={item.favorite} />
          </button>
          <button
            className="icon-btn"
            title="下载"
            onClick={(e) => {
              e.stopPropagation();
              onDownload(item);
            }}
          >
            <IconDownload />
          </button>
          <button
            className="icon-btn"
            title="大图预览"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(item);
            }}
          >
            <IconExpand />
          </button>
        </div>
      </div>
      {menu && (
        <div className="card-ctx" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setMenu(null); onOpen(item); }}>
            <IconExpand /> 大图预览
          </button>
          <button onClick={() => { setMenu(null); onToggleFavorite(item); }}>
            <IconHeart filled={item.favorite} /> {item.favorite ? '取消收藏' : '收藏'}
          </button>
          <button onClick={() => { setMenu(null); onDownload(item); }}>
            <IconDownload /> 下载
          </button>
          <button onClick={() => { setMenu(null); copyLink(); }}>🔗 复制图片链接</button>
          <button onClick={() => { setMenu(null); setWall(); }}>🖥 设为壁纸</button>
        </div>
      )}
    </div>
  );
});

export default ImageCard;
