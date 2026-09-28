import { app, BrowserWindow, Menu, Tray, globalShortcut, dialog, ipcMain, shell, screen, powerMonitor, nativeTheme, crashReporter } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT_DIR = path.resolve(__dirname, '..');

export const APP_NAME = '图库';
export const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');

app.setName(APP_NAME);
app.setAppUserModelId('com.gem.gallery.wallpaper');

/* ------------------------- 崩溃捕获与日志落盘（最先初始化） ------------------------- */
// minidump 只落本地 userData/CrashReports，不上传（隐私优先）；配合日志可定位白屏 / 闪退
try {
  crashReporter.start({ uploadToServer: false });
} catch {
  /* 部分平台不支持，忽略 */
}
initLogger(app.isPackaged ? app.getPath('userData') : APP_ROOT_DIR);
process.on('uncaughtException', (err) => {
  console.error('[desktop] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[desktop] unhandledRejection:', err);
});

/**
 * 打包后应用代码位于只读的 app.asar 内，数据库 / 缩略图 / AI 运行库必须写到可写目录。
 * 这里在「服务端模块被加载之前」注入目录，服务端因此改为动态 import：
 * 主进程必须等入口模块求值完成才会启动事件循环，若在模块顶层 await import('electron')
 * 会形成死锁（表现为进程活着但无窗口、无端口、无子进程）。
 */
process.env.GEM_USER_DATA = app.isPackaged ? app.getPath('userData') : APP_ROOT_DIR;
process.env.GEM_PACKAGED = app.isPackaged ? '1' : '';
// 默认图片保存位置：用户「图片」目录下的「图库」文件夹。
// 不再写死具体路径——任何人安装后都能在设置页改成自己想要的任意文件夹。
process.env.GEM_DEFAULT_STORAGE_DIR = path.join(app.getPath('pictures'), '图库');

// 服务端相关能力（在 app ready 后动态加载）
let startServer = null;
let getSettings = () => ({ storageDir: '' });
let ipcStorageRoot = ''; // 缩略图/回收站所在的应用数据 storage 根（config.js STORAGE_DIR）
let applyProxy = async () => {};
let registerProxyAuth = () => {};
let desktopApi = null; // 桌面层挂载等能力（attachLiveWindow 等）

// 只允许一个实例：第二次启动直接退出，并把已有窗口带到前台
// （两个实例会同时读写同一个数据库与图片文件，容易互相锁住）
let mainWindow = null;
let serverPort = 0;
let forceQuit = false;
let weiboWin = null; // 微博登录小窗（用完即关）

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/** 本地 API 鉴权令牌（app ready 后从 server/config.js 读入，见 fetchJson） */
let apiToken = '';

/** 给本机 API 的 URL 追加 ?token=（下载直链等无法自定义 header 的请求用） */
function withApiToken(url) {
  if (!apiToken || !/^https?:/i.test(url)) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('token')) u.searchParams.set('token', apiToken);
    return u.toString();
  } catch {
    return url;
  }
}

