import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile } from '../api';
import type { ImageItem } from '../types';
import ImageCard from '../components/ImageCard';
import ColorPad from '../components/ColorPad';
import MasonryGrid from '../components/MasonryGrid';

type Mode = 'color' | 'ai' | 'image';

interface Props {
  onToast: (msg: string) => void;
  /** 打开大图预览（App 级 Lightbox，可在结果间左右导航） */
  onOpenItem?: (item: ImageItem, pool?: ImageItem[]) => void;
}

export default function Search({ onToast, onOpenItem }: Props) {
  const [mode, setMode] = useState<Mode>('ai');
  const [hex, setHex] = useState('#ff4d6d');
  const [tol, setTol] = useState(48);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [queryPreview, setQueryPreview] = useState(''); // 以图搜图的查询图预览

  const runSearch = useCallback(
    async (fn: () => Promise<void>) => {
      setLoading(true);
      try {
        await fn();
      } catch (err) {
        onToast((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [onToast]
  );

  /* ---- 颜色搜索：Eagle 式「停下即搜」 ----
   * 色盘拖动高频更新 hex/tol，这里 150ms 静止后才真正请求；
   * 用递增序号丢弃过期响应，快速拖动也不会出现旧结果盖新结果。 */
  const colorSeq = useRef(0);
  useEffect(() => {
    if (mode !== 'color') return;
    const my = ++colorSeq.current;
    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        const r = await api.searchColor(hex, tol, 120);
        if (colorSeq.current !== my) return; // 已有更新的搜索，丢弃过期响应
        setItems(r.items);
        setTotal(r.total);
      } catch (err) {
        if (colorSeq.current === my) onToast((err as Error).message);
      } finally {
        if (colorSeq.current === my) setLoading(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [hex, tol, mode, onToast]);

  const byAi = () =>
    runSearch(async () => {
      if (!query.trim()) return onToast('请输入想找的图，例如「邓紫棋演唱会」「有山的写真」');
      const r = await api.aiSearch(query.trim(), 60);
      setItems(r.items);
      setTotal(r.total);
      if (!r.items.length) onToast('没有匹配结果（可换种说法，或先在「整理」里 AI 打标）');
    });

  const byImage = (file: File) =>
    runSearch(async () => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error('读取图片失败'));
        fr.readAsDataURL(file);
      });
      setQueryPreview(dataUrl);
      const r = await api.searchByImage(dataUrl, 10, 24);
      setItems(r.items);
      setTotal(r.total);
      if (!r.items.length) onToast('没有找到足够相似的图（可检查图片是否模糊/裁剪过度）');
    });

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) byImage(f);
    e.target.value = '';
  };

  const toggleFavorite = async (item: ImageItem) => {
    const updated = await api.patch(item.id, { favorite: !item.favorite });
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
  };

  /** 汉明距离越小越像：64bit pHash，≤2 几乎同一张，≤6 高度相似，其余为构图相近 */
  const simLabel = (d?: number) => {
    if (typeof d !== 'number') return '';
    if (d <= 2) return '几乎相同';
    if (d <= 6) return '高度相似';
    return '构图相近';
  };

  const grid = useMemo(
    () => (it: ImageItem) => (
      <ImageCard
        item={it}
        note={simLabel((it as ImageItem & { hamming?: number }).hamming)}
        selected={false}
        onOpen={(i) => onOpenItem?.(i, items)}
        onToggleSelect={() => {}}
        onToggleFavorite={toggleFavorite}
        onDownload={(it) => downloadFile(it.downloadUrl || it.url)}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items]
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>智能检索</h2>
        <p className="page-sub">颜色搜图 · AI 语义搜索 · 以图搜图（视觉搜索）</p>
      </div>

      <div className="seg">
        <button className={mode === 'ai' ? 'on' : ''} onClick={() => setMode('ai')}>
          AI 语义
        </button>
        <button className={mode === 'color' ? 'on' : ''} onClick={() => setMode('color')}>
          颜色
        </button>
        <button className={mode === 'image' ? 'on' : ''} onClick={() => setMode('image')}>
          以图搜图
        </button>
      </div>

      <div className="search-bar">
        {mode === 'ai' && (
          <>
            <input
              className="inp"
              placeholder='自然语言，如「邓紫棋演唱会舞台」「有山景的红色礼服写真」'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && byAi()}
            />
            <button className="btn primary" onClick={byAi} disabled={loading}>
              {loading ? '搜索中…' : '搜索'}
            </button>
          </>
        )}

        {mode === 'color' && (
          <div className="color-live">
            <ColorPad value={hex} onChange={setHex} />
            <div className="color-side">
              <div className="color-hex-lg">
                <span className="color-chip" style={{ background: hex }} />
                <span className="color-hex">{hex.toUpperCase()}</span>
              </div>
              <label className="tol">
                准确度
                <input
                  type="range"
                  min={0}
                  max={160}
                  value={160 - tol}
                  onChange={(e) => setTol(160 - Number(e.target.value))}
                />
                <b>{160 - tol}</b>
              </label>
              <span className="hint">拖到想要的颜色，鼠标停下结果立即出现</span>
            </div>
          </div>
        )}

        {mode === 'image' && (
          <>
            <label className="btn primary file">
              选择图片
              <input type="file" accept="image/*" onChange={onFile} hidden />
            </label>
            {queryPreview && (
              <img
                src={queryPreview}
                alt="查询图"
                style={{
                  height: 64,
                  maxWidth: 160,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              />
            )}
            {queryPreview && (
              <button className="btn ghost sm" onClick={() => { setQueryPreview(''); setItems([]); setTotal(0); }}>
                清除
              </button>
            )}
          </>
        )}
      </div>

      <div className="result-meta">
        {total > 0 ? `命中 ${total} 张` : loading ? '加载中…' : '暂无结果'}
      </div>

      <MasonryGrid items={items} renderItem={grid} />
    </div>
  );
}
