import React, { useEffect, useRef, useState } from 'react';
import { formatSize } from '../api';
import type { ImageItem } from '../types';

interface Props {
  items: ImageItem[];
  leftId: number;
  rightId: number;
  /** 点「保留这张」：确认后保留该图、其余移入回收站（由父级执行，成功后关闭对比） */
  onKeep: (id: number) => void | Promise<void>;
  onClose: () => void;
}

interface View {
  s: number;
  x: number;
  y: number;
}

const MIN_S = 1;
const MAX_S = 12;
const RESET: View = { s: 1, x: 0, y: 0 };

/**
 * 相似图左右对比：两个半区共用一份缩放/位移状态，
 * 任一半区滚轮缩放、拖动平移，另一侧完全同步——方便对比同一区域的画面细节。
 */
export default function CompareView({ items, leftId, rightId, onKeep, onClose }: Props) {
  const [left, setLeft] = useState(items.find((i) => i.id === leftId) || items[0]);
  const [right, setRight] = useState(items.find((i) => i.id === rightId) || items[items.length - 1]);
  const [keeping, setKeeping] = useState(false);
  // 当前「活动」半区：点缩略图替换到这一侧
  const [active, setActive] = useState<'left' | 'right'>('left');
  const [view, setView] = useState<View>(RESET);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '0') setView(RESET);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const assign = (it: ImageItem) => {
    if (active === 'left') {
      if (it.id === right.id) setRight(left); // 互换
      setLeft(it);
    } else {
      if (it.id === left.id) setLeft(right);
      setRight(it);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const s = Math.min(MAX_S, Math.max(MIN_S, v.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      if (s === v.s) return v;
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    setActive(e.currentTarget.dataset.side === 'right' ? 'right' : 'left');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const pane = (side: 'left' | 'right', it: ImageItem) => (
    <div className="cmp-side" data-side={side} onPointerDown={() => setActive(side)}>
      <div
        className={`cmp-pane${active === side ? ' active' : ''}`}
        data-side={side}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="cmp-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          <img src={it.url} alt={it.title} draggable={false} />
        </div>
        {view.s > 1 && <span className="cmp-zoom">{view.s.toFixed(1)}×</span>}
      </div>
      <div className="cmp-meta">
        <div className="cmp-info">
          <b title={it.title}>{it.title}</b>
          <span>
            {it.width}×{it.height} · {formatSize(it.sizeBytes)} · {it.source}
            {it.rating > 0 ? ` · ${'★'.repeat(it.rating)}` : ''}
          </span>
        </div>
        <button
          className="btn sm primary"
          disabled={keeping}
          onClick={() => {
            setKeeping(true);
            Promise.resolve(onKeep(it.id)).finally(() => setKeeping(false));
          }}
        >
          保留这张
        </button>
      </div>
    </div>
  );

  return (
    <div className="cmp-overlay">
      <div className="cmp-head">
        <b>左右对比</b>
        <div className="cmp-thumbs">
          {items.map((it) => (
            <button
              key={it.id}
              className={`cmp-thumb${it.id === left.id || it.id === right.id ? ' used' : ''}`}
              title={`替换到${active === 'left' ? '左' : '右'}侧`}
              onClick={() => assign(it)}
            >
              <img src={it.thumbUrl} alt="" draggable={false} />
            </button>
          ))}
        </div>
        <span className="cmp-hint">滚轮缩放 / 按住拖动两侧同步 · 点缩略图换到活动半区（点画面选择活动侧）</span>
        <div className="cmp-actions">
          <button className="btn sm" onClick={() => setView(RESET)} title="恢复 1:1（快捷键 0）">
            重置视图
          </button>
          <button className="btn sm danger" onClick={onClose} title="退出对比（快捷键 Esc）">
            ✕ 退出对比 (Esc)
          </button>
        </div>
      </div>
      <div className="cmp-body">
        {pane('left', left)}
        {pane('right', right)}
      </div>
    </div>
  );
}