/** 任务进行中时拦截退出（任务管理器、强制关机等系统级手段无法拦截，属正常） */
async function fetchJson(url, init = {}, timeoutMs = 2500) {
  // Node fetch 不带 Sec-Fetch 头，必须显式带 Bearer 令牌过 /api 鉴权
  const headers = { ...(init.headers || {}) };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

async function busyTasks() {
  const tasks = [];
  if (!serverPort) return tasks;
  try {
    const crawl = await fetchJson(`http://127.0.0.1:${serverPort}/api/crawl/status`);
    if (crawl?.running) tasks.push('图片采集');
  } catch {}
  try {
    const imp = await fetchJson(`http://127.0.0.1:${serverPort}/api/import/status`);
    if (imp?.running) tasks.push('本地素材导入');
  } catch {}
  try {
    const enh = await fetchJson(`http://127.0.0.1:${serverPort}/api/enhance/job`);
    if (enh?.running) tasks.push('画质增强');
  } catch {}
  return tasks;
}

async function confirmExitWhileBusy() {
  if (forceQuit) return true;
  const tasks = await busyTasks();
  if (!tasks.length) return true;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '任务进行中',
    message: `有任务正在进行：${tasks.join('、')}`,
    detail: '现在退出会中断任务，可能导致部分图片未完成下载或入库。确定要退出吗？',
    buttons: ['继续运行（不退出）', '仍然退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

/** 不显示原生菜单栏（顶部「文件 / 视图 / 帮助」由应用内界面承担）。
 *  常用的开发者快捷键改为窗口级快捷键，保持调试便利。 */
function buildMenu() {
  Menu.setApplicationMenu(null);
}

/** 窗口级快捷键（替代原菜单加速键） */
function registerShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    if (ctrl && key === 'r') {
      win.webContents.reload();
      event.preventDefault();
    } else if (ctrl && input.key === '0') {
      win.webContents.setZoomLevel(0);
      event.preventDefault();
    } else if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

/** 开发用：让桌面窗口加载 Vite 开发服务器（前端热更新），API 走 npm run dev 起的 3001。
 *  打包版一律忽略：--dev-url / GEM_DEV_URL 可加载任意远程页面且携带完整桥接，绝不能在生产生效。 */
function devServerUrl() {
  if (app.isPackaged) return '';
  const arg = process.argv.find((a) => a.startsWith('--dev-url='));
  return arg ? arg.slice('--dev-url='.length) : process.env.GEM_DEV_URL || '';
}

async function createWindow() {
  const externalDev = devServerUrl();
  if (externalDev) {
    // 已有外部服务端（npm run dev），不再自起一个
    serverPort = Number(process.env.GEM_API_PORT || 3001);
  } else {
    try {
      const { port } = await startServer(0, { desktop: true });
      serverPort = port;
    } catch (err) {
      // 随机端口几乎不会冲突，失败通常是防火墙/安全软件拦截监听：给出明确提示而不是白屏
      console.error('[desktop] 本地服务启动失败:', err);
      dialog.showErrorBox(
        '图库服务启动失败',
        `本地服务未能启动：${err?.message || err}\n\n请重启应用；若反复出现，请检查防火墙或安全软件是否拦截了本机监听。`
      );
      app.exit(1);
      return;
    }
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: `${APP_NAME} · 邓紫棋照片采集器`,
    icon: APP_ICON,
    backgroundColor: '#0a0a12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerShortcuts(mainWindow);

  const devUrl = devServerUrl();
  const url = devUrl || `http://127.0.0.1:${serverPort}`;
  console.log('[desktop] 加载', url);
  if (devUrl) {
    // 开发模式：Vite 可能还没起来，失败就重试，避免白屏
    let lastErr = null;
    for (let i = 0; i < 40; i++) {
      try {
        await mainWindow.loadURL(url);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastErr) {
      console.error('[desktop] 开发服务器未就绪：', lastErr.message);
      await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`).catch(() => {});
    }
  } else {
    await mainWindow.loadURL(url);
  }
  mainWindow.show();

  // 不新建窗口：下载类链接交给下载管理器，其他链接交给系统浏览器
  // （原来 window.open 会拉出一个空白窗口）
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.includes('/api/')) {
      mainWindow.webContents.downloadURL(target);
    } else if (/^https?:/i.test(target)) {
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  // 下载时自己弹「另存为」：显式决定保存位置，取消就取消下载
  mainWindow.webContents.session.on('will-download', async (_e, item) => {
    let name = 'download';
    try {
      name = item.getFilename() || name;
    } catch {}
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: path.join(app.getPath('downloads'), name),
      buttonLabel: '保存',
    });
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
  });

  // 诊断：渲染进程 / GPU 进程异常退出时打印原因，便于排查白屏
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[desktop] 渲染进程崩溃:', details.reason, details.exitCode);
  });
  app.on('child-process-gone', (_e, details) => {
    console.error('[desktop] 子进程退出:', details.type, details.reason, details.exitCode);
  });
  // 兼容新旧两种签名（Electron 44 起改为事件对象）
  mainWindow.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const level = typeof ev?.level === 'number' ? ev.level : args[1];
    const message = ev?.message ?? args[2] ?? '';
    const line = ev?.lineNumber ?? args[3] ?? 0;
    const sourceId = ev?.sourceId ?? args[4] ?? '';
    if (level >= 3) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('close', async (e) => {
    if (forceQuit) return;
    e.preventDefault();
    const ok = await confirmExitWhileBusy();
    if (!ok) return;
    forceQuit = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    app.quit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* --------------------------- 托盘与全局快捷键 --------------------------- */

let tray = null;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 通过本地接口操作壁纸（托盘菜单与全局快捷键共用） */
async function wallpaperAction(kind) {
  if (!serverPort) return null;
  const path =
    kind === 'now'
      ? '/api/wallpaper/now'
      : kind === 'favorite'
        ? '/api/wallpaper/current/favorite'
        : '/api/wallpaper/current/dislike';
  try {
    return await fetchJson(`http://127.0.0.1:${serverPort}${path}`, { method: 'POST' }, 30000);
  } catch (err) {
    console.error('[wallpaper] 操作失败：', err?.message || err);
    return null;
  }
}

/** 托盘图标：不打开主窗口也能换壁纸、收藏当前壁纸 */
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(APP_ICON);
  } catch (err) {
    console.error('[tray] 托盘创建失败：', err?.message || err);
    return;
  }
  tray.setToolTip(`${APP_NAME} · 邓紫棋照片采集器`);

  const refreshMenu = async () => {
    if (!tray || tray.isDestroyed()) return;
    let cur = {};
    let auto = {};
    let live = {};
    try {
      cur = (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/current`)) || {};
    } catch {}
    try {
      auto = (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/auto`))?.config || {};
    } catch {}
    try {
      live = (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/live`)) || {};
    } catch {}
    const title = String(cur.title || '').slice(0, 16);
    const menu = Menu.buildFromTemplate([
      { label: '打开主窗口', click: showMainWindow },
      { type: 'separator' },
      { label: '换一张壁纸　Ctrl+Alt+W', click: () => wallpaperAction('now') },
      {
        label: title ? `收藏当前壁纸（${title}）` : '收藏当前壁纸',
        enabled: !!cur.imageId,
        click: () => wallpaperAction('favorite'),
      },
      {
        label: '不喜欢，换一张',
        enabled: !!cur.imageId,
        click: () => wallpaperAction('dislike'),
      },
      { type: 'separator' },
      {
        label: live.enabled ? '关闭动态壁纸' : '开启动态壁纸',
        click: async () => {
          try {
            // 只保存配置，真正的创建/销毁由 liveBus 广播触发
            await fetchJson(
              `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !live.enabled }),
              }
            );
          } catch (err) {
            console.error('[tray] 动态壁纸切换失败：', err?.message || err);
          }
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: auto.enabled ? '暂停定时切换' : '启用定时切换',
        click: async () => {
          try {
            await fetchJson(
              `http://127.0.0.1:${serverPort}/api/wallpaper/auto`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !auto.enabled }),
              }
            );
          } catch (err) {
            console.error('[tray] 切换定时失败：', err?.message || err);
          }
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          forceQuit = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };

  tray.on('click', showMainWindow);
  refreshMenu();
  setInterval(refreshMenu, 30000); // 让菜单里的「当前壁纸」保持最新
  console.log('[tray] 托盘已就绪（左键打开窗口 / 右键菜单）');
}

