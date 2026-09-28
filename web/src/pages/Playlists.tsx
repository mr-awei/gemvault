import React, { useCallback, useEffect, useState } from 'react';
import { api, quiet } from '../api';
import type { ImageItem, Playlist } from '../types';
import { IconFolder, IconTrash, IconWallpaper } from '../components/Icons';
import { formatDate } from '../api';

export default function Playlists({
  onToast,
  onOpen,
  onSetWallpaper,
}: {
  onToast: (msg: string) => void;
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
  onSetWallpaper: (item: ImageItem) => void;
}) {
  const [lists, setLists] = useState<Playlist[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [items, setItems] = useState<ImageItem[]>([]);
  const [newName, setNewName] = useState('');

  const refresh = useCallback(() => {
    api.playlists().then(setLists).catch(quiet);
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!activeId) {
      setItems([]);
      return;
    }
    api.playlistImages(activeId).then(setItems).catch(quiet);
  }, [activeId]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const res = await api.createPlaylist(name);
    setLists(res.playlists);
    setNewName('');
    const created = res.playlists.find((p) => p.name === name);
    if (created) setActiveId(created.id);
    onToast(`已创建清单「${name}」`);
  };

  const removeList = async (p: Playlist) => {
    if (!window.confirm(`删除清单「${p.name}」？清单内的图片不会被删除。`)) return;
    const res = await api.deletePlaylist(p.id);
    setLists(res.playlists);
    if (activeId === p.id) setActiveId(null);
  };

  const removeItem = async (imageId: number) => {
    if (!activeId) return;
    const res = await api.removeFromPlaylist(activeId, imageId);
    setLists(res.playlists);
    setItems((prev) => prev.filter((i) => i.id !== imageId));
  };

  const useForAuto = async (p: Playlist) => {
    await api.saveAutoWallpaper({ scope: 'playlist', playlistId: p.id });
    onToast(`自动换壁纸已切换到清单「${p.name}」`);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">清单</h1>
          <div className="page-sub">把喜欢的图收进不同清单，可作为定时换壁纸的切换范围</div>
        </div>
      </div>

      <div className="crawl-layout" style={{ gridTemplateColumns: '300px 1fr' }}>
        <div className="card">
          <h4 className="section-title">我的清单（{lists.length}）</h4>
          <div className="kw-list" style={{ maxHeight: 320 }}>
            {lists.map((p) => (
              <div
                className="kw-row"
                key={p.id}
                style={{
                  cursor: 'pointer',
                  background: activeId === p.id ? 'rgba(255,77,141,0.14)' : undefined,
                  borderColor: activeId === p.id ? 'rgba(255,77,141,0.45)' : undefined,
                }}
                onClick={() => setActiveId(p.id)}
              >
                <IconFolder />
                <span>{p.name}</span>
                <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{p.count}</span>
                <button
                  className="del"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeList(p);
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            ))}
            {!lists.length && (
              <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 4px' }}>
                还没有清单。在下方输入名称创建，或到图库批量选中后「加入清单」。
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="新清单名称，如「演唱会壁纸」"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <button className="btn primary" onClick={create}>
              新建
            </button>
          </div>
        </div>

        <div className="card">
          <h4 className="section-title">
            {activeId ? lists.find((p) => p.id === activeId)?.name : '未选择清单'}
            {activeId && (
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                {items.length} 张 · 创建于 {formatDate(lists.find((p) => p.id === activeId)?.created_at || '')}
              </span>
            )}
          </h4>

          {activeId && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn sm" onClick={() => lists.find((p) => p.id === activeId) && useForAuto(lists.find((p) => p.id === activeId)!)}>
                <IconWallpaper /> 设为自动换壁纸的范围
              </button>
            </div>
          )}

          {!activeId ? (
            <div className="empty" style={{ padding: '50px 20px' }}>
              <div className="big">📂</div>
              <h3>选择或新建一个清单</h3>
              <p>清单可以包含任意图片，用于分类收藏或作为定时换壁纸的来源范围。</p>
            </div>
          ) : !items.length ? (
            <div className="empty" style={{ padding: '50px 20px' }}>
              <div className="big">🖼️</div>
              <h3>这个清单还是空的</h3>
              <p>去图库勾选图片后点「加入清单」，就能把它们加进来。</p>
            </div>
          ) : (
            <div className="recent-grid">
              {items.map((item) => (
                <div key={item.id} style={{ position: 'relative' }}>
                  <img
                    src={item.thumbUrl}
                    alt={item.title}
                    loading="lazy"
                    onClick={() => onOpen(item, items)}
                    title={`${item.width}×${item.height}`}
                  />
                  <button
                    className="icon-btn"
                    style={{ position: 'absolute', top: 6, right: 6, width: 26, height: 26 }}
                    title="从清单移除"
                    onClick={() => removeItem(item.id)}
                  >
                    ×
                  </button>
                  <button
                    className="icon-btn"
                    style={{ position: 'absolute', bottom: 6, right: 6, width: 26, height: 26 }}
                    title="设为桌面壁纸"
                    onClick={() => onSetWallpaper(item)}
                  >
                    <IconWallpaper />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
