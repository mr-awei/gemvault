# 图库

**桌面应用（Electron）**：多源采集、去重、筛选、浏览与管理本地高清图片，图片**直接保存到本地文件夹**，可一键设为桌面壁纸。
技术栈：**Electron + Node 22+（内置 `node:sqlite`）+ Express 5 + sharp + React 18 + Vite 6**，无需外部数据库。

## 启动桌面应用

```bash
npm install            # 仓库根目录执行（应用代码就在本仓库内，无需进入子目录）
npm run desktop        # 先构建前端，再启动 Electron 窗口
```

首次启动后：设置 →「本地保存文件夹」→ 选择你要存放照片的目录（默认 `图片\G.E.M. 邓紫棋`）。
采集到的图片会以 `关键词_来源_宽x高_时间.jpg` 直接写入该目录，可用资源管理器直接浏览。

其它命令：

```bash
npm run desktop:dev    # 已构建过前端，只启动 Electron
npm start              # 网页模式（浏览器访问 http://localhost:3001）
npm run dev            # 前端热更新 http://localhost:5173 + 后端 :3001
```

> 首次启动且图库为空时，会自动把工作区根目录下的已有素材（`*.jpg/png/webp`、`raw/`、`enhanced/`）登记入库，
> 344 张本地素材经 pHash 去重后保留 174 张，并生成缩略图。

## 功能

| 模块 | 说明 |
|---|---|
| 多源采集 | 必应图片 / 百度图片 / 搜狗图片 / Wallhaven，关键词可增删改，每关键词可配置页数；**边搜边下载**，双进度条（搜索 / 下载）+ 当前位置 + 失败明细（含原因），已下载 URL 自动跳过（增量采集） |
| 网络代理 | 设置 → 网络/代理：关闭 / 系统代理 / HTTP / HTTPS / SOCKS5 / SOCKS4 + 主机、端口、账号密码、测试连接；走 Chromium 网络栈，采集、下载、AI 全部生效 |
| 质量过滤 | 长边最小像素（默认 800px）、最小文件大小（默认 30KB）、格式白名单 jpg/png/webp、单张体积上限 |
| pHash 去重 | 32×32 DCT 感知哈希，汉明距离 ≤ 阈值（默认 8）自动丢弃 |
| 图库浏览 | 瀑布流 / 网格切换、缩略图懒加载、悬停操作（收藏 / 下载 / 预览）、无限滚动 |
| 大图预览 | Lightbox 全屏查看，显示分辨率 / 体积 / 来源 / 关键词 / 时间，支持 ESC 关闭、左右箭头切换、收藏与标签编辑 |
| 筛选搜索 | 收藏状态、来源、分辨率区间、画幅方向、标签，以及文件名 / 标签 / 关键词搜索 |
| 收藏与标签 | 心形收藏、收藏夹视图、自定义标签与按标签筛选 |
| 下载管理 | 单张下载、批量选中打包 ZIP |
| 桌面能力 | 图片直接落盘到本地文件夹；大图预览可「设为桌面壁纸」「在文件夹中显示」；底部状态栏一键打开保存目录 |
| 文件夹管理 | 壁纸库 = `F:\邓紫棋`，软件可递归扫描登记、重命名、删除、恢复（应用内回收站，同盘移动秒完成） |
| AI 接入 | 通用 OpenAI 兼容接口，内置 DeepSeek / OpenAI / 通义千问 / 智谱 / Ollama 预设 + 自定义；可自填 Base URL、API Key、文本模型与视觉模型，支持拉取模型列表与测试连接 |
| AI 知识库 | 删除图片时弹窗选择「为什么不满意」并可让 AI 看图补充分析 → 沉淀为规则（来源/关键词/分辨率/宽高比/标签/相似画面/AI 描述词）→ 给图库图片打分、低分降权排序、采集时自动过滤；还能生成采集建议 |
| 仪表盘 | 总数 / 收藏数 / 体积 / 来源分布（环形图）/ 分辨率分布（柱状）/ 采集趋势（折线）/ 最近与最高画质预览 |
| 设置 | 采集参数、pHash 阈值、采集源开关、关键词管理、导入本地素材、清空图库 |

## API

