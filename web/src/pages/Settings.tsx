import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  desktop,
  formatDate,
  getAppInfo,
  isDesktop,
  openFolder,
  pickFolder,
  prettyHotkey,
  SOURCE_OPTIONS,
} from '../api';
import { subscribeEvents } from '../events';
import type { AppInfo } from '../api';
import { quiet } from '../api';
import type {
  AiPreset,
  AiStatus,
  AiUpscaleStatus,
  AutoWallpaperConfig as AutoConfig,
  AutoWallpaperStatus,
  EnhanceAiModel,
  EnhanceModel,
  EnhanceRemoteService,
  Keyword,
  NetworkConfig,
  Playlist,
  Settings as SettingsType,
  WallpaperLogItem,
  WallpaperMonitors,
  LiveWallpaperConfig,
} from '../types';
import {
  IconBrain,
  IconDownload,
  IconFolder,
  IconGlobe,
  IconImages,
  IconSpider,
  IconTrash,
  IconWand,
  IconWallpaper,
} from '../components/Icons';
import Card from './settings/Card';
import AppUpdateCard from './settings/AppUpdateCard';
import RecycleBinCard from './settings/RecycleBinCard';

/** 壁纸不喜欢时推断出的原因 → 中文说明（与删除原因同一套标签） */
const REASON_LABELS: Record<string, string> = {
  blur: '模糊 / 低清',
  lowres: '分辨率太低',
  noise: '噪点多 / 压缩痕迹重',
  lighting: '光线差 / 过曝欠曝',
  expression: '表情不好 / 闭眼',
  pose: '动作 / 姿态扭曲',
  composition: '构图不好',
  background: '背景杂乱',
  cropped: '截取不全 / 变形',
  overedited: '修图过度 / 不自然',
  watermark: '有水印或平台 Logo',
  notHer: '不是本人',
  color: '色调不喜欢',
  other: '其他',
};
const reasonLabel = (k: string) => REASON_LABELS[k] || k;