/** 已成功注册的全局快捷键（键名 → 加速键），界面上会显示实际生效的那一组 */
const registeredHotkeys = {};

/**
 * 全局快捷键：别的窗口聚焦时也能换壁纸。
 * 默认键可能被其它软件占用，这里按候选顺序回退，并把实际生效的键回传给界面。
 */
function registerGlobalShortcuts() {
  if (getSettings().globalShortcuts === false) {
    console.log('[shortcut] 已按设置关闭全局快捷键');
    return;
  }
  const handlers = {
    next: () => wallpaperAction('now'),
    favorite: () => wallpaperAction('favorite'),
    window: showMainWindow,
    live: async () => {
      try {
        const cfg = await getLiveCfg();
        const enabled = !(cfg.enabled === true);
        // 只保存配置，真正的创建/销毁由 liveBus 广播触发
        await fetchJson(
          `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) },
          5000
        ).catch(() => {});
      } catch (err) {
        console.error('[shortcut] 动态壁纸切换失败：', err?.message || err);
      }
    },
  };
  const candidates = {
    next: ['CommandOrControl+Alt+W', 'CommandOrControl+Alt+Shift+W', 'CommandOrControl+Shift+F10'],
    favorite: ['CommandOrControl+Alt+F', 'CommandOrControl+Alt+Shift+F', 'CommandOrControl+Shift+F11'],
    window: ['CommandOrControl+Alt+G', 'CommandOrControl+Alt+Shift+G', 'CommandOrControl+Shift+F12'],
    live: ['CommandOrControl+Alt+V', 'CommandOrControl+Alt+Shift+V', 'CommandOrControl+Shift+F9'],
  };
  for (const [action, list] of Object.entries(candidates)) {
    for (const acc of list) {
      try {
        if (globalShortcut.register(acc, handlers[action])) {
          registeredHotkeys[action] = acc;
          break;
        }
      } catch (err) {
        console.warn('[shortcut] 注册异常：', acc, err?.message || err);
      }
    }
    if (!registeredHotkeys[action]) console.warn('[shortcut] 候选键全部被占用：', action);
  }
  console.log('[shortcut] 已注册：', JSON.stringify(registeredHotkeys));
}

/* ----------------------------- 动态壁纸窗口 ----------------------------- */
// 把一扇无边框、不接收鼠标、不进任务栏的窗口挂到桌面图标层（WorkerW）后面，
// 做成真正的动态桌面。由设置页/托盘/快捷键控制开关。

let liveWindow = null;
let livePerfTimer = null;
/** 副屏位移补偿：挂到桌面层后窗口原点可能被系统当作 (0,0)，这里记录真实位置用于暂停判断 */
let liveBounds = { x: 0, y: 0, width: 0, height: 0 };

/** 覆盖整个虚拟屏幕（多屏拼接）的矩形 */
function virtualScreenBounds() {
  const displays = screen.getAllDisplays();
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function createLiveWindow() {
  if (liveWindow && !liveWindow.isDestroyed()) return liveWindow;
  const b = virtualScreenBounds();
  liveBounds = b;
  liveWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    enableLargerThanScreen: true,
    webPreferences: {
      // 安全：这里绝不能挂 preload.cjs —— web 模式下本窗口加载的是用户配置的
      // 任意远程网址，挂了桥接等于把完整 desktopAPI（打开文件夹/下载/截图/
      // 微博登录…）暴露给不可信页面。壁纸渲染页(/live)是自绘 HTML，也不需要桥。
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  liveWindow.setBounds(b);
  liveWindow.setSkipTaskbar(true);
  liveWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 点击穿透：壁纸不拦截桌面操作
  liveWindow.setIgnoreMouseEvents(true);
  // 主窗口关闭时这个窗口不能阻止退出；单独 destroy 即可
  liveWindow.on('closed', () => {
    liveWindow = null;
  });
  return liveWindow;
}

/** 把 Electron 窗口句柄还原成正确的 64 位整数（十进制字符串）。
 *  getNativeWindowHandle() 返回的是原生字节序（小端）Buffer，
 *  若 .toString('hex') 后直接用 [long]::Parse(hex) 解析会被当成大端，得到错误句柄。
 *  这里直接按小端读出数值并以十进制传给 C#，彻底规避字节序问题。 */
function nativeHandleDecimal(win) {
  const buf = win.getNativeWindowHandle();
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 8) return b.readBigUInt64LE(0).toString();
  if (b.length === 4) return b.readUInt32LE(0).toString();
  return '0';
}

function destroyLiveWindow() {
  stopLivePerfRules();
  if (liveWindow && !liveWindow.isDestroyed()) {
    const h = nativeHandleDecimal(liveWindow);
    desktopApi?.detachLiveWindow(h).catch(() => {});
    try {
      liveWindow.destroy();
    } catch {}
  }
  liveWindow = null;
}

/** 把动态壁纸窗口挂到桌面层并铺满虚拟屏幕 */
async function mountLiveWindow() {
  if (!liveWindow || liveWindow.isDestroyed()) return false;
  const b = liveBounds;
  const h = nativeHandleDecimal(liveWindow);
  console.log('[live-debug] mount hwnd=', h, 'w=', b.width, 'h=', b.height);
  const ok = await desktopApi?.attachLiveWindow(h, b.width, b.height).catch((e) => { console.log('[live-debug] attach err', e?.message); return false; });
  console.log('[live-debug] attach ok=', ok);
  if (ok) {
    // 注意：挂载（SetParent + WS_CHILD）之后不要再调用 setBounds/showInactive，
    // 否则 Chromium 会重新认领父窗口、把刚挂到 WorkerW 的窗口还原回顶层，导致重新变成顶层窗口。
    // Attach 内部的 SetWindowPos(SWP_SHOWWINDOW) 已经负责显示与铺满。
    startLivePerfRules();
  } else {
    console.warn('[live] 挂载到桌面层失败（系统可能不支持，窗口已隐藏）');
    try {
      liveWindow.hide();
    } catch {}
  }
  return !!ok;
}

/** 性能规则：全屏应用 / 笔记本用电池 / 锁屏 时自动暂停动态壁纸 */
function startLivePerfRules() {
  stopLivePerfRules();
  const pause = (on) =>
    liveWindow?.webContents
      ?.executeJavaScript(`window.__live && window.__live.pause(${on})`)
      .catch(() => {});
  livePerfTimer = setInterval(async () => {
    if (!liveWindow || liveWindow.isDestroyed()) return;
    const cfg = await getLiveCfg();
    let shouldPause = false;
    if (cfg.pauseOnBattery && powerMonitor && !powerMonitor.isOnAC) shouldPause = true;
    if (cfg.pauseOnFullscreen && desktopApi) {
      try {
        if (await desktopApi.isFullscreenAppRunning()) shouldPause = true;
      } catch {}
    }
    pause(shouldPause);
  }, 3000);
  // 锁屏/休眠暂停，解锁后由轮询自动恢复
  powerMonitor?.on('lock-screen', () => pause(true));
  powerMonitor?.on('suspend', () => pause(true));
}

function stopLivePerfRules() {
  if (livePerfTimer) {
    clearInterval(livePerfTimer);
    livePerfTimer = null;
  }
}

/** 读最新动态壁纸配置（直接走本地接口，保证拿到刚保存的值） */
async function getLiveCfg() {
  if (!serverPort) return {};
  try {
    return (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/live`, {}, 5000)) || {};
  } catch {
    return {};
  }
}

/** 根据配置创建 / 销毁动态壁纸窗口，并加载对应内容 */
async function applyLiveWallpaper() {
  if (process.platform !== 'win32') {
    console.log('[live] 动态壁纸目前仅支持 Windows，已跳过');
    return;
  }
  const cfg = await getLiveCfg();
  if (!cfg || cfg.enabled === false) {
    destroyLiveWindow();
    return;
  }
  if (!liveWindow || liveWindow.isDestroyed()) {
    createLiveWindow();
  }
  // web 模式直接加载网址；其它模式用内置渲染页（/live 会按配置渲染）。
  // /live 页的 fetch 走 ?token= 传递鉴权（见 server/live-page.js）
  const url =
    cfg.mode === 'web' && cfg.webUrl
      ? cfg.webUrl
      : `http://127.0.0.1:${serverPort}/live?token=${encodeURIComponent(apiToken)}`;
  try {
    if (liveWindow.webContents.getURL() !== url) await liveWindow.loadURL(url);
    // 页面加载后再挂载，避免挂载时还没渲染
    await new Promise((r) => setTimeout(r, 1200));
    await mountLiveWindow();
    // 让页面立即按最新配置渲染（覆盖模式切换：slideshow ↔ video 无需整窗重载）
    liveWindow.webContents
      .executeJavaScript(`window.__live && window.__live.apply && window.__live.apply()`)
      .catch(() => {});
  } catch (err) {
    console.error('[live] 启动失败：', err?.message || err);
  }
}

// 设置变更 / 托盘 / 快捷键 通过 IPC 触发（只负责保存，真正动作由 liveBus 广播）
/**
 * 微博登录小窗：打开 m.weibo.cn 登录页让用户登录，登录成功后自动把整段 Cookie 返回
 * 给渲染进程，省去用户手动 F12 复制的麻烦。
 *
 * 关键点（踩过坑）：SUB Cookie 在登录跳转过程中会提前出现，拿到后又被微博作废，
 * 必须等 Cookie 快照连续两次稳定、且用真实接口验证通过（ok=1）才算抓取成功；
 * 同时把登录会话的 User-Agent 一起返回——微博风控会把登录态与 UA 绑定，
 * 采集请求必须用同一个 UA（crawler.searchWeibo 通过 settings.weiboUserAgent 复用）。
 */
async function weiboLoginFlow() {
  if (weiboWin && !weiboWin.isDestroyed()) {
    weiboWin.show();
    weiboWin.focus();
    return { ok: false, msg: '登录窗口已打开，请完成登录' };
  }
  weiboWin = new BrowserWindow({
    width: 1020,
    height: 740,
    title: '登录微博（登录成功后自动获取 Cookie）',
    parent: mainWindow,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'weibo-login' },
  });
  const ses = weiboWin.webContents.session;
  // HTTP 头只允许 latin1：app.setName('图库') 会把中文应用名带进 Electron 默认 UA，
  // 直接用作 fetch 请求头会报 ByteString 错误（之前窗口不自动关闭的元凶），
  // 非 ASCII 字符统一百分号编码后再使用
  const ua = ses.getUserAgent().replace(/[^\x00-\xff]/g, (ch) => encodeURIComponent(ch));
  // 清掉上次残留的过期登录态，确保拿到的是本次登录的 Cookie
  await ses.clearStorageData({ storages: ['cookies'] }).catch(() => {});
  await weiboWin.loadURL('https://passport.weibo.cn/signin/login');

  let settled = false;
  return await new Promise((resolve) => {
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(r);
      if (weiboWin && !weiboWin.isDestroyed()) weiboWin.close();
    };
    let verifying = false;
    let lastVerifyAt = 0;
    // 用登录会话同款 UA 请求真实接口，ok=1 才算登录态有效
    const verifyCookie = async (str) => {
      try {
        const cid = '100103type%3D1%26q%3D' + encodeURIComponent('邓紫棋');
        const res = await fetch(`https://m.weibo.cn/api/container/getIndex?containerid=${cid}&page_type=searchall&page=1`, {
          headers: {
            'User-Agent': ua,
            Referer: `https://m.weibo.cn/search?containerid=${cid}`,
            'X-Requested-With': 'XMLHttpRequest',
            'MWeibo-Pwa': '1',
            Accept: 'application/json, text/plain, */*',
            Cookie: str,
          },
        });
        const json = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
        return json?.ok === 1;
      } catch {
        return false; // 网络抖动时不判定失败，继续轮询
      }
    };
    const grab = async () => {
      if (verifying) return;
      try {
        const cookies = await ses.cookies.get({});
        // 已登录标志：SUB 出现；只取 weibo.cn 系域的 Cookie
        // 注意：MLOGIN 在已登录会话里可能仍是 0，不能作为登录判据，最终以接口验证为准
        if (!cookies.some((c) => c.name === 'SUB')) return;
        const seen = new Set();
        const str = cookies
          .filter((c) => /weibo\.cn$/i.test(c.domain))
          .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
          // Electron 返回的 Cookie 值是解码后的原文，部分 Cookie（浏览页面后种下）含中文等
          // 非 ASCII 字符，直接放进请求头会报 ByteString 错误；HTTP 头要求 latin1，重新编码
          // 名称含非 ASCII 的属于畸形 Cookie（多为追踪器写入），无法安全放进请求头，直接跳过
          .map((c) => {
            if (!/^[\x00-\xff]*$/.test(c.name)) return '';
            return `${c.name}=${/^[\x00-\xff]*$/.test(c.value) ? c.value : encodeURIComponent(c.value)}`;
          })
          .filter(Boolean)
          .join('; ');
        if (!str) return;
        // 不做快照稳定性判断：m.weibo.cn 会周期性轮换 XSRF-TOKEN，Cookie 串一直在变，
        // 等它稳定会永远等不到。直接以接口验证为准（验证通过的那份串就是要保存的串）。
        if (Date.now() - lastVerifyAt < 3000) return; // 节流，避免高频打微博接口
        lastVerifyAt = Date.now();
        verifying = true;
        const ok = await verifyCookie(str);
        verifying = false;
        if (ok) finish({ ok: true, cookie: str, ua });
      } catch {}
    };
    const timer = setInterval(grab, 1500);
    // SPA 登录可能不触发 did-navigate，轮询兜底；两个导航钩子只是加快取到
    weiboWin.webContents.on('did-navigate', grab);
    weiboWin.webContents.on('did-frame-finish-load', grab);
    weiboWin.on('closed', () => {
      weiboWin = null;
      finish({ ok: false, msg: '已取消登录' });
    });
  });
}