```
GET    /api/stats                      统计概览
GET    /api/images?q=&source=&favorite=&orientation=&bucket=&tag=&sort=&page=
GET    /api/images/:id                 PATCH(收藏/标签/标题)  DELETE
GET    /api/images/:id/thumb|file|download
POST   /api/images/batch               {ids, action: favorite|unfavorite|delete|addTag}
GET    /api/download/zip?ids=1,2,3     打包下载
GET    /api/tags
GET/PUT /api/settings
GET/POST/PUT/DELETE /api/keywords
POST   /api/crawl/start  {keywords, sources, pages}
POST   /api/crawl/stop        GET /api/crawl/status
POST   /api/import/local      GET /api/import/status
POST   /api/seed              DELETE /api/library
GET    /api/network           PUT /api/network        POST /api/network/test
GET    /api/system/info       POST /api/system/open-folder  /api/system/reveal
POST   /api/images/:id/wallpaper
POST   /api/images/:id/delete-reason  {reasons, note, aiAnalysis}   删除并学习
POST   /api/images/:id/rename {title}                               重命名磁盘文件
POST   /api/library/scan      GET/POST-DELETE /api/library/missing|purge-missing
GET    /api/ai/presets|status   POST /api/ai/test|models|analyze|summarize|suggest
GET    /api/kb/rules|feedback|stats   PUT/DELETE /api/kb/rules/:id   POST /api/kb/rescore
GET    /api/trash   POST /api/trash/:id/restore   DELETE /api/trash/:id   POST /api/trash/empty
```

## 目录

```
electron/       main.js 窗口/原生菜单/IPC · preload.cjs 暴露桌面能力
server/         app.js(API 与启动) db.js library.js(入库/落盘/去重) phash.js crawler.js importer.js desktop.js
web/            前端源码：React 页面（仪表盘 / 图库 / 收藏 / 采集 / 设置），样式按区块拆在 web/src/styles/
dist/web/       前端构建产物（vite build 输出，打包时随 asar 分发）
storage/thumbs  缩略图缓存
data/gallery.db SQLite 数据库
release-build/  electron-builder 打包输出
```

## 说明

- 桌面端后端在 Electron 主进程内启动（随机端口），图片通过 Node 直接写入本地文件夹，不经浏览器下载。
- 设为桌面壁纸：Windows 通过 `SystemParametersInfo(SPI_SETDESKWALLPAPER)`，macOS 用 Finder，Linux 用 gsettings。
- 工作区已有素材按原路径登记（不复制）；新采集的图片会写入壁纸库文件夹。
- 删除策略默认「应用内回收站」：文件移动到 `app/storage/trash`（同盘移动，秒完成），可在设置页一键恢复；比调用系统回收站 API 更可靠（部分环境下系统 API 会报 `The system call level is not correct`）。
- 知识库完全本地：`feedback` / `kb_rules` / `ai_desc` 三张 SQLite 表，API Key 只存本机。
- 不配置 AI 也能变聪明：删除时选择的原因会直接转成规则；配置 AI 后可看图分析并归纳更细的规则。
- Wallhaven 在国内网络可能无法直连，采集失败时日志会提示，其余来源不受影响。

## 打包与代码签名

```bash
npm run dist        # vite build + electron-builder → release-build/Gallery-Setup-*.exe（NSIS 安装包）
npm run dist:dir    # 只出免安装目录 release-build/win-unpacked/，更快，适合先做打包验证
```

**代码签名（可选）**：不签名时 SmartScreen 会提示「未知发布者」，功能不受影响。
项目未内置证书；拿到 `.pfx/.p12` 证书文件后**无需改任何配置**，打包前设置环境变量即可：

```powershell
$env:CSC_LINK = "D:\certs\mycert.pfx"     # 证书文件路径（也支持 http(s) 直链）
$env:CSC_KEY_PASSWORD = "证书密码"
npm run dist
```

electron-builder 检测到 `CSC_LINK` 后自动对 exe 与安装包做 SHA-256 签名并加 RFC 3161 时间戳
（时间戳服务已在 `package.json` 的 `build.win` 中配置为 DigiCert）。
EV 证书（USB 硬件钥匙）不需要 `CSC_LINK`，装好厂商驱动后 electron-builder 会自动从证书库选择。
验证签名结果：

```powershell
Get-AuthenticodeSignature "release-build\Gallery-Setup-1.0.0.exe" | Format-List
```