/** 常用免费线上增强服务预设（一键添加后可自行微调，再用「测试服务」验证） */
const REMOTE_PRESETS: {
  key: string;
  name: string;
  tag: string;
  desc: string;
  service: Omit<EnhanceRemoteService, 'id'>;
}[] = [
  {
    key: 'hf-swin2sr',
    name: 'Hugging Face · Swin2SR 图像超分',
    tag: '免费 · 需 Token',
    desc: '免费 Serverless 推理，直接返回图片。到 huggingface.co 注册后生成 hf_ 开头的 Token 填入',
    service: {
      name: 'HuggingFace Swin2SR ×4',
      uploadUrl: 'https://api-inference.huggingface.co/models/caidas/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
      method: 'POST',
      bodyMode: 'binary',
      fileField: 'file',
      headers: [{ key: 'Authorization', value: 'Bearer 在这里填你的 hf_ Token' }],
      resultType: 'direct',
      resultUrlPath: '',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'deepai',
    name: 'DeepAI · 超分辨率（Torch-SRGAN）',
    tag: '免费额度 · 需 Key',
    desc: '老牌接口，注册即送免费额度。上传后返回结果链接，需填入 api-key',
    service: {
      name: 'DeepAI 超分',
      uploadUrl: 'https://api.deepai.org/api/torch-srgan',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'image',
      headers: [{ key: 'api-key', value: '在这里填你的 DeepAI Key' }],
      resultType: 'json',
      resultUrlPath: 'output_url',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'deepai-waifu2x',
    name: 'DeepAI · waifu2x 放大（动漫/插画）',
    tag: '免费额度 · 需 Key',
    desc: '与上面同一家的动漫风超分接口，同样填 DeepAI 的 api-key 即可',
    service: {
      name: 'DeepAI waifu2x',
      uploadUrl: 'https://api.deepai.org/api/waifu2x',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'image',
      headers: [{ key: 'api-key', value: '在这里填你的 DeepAI Key' }],
      resultType: 'json',
      resultUrlPath: 'output_url',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'selfhost',
    name: '自建 Real-ESRGAN 服务',
    tag: '完全免费 · 无限次',
    desc: '开源自建（如 image-enhance-api / realesrgan-api），本机或服务器部署，无需 Key',
    service: {
      name: '自建超分服务',
      uploadUrl: 'http://127.0.0.1:8000/upscale',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'file',
      headers: [],
      resultType: 'direct',
      resultUrlPath: '',
      params: [],
      apiKey: '',
    },
  },
];

type SectionKey = 'general' | 'crawl' | 'ai' | 'wallpaper' | 'network' | 'data' | 'enhance';

const SECTIONS: { key: SectionKey; label: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'general', label: '通用', desc: '图片保存位置与删除行为', icon: <IconFolder /> },
  { key: 'crawl', label: '采集', desc: '采集源、关键词与质量过滤', icon: <IconSpider /> },
  { key: 'ai', label: 'AI 接入', desc: '智能评分与知识库的大模型配置', icon: <IconBrain /> },
  { key: 'wallpaper', label: '壁纸', desc: '设壁纸的填充方式与定时自动切换', icon: <IconWallpaper /> },
  { key: 'enhance', label: '画质增强', desc: '目标标准、增强模型与线上服务', icon: <IconWand /> },
  { key: 'network', label: '网络', desc: '代理设置，对采集、下载、AI 生效', icon: <IconGlobe /> },
  { key: 'data', label: '数据与维护', desc: '本地导入与回收站', icon: <IconImages /> },
];

export default function Settings({
  onToast,
  onLibraryChanged,
}: {
  onToast: (msg: string) => void;
  onLibraryChanged: () => void;
}) {
  const [section, setSection] = useState<SectionKey>('general');
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [newKw, setNewKw] = useState('');
  const [wbLogin, setWbLogin] = useState(false);
  // 微博 Cookie 输入草稿：已保存的凭据不会回显（服务端脱敏），留空保存 = 保持不变
  const [wbCookieDraft, setWbCookieDraft] = useState('');
  // AI API Key 同理：password 输入框只当「填写新 Key」用，留空保存 = 保持不变
  const [aiKeyDraft, setAiKeyDraft] = useState('');
  const [importing, setImporting] = useState(false);
  const [presets, setPresets] = useState<Record<string, AiPreset>>({});
  const [models, setModels] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [aiError, setAiError] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [customVision, setCustomVision] = useState(false);
  const [net, setNet] = useState<NetworkConfig | null>(null);
  const [netError, setNetError] = useState('');
  const [testingNet, setTestingNet] = useState(false);
  const [autoStatus, setAutoStatus] = useState<AutoWallpaperStatus | null>(null);
  const [wallpaperHistory, setWallpaperHistory] = useState<WallpaperLogItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [enhanceModels, setEnhanceModels] = useState<{
    builtin: EnhanceModel[];
    remote: EnhanceRemoteService[];
    ai?: EnhanceAiModel[];
  }>({
    builtin: [],
    remote: [],
    ai: [],
  });
  const [aiUp, setAiUp] = useState<AiUpscaleStatus | null>(null);
  // 第二档：Transformer 超分（Swin2SR）模型状态
  const [sr, setSr] = useState<Awaited<ReturnType<typeof api.aiSrStatus>> | null>(null);
  // 本地偏好模型状态
  const [pref, setPref] = useState<Awaited<ReturnType<typeof api.prefStatus>> | null>(null);
  // AI 去背景模型状态
  const [matting, setMatting] = useState<Awaited<ReturnType<typeof api.mattingStatus>> | null>(null);

  /** 偏好模型特征名 → 中文（便于看懂模型学到了什么） */
  const featureLabel = (f: string) => {
    const [kind, value] = f.split(':');
    const map: Record<string, string> = {
      src: '来源',
      kw: '关键词',
      bucket: '分辨率档',
      orient: '方向',
      hue: '色系',
      bright: '亮度档',
      sharp: '清晰度档',
      term: '画面问题',
    };
    const v: Record<string, string> = {
      sd: '低清', fhd: '1080P', '2k': '2K', '4k': '4K',
      portrait: '竖图', landscape: '横图', square: '方图', gray: '黑白灰',
    };
    return `${map[kind] || kind}·${v[value] ?? value}`;
  };
  const [monitors, setMonitors] = useState<WallpaperMonitors | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  // 「应用与更新」区块（开机自启 / 检查更新）已拆分至 settings/AppUpdateCard.tsx
  const [live, setLive] = useState<LiveWallpaperConfig | null>(null);
  const [remoteTest, setRemoteTest] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [remoteTesting, setRemoteTesting] = useState<string>('');

  const provider = settings?.ai?.provider || '';
  const modelOptions = useMemo(
    () => Array.from(new Set([...(presets[provider]?.models || []), ...models])),
    [presets, models, provider]
  );
  const visionOptions = useMemo(
    () => Array.from(new Set([...(presets[provider]?.visionModels || []), ...models])),
    [presets, models, provider]
  );

  useEffect(() => {
    api.settings().then(setSettings);
    api.keywords().then(setKeywords);
    api.aiPresets().then(setPresets).catch(quiet);
    api.aiStatus().then(setAiStatus).catch(quiet);
    api.network().then(setNet).catch(quiet);
    api.playlists().then(setPlaylists).catch(quiet);
    api.enhanceModels().then(setEnhanceModels).catch(quiet);
    api.aiUpscaleStatus().then(setAiUp).catch(quiet);
    api.aiSrStatus().then(setSr).catch(quiet);
    api.prefStatus().then(setPref).catch(quiet);
    api.mattingStatus().then(setMatting).catch(quiet);
    loadAuto();
  }, []);

  // 任务进度推送（sr / 运行库 / 本地导入）→ 订阅 job 事件（原三处 1.2~1.5s 轮询）
  const srLoadingRef = useRef(false);
  srLoadingRef.current = !!sr?.loading;
  const aiUpDownloadingRef = useRef(false);
  aiUpDownloadingRef.current = !!aiUp?.downloading;
  const importingRef = useRef(false);
  importingRef.current = importing;

  useEffect(() => {
    let off = () => {};
    subscribeEvents('job', (d) => {
      try {
        if (d?.sr) {
          const st = d.sr;
          setSr(st);
          if (srLoadingRef.current && !st.loading) {
            onToast(st.error ? `模型下载失败：${st.error}` : '超分模型已就绪');
            api.enhanceModels().then(setEnhanceModels).catch(quiet);
          }
          srLoadingRef.current = !!st.loading;
        }
        if (d?.aiUp) {
          const st = d.aiUp;
          setAiUp(st);
          if (aiUpDownloadingRef.current && !st.downloading) {
            onToast(st.installed ? 'AI 超分运行库安装完成' : '安装未完成');
            api.enhanceModels().then(setEnhanceModels).catch(quiet);
          }
          aiUpDownloadingRef.current = !!st.downloading;
        }
        if (d?.import) {
          const st = d.import;
          setImporting(!!st.running);
          if (importingRef.current && !st.running) {
            onToast(`导入完成：${st.message || ''}`);
            onLibraryChanged();
          }
          importingRef.current = !!st.running;
        }
      } catch {
        /* ignore */
      }
    }).then((o) => {
      off = o;
    });
    return () => {
      off();
    };
  }, [onToast, onLibraryChanged]);

  const loadAuto = () => {
    api.autoWallpaper().then(setAutoStatus).catch(quiet);
    api.wallpaperHistory().then(setWallpaperHistory).catch(quiet);
    api.wallpaperMonitors().then(setMonitors).catch(quiet);
    api.liveWallpaper().then(setLive).catch(quiet);
    getAppInfo().then(setAppInfo).catch(quiet);
  };

  /** 保存并应用动态壁纸配置（桌面端会据此创建/销毁桌面层窗口） */
  const applyLive = async (patch: Partial<LiveWallpaperConfig>) => {
    try {
      const saved = await api.saveLiveWallpaper(patch);
      setLive(saved);
      if (isDesktop && desktop?.controlLiveWallpaper) {
        await desktop.controlLiveWallpaper(patch);
        onToast('动态壁纸已更新');
      } else {
        onToast('已保存（桌面端中打开才会真正显示）');
      }
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const saveAuto = async (patch: Partial<AutoConfig>) => {
    const status = await api.saveAutoWallpaper(patch);
    setAutoStatus(status);
    onToast('已保存');
  };

  const switchNow = async () => {
    try {
      const res = await api.switchWallpaperNow();
      onToast(`已切换到：${res.title || '图片'}（图片会完整居中展示，不裁切）`);
      loadAuto();
      setWallpaperHistory(await api.wallpaperHistory());
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const netModeLabel = (mode?: string) =>
    ({ off: '直连', system: '系统代理', http: 'HTTP 代理', https: 'HTTPS 代理', socks5: 'SOCKS5 代理', socks4: 'SOCKS4 代理' }[
      mode || 'off'
    ] || '直连');

  const applyPreset = (key: string) => {
    const preset = presets[key];
    if (!preset || !settings) return;
    setCustomModel(false);
    setCustomVision(false);
    setSettings({
      ...settings,
      ai: {
        ...settings.ai,
        provider: key,
        baseUrl: preset.baseUrl,
        model: preset.models[0] || settings.ai.model,
        visionModel: preset.visionModels[0] || '',
      },
    });
    setModels(preset.models);
  };

  const testAi = async () => {
    setTesting(true);
    setAiError('');
    try {
      const res = await api.aiTest();
      onToast(`连接成功：${res.reply || res.model}`);
      setAiStatus(await api.aiStatus());
      if (res.models?.length) setModels(res.models);
    } catch (err) {
      setAiError((err as Error).message);
      onToast('连接失败，详情见下方提示');
    } finally {
      setTesting(false);
    }
  };

  const fetchModels = async () => {
    setAiError('');
    try {
      const res = await api.aiModels();
      setModels(res.models);
      setCustomModel(false);
      onToast(`拉取到 ${res.models.length} 个模型`);
    } catch (err) {
      setAiError((err as Error).message);
      onToast('拉取失败，详情见下方提示');
    }
  };

  if (!settings) {
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  }

  const patch = (p: Partial<SettingsType>) => setSettings({ ...settings, ...p });

  const save = async () => {
    // Cookie / AI Key 都是凭据（服务端已脱敏不回显），只提交输入框里的新草稿；留空 = 保持不变
    const draft = wbCookieDraft.trim();
    const aiDraft = aiKeyDraft.trim();
    const payload: SettingsType = draft
      ? { ...settings, weiboCookie: draft }
      : ({ ...settings, weiboCookie: '' } as SettingsType);
    payload.ai = aiDraft ? { ...payload.ai, apiKey: aiDraft } : { ...payload.ai, apiKey: '' };
    const saved = await api.saveSettings(payload);
    setSettings(saved);
    if (draft) setWbCookieDraft('');
    if (aiDraft) setAiKeyDraft('');
    onToast('设置已保存');
  };

  /** 清除服务端已保存的微博 Cookie（显式指令，区别于「留空不改」） */
  const clearWeiboCookie = async () => {
    try {
      const saved = await api.saveSettings({ weiboCookieClear: true });
      setSettings(saved);
      setWbCookieDraft('');
      onToast('已清除微博 Cookie');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  /** 清除服务端已保存的 AI API Key */
  const clearAiApiKey = async () => {
    try {
      const saved = await api.saveSettings({ aiApiKeyClear: true });
      setSettings(saved);
      setAiKeyDraft('');
      onToast('已清除 AI API Key');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const toggleSource = (key: string) =>
    setSettings({ ...settings, sources: { ...settings.sources, [key]: !settings.sources[key] } });

  /** 内置浏览器登录微博，自动抓取 Cookie 并保存（桌面端专属） */
  const weiboLogin = async () => {
    setWbLogin(true);
    try {
      const res = await desktop?.weiboLogin?.();
      if (res?.ok && res.cookie) {
        const saved = await api.saveSettings({
          weiboCookie: res.cookie,
          weiboUserAgent: res.ua || '',
        });
        setSettings(saved);
        setWbCookieDraft('');
        onToast('已自动获取微博 Cookie 并保存');
      } else if (res?.msg) {
        onToast(res.msg);
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setWbLogin(false);
    }
  };

  const addKeyword = async () => {
    const text = newKw.trim();
    if (!text) return;
    const res = await api.addKeyword(text);
    setKeywords(res.keywords);
    setNewKw('');
  };

  const toggleKeyword = async (k: Keyword) => {
    const res = await api.updateKeyword(k.id, { enabled: k.enabled ? 0 : 1 });
    setKeywords(res.keywords);
  };

  const removeKeyword = async (id: number) => {
    const res = await api.deleteKeyword(id);
    setKeywords(res.keywords);
  };

  const runImport = async () => {
    setImporting(true);
    importingRef.current = true;
    await api.importLocal();
    onToast('已开始导入本地素材，请稍候刷新图库');
    // 完成时机由 job 事件推送（见上方订阅）；这里留超时兜底，防止推送断连时按钮永久锁死
    window.setTimeout(() => {
      if (importingRef.current) {
        importingRef.current = false;
        setImporting(false);
      }
    }, 15 * 60 * 1000);
  };

  const runSeed = async () => {
    await api.seed();
    onToast('初始素材已尝试下载');
    onLibraryChanged();
  };

  const clearAll = async () => {
    if (!window.confirm('确定清空整个图库？图片文件也会一并删除（收藏与标签将丢失）。')) return;
    const res = await api.clearLibrary();
    onToast(`已清空 ${res.removed} 张图片`);
    onLibraryChanged();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">保存位置 · 采集 · AI · 壁纸 · 网络 · 数据维护</div>
        </div>
        <button className="btn primary" onClick={save}>
          保存设置
        </button>
      </div>

      <div className="settings-shell">
        <nav className="settings-nav">
          <div className="nav-label">设置分类</div>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={section === s.key ? 'active' : ''}
              onClick={() => setSection(s.key)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {/* ------------------------------ 通用 ------------------------------ */}
          {section === 'general' && (
            <Card title="通用" desc="采集到的图片保存到哪里、删除图片时的行为。">
              <div className="field">
                <label>图片保存文件夹</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={settings.storageDir}
                    onChange={(e) => patch({ storageDir: e.target.value })}
                  />
                  <button
                    className="btn"
                    disabled={!isDesktop}
                    title={isDesktop ? '选择文件夹' : '仅桌面端支持选择文件夹'}
                    onClick={async () => {
                      const dir = await pickFolder();
                      if (dir) {
                        patch({ storageDir: dir });
                        await api.saveSettings({ storageDir: dir });
                        onToast(`保存文件夹已设置为 ${dir}`);
                      }
                    }}
                  >
                    选择…
                  </button>
                </div>
                <div className="hint">
                  文件名格式：关键词_来源_宽x高_时间.jpg；可直接用资源管理器浏览、设为壁纸
                </div>
              </div>
              <div className="field">
                <label>在软件里删除图片时</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.deletePolicy}
                  onChange={(e) => patch({ deletePolicy: e.target.value as SettingsType['deletePolicy'] })}
                >
                  <option value="trash">移到回收站（可恢复）</option>
                  <option value="permanent">彻底删除</option>
                  <option value="unlink">只从图库移除，保留文件</option>
                </select>
              </div>
              <div className="field">
                <label>智能评分阈值（低于该分采集时自动丢弃）</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={settings.scoreThreshold}
                  onChange={(e) => patch({ scoreThreshold: Number(e.target.value) || 0 })}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => openFolder(settings.storageDir)}>
                  <IconFolder /> 打开文件夹
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const res = await api.scanFolder();
                    onToast(res.ok ? `扫描完成：新增 ${res.saved ?? 0} 张` : res.message || '扫描失败');
                    onLibraryChanged();
                  }}
                >
                  重新扫描文件夹
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const res = await api.purgeMissing();
                    onToast(`已清理 ${res.removed} 条失效记录`);
                    onLibraryChanged();
                  }}
                >
                  清理失效记录
                </button>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                修改保存位置或删除策略后，点右上角「保存设置」生效
              </div>
            </Card>
          )}

          {/* ------------------------------ 采集 ------------------------------ */}
          {section === 'crawl' && (
            <>
              <Card title="采集源" desc="开关参与采集的图片来源，可多选。">
                {SOURCE_OPTIONS.map((s) => (
                  <div className="switch-row" key={s.key} title={s.hint}>
                    <span>
                      {s.label}
                      {s.hint && <span className="src-hint">需配置</span>}
                    </span>
                    <input type="checkbox" checked={!!settings.sources[s.key]} onChange={() => toggleSource(s.key)} />
                  </div>
                ))}
                <div className="field" style={{ marginTop: 14 }}>
                  <label>微博 Cookie（可选，填了才能用「微博图片」源）</label>
                  {isDesktop && (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <button className="btn sm" onClick={weiboLogin} disabled={wbLogin}>
                        {wbLogin ? '等待登录…' : '打开内置浏览器登录，自动获取'}
                      </button>
                    </div>
                  )}
                  <textarea
                    className="input"
                    rows={2}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                    value={wbCookieDraft}
                    placeholder={settings.hasWeiboCookie ? '已保存登录凭据（不回显）。粘贴新 Cookie 可覆盖' : 'SUB=xxx; SUBP=xxx; SSOLoginState=xxx; …（整段粘贴）'}
                    onChange={(e) => setWbCookieDraft(e.target.value)}
                  />
                  <div className="hint">
                    推荐用上面的「打开内置浏览器登录」：登录成功后自动抓取并保存，无需手动复制。
                    也可以手动获取：浏览器登录 weibo.com → 按 F12 → Network 面板随便点一个请求 →
                    复制请求头里的 Cookie 整段粘到这里。Cookie 只存在本机且加密保存，
                    不再回显到界面（此框留空保存 = 保持不变），仅用于让微博源以你的账号身份请求图片。
                  </div>
                  {settings.hasWeiboCookie && (
                    <div style={{ marginTop: 6 }}>
                      <button className="btn sm" onClick={clearWeiboCookie}>
                        清除已保存的 Cookie
                      </button>
                    </div>
                  )}
                </div>
              </Card>

              <Card title="关键词" desc="采集时按这些关键词逐个抓图，可临时停用某个词。">
                <div className="kw-list">
                  {keywords.map((k) => (
                    <div className="kw-row" key={k.id}>
                      <input type="checkbox" checked={!!k.enabled} onChange={() => toggleKeyword(k)} />
                      <span style={{ opacity: k.enabled ? 1 : 0.45 }}>{k.text}</span>
                      <button className="del" onClick={() => removeKeyword(k.id)}>
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="新增关键词…"
                    value={newKw}
                    onChange={(e) => setNewKw(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
                  />
                  <button className="btn" onClick={addKeyword}>
                    添加
                  </button>
                </div>
              </Card>

              <Card title="抓取与质量过滤" desc="控制抓取量与入库门槛，过滤低质与重复图片。">
                <div className="field">
                  <label>每个关键词默认页数</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={20}
                    value={settings.pagesPerKeyword}
                    onChange={(e) => patch({ pagesPerKeyword: Number(e.target.value) || 1 })}
                  />
                </div>
                <div className="field">
                  <label>并发下载数</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={12}
                    value={settings.concurrency}
                    onChange={(e) => patch({ concurrency: Number(e.target.value) || 1 })}
                  />
                </div>
                <div className="field">
                  <label>Wallhaven API Key（可选）</label>
                  <input
                    className="input"
                    value={settings.wallhavenApiKey}
                    placeholder="留空亦可搜索 SFW 内容"
                    onChange={(e) => patch({ wallhavenApiKey: e.target.value })}
                  />
                </div>
                <div className="settings-subtitle">质量过滤与去重</div>
                <div className="field">
                  <label>长边最小像素</label>
                  <input
                    className="input"
                    type="number"
                    value={settings.minResolution}
                    onChange={(e) => patch({ minResolution: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">低于该分辨率的图片会被丢弃（默认 800px）</div>
                </div>
                <div className="field">
                  <label>最小文件大小（KB）</label>
                  <input
                    className="input"
                    type="number"
                    value={settings.minFileSize}
                    onChange={(e) => patch({ minFileSize: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">过滤图标、缩略图等小文件（默认 30KB）</div>
                </div>
                <div className="field">
                  <label>pHash 汉明距离阈值</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={32}
                    value={settings.phashThreshold}
                    onChange={(e) => patch({ phashThreshold: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">≤ 该值判定为重复图片并丢弃（默认 8，越小越宽松）</div>
                </div>
                <div className="field">
                  <label>单张最大体积（MB）</label>
                  <input
                    className="input"
                    type="number"
                    value={settings.maxFileSize}
                    onChange={(e) => patch({ maxFileSize: Number(e.target.value) || 1 })}
                  />
                </div>
              </Card>
            </>
          )}

          {/* ---------------------------- AI 接入 ---------------------------- */}
          {section === 'ai' && (
            <Card
              title="AI 接入"
              desc="用于图片智能评分、看图分析、删除原因学习与知识库。不配置也能正常使用。"
              badge={
                aiStatus?.ready ? (
                  <span style={{ color: 'var(--ok)', fontWeight: 400, fontSize: 12 }}>● 已就绪</span>
                ) : (
                  <span style={{ color: 'var(--warn)', fontWeight: 400, fontSize: 12 }}>○ 未配置</span>
                )
              }
            >
              <div className="field">
                <label>厂家预设（均为 OpenAI 兼容接口）</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.ai?.provider || 'custom'}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  {Object.entries(presets).map(([key, p]) => (
                    <option key={key} value={key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  className="input"
                  value={settings.ai?.baseUrl || ''}
                  placeholder="https://api.deepseek.com/v1"
                  onChange={(e) => patch({ ai: { ...settings.ai, baseUrl: e.target.value } })}
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  className="input"
                  type="password"
                  value={aiKeyDraft}
                  placeholder={settings.hasAiApiKey ? '已保存（不回显），粘贴新 Key 可覆盖' : 'sk-...'}
                  onChange={(e) => setAiKeyDraft(e.target.value)}
                />
                {settings.hasAiApiKey && (
                  <div style={{ marginTop: 6 }}>
                    <button className="btn sm" onClick={clearAiApiKey}>
                      清除已保存的 Key
                    </button>
                  </div>
                )}
                <div className="hint">
                  {presets[settings.ai?.provider || '']?.keyHint || '按接口方要求填写'}
                  {presets[settings.ai?.provider || '']?.docs && (
                    <>
                      {' · '}
                      <a
                        href={presets[settings.ai?.provider || ''].docs}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent)' }}
                      >
                        去获取密钥
                      </a>
                    </>
                  )}
                </div>
              </div>
              <div className="field">
                <label>文本模型（归纳规则 / 生成建议）</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {customModel || !modelOptions.length ? (
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={settings.ai?.model || ''}
                      placeholder="如 glm-4-flash / gpt-4o-mini / deepseek-chat"
                      onChange={(e) => patch({ ai: { ...settings.ai, model: e.target.value } })}
                    />
                  ) : (
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={settings.ai?.model || ''}
                      onChange={(e) =>
                        e.target.value === '__custom__'
                          ? setCustomModel(true)
                          : patch({ ai: { ...settings.ai, model: e.target.value } })
                      }
                    >
                      {settings.ai?.model && !modelOptions.includes(settings.ai.model) && (
                        <option value={settings.ai.model}>{settings.ai.model}（当前）</option>
                      )}
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">自定义 / 手动输入…</option>
                    </select>
                  )}
                  <button className="btn" onClick={fetchModels} title="从接口拉取模型列表">
                    拉取
                  </button>
                  <button
                    className="btn"
                    onClick={() => setCustomModel((v) => !v)}
                    title="在下拉与手动输入之间切换"
                  >
                    {customModel ? '下拉' : '手填'}
                  </button>
                </div>
                {modelOptions.length > 0 && !customModel && (
                  <div className="hint">共 {modelOptions.length} 个可选模型</div>
                )}
              </div>
              <div className="field">
                <label>视觉模型（看图分析，可留空复用文本模型）</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {customVision || !visionOptions.length ? (
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={settings.ai?.visionModel || ''}
                      placeholder="如 glm-4v-flash / qwen-vl-max-latest / gpt-4o-mini"
                      onChange={(e) => patch({ ai: { ...settings.ai, visionModel: e.target.value } })}
                    />
                  ) : (
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={settings.ai?.visionModel || ''}
                      onChange={(e) =>
                        e.target.value === '__custom__'
                          ? setCustomVision(true)
                          : patch({ ai: { ...settings.ai, visionModel: e.target.value } })
                      }
                    >
                      {settings.ai?.visionModel && !visionOptions.includes(settings.ai.visionModel) && (
                        <option value={settings.ai.visionModel}>{settings.ai.visionModel}（当前）</option>
                      )}
                      {visionOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">自定义 / 手动输入…</option>
                    </select>
                  )}
                  <button
                    className="btn"
                    onClick={() => setCustomVision((v) => !v)}
                    title="在下拉与手动输入之间切换"
                  >
                    {customVision ? '下拉' : '手填'}
                  </button>
                </div>
              </div>
              <div className="switch-row">
                <span>启用 AI</span>
                <input
                  type="checkbox"
                  checked={!!settings.ai?.enabled}
                  onChange={(e) => patch({ ai: { ...settings.ai, enabled: e.target.checked } })}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={testAi} disabled={testing}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
              </div>
              {aiError && <div className="ai-result" style={{ borderColor: 'rgba(248,113,113,0.4)' }}>{aiError}</div>}
              <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                · 密钥只保存在本机数据库，不外传
                <br />· 不配置也能用：删除原因会直接转成规则
                <br />· 401：密钥错误/过期/带空格；403：无该模型权限；404：Base URL 填错；429：限流或余额不足
                <br />· 部分厂家不开放 /models 接口，拉取失败可直接手填模型名后点「测试连接」
                <br />· 修改后点右上角「保存设置」生效
              </div>
            </Card>
          )}

          {/* ------------------------------ 画质增强 ------------------------------ */}
          {section === 'enhance' && (
            <Card
              title="画质增强"
              desc="设置「低于该标准」的图片自动收录，并选择增强方式。改动后点右上角「保存设置」生效。"
            >
              <div className="field">
                <label>目标标准（低于该分辨率的图片视为待增强）</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.enhance?.standard || '1080p'}
                  onChange={(e) => patch({ enhance: { ...settings.enhance, standard: e.target.value } })}
                >
                  <option value="480p">480P（854×480）</option>
                  <option value="720p">720P（1280×720）</option>
                  <option value="1080p">1080P（1920×1080）</option>
                  <option value="2k">2K（2560×1440）</option>
                  <option value="4k">4K（3840×2160）</option>
                  <option value="custom">自定义…</option>
                </select>
              </div>
              {settings.enhance?.standard === 'custom' && (
                <div style={{ display: 'flex', gap: 8, marginTop: -4 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>宽度（px）</label>
                    <input
                      className="input"
                      type="number"
                      value={settings.enhance?.customWidth ?? 1920}
                      onChange={(e) => patch({ enhance: { ...settings.enhance, customWidth: Number(e.target.value) || 0 } })}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>高度（px）</label>
                    <input
                      className="input"
                      type="number"
                      value={settings.enhance?.customHeight ?? 1080}
                      onChange={(e) => patch({ enhance: { ...settings.enhance, customHeight: Number(e.target.value) || 0 } })}
                    />
                  </div>
                </div>
              )}
              <div className="field">
                <label>默认增强模型</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.enhance?.model || 'sharp-standard'}
                  onChange={(e) => patch({ enhance: { ...settings.enhance, model: e.target.value } })}
                >
                  <optgroup label="内置模型（离线）">
                    {(enhanceModels.builtin || []).map((m: EnhanceModel) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.desc}
                      </option>
                    ))}
                  </optgroup>
                  {(enhanceModels.ai || []).length > 0 && (
                    <optgroup label="AI 超分模型（Real-ESRGAN）">
                      {(enhanceModels.ai || []).map((m: EnhanceAiModel) => (
                        <option key={m.id} value={m.id} disabled={!m.available}>
                          {m.label}
                          {m.available ? '' : '（未安装）'}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {(enhanceModels.remote || []).length > 0 && (
                    <optgroup label="线上服务">
                      {(enhanceModels.remote || []).map((r: EnhanceRemoteService) => (
                        <option key={r.id} value={`remote:${r.id}`}>
                          {r.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <div className="hint">
                  内置模型基于 sharp 插值放大，离线可用、无额外依赖；也可在下方配置线上免费增强服务
                </div>
              </div>

              <div className="settings-subtitle">AI 超分模型（Real-ESRGAN）</div>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 14,
                  background: 'var(--panel)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13 }}>
                    {aiUp?.installed
                      ? aiUp.usable === false
                        ? '● 已安装，但运行环境异常'
                        : '● 已安装，可离线使用'
                      : '○ 未安装'}
                  </b>
                  {aiUp?.installed && aiUp.gpu && (
                    <span className="tag-pill ok">AI 加速：{aiUp.gpu}</span>
                  )}
                  <span className="hint" style={{ marginLeft: 'auto' }}>
                    免 Python / 免 CUDA · 约 43MB · 一次下载永久离线
                  </span>
                </div>

                {aiUp?.downloading && (
                  <>
                    <div className="enh-progress" style={{ marginTop: 10 }}>
                      <div style={{ width: `${aiUp.progress}%` }} />
                    </div>
                    <div className="hint" style={{ marginTop: 6 }}>{aiUp.message}</div>
                  </>
                )}

                {aiUp?.usable === false && aiUp.error && (
                  <div className="ai-result" style={{ marginTop: 8, borderColor: 'rgba(248,113,113,0.4)' }}>
                    {aiUp.error}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button
                    className="btn primary"
                    disabled={!!aiUp?.downloading}
                    onClick={async () => {
                      try {
                        await api.aiUpscaleInstall();
                        setAiUp(await api.aiUpscaleStatus());
                        onToast('已开始下载（约 43MB），可在下方查看进度');
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                  >
                    {aiUp?.downloading
                      ? `下载中 ${aiUp.progress}%`
                      : aiUp?.installed
                        ? '重新安装 / 修复'
                        : '下载并安装运行库'}
                  </button>
                  <button
                    className="btn"
                    disabled={!aiUp?.installed}
                    onClick={async () => {
                      try {
                        const r = await api.aiUpscaleSelfTest();
                        setAiUp(await api.aiUpscaleStatus());
                        onToast(r.gpu ? `自检通过，AI 加速：${r.gpu}` : `自检失败：${r.error}`);
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                  >
                    重新检测
                  </button>
                </div>

                <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                  · 安装后「画质增强」页的模型下拉里会出现 3 个真·AI 超分模型：
                  <br />　realesrgan-x4plus（通用照片）、x4plus-anime（二次元/插画）、animevideov3（动漫/写真，最快）
                  <br />· AI 超分单张约数秒到数十秒，批量任务在后台执行，可在增强页看进度
                  <br />· 运行环境：Real-ESRGAN ncnn + Vulkan，使用显卡加速，无需安装 Python 或 CUDA
                </div>

                {/* 社区模型（真人照片效果更好）+ Real-CUGAN（两级降噪放大） */}
                <div className="settings-subtitle" style={{ marginTop: 14 }}>
                  社区模型与 Real-CUGAN
                </div>
                <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
                  · 社区模型比内置 realesrgan-x4plus 更适合真人照片（涂抹感更少、细节更稳），点「安装」即下载（单个约几 MB）
                  <br />· Real-CUGAN 带降噪档位：装了它之后，**噪点重 / 压缩狠的图会自动走两级流程**：Real-CUGAN 2× 降噪 → 主模型补到标准
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                  {(aiUp?.community || []).map((m: { id: string; label: string; desc: string; installed: boolean }) => (
                    <button
                      key={m.id}
                      className={`btn sm${m.installed ? '' : ' primary'}`}
                      disabled={!aiUp?.installed || !!aiUp?.downloading}
                      onClick={async () => {
                        try {
                          await api.aiUpscaleInstallModel(m.id);
                          setAiUp(await api.aiUpscaleStatus());
                          setEnhanceModels(await api.enhanceModels());
                          onToast(`已安装模型：${m.label}`);
                        } catch (err) {
                          onToast((err as Error).message);
                        }
                      }}
                      title={m.desc}
                    >
                      {m.installed ? '✓ ' : '↓ '}
                      {m.label}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className={`btn sm${aiUp?.cugan?.installed ? '' : ' primary'}`}
                    disabled={!!aiUp?.downloading}
                    onClick={async () => {
                      try {
                        await api.aiUpscaleInstallCugan();
                        setAiUp(await api.aiUpscaleStatus());
                        setEnhanceModels(await api.enhanceModels());
                        onToast('Real-CUGAN 运行库安装完成');
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                  >
                    {aiUp?.cugan?.installed ? '重新安装 Real-CUGAN' : '↓ 安装 Real-CUGAN 运行库（约 30MB）'}
                  </button>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {aiUp?.cugan?.installed
                      ? `已安装（可用模型 ${(aiUp.cugan.models || []).length} 个）`
                      : '未安装：噪点重的图将只走单级放大'}
                    </span>
                    </div>

                    {/* AI 去背景 */}
                <div className="settings-subtitle" style={{ marginTop: 14 }}>
                  AI 去背景（U-2-Net 人像分割）
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className={`btn sm${matting?.downloaded ? '' : ' primary'}`}
                    disabled={!!matting?.downloading}
                    onClick={async () => {
                      try {
                        await api.mattingInstall();
                        setMatting(await api.mattingStatus());
                        onToast('去背景模型下载完成，可在大图预览里点「✂ 去背景」');
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                  >
                    {matting?.downloading
                      ? `下载中 ${matting.progress}%`
                      : matting?.downloaded
                        ? '重新下载模型'
                        : '↓ 下载模型（约 4.5MB）'}
                  </button>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {matting?.downloaded
                      ? '已就绪：大图预览 → 「✂ 去背景」，生成透明 PNG 存为新图，原图不动'
                      : '未下载：去背景功能需要先下载模型（一次性）'}
                  </span>
                </div>

                {/* 本地偏好模型：个性化推荐 */}
                <div className="settings-subtitle" style={{ marginTop: 14 }}>
                  本地偏好模型（个性化推荐）
                </div>
                <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
                  · 用你的行为离线训练：收藏 / 壁纸「喜欢」当正样本，删除并选了原因 / 壁纸「不喜欢」当负样本
                  <br />· 只用画面属性（来源、分辨率、方向、色系、亮度、清晰度、模糊噪点等问题词）建模，全部在本机完成
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className="btn primary"
                    onClick={async () => {
                      try {
                        const r = await api.prefTrain();
                        setPref(await api.prefStatus());
                        onToast(
                          r.ok
                            ? `训练完成：${r.samples} 个样本（喜欢 ${r.pos} / 不喜欢 ${r.neg}），已更新 ${r.updated} 张图的偏好分`
                            : r.message || '训练失败'
                        );
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                  >
                    训练偏好模型
                  </button>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {pref?.trained
                      ? `已训练（${pref.samples} 样本 · ${pref.featureCount} 特征）`
                      : '未训练：图库「推荐」排序与壁纸挑选将使用中性分'}
                  </span>
                </div>
                {!!(pref?.top || []).length && (
                  <div className="hint" style={{ marginTop: 8, lineHeight: 1.9 }}>
                    模型最看重的因素：
                    {(pref?.top || []).map((t) => (
                      <span key={t.feature} style={{ marginRight: 8 }}>
                        {featureLabel(t.feature)}
                        <b style={{ marginLeft: 4 }}>{t.w > 0 ? `+${t.w}` : t.w}</b>
                      </span>
                    ))}
                  </div>
                )}

                {/* 第二档：Transformer 系（Swin2SR）——高画质但慢 */}
                    <div className="settings-subtitle" style={{ marginTop: 14 }}>
                    高画质（慢）· Transformer 超分
                    </div>
                    <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
                    · Swin2SR（SwinIR 后续工作）重建更自然、伪影更少，但 CPU 上单张约十秒级，适合少量重点图
                    <br />· 首次使用会自动下载模型（几十到几百 MB，走国内镜像）；点下面的按钮可提前下载 / 预热
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {(sr?.models || []).map((m) => (
                    <button
                    key={m.id}
                    className={`btn sm${m.downloaded ? '' : ' primary'}`}
                    disabled={!!sr?.loading}
                    onClick={async () => {
                      try {
                        const r = await api.aiSrLoad(m.id);
                        setSr(await api.aiSrStatus());
                        setEnhanceModels(await api.enhanceModels());
                        onToast(`${m.label}：${m.downloaded ? '已就绪' : '下载并加载完成'}`);
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                    title={m.desc}
                    >
                    {m.downloaded ? '✓ ' : '↓ '}
                    {m.label}
                    {m.loaded ? '（已就绪）' : ''}
                    </button>
                    ))}
                    </div>
                    {!!sr?.loading && (
                    <div className="hint" style={{ marginTop: 8 }}>
                    正在处理：{sr.message || sr.loading}
                    </div>
                    )}
                    {!!sr?.error && (
                    <div className="hint" style={{ marginTop: 8, color: 'var(--err, #e5484d)' }}>
                    {sr.error}
                    </div>
                    )}
                    </div>

              <div className="settings-subtitle">线上增强服务（可选）</div>
              <div className="settings-desc">
                软件会自动完成「上传图片 → 按参数请求 → 下载结果 → 覆盖原文件」。下面是可直接一键添加的常用免费服务，
                添加后请把 Key 换成自己的，再点「测试服务」验证连通性（返回内容会直接显示出来，便于照着调整）。
                支持「一次请求返回结果」的接口；需要轮询任务的服务（如 Replicate、Bigjpg 官方 API）请改用下方自建服务。
              </div>
              <div className="preset-grid">
                {REMOTE_PRESETS.map((p) => (
                  <div className="preset-card" key={p.key}>
                    <div className="preset-head">
                      <b>{p.name}</b>
                      <span className="tag-pill">{p.tag}</span>
                    </div>
                    <div className="hint">{p.desc}</div>
                    <button
                      className="btn sm"
                      onClick={() =>
                        patch({
                          enhance: {
                            ...settings.enhance,
                            remoteServices: [
                              ...(settings.enhance.remoteServices || []),
                              { ...p.service, id: String(Date.now()) + p.key },
                            ],
                          },
                        })
                      }
                    >
                      ＋ 添加此服务
                    </button>
                  </div>
                ))}
              </div>

              {(settings.enhance?.remoteServices || []).map((svc: EnhanceRemoteService) => (
                <div
                  key={svc.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: 10,
                    marginBottom: 10,
                    background: 'var(--panel)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="服务名称"
                      value={svc.name}
                      onChange={(e) =>
                        patch({
                          enhance: {
                            ...settings.enhance,
                            remoteServices: settings.enhance.remoteServices.map((s) =>
                              s.id === svc.id ? { ...s, name: e.target.value } : s
                            ),
                          },
                        })
                      }
                    />
                    <button
                      className="del"
                      title="删除该服务"
                      onClick={() =>
                        patch({
                          enhance: {
                            ...settings.enhance,
                            remoteServices: settings.enhance.remoteServices.filter((s) => s.id !== svc.id),
                          },
                        })
                      }
                    >
                      <IconTrash />
                    </button>
                  </div>
                  <div className="field">
                    <label>上传接口地址（接收 multipart 文件字段）</label>
                    <input
                      className="input"
                      value={svc.uploadUrl}
                      placeholder="https://example.com/api/upscale"
                      onChange={(e) =>
                        patch({
                          enhance: {
                            ...settings.enhance,
                            remoteServices: settings.enhance.remoteServices.map((s) =>
                              s.id === svc.id ? { ...s, uploadUrl: e.target.value } : s
                            ),
                          },
                        })
                      }
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>文件字段名</label>
                      <input
                        className="input"
                        value={svc.fileField || 'file'}
                        onChange={(e) =>
                          patch({
                            enhance: {
                              ...settings.enhance,
                              remoteServices: settings.enhance.remoteServices.map((s) =>
                                s.id === svc.id ? { ...s, fileField: e.target.value } : s
                              ),
                            },
                          })
                        }
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>返回类型</label>
                      <select
                        className="select"
                        style={{ width: '100%' }}
                        value={svc.resultType || 'json'}
                        onChange={(e) =>
                          patch({
                            enhance: {
                              ...settings.enhance,
                              remoteServices: settings.enhance.remoteServices.map((s) =>
                                s.id === svc.id ? { ...s, resultType: e.target.value as 'direct' | 'json' } : s
                              ),
                            },
                          })
                        }
                      >
                        <option value="json">JSON（含结果地址）</option>
                        <option value="direct">直接返回图片</option>
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>请求体方式</label>
                      <select
                        className="select"
                        style={{ width: '100%' }}
                        value={svc.bodyMode || 'multipart'}
                        onChange={(e) =>
                          patch({
                            enhance: {
                              ...settings.enhance,
                              remoteServices: settings.enhance.remoteServices.map((s) =>
                                s.id === svc.id ? { ...s, bodyMode: e.target.value as 'multipart' | 'binary' } : s
                              ),
                            },
                          })
                        }
                      >
                        <option value="multipart">表单上传（多数服务）</option>
                        <option value="binary">二进制直传（Hugging Face 等）</option>
                      </select>
                    </div>
                  </div>
                  {svc.resultType !== 'direct' && (
                    <div className="field">
                      <label>结果地址字段路径（如 data.output，留空尝试 url/result/output）</label>
                      <input
                        className="input"
                        value={svc.resultUrlPath || ''}
                        placeholder="data.output"
                        onChange={(e) =>
                          patch({
                            enhance: {
                              ...settings.enhance,
                              remoteServices: settings.enhance.remoteServices.map((s) =>
                                s.id === svc.id ? { ...s, resultUrlPath: e.target.value } : s
                              ),
                            },
                          })
                        }
                      />
                    </div>
                  )}
                  <div className="field">
                    <label>附加参数（每行 key=value，可选）</label>
                    <textarea
                      className="input"
                      rows={2}
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                      value={(svc.params || []).map((p) => `${p.key}=${p.value}`).join('\n')}
                      placeholder={'scale=2\nnoise=1'}
                      onChange={(e) =>
                        patch({
                          enhance: {
                            ...settings.enhance,
                            remoteServices: settings.enhance.remoteServices.map((s) =>
                              s.id === svc.id
                                ? {
                                    ...s,
                                    params: e.target.value
                                      .split('\n')
                                      .map((l) => l.trim())
                                      .filter(Boolean)
                                      .map((l) => {
                                        const i = l.indexOf('=');
                                        return i < 0
                                          ? { key: l, value: '' }
                                          : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
                                      }),
                                  }
                                : s
                            ),
                          },
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>自定义请求头（每行 名称=值，可选；如 api-key=xxx）</label>
                    <textarea
                      className="input"
                      rows={2}
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                      value={(svc.headers || []).map((h) => `${h.key}=${h.value}`).join('\n')}
                      placeholder={'api-key=你的Key\nAuthorization=Bearer xxx'}
                      onChange={(e) =>
                        patch({
                          enhance: {
                            ...settings.enhance,
                            remoteServices: settings.enhance.remoteServices.map((s) =>
                              s.id === svc.id
                                ? {
                                    ...s,
                                    headers: e.target.value
                                      .split('\n')
                                      .map((l) => l.trim())
                                      .filter(Boolean)
                                      .map((l) => {
                                        const i = l.indexOf('=');
                                        return i < 0
                                          ? { key: l, value: '' }
                                          : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
                                      }),
                                  }
                                : s
                            ),
                          },
                        })
                      }
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="btn sm"
                      disabled={remoteTesting === svc.id}
                      onClick={async () => {
                        setRemoteTesting(svc.id);
                        try {
                          const r = await api.enhanceRemoteTest(svc);
                          setRemoteTest((prev) => ({ ...prev, [svc.id]: { ok: r.ok, message: r.message } }));
                        } catch (err) {
                          setRemoteTest((prev) => ({
                            ...prev,
                            [svc.id]: { ok: false, message: (err as Error).message },
                          }));
                        } finally {
                          setRemoteTesting('');
                        }
                      }}
                    >
                      {remoteTesting === svc.id ? '测试中…' : '测试服务'}
                    </button>
                    <span className="hint">用一张 64×64 测试图跑完整流程，不会改动你的图片</span>
                  </div>
                  {remoteTest[svc.id] && (
                    <div
                      className="ai-result"
                      style={{
                        marginTop: 8,
                        borderColor: remoteTest[svc.id].ok ? 'rgba(74,222,128,0.4)' : 'rgba(248,113,113,0.4)',
                      }}
                    >
                      {remoteTest[svc.id].ok ? '✓ ' : '✗ '}
                      {remoteTest[svc.id].message}
                    </div>
                  )}
                </div>
              ))}
              <button
                className="btn"
                onClick={() =>
                  patch({
                    enhance: {
                      ...settings.enhance,
                      remoteServices: [
                        ...(settings.enhance.remoteServices || []),
                        {
                          id: String(Date.now()),
                          name: '',
                          uploadUrl: '',
                          fileField: 'file',
                          method: 'POST',
                          bodyMode: 'multipart',
                          headers: [],
                          resultType: 'json',
                          resultUrlPath: '',
                          apiKey: '',
                          params: [],
                        },
                      ],
                    },
                  })
                }
              >
                ＋ 新增线上服务
              </button>
              <div className="hint" style={{ marginTop: 12 }}>
                · 软件会自动：上传图片 → 按参数请求 → 下载结果 → 覆盖原文件（其他软件打开即为增强后效果）
                <br />· 线上服务需自备接口（开源/免费增强 API 均可），请遵守其使用条款
              </div>
            </Card>
          )}

          {/* ------------------------------ 壁纸 ------------------------------ */}
          {section === 'wallpaper' && (
            <>
              <Card title="设为壁纸" desc="图片比例与屏幕不同（如竖图做横屏壁纸）时，四周留白的处理方式。">
                <div className="field">
                  <label>留白填充方式</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={settings.wallpaperFill || 'blur'}
                    onChange={(e) => patch({ wallpaperFill: e.target.value as SettingsType['wallpaperFill'] })}
                  >
                    <option value="blur">模糊同图铺底（推荐，同 iOS / macOS 做法）</option>
                    <option value="solid">纯色铺底（取图片主色）</option>
                    <option value="black">纯黑铺底</option>
                  </select>
                  <div className="hint">
                    任意比例的图片都会先合成一张<b>屏幕分辨率的壁纸</b>：原图按原始比例<b>完整居中显示</b>，
                    四周用上面的方式填充 —— 不裁切、不变形、不缩放只显示一部分，始终完整展示
                  </div>
                  </div>
                  </Card>

                  <Card
                  title="多显示器"
                  desc="检测到的显示器，以及多屏时的摆放方式（需要系统支持 IDesktopWallpaper）。"
                  badge={
                    <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
                      检测到 {monitors?.count ?? '…'} 个屏幕
                    </span>
                  }
                  >
                  <div className="field">
                    <label>多屏模式</label>
                    <select
                      className="select"
                      style={{ width: '100%' }}
                      value={settings.wallpaperMode || 'single'}
                      onChange={(e) => patch({ wallpaperMode: e.target.value as SettingsType['wallpaperMode'] })}
                    >
                      <option value="single">主屏一张（默认）</option>
                      <option value="span">跨屏合成一张（多屏无缝衔接同一张图）</option>
                      <option value="per-monitor">每个屏幕不同图片（各自按屏幕比例合成）</option>
                    </select>
                  </div>

                  {!!monitors?.monitors?.length && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9 }}>
                      {monitors.monitors.map((m, i) => (
                        <div key={m.id}>
                          屏幕 {i + 1}：{m.width}×{m.height}
                          {m.x || m.y ? `（位置 ${m.x},${m.y}）` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {(settings.wallpaperMode || 'single') !== 'single' && (monitors?.count ?? 0) <= 1 && (
                    <div className="hint" style={{ color: 'var(--warn)' }}>
                      当前只检测到 1 个显示器，多屏模式会自动回退为「主屏一张」
                    </div>
                  )}

                  <div className="switch-row" style={{ marginTop: 10 }}>
                    <span>多屏时每个屏幕放不同的图</span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.perMonitorDifferent !== false}
                      onChange={(e) => saveAuto({ perMonitorDifferent: e.target.checked })}
                    />
                  </div>
                  </Card>

                  <AppUpdateCard appInfo={appInfo} patch={patch} onToast={onToast} />
                  <Card title="托盘与快捷键" desc="不打开主窗口也能换壁纸。">
                  <div className="switch-row">
                    <span>启用全局快捷键</span>
                    <input
                      type="checkbox"
                      checked={settings.globalShortcuts !== false}
                      onChange={(e) => patch({ globalShortcuts: e.target.checked })}
                    />
                  </div>
                  <div className="hint" style={{ lineHeight: 1.9 }}>
                    · 换一张壁纸：<b>{prettyHotkey(appInfo?.hotkeys?.next) || '未生效'}</b>
                    {appInfo?.hotkeys?.next && appInfo.hotkeys.next !== 'CommandOrControl+Alt+W' && (
                      <span style={{ color: 'var(--warn)' }}>（默认键被其它软件占用，已自动换备用键）</span>
                    )}
                    ，任何窗口下都生效
                    <br />· 收藏当前壁纸：<b>{prettyHotkey(appInfo?.hotkeys?.favorite) || '未生效'}</b>
                    <br />· 唤出主窗口：<b>{prettyHotkey(appInfo?.hotkeys?.window) || '未生效'}</b>
                    <br />· 托盘图标：左键打开窗口，右键可换壁纸 / 收藏 / 不喜欢（排除该图并换下一张）/ 暂停定时切换
                    <br />· 「不喜欢」会自动归因（暗了 / 糊了 / 有噪点 / 闭眼了 / 动作变形…），只针对该原因学习，不会连坐整个来源或关键词
                    {isDesktop && !appInfo?.shortcutEnabled && (
                      <>
                        <br />
                        <span style={{ color: 'var(--warn)' }}>当前已在设置里关闭全局快捷键</span>
                      </>
                    )}
                    {!isDesktop && (
                      <>
                        <br />
                        <span style={{ color: 'var(--muted)' }}>网页模式下没有托盘与全局快捷键（仅桌面端可用）</span>
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      className="btn primary"
                      onClick={async () => {
                        try {
                          const r = await api.favoriteCurrentWallpaper();
                          onToast(`已收藏当前壁纸：${r.title || r.imageId}`);
                        } catch (err) {
                          onToast((err as Error).message);
                        }
                      }}
                    >
                      收藏当前壁纸
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const r = await api.dislikeCurrentWallpaper();
                          const why = (r.learned || []).length ? `（已记录原因：${(r.learned || []).map(reasonLabel).join('、')}）` : '';
                          onToast(`已排除并换了一张${why}`);
                          loadAuto();
                        } catch (err) {
                          onToast((err as Error).message);
                        }
                      }}
                    >
                      不喜欢，换一张
                    </button>
                  </div>
                  </Card>

                  <Card
                    title="动态壁纸"
                    desc="把一扇隐藏窗口挂到桌面图标层后面，做成真正的动态桌面（视频 / 网页 / 相册轮播）。"
                    badge={
                      !isDesktop ? (
                        <span style={{ color: 'var(--warn)', fontSize: 12, fontWeight: 400 }}>仅桌面端可用</span>
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
                          {live?.enabled ? '已开启' : '未开启'}
                        </span>
                      )
                    }
                  >
                    {!isDesktop && (
                      <div className="hint" style={{ color: 'var(--warn)', marginBottom: 10 }}>
                        网页模式下无法把窗口挂到桌面层，请在桌面应用（npm run desktop / npm run dev）中使用此功能。
                      </div>
                    )}
                    <div className="switch-row">
                      <span>开启动态壁纸</span>
                      <input
                        type="checkbox"
                        checked={!!live?.enabled}
                        onChange={(e) => applyLive({ enabled: e.target.checked })}
                      />
                    </div>

                    <div className="field">
                      <label>壁纸类型</label>
                      <select
                        className="select"
                        style={{ width: '100%' }}
                        value={live?.mode || 'slideshow'}
                        onChange={(e) => applyLive({ mode: e.target.value as LiveWallpaperConfig['mode'] })}
                      >
                        <option value="slideshow">相册轮播（从收藏/全库自动播放，带缓慢缩放）</option>
                        <option value="video">本地视频循环（mp4 / webm）</option>
                        <option value="web">网页（任意网址，如网页动画 / 在线壁纸）</option>
                      </select>
                    </div>

                    {live?.mode === 'slideshow' && (
                      <>
                        <div className="field">
                          <label>轮播范围</label>
                          <select
                            className="select"
                            style={{ width: '100%' }}
                            value={live?.scope || 'favorites'}
                            onChange={(e) => applyLive({ scope: e.target.value as LiveWallpaperConfig['scope'] })}
                          >
                            <option value="favorites">仅收藏</option>
                            <option value="all">全库</option>
                            {!!playlists?.length && <option value="playlist">指定清单</option>}
                          </select>
                        </div>
                        {live?.scope === 'playlist' && (
                          <div className="field">
                            <label>选择清单</label>
                            <select
                              className="select"
                              style={{ width: '100%' }}
                              value={live?.playlistId ?? ''}
                              onChange={(e) =>
                                applyLive({ playlistId: e.target.value ? Number(e.target.value) : null })
                              }
                            >
                              <option value="">— 请选择 —</option>
                              {playlists?.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div className="two-col">
                          <div className="field">
                            <label>切换间隔（秒）</label>
                            <input
                              className="input"
                              type="number"
                              min={5}
                              max={600}
                              value={live?.intervalSec ?? 15}
                              onChange={(e) =>
                                applyLive({ intervalSec: Math.max(5, Math.min(600, Number(e.target.value) || 15)) })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>最低评分（0 = 不限）</label>
                            <input
                              className="input"
                              type="number"
                              min={0}
                              max={100}
                              value={live?.minScore ?? 0}
                              onChange={(e) =>
                                applyLive({ minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })
                              }
                            />
                          </div>
                        </div>
                        <div className="switch-row">
                          <span>缓慢缩放（Ken Burns）</span>
                          <input
                            type="checkbox"
                            checked={live?.kenBurns !== false}
                            onChange={(e) => applyLive({ kenBurns: e.target.checked })}
                          />
                        </div>
                      </>
                    )}

                    {live?.mode === 'video' && (
                      <div className="field">
                        <label>视频文件（本地 mp4 / webm）</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            className="input"
                            style={{ flex: 1 }}
                            value={live?.videoPath || ''}
                            placeholder="C:\\Users\\...\\gem.mp4"
                            onChange={(e) => applyLive({ videoPath: e.target.value })}
                          />
                          <button
                            className="btn"
                            onClick={async () => {
                              try {
                                const p = await desktop?.pickFile?.([
                                  { name: '视频', extensions: ['mp4', 'webm', 'mov'] },
                                ]);
                                if (p) applyLive({ videoPath: p });
                              } catch (err) {
                                onToast((err as Error).message);
                              }
                            }}
                          >
                            选择文件
                          </button>
                        </div>
                      </div>
                    )}

                    {live?.mode === 'web' && (
                      <div className="field">
                        <label>网页地址</label>
                        <input
                          className="input"
                          value={live?.webUrl || ''}
                          placeholder="https://..."
                          onChange={(e) => applyLive({ webUrl: e.target.value })}
                        />
                        <div className="hint">注意：很多站点禁止被内嵌（X-Frame-Options），这类网页做不了壁纸</div>
                      </div>
                    )}

                    <div className="field" style={{ marginTop: 6 }}>
                      <label>性能规则（避免抢资源）</label>
                      <div className="switch-row">
                        <span>有全屏应用 / 游戏时暂停</span>
                        <input
                          type="checkbox"
                          checked={live?.pauseOnFullscreen !== false}
                          onChange={(e) => applyLive({ pauseOnFullscreen: e.target.checked })}
                        />
                      </div>
                      <div className="switch-row">
                        <span>笔记本用电池时暂停</span>
                        <input
                          type="checkbox"
                          checked={!!live?.pauseOnBattery}
                          onChange={(e) => applyLive({ pauseOnBattery: e.target.checked })}
                        />
                      </div>
                    </div>
                  </Card>

              <Card
                title="定时自动切换"
                desc="按设定周期，从指定范围内自动更换桌面壁纸。"
                badge={
                  autoStatus?.config?.enabled ? (
                    <span style={{ color: 'var(--ok)', fontWeight: 400, fontSize: 12 }}>● 已启用</span>
                  ) : (
                    <span style={{ color: 'var(--warn)', fontWeight: 400, fontSize: 12 }}>○ 未启用</span>
                  )
                }
              >
                <div className="switch-row">
                  <span>启用自动换壁纸</span>
                  <input
                    type="checkbox"
                    checked={!!autoStatus?.config?.enabled}
                    onChange={(e) => saveAuto({ enabled: e.target.checked })}
                  />
                </div>

                <div className="field">
                  <label>切换频率</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.mode || 'day'}
                    onChange={(e) => saveAuto({ mode: e.target.value as AutoConfig['mode'] })}
                  >
                    <option value="day">每天</option>
                    <option value="week">每周</option>
                    <option value="month">每月</option>
                    <option value="custom">自定义间隔（分钟）</option>
                  </select>
                </div>

                {autoStatus?.config?.mode === 'custom' ? (
                  <div className="field">
                    <label>间隔分钟数</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={autoStatus?.config?.minutes ?? 60}
                      onChange={(e) => saveAuto({ minutes: Math.max(1, Number(e.target.value) || 60) })}
                    />
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <label>执行时刻</label>
                      <input
                        className="input"
                        type="time"
                        value={autoStatus?.config?.atTime || '09:00'}
                        onChange={(e) => saveAuto({ atTime: e.target.value })}
                      />
                    </div>
                    {autoStatus?.config?.mode === 'week' && (
                      <div className="field">
                        <label>星期几</label>
                        <select
                          className="select"
                          style={{ width: '100%' }}
                          value={autoStatus?.config?.weekday ?? 1}
                          onChange={(e) => saveAuto({ weekday: Number(e.target.value) })}
                        >
                          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                            <option key={d} value={d}>
                              星期{'日一二三四五六'[d % 7]}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {autoStatus?.config?.mode === 'month' && (
                      <div className="field">
                        <label>每月几号</label>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={28}
                          value={autoStatus?.config?.dayOfMonth ?? 1}
                          onChange={(e) =>
                            saveAuto({ dayOfMonth: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })
                          }
                        />
                      </div>
                    )}
                  </>
                )}

                <div className="field">
                  <label>切换范围</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.scope || 'favorites'}
                    onChange={(e) => saveAuto({ scope: e.target.value as AutoConfig['scope'] })}
                  >
                    <option value="all">全库</option>
                    <option value="favorites">收藏 / 喜欢</option>
                    <option value="playlist">指定清单</option>
                  </select>
                </div>

                {autoStatus?.config?.scope === 'playlist' && (
                  <div className="field">
                    <label>选择清单</label>
                    <select
                      className="select"
                      style={{ width: '100%' }}
                      value={autoStatus?.config?.playlistId ?? ''}
                      onChange={(e) => saveAuto({ playlistId: Number(e.target.value) || null })}
                    >
                      <option value="">（请选择）</option>
                      {(playlists || []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}（{p.count}）
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="field">
                  <label>切换顺序</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.order || 'smart'}
                    onChange={(e) => saveAuto({ order: e.target.value as AutoConfig['order'] })}
                  >
                    <option value="ai">AI 智能适配（推荐）：知识库评分 + 壁纸适配度 + 时间偏好</option>
                    <option value="smart">智能：高分图片更常出现（用 AI 评分加权）</option>
                    <option value="random">随机（每张等概率）</option>
                    <option value="sequential">按顺序轮流</option>
                  </select>
                  <div className="hint">
                    评分来自知识库（采集时的 AI 打分 + 你的删除反馈），分数越高越容易被抽中，但低分图仍会偶尔出现
                    <br />
                    「AI 智能适配」会额外评估这张图<strong>适不适合做壁纸</strong>（留白、亮度、对比、复杂度，配了视觉模型还会让 AI 看一眼），
                    并按时间挑：白天偏明亮、夜间偏暗色
                  </div>
                </div>

                <div className="field">
                  <label>最低评分（低于该分数不做壁纸，0 = 不限）</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    value={autoStatus?.config?.minScore ?? 0}
                    onChange={(e) => saveAuto({ minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                  />
                </div>

                {/* AI 壁纸闭环开关 */}
                <div className="settings-subtitle" style={{ marginTop: 14 }}>
                  AI 闭环
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label className="switch-row">
                    <span>
                      评估「适不适合做壁纸」（留白 / 亮度 / 构图）
                      <span className="hint">　配了视觉模型时会让 AI 看一眼构图与主体位置</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.useAiFit !== false}
                      onChange={(e) => saveAuto({ useAiFit: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      「不喜欢这张」自动归因并回流知识库
                      <span className="hint">
                        　先推断这张为什么不合适（噪点/光线/闭眼/动作…），只按该原因建规则；不会给整个来源或关键词降分
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.feedbackToKb !== false}
                      onChange={(e) => saveAuto({ feedbackToKb: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      按时间挑图（白天偏亮 / 夜间偏暗）
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.useTimeAware !== false}
                      onChange={(e) => saveAuto({ useTimeAware: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      抽到低清图时先自动增强再设为壁纸
                      <span className="hint">　会慢一些，但桌面不会出现糊图</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.autoEnhance === true}
                      onChange={(e) => saveAuto({ autoEnhance: e.target.checked })}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  <button className="btn primary" onClick={switchNow}>
                    立即切换一张
                  </button>
                  <button className="btn" onClick={() => loadAuto()}>
                    刷新状态
                  </button>
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const r = await api.scanWallpaperFit(120, true);
                        onToast(`已补算 ${r.done} 张壁纸适配度，剩余 ${r.remain} 张`);
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                    title="提前算好候选图的适配度，切换时更快"
                  >
                    补算适配度（120 张）
                  </button>
                </div>

                <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                  · 范围内可用图片：{autoStatus?.scopeCount ?? 0} 张
                  <br />· 下次切换：
                  {autoStatus?.nextRunAt ? formatDate(autoStatus.nextRunAt) : '未安排'}
                  <br />· 上次切换：
                  {autoStatus?.lastLog ? `${autoStatus.lastLog.title || '图片'}（${formatDate(autoStatus.lastLog.appliedAt)}）` : '暂无'}
                </div>

                {wallpaperHistory.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>最近切换记录</div>
                    {wallpaperHistory.slice(0, 5).map((h) => (
                      <div key={h.id} style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.8 }}>
                        {formatDate(h.appliedAt)} · {h.title || `图片 ${h.imageId}`} ·{' '}
                        {h.scope === 'favorites' ? '收藏' : h.scope === 'playlist' ? '清单' : '全库'}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}

          {/* ------------------------------ 网络 ------------------------------ */}
          {section === 'network' && (
            <Card
              title="网络 / 代理"
              desc="采集 Wallhaven 等外网源、AI 接口访问不畅时，配置代理即可。"
              badge={
                <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                  {netModeLabel(net?.mode)}
                </span>
              }
            >
              <div className="field">
                <label>代理模式</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={net?.mode || 'off'}
                  onChange={(e) => setNet((prev) => (prev ? { ...prev, mode: e.target.value } : prev))}
                >
                  {(net?.modes || []).map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              {net && !['off', 'system'].includes(net.mode) && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="field" style={{ flex: 2 }}>
                      <label>主机</label>
                      <input
                        className="input"
                        value={net.host}
                        onChange={(e) => setNet({ ...net, host: e.target.value })}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>端口</label>
                      <input
                        className="input"
                        type="number"
                        value={net.port}
                        onChange={(e) => setNet({ ...net, port: Number(e.target.value) || 0 })}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>用户名（可选）</label>
                      <input
                        className="input"
                        value={net.username}
                        onChange={(e) => setNet({ ...net, username: e.target.value })}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>密码（可选）</label>
                      <input
                        className="input"
                        type="password"
                        value={net.password}
                        onChange={(e) => setNet({ ...net, password: e.target.value })}
                      />
                    </div>
                  </div>
                </>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn"
                  disabled={testingNet}
                  onClick={async () => {
                    if (!net) return;
                    setTestingNet(true);
                    try {
                      await api.saveNetwork(net);
                      const res = await api.testNetwork();
                      if (res.ok) onToast(`网络正常（${res.proxy}，${res.elapsed}ms）`);
                      else onToast(`网络不通（${res.proxy}），详见下方提示`);
                      setNetError(JSON.stringify(res.results, null, 2));
                    } catch (err) {
                      setNetError((err as Error).message);
                    } finally {
                      setTestingNet(false);
                    }
                  }}
                >
                  {testingNet ? '测试中…' : '测试连接'}
                </button>
                <button
                  className="btn primary"
                  onClick={async () => {
                    if (!net) return;
                    const saved = await api.saveNetwork(net);
                    setNet(saved);
                    onToast(saved.applied ? '网络设置已生效' : '已保存（网页模式下代理不生效，请用桌面端）');
                  }}
                >
                  保存并应用
                </button>
              </div>
              {netError && <div className="ai-result">{netError}</div>}
              <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                · 常见本地端口：Clash 7890（HTTP/SOCKS5）、v2rayN 10808（SOCKS5）/ 10809（HTTP）
                <br />· 建议同时勾选 Wallhaven 等外网来源后再开代理采集
                <br />· 系统代理（自动）会跟随 Windows 的代理设置
              </div>
            </Card>
          )}

          {/* --------------------------- 数据与维护 --------------------------- */}
          {section === 'data' && (
            <>
              <Card title="图库维护" desc="本地素材导入与初始化。">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button className="btn" onClick={runImport} disabled={importing}>
                    {importing ? '导入中…' : '导入工作区本地素材'}
                  </button>
                  <button className="btn" onClick={runSeed}>
                    <IconDownload /> 下载初始素材（6 张 4K）
                  </button>
                  <button className="btn danger" onClick={clearAll}>
                    <IconTrash /> 清空图库
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 14, lineHeight: 1.9 }}>
                  · 采集到的图片直接写入「通用」里设置的本地文件夹，可用资源管理器直接访问
                  <br />· 本地已有素材按原路径登记并生成缩略图，不复制原文件
                  <br />· 大图预览中可一键「设为桌面壁纸」「在文件夹中显示」
                </div>
              </Card>

              <RecycleBinCard onLibraryChanged={onLibraryChanged} onToast={onToast} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
