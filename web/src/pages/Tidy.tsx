import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatSize, quiet } from '../api';
import type { ImageItem, SimilarGroup } from '../types';
import { IconRefresh, IconTrash, IconWand } from '../components/Icons';
import DuelView from '../components/DuelView';

interface Props {
  onToast: (msg: string) => void;
  onLibraryChanged: () => void;
}

/** 整理页：相似图审查合并 + 补算主色 + AI 自动打标 */
export default function Tidy({ onToast, onLibraryChanged }: Props) {
  const [threshold, setThreshold] = useState(10);
  const [groups, setGroups] = useState<SimilarGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<Record<string, number>>({}); // 每组选中的保留项
  const [skipped, setSkipped] = useState<Set<number>>(new Set()); // 已「不处理」的组（按 recommendId 持久化）
  const [busy, setBusy] = useState('');
  const [duel, setDuel] = useState<SimilarGroup | null>(null);

  /** 两两对决淘汰一张：立刻移入回收站；同步把该图从当前组数据里移除 */
  const eliminateOne = useCallback(
    async (keepId: number, loseId: number): Promise<boolean> => {
      try {
        const res = await api.resolveSimilar(keepId, [loseId]);
        if (!res.removed) {
          onToast(res.failures?.[0]?.error || '移入回收站失败');
          return false;
        }
        setGroups((prev) =>
          prev.map((g) => (g.key === duel?.key ? { ...g, items: g.items.filter((it) => it.id !== loseId) } : g))
        );
        onLibraryChanged();
        return true;
      } catch (err) {
        onToast((err as Error).message);
        return false;
      }
    },
    [duel, onToast, onLibraryChanged]
  );
  const [mode, setMode] = useState<'phash' | 'format' | 'clip'>('phash'); // 当前列表来源：pHash 相似 / 同名格式 / CLIP 深度
  const [stats, setStats] = useState<{ total: number; noDominant: number; noAiDesc: number; rated: number } | null>(
    null
  );
  const [jobProgress, setJobProgress] = useState('');

  const loadStats = useCallback(() => {
    api.tidyStats().then(setStats).catch(quiet);
  }, []);

  const loadSkips = useCallback(() => {
    api.tidySkipList().then((r) => setSkipped(new Set(r.ids))).catch(quiet);
  }, []);

  const scan = useCallback(
    async (th = threshold) => {
      setScanning(true);
      try {
        const res = await api.similar(th);
        setMode('phash');
        setGroups(res.groups);
        const next: Record<string, number> = {};
        for (const g of res.groups) next[g.key] = g.recommendId;
        setPicked(next);
        onToast(res.count ? `发现 ${res.count} 组相似图片` : '没有发现相似图片');
      } catch (err) {
        onToast((err as Error).message);
      } finally {
        setScanning(false);
      }
    },
    [threshold, onToast]
  );

  // 同名跨格式去重：同目录同名（如 5.jpg 与 5.png）视为同一张，推荐保留 PNG
  const scanFormat = useCallback(async () => {
    setScanning(true);
    try {
      // 先登记磁盘上新增/手动拷入的文件，否则只有 png 在库里、jpg 配不成对
      const scanned = await api.scanFolder();
      const res = await api.formatDupes();
      setMode('format');
      setGroups(res.groups);
      const next: Record<string, number> = {};
      for (const g of res.groups) next[g.key] = g.recommendId;
      setPicked(next);
      const extra = scanned.saved ? `（本次新登记 ${scanned.saved} 张）` : '';
      onToast(res.count ? `发现 ${res.count} 组同名格式重复（推荐保留 PNG）${extra}` : `没有同名 JPG/PNG 重复${extra}`);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setScanning(false);
    }
  }, [onToast]);

  // CLIP 深度特征相似：余弦 ≥ 0.92 视为同类，能抓住 pHash 漏掉的裁剪/旋转/滤镜变体
  const scanClip = useCallback(async () => {
    setScanning(true);
    try {
      const res = await api.similarClip(0.92);
      setMode('clip');
      setGroups(res.groups);
      const next: Record<string, number> = {};
      for (const g of res.groups) next[g.key] = g.recommendId;
      setPicked(next);
      if (!res.count) return onToast('没有发现深度相似的图片');
      const exact = res.groups.filter((g) => g.tier === 'exact').length;
      onToast(
        `发现 ${res.count} 组：${exact} 组完全重复（可一键清理），${res.count - exact} 组系列照（只折叠，不自动删）`
      );
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setScanning(false);
    }
  }, [onToast]);

  // 已被「不处理」的组不显示（刷新/重扫后依旧隐藏，因为 recommendId 已持久化）
  const visibleGroups = useMemo(
    () => groups.filter((g) => !skipped.has(g.recommendId)),
    [groups, skipped]
  );

  useEffect(() => {
    loadStats();
    loadSkips();
    scan(10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 保留指定项（keepOverride 缺省用当前选中），其余移入回收站；返回是否成功执行 */
  const resolve = async (g: SimilarGroup, keepOverride?: number): Promise<boolean> => {
    const keep = keepOverride ?? (picked[g.key] || g.recommendId);
    const removeIds = g.items.filter((it) => it.id !== keep).map((it) => it.id);
    if (!removeIds.length) {
      onToast('这组只有一张图，无需处理');
      return true;
    }
    if (!window.confirm(`保留 1 张，把另外 ${removeIds.length} 张移入应用内回收站？（可在「设置 → 数据与维护」恢复）`)) return false;
    setBusy(g.key);
    try {
      const res = await api.resolveSimilar(keep, removeIds);
      onToast(res.removed ? `已移入回收站 ${res.removed} 张` : '没有删除任何图片');
      setGroups((prev) => prev.filter((x) => x.key !== g.key));
      loadStats();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
    }
    return true;
  };

  /** 一键处理所有组：完全重复组保留推荐项，其余移入回收站；系列照组跳过（需人工逐组确认） */
  const resolveAll = async () => {
    const list = visibleGroups.filter((g) => g.tier !== 'series');
    const seriesCount = visibleGroups.length - list.length;
    if (!list.length) {
      onToast(seriesCount ? `${seriesCount} 组都是系列照，已跳过（请逐组人工确认）` : '没有可处理的组');
      return;
    }
    const total = list.reduce((s, g) => s + g.items.length - 1, 0);
    const tip = seriesCount ? `另有 ${seriesCount} 组系列照已跳过` : '';
    if (!window.confirm(`将处理 ${list.length} 组，共移入回收站 ${total} 张（每组保留推荐的那张）。${tip}确定吗？`)) return;
    setBusy('__all__');
    let removed = 0;
    const doneKeys = new Set<string>();
    try {
      for (const g of list) {
        const keep = picked[g.key] || g.recommendId;
        const res = await api.resolveSimilar(
          keep,
          g.items.filter((it) => it.id !== keep).map((it) => it.id)
        );
        removed += res.removed;
        doneKeys.add(g.key);
      }
      onToast(`已移入回收站 ${removed} 张${seriesCount ? `，${seriesCount} 组系列照保留待人工确认` : ''}`);
      setGroups((prev) => prev.filter((g) => !doneKeys.has(g.key)));
      loadStats();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 补算主色（分批循环到算完） */
  const runDominant = async () => {
    if (!stats?.noDominant) return onToast('所有图片都已有主色');
    setBusy('dominant');
    let done = 0;
    try {
      for (;;) {
        const res = await api.backfillDominant(300);
        done += res.done;
        setJobProgress(`已处理 ${done} 张，剩余 ${res.remain} 张`);
        if (!res.remain || !res.done) break;
      }
      onToast(`主色补算完成，共 ${done} 张`);
      loadStats();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
      setJobProgress('');
    }
  };

  /** AI 打标（分批循环，供自然语言搜索） */
  const runAiTag = async () => {
    if (!stats?.noAiDesc) return onToast('所有图片都已有 AI 描述');
    setBusy('ai');
    let done = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await api.aiTagBatch(4);
        done += res.done;
        setJobProgress(`AI 已分析 ${done} 张，剩余 ${res.remain} 张`);
        if (!res.remain) break;
        if (!res.done) {
          const err = res.results.find((r) => !r.ok)?.error;
          onToast(err ? `AI 分析中断：${err}` : 'AI 分析没有进展');
          break;
        }
      }
      onToast(`AI 打标完成，共 ${done} 张`);
      loadStats();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
      setJobProgress('');
    }
  };

  const label = (it: ImageItem) => `${it.width}×${it.height} · ${formatSize(it.sizeBytes)}`;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">整理</h1>
          <div className="page-sub">
            {mode === 'format'
              ? '同名格式去重：同目录下同名 JPG/PNG 视为同一张，推荐保留更清晰的 PNG'
              : mode === 'clip'
                ? 'CLIP 深度相似：按 AI 视觉特征分组，裁剪 / 旋转 / 加滤镜的变体也能归到一组'
                : '相似图审查合并 · 主色补算 · AI 描述打标（让搜索能听懂自然语言）'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={scanClip} disabled={scanning}>
            <IconWand /> CLIP 深度相似
          </button>
          <button className="btn" onClick={scanFormat} disabled={scanning}>
            <IconWand /> 同名 JPG/PNG 去重
          </button>
          <button className="btn" onClick={() => scan()} disabled={scanning}>
            <IconRefresh /> {scanning ? '扫描中…' : '重新扫描相似图'}
          </button>
          <button
            className="btn primary"
            onClick={resolveAll}
            disabled={!!busy || !visibleGroups.length}
          >
            <IconTrash /> 一键保留最佳
          </button>
          {skipped.size > 0 && (
            <button
              className="btn"
              onClick={async () => {
                try {
                  await api.tidySkipReset();
                  setSkipped(new Set());
                  onToast('已重置全部「不处理」，被跳过的组会重新出现');
                } catch (e) {
                  onToast((e as Error).message);
                }
              }}
              disabled={!!busy}
            >
              重置全部跳过 ({skipped.size})
            </button>
          )}
        </div>
      </div>

      <div className="toolbar">
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>相似度阈值</span>
        <input
          type="range"
          min={2}
          max={18}
          value={threshold}
          style={{ width: 160 }}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
        <span style={{ fontSize: 12.5 }}>{threshold}</span>
        <span className="hint" style={{ marginLeft: 4 }}>
          越小越严格（只有几乎同一张才会归为一组）
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12.5 }}>
          {visibleGroups.length} 组 · 共 {visibleGroups.reduce((s, g) => s + g.count, 0)} 张
        </span>
      </div>

      {visibleGroups.length === 0 && !scanning && (
        <div className="empty">
          <div className="big">🧹</div>
          <h3>没有需要合并的相似图片</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            同一张照片的不同裁剪 / 不同来源版本会自动出现在这里，可整组对比后保留最清晰的那张
          </p>
        </div>
      )}

      {visibleGroups.map((g) => {
        const keep = picked[g.key] || g.recommendId;
        return (
          <div className="card" key={g.key} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13.5 }}>{g.count} 张相似</b>
              {g.tier === 'exact' ? (
                <span
                  style={{
                    fontSize: 11.5,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(220,80,80,.15)',
                    color: 'var(--err, #e5484d)',
                  }}
                >
                  完全重复 · 可放心清理
                </span>
              ) : g.tier === 'series' ? (
                <span
                  style={{
                    fontSize: 11.5,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(240,170,40,.15)',
                    color: '#e8a33d',
                  }}
                  title="同一场拍摄的多帧，不算重复。已按画质排好序，想要留哪张自己勾选"
                >
                  系列照 · 建议保留，不自动清理
                </span>
              ) : null}
              <span className="hint">
                选一张保留，其余移入回收站（推荐项已按「清晰度 × 分辨率」自动选中）
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => setDuel(g)}
                  disabled={g.items.length < 2}
                  title="两个一组逐对比较：败者立即移入回收站，直到只剩一张"
                >
                  两两对比
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await api.tidySkipAdd(g.recommendId);
                      setSkipped((prev) => new Set(prev).add(g.recommendId));
                    } catch (e) {
                      onToast((e as Error).message);
                    }
                  }}
                  disabled={!!busy}
                >
                  这组不处理
                </button>
                <button className="btn sm danger" onClick={() => resolve(g)} disabled={!!busy}>
                  {busy === g.key ? '处理中…' : `保留选中的，删其余 ${g.items.length - 1} 张`}
                </button>
              </div>
            </div>
            <div className="similar-row">
              {g.items.map((it) => (
                <label className={`similar-item${keep === it.id ? ' on' : ''}`} key={it.id}>
                  <input
                    type="radio"
                    name={g.key}
                    checked={keep === it.id}
                    onChange={() => setPicked((prev) => ({ ...prev, [g.key]: it.id }))}
                  />
                  <img src={it.thumbUrl} alt={it.title} loading="lazy" />
                  <div className="similar-meta">
                    <span>{label(it)}</span>
                    <span>
                      {typeof it.quality === 'number' ? `画质 ${it.quality}` : `评分 ${it.score}`}
                      {it.rating > 0 ? ` · ${'★'.repeat(it.rating)}` : ''}
                      {it.id === g.recommendId ? ' · 推荐' : ''}
                    </span>
                    <span className="hint">{it.source}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      {duel && (
        <DuelView
          group={duel}
          onEliminate={eliminateOne}
          onFinished={() => {
            onToast('整组处理完成，只保留了画质最佳的一张');
            setGroups((prev) => prev.filter((g) => g.key !== duel.key));
            loadStats();
            setDuel(null);
          }}
          onClose={() => setDuel(null)}
        />
      )}

      <div className="card">
        <h4 className="section-title">素材维护</h4>
        <div className="hint" style={{ marginBottom: 10, lineHeight: 1.9 }}>
          · 库内共 {stats?.total ?? '…'} 张，已评分 {stats?.rated ?? 0} 张
          <br />· 缺主色：{stats?.noDominant ?? '…'} 张（主色用于「找同色」与颜色筛选）
          <br />· 缺 AI 描述：{stats?.noAiDesc ?? '…'} 张（AI 描述会进入搜索索引，可搜「红裙 舞台」这类自然语言）
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={runDominant} disabled={!!busy}>
            <IconWand /> {busy === 'dominant' ? '补算主色中…' : '补算主色'}
          </button>
          <button className="btn" onClick={runAiTag} disabled={!!busy}>
            <IconWand /> {busy === 'ai' ? 'AI 分析中…' : '批量 AI 打标'}
          </button>
          <button className="btn" onClick={loadStats} disabled={!!busy}>
            刷新统计
          </button>
          {jobProgress && <span className="hint" style={{ alignSelf: 'center' }}>{jobProgress}</span>}
        </div>
      </div>
    </div>
  );
}
