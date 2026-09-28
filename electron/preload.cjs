const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  revealFile: (p) => ipcRenderer.invoke('reveal-file', p),
  // 走 Electron 下载管理器（弹「另存为」），避免 window.open 产生空白窗口
  download: (url) => ipcRenderer.invoke('download-file', url),
  // 桌面端信息：实际生效的全局快捷键等（被其它软件占用时会自动换备用键）
  appInfo: () => ipcRenderer.invoke('app-info'),
  // 保存并应用动态壁纸配置（主进程据此创建/销毁桌面层窗口）
  controlLiveWallpaper: (patch) => ipcRenderer.invoke('live-wallpaper-control', patch),
  // 选择单个文件（如动态壁纸视频）
  pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
  // 微博 Cookie：打开内置登录窗口，登录成功后自动回传整段 Cookie
  weiboLogin: () => ipcRenderer.invoke('weibo-login'),
  // 同步原生控件（下拉弹层等）主题：dark / light / system
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  // 全屏截图（吸管取色）：返回 { dataUrl, x, y, width, height, scale }
  screenCapture: () => ipcRenderer.invoke('screen-capture'),
  // 本地 API 鉴权令牌（渲染进程的 fetch 需要带 Bearer 头）
  getApiToken: () => ipcRenderer.invoke('get-api-token'),
  // 开机自启开关（读/写系统登录项）
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  // 检查更新：{ ok, hasUpdate, latest, current, url } 或 { ok: false, msg }
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
});