// 设置变更 / 托盘 / 快捷键 通过 IPC 触发（只负责保存，真正动作由 liveBus 广播）
ipcMain.handle('get-api-token', () => apiToken);
// 开机自启：写系统登录项（用户可在设置页开关；随设置持久化到 settings）
ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-auto-launch', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});
// 检查更新：读 GitHub latest release 与本机版本比较，有新版就给出下载链接（不自动静默更新，
// 个人分发没有更新服务器；用户自己决定何时升级）
ipcMain.handle('check-for-updates', async () => {
  try {
    const cfg = await fetchJson(
      `http://127.0.0.1:${serverPort}/api/settings`,
      { method: 'GET' },
      8000
    );
    const repo = String(cfg?.updateRepo || process.env.GEM_UPDATE_REPO || '').trim();
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { ok: false, msg: '未配置更新源（设置 updateRepo，如 user/repo）' };
    }
    const rel = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, { method: 'GET' }, 15000);
    const latest = String(rel?.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    const isNewer = (a, b) => {
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
      }
      return false;
    };
    return {
      ok: true,
      hasUpdate: isNewer(latest, current),
      latest,
      current,
      url: rel?.html_url || `https://github.com/${repo}/releases/latest`,
    };
  } catch (err) {
    return { ok: false, msg: String(err?.message || err).slice(0, 160) };
  }
});
ipcMain.handle('live-wallpaper-control', async (_e, patch) => {
  await fetchJson(
    `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch || {}) },
    5000
  ).catch(() => {});
  return { ok: true };
});

app.whenReady().then(async () => {
  // 第二个实例不再初始化服务与窗口
  if (!gotSingleInstanceLock) return;

  // 目录环境变量已在模块顶层设置，这里再加载服务端（此时数据目录已就绪）。
  // 双进程同时启动会短暂抢数据库锁：加载失败（locked）时重试几次
  let mods = null;
  for (let attempt = 0; !mods; attempt++) {
    try {
      mods = await Promise.all([
        import('../server/app.js'),
        import('../server/db.js'),
        import('../server/network.js'),
        import('../server/desktop.js'),
        import('../server/config.js'),
      ]);
    } catch (err) {
      if (attempt >= 5 || !String(err?.message || '').includes('locked')) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const [appMod, dbMod, netMod, desktopMod, configMod] = mods;
  startServer = appMod.startServer;
  getSettings = dbMod.getSettings;
  ipcStorageRoot = configMod.STORAGE_DIR || '';
  applyProxy = netMod.applyProxy;
  registerProxyAuth = netMod.registerProxyAuth;
  desktopApi = desktopMod;
  apiToken = configMod.API_TOKEN || '';

  // 配置变更（来自设置页 HTTP 保存、托盘、快捷键）统一走事件总线，主进程据此创建/销毁动态壁纸窗口
  const { liveBus } = await import('../server/live-bus.js');
  liveBus.on('changed', (cfg) => {
    try {
      if (!cfg || cfg.enabled === false) destroyLiveWindow();
      else applyLiveWallpaper();
    } catch (err) {
      console.error('[live] 应用配置失败：', err?.message || err);
    }
  });

  buildMenu();
  registerProxyAuth();
  await applyProxy();

  // 启动时按设置同步开机自启（用户改了设置就立即生效，无需重启）
  try {
    app.setLoginItemSettings({ openAtLogin: !!getSettings().autoLaunch, args: ['--hidden'] });
  } catch (err) {
    console.error('[desktop] 设置开机自启失败:', err);
  }
  ipcMain.handle('app-info', () => ({
    hotkeys: registeredHotkeys,
    shortcutEnabled: getSettings().globalShortcuts !== false,
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片保存文件夹',
      defaultPath: getSettings().storageDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 原生控件（<select> 下拉弹层等）跟随应用主题，避免暗色界面弹出自带白底的系统弹层
  nativeTheme.themeSource = 'dark';
  ipcMain.handle('set-theme', (_e, theme) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'system';
    return nativeTheme.themeSource;
  });
  ipcMain.handle('get-theme', () => nativeTheme.themeSource);

  /* IPC 路径白名单：只放行应用实际管理的两个根目录（用户图片库 storageDir
   * 与应用数据 storage 根[缩略图/回收站]），防止渲染层被注入后借 IPC
   * 任意打开资源管理器 / 定位本机文件 */
  const pathAllowed = (p) => {
    if (typeof p !== 'string' || !p.trim()) return false;
    const roots = [getSettings().storageDir, ipcStorageRoot].filter(Boolean).map((r) => path.resolve(r));
    if (!roots.length) return false;
    const target = path.resolve(p);
    return roots.some((root) => {
      const rel = path.relative(root, target);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  };

  ipcMain.handle('open-folder', async (_e, p) => {
    const target = p || getSettings().storageDir;
    if (!pathAllowed(target)) {
      console.warn('[ipc] open-folder 拒绝白名单外路径:', p);
      return '路径不在应用管理的目录内，已拒绝打开';
    }
    const err = await shell.openPath(target);
    return err || null;
  });

  ipcMain.handle('reveal-file', async (_e, p) => {
    if (!pathAllowed(p)) {
      console.warn('[ipc] reveal-file 拒绝白名单外路径:', p);
      return false;
    }
    shell.showItemInFolder(p);
    return true;
  });

  // 吸管取色截图：直接抓本应用窗口内容（设备分辨率、无几何换算、零延迟）。
  // 之前用 desktopCapturer 截全屏再裁剪，在多屏/缩放环境下返回尺寸不可控，
  // 裁剪坐标错乱导致覆盖层画面整体缩小错位（「迷你窗口」bug）。
  ipcMain.handle('screen-capture', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const img = await mainWindow.webContents.capturePage();
    return { dataUrl: img.toDataURL() };
  });

  // 选择单个文件（动态壁纸视频等）；filters 形如 [{ name: '视频', extensions: ['mp4','webm'] }]
  ipcMain.handle('pick-file', async (_e, filters) => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件',
      defaultPath: getSettings().storageDir,
      properties: ['openFile'],
      filters: Array.isArray(filters) ? filters : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 微博 Cookie：打开内置登录窗口，登录后自动回传
  ipcMain.handle('weibo-login', () => weiboLoginFlow());

  // 用 Electron 下载管理器下载（弹「另存为」；不会产生空白窗口，也不影响当前页面）。
  // 只允许本机 server 的资源：被注入的渲染层不能借它把任意外部文件拉到用户磁盘
  ipcMain.handle('download-file', async (_e, url) => {
    if (!url || !mainWindow || mainWindow.isDestroyed()) return false;
    const absolute = /^https?:/i.test(url)
      ? new URL(url, `http://127.0.0.1:${serverPort}`).toString()
      : `http://127.0.0.1:${serverPort}${url.startsWith('/') ? '' : '/'}${url}`;
    if (!new URL(absolute).host.includes('127.0.0.1')) {
      console.warn('[ipc] download-file 拒绝非本机地址:', url);
      return false;
    }
    // 下载请求由主进程发起，带不上页面的 Authorization 头，改走 ?token=
    mainWindow.webContents.downloadURL(withApiToken(absolute));
    return true;
  });

  await createWindow();

  createTray();
  registerGlobalShortcuts();
  // 若上次退出时开着动态壁纸，则自动恢复
  applyLiveWallpaper();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  destroyLiveWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
