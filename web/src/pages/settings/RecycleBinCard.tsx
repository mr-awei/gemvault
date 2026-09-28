import React, { useEffect, useState } from 'react';
import { api, quiet } from '../../api';
import type { TrashItem } from '../../types';
import { IconTrash } from '../../components/Icons';
import Card from './Card';

interface Props {
  onLibraryChanged: () => void;
  onToast: (msg: string) => void;
}

/** 「回收站」卡片：最近删除的图片，可恢复 / 彻底删除 */
export default function RecycleBinCard({ onLibraryChanged, onToast }: Props) {
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const loadTrash = () => api.trash().then(setTrash).catch(quiet);

  useEffect(() => {
    loadTrash();
  }, []);

  return (
    <Card title={`回收站（${trash.length}）`} desc="删除的图片先进入这里，可随时恢复到原文件夹。">
      {!trash.length && (
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>暂无被删除的图片</span>
      )}
      {trash.slice(0, 20).map((t) => (
        <div className="kw-row" key={t.id} style={{ marginBottom: 6 }}>
          <span style={{ flex: 1, fontSize: 12.5, minWidth: 0 }}>
            {t.title}
            <span style={{ color: 'var(--muted)', fontSize: 11.5, marginLeft: 6 }}>
              {t.width}×{t.height} · {t.reason || '未记录原因'}
            </span>
          </span>
          <button
            className="btn sm"
            onClick={async () => {
              await api.restoreTrash(t.id);
              loadTrash();
              onLibraryChanged();
              onToast('已恢复到原位置');
            }}
          >
            恢复
          </button>
          <button
            className="del"
            onClick={async () => {
              await api.deleteTrash(t.id);
              loadTrash();
            }}
          >
            <IconTrash />
          </button>
        </div>
      ))}
      {trash.length > 0 && (
        <button
          className="btn danger"
          style={{ marginTop: 10 }}
          onClick={async () => {
            const res = await api.emptyTrash();
            onToast(`已彻底删除 ${res.removed} 个文件`);
            loadTrash();
          }}
        >
          清空回收站
        </button>
      )}
    </Card>
  );
}
