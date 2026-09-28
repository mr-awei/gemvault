import React, { useEffect, useState } from 'react';
import type { AppInfo } from '../../api';
import type { Settings as SettingsType } from '../../types';
import { desktop, quiet } from '../../api';
import Card from './Card';

interface Props {
  appInfo: AppInfo | null;
  patch: (p: Partial<SettingsType>) => void;
  onToast: (msg: string) => void;
}

/** 「应用与更新」卡片：开机自启 + 手动检查更新（桌面端） */
export default function AppUpdateCard({ appInfo, patch, onToast }: Props) {
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');

  useEffect(() => {
    desktop?.getAutoLaunch?.().then(setAutoLaunch).catch(quiet);
  }, []);

  return (
    <Card title="应用与更新" desc="随系统启动；手动检查新版本。">
      {desktop && (
        <div className="switch-row">
          <span>开机自动启动</span>
          <input
            type="checkbox"
            checked={autoLaunch}
            onChange={async (e) => {
              const next = e.target.checked;
              setAutoLaunch(next);
              try {
                const applied = (await desktop?.setAutoLaunch?.(next)) ?? next;
                setAutoLaunch(applied);
                patch({ autoLaunch: applied });
                onToast(applied ? '已开启开机自启' : '已关闭开机自启');
              } catch {
                setAutoLaunch(!next);
                onToast('设置开机自启失败');
              }
            }}
          />
        </div>
      )}
      <div className="hint">当前版本：v{appInfo?.version || '?'}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button
          className="btn"
          disabled={!!updateBusy}
          onClick={async () => {
            setUpdateBusy(true);
            setUpdateMsg('');
            try {
              const r = await desktop?.checkForUpdates?.();
              if (!r?.ok) {
                setUpdateMsg(r?.msg || '检查失败');
              } else if (r.hasUpdate) {
                setUpdateMsg(`发现新版本 v${r.latest}（当前 v${r.current}），请到发布页下载`);
                if (r.url) window.open(r.url, '_blank', 'noopener');
              } else {
                setUpdateMsg(`已是最新版本 v${r.current}`);
              }
            } finally {
              setUpdateBusy(false);
            }
          }}
        >
          {updateBusy ? '检查中…' : '检查更新'}
        </button>
        {updateMsg && <span className="hint" style={{ margin: 0 }}>{updateMsg}</span>}
      </div>
    </Card>
  );
}
