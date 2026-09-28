import React, { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, type SmartFolder } from '../api';
import type { ImageItem } from '../types';
import ImageCard from '../components/ImageCard';
import { promptDialog } from '../components/Dialogs';
import MasonryGrid from '../components/MasonryGrid';

interface Props {
  onToast: (msg: string) => void;
  /** 打开大图预览（App 级 Lightbox，可在预览列表间导航） */
  onOpenItem?: (item: ImageItem, pool?: ImageItem[]) => void;
}

export default function Smart({ onToast, onOpenItem }: Props) {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [folders, setFolders] = useState<SmartFolder[]>([]);
  const [previewItems, setPreviewItems] = useState<ImageItem[] | null>(null);
  const [previewName, setPreviewName] = useState('');

  // 新建智能文件夹表单
  const [name, setName] = useState('');
  const [autoTags, setAutoTags] = useState('');
  const [rulesText, setRulesText] = useState(
    JSON.stringify({ favorite: null, minRating: 0, orientation: null, tagsInclude: [], aiKeywords: [] }, null, 2)
  );

  const load = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([api.tags(), api.smartFolders()]);
      setTags(t);
      setFolders(f);
    } catch (err) {
      onToast((err as Error).message);
    }
  }, [onToast]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshTags = (r: { tags: { tag: string; count: number }[] }) => setTags(r.tags);

  const renameTag = async (oldName: string) => {
    const nn = await promptDialog('重命名为：', oldName);
    if (!nn || nn === oldName) return;
    try {
      refreshTags(await api.renameTag(oldName, nn));
      onToast(`已重命名 ${oldName} → ${nn}`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };
  const deleteTag = async (t: string) => {
    if (!window.confirm(`删除标签「${t}」（会从所有图片上摘除）？`)) return;
    try {
      refreshTags(await api.deleteTag(t));
      onToast(`已删除标签 ${t}`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };
  const mergeTag = async (from: string) => {
    const to = await promptDialog(`把「${from}」合并到（输入目标标签名）：`, from);
    if (!to || to === from) return;
    try {
      refreshTags(await api.mergeTags(from, to));
      onToast(`已合并 ${from} → ${to}`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const createFolder = async () => {
    if (!name.trim()) return onToast('请输入名称');
    let rules: Record<string, unknown> = {};
    try {
      rules = JSON.parse(rulesText || '{}');
    } catch {
      return onToast('规则 JSON 格式错误');
    }
    try {
      const r = await api.createSmartFolder({
        name: name.trim(),
        autoTags: autoTags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        rules,
      });
      setFolders(r.folders);
      setName('');
      setAutoTags('');
      onToast('已创建智能文件夹');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const applyTags = async (id: number, fname: string) => {
    try {
      const r = await api.applySmartFolderTags(id);
      setTags(r.tags);
      onToast(`已把「${fname}」的标签继承到 ${r.changed} 张图`);
      load();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const preview = async (f: SmartFolder) => {
    try {
      const r = await api.previewSmartFolder(f.id);
      setPreviewItems(r.items);
      setPreviewName(`${f.name}（${r.total} 张）`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const delFolder = async (id: number) => {
    if (!window.confirm('删除该智能文件夹？')) return;
    try {
      const r = await api.deleteSmartFolder(id);
      setFolders(r.folders);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>标签与智能文件夹</h2>
        <p className="page-sub">标签管理（改名 / 合并 / 删除）· 智能文件夹按条件自动归类 + 文件夹标签继承</p>
      </div>

      <h3>标签</h3>
      <div className="tag-cloud">
        {tags.length === 0 && <span className="muted">还没有标签，可在大图预览里给图片加标签。</span>}
        {tags.map((t) => (
          <div className="tag-chip" key={t.tag}>
            <span className="tname">{t.tag}</span>
            <span className="tcount">{t.count}</span>
            <span className="tactions">
              <button className="mini" title="重命名" onClick={() => renameTag(t.tag)}>
                改
              </button>
              <button className="mini" title="合并到…" onClick={() => mergeTag(t.tag)}>
                并
              </button>
              <button className="mini danger" title="删除" onClick={() => deleteTag(t.tag)}>
                删
              </button>
            </span>
          </div>
        ))}
      </div>

      <h3>智能文件夹</h3>
      <div className="sf-form">
        <div className="row">
          <input className="inp" placeholder="名称，如「高清演唱会」" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className="inp"
            placeholder="自动标签（逗号分隔，命中即继承），如：演唱会,live"
            value={autoTags}
            onChange={(e) => setAutoTags(e.target.value)}
          />
        </div>
        <label className="muted small">规则（JSON，可留 {} 仅用自动标签）：</label>
        <textarea
          className="ta"
          rows={4}
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          spellCheck={false}
        />
        <button className="btn primary" onClick={createFolder}>
          新建智能文件夹
        </button>
      </div>

      <div className="sf-list">
        {folders.length === 0 && <span className="muted">还没有智能文件夹。</span>}
        {folders.map((f) => (
          <div className="sf-item" key={f.id}>
            <div className="sf-main">
              <b>{f.name}</b>
              {f.autoTags.length > 0 && (
                <span className="sf-tags">自动标签：{f.autoTags.join('、')}</span>
              )}
              <span className="muted small">{Object.keys(f.rules).length ? '含规则' : '仅自动标签'}</span>
            </div>
            <div className="sf-actions">
              <button className="btn sm" onClick={() => preview(f)}>
                查看
              </button>
              <button className="btn sm" onClick={() => applyTags(f.id, f.name)}>
                应用标签(继承)
              </button>
              <button className="btn sm ghost" onClick={() => delFolder(f.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {previewItems && (
        <div className="lb-overlay" onClick={() => setPreviewItems(null)}>
          <div className="lb-box wide" onClick={(e) => e.stopPropagation()}>
            <div className="lb-head">
              <b>{previewName}</b>
              <button className="btn sm ghost" onClick={() => setPreviewItems(null)}>
                关闭
              </button>
            </div>
            {/* 弹窗内容超出 90vh 滚动，MasonryGrid 会自动探测滚动容器做虚拟化 */}
            <div style={{ padding: 16 }}>
              <MasonryGrid
                items={previewItems}
                renderItem={(it) => (
                  <ImageCard
                    item={it}
                    selected={false}
                    onOpen={(i) => onOpenItem?.(i, previewItems ?? undefined)}
                    onToggleSelect={() => {}}
                    onToggleFavorite={() => {}}
                    onDownload={(it) => downloadFile(it.downloadUrl || it.url)}
                  />
                )}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
