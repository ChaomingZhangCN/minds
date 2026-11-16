# minds 0.1.0 验证记录

日期：2026-11-16。环境：Linux、Node.js 22.16.0、npm 10。本文只记录实际执行结果，不将 mock、jsdom、SSR 或静态资源校验当作真正 VS Code / Chromium 的交互验证。

**交付定位：本机私用预览。** 真实 UI/原生验收仍有阻塞，完整 draw.io 的公开 binary 再分发审计未通过，不适合直接上传 Marketplace 或公开 Release。

## 自动化结果

- `npm run typecheck`：exit 0。
- 最后一次完整 `npm test`：exit 0，**15 个文件、264 项测试全部通过**，包含新增 SVG presentation 属性/单根回归及随包原生示例。
- 示例 Charts 经共享 schema 与真实 ECharts 导出；示例 Excalidraw 经过真实 SDK restore/export 和 Host SVG 校验；示例 draw.io 经过原生 XML 校验，未重写源文件。
- 曾有两项新增 jsdom fixture 测试因 Vite 将 `new URL` 当作浏览器资源改写而失败，已改为 Node URL；先定向 36 项通过，再执行上述完整 264 项回归。没有删除失败测试或用 stub 替代真实 SDK。

### 测试层次和边界

| 范围 | 实际测试方法 | 不代表什么 |
| --- | --- | --- |
| 文本与同步 | LF/CRLF、UTF-16/emoji、小范围替换、版本/操作 ID、领先草稿及冲突测试 | 不是实际输入法、跨窗口或原生撤销验证 |
| CodeMirror DOM | jsdom 中真实 CodeMirror/React；@ 菜单显式选择、偏移、卡片锚点、widget root 复用；图形组件明确 stub | 不是 Chromium 布局、canvas 或 CSP 验证 |
| AI | 官方 Anthropic/OpenAI SDK 的模拟 HTTP 流、注入 transport、配置/凭证/取消/拒绝/截断测试 | 没有付费调用，没有验证实际 Provider 可用性或模型质量 |
| Charts | 真实 ECharts SVG SSR、深浅主题、schema、数据表/颜色身份；实际 SVG 通过 XML 与 Host 安全校验 | 没有真实浏览器 tooltip、几何碰撞、截图验收 |
| Excalidraw | 真 0.18.1 SDK 的 native serialize/restore/export；jsdom 字体/canvas shim | 不是互动编辑器、本地字体下载或画布保存 UI 验证 |
| draw.io | 固定上游和完整产物逐文件哈希；原厂许可证原字节；协议来源/origin/phase、安全 XML/SVG 校验 | 静态资源与模拟事件不代表 iframe 在 VS Code CSP 下已跑通 |
| Storage | 真实文件系统、独立 Node 进程竞争、锁 owner 状态、完整 Manifest、保留策略、GC、pending 提交恢复 | 不是 Windows/macOS 文件系统兼容保证，也不是多文件原子事务 |
| Host 保存/恢复 | mock VS Code 与真实 SnapshotStore/fs；同内容保存独立记录、一次恢复一条 provenance、保存时间冻结、归档失败分类 | 不是实际 VS Code 原生保存事件链/多面板验收 |
| 恢复日志 | 真实 fs 的备份、失败回滚、外部修改保护、新建文件失败清理 | 首版不提供跨进程崩溃后的一键恢复向导 |

SVG 回归包含：真实 ECharts 导出字体引号、CDATA/嵌入字体、原生 draw.io 的受限 HTML 标签、数字实体编码的外部 CSS URL、presentation 属性的 CSS escape、脚本/事件/嵌套 SVG/声明/深度与尺寸限制。不宣称这是一份完备安全审计。

调色板已实际执行 dataviz 验证：浅色、深色的三系列 CVD 和正常视觉分离检查通过；浅色绿色对背景对比度有 WARN（约 2.74），使用已有数据表/标签/纹理辅助，不宣称每个标记都达到文本对比标准。未获得真实 UI 截图。

## 真实运行尝试：未通过环境前置条件

### Chromium / Playwright

实际执行：

```sh
npm run test:browser -- --grep 'typing @writer'
```

exit 1，停在 `browserType.launch`：

```text
Executable doesn't exist at .../chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell
```

此前 Chromium 下载在后台超时终止，未安装成功。本次已修复 Playwright config 的 CJS/import.meta 问题，但没有进入浏览器测试正文，**不能计为 UI 通过**。未自动安装系统软件。

已提供 5 项 browser specs 和明确标记“模拟 Host”的 loopback 测试页。其 AI、保存、历史是假 Host；图形加载目标是真生产 bundle 和完整本地 runtime。在有浏览器的开发机运行：

```sh
npm run build
npm exec playwright install chromium
npm run test:browser
```

也可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。服务仅绑定 127.0.0.1；主页面 5173，draw.io 5174，以不同 origin 隔离。它不证明实际 VS Code Webview 的 origin、资源 URL 和 CSP 行为。

### 原生 VS Code Extension Host

实际执行：`npm run test:extension`，exit 1：Linux 没有 DISPLAY，脚本明确表示没有运行原生测试。

已提供固定 VS Code 1.105.0 的独立 Extension Host 测试入口，包含真实 TextDocument、WorkspaceEdit、源码/Custom Editor 的原生 undo/redo、CRLF/emoji、旧版本拒绝、保存；没有运行成功记录。可在桌面环境运行，或自行使用：

```sh
xvfb-run -a npm run test:extension
```

可设置 `VSCODE_EXECUTABLE_PATH`。没有自行 sudo/安装 Xvfb。中文 IME、持续快速输入、两窗口与多面板仍需手工验收。

## 构建和安装包

生产 esbuild 构建此前已成功，包含真实 Excalidraw 本地字体与固定完整 draw.io。npm 原声明复制已实际执行：319 个已安装生产依赖元数据、276 份声明文件；这只是保守依赖超集，不是法律 clearance。

`vsce ls --no-dependencies` 的初步白名单检查已执行，包含 Host/Webview、完整 draw.io、本地字体、原始第三方声明和原生示例；不包含 minds 顶层源码、测试、构建缓存、node_modules、凭证或私有历史。原厂 mxGraph 的 `dist/drawio/mxgraph/src/` 和声明文件原目录层级是必要随包资源，不应错误删掉。

本机 harness 的 HTTP smoke 检查通过：模拟状态标识、真实生产 JS 的 MIME、不同 origin 的 draw.io 入口、父页 nonce CSP/子页 self CSP、拒绝项目 package.json 和 .env 路由；检查后已关闭两个服务器。这不是浏览器脚本执行/CSP 生效验证。初次 smoke 误将父页 HTTP CSP 头当作 HTML meta，并错误要求无 inline script 的 draw.io 首页也带哈希；按实际 header/self policy 修正检查后通过，未放宽服务 CSP。

本地安装包生成后，另行检查实际 ZIP 的白名单、路径/重复项、完整 draw.io 逐文件哈希、npm 原声明哈希、字体与示例，记录包体大小、SHA-256 以及 VSIX manifest。结果保存在构建生成的 `.cache/package-report.json`（不进入 VSIX，避免包体哈希自引用）；缺少该报告时不能把打包/ZIP 验证视为已完成。`vsce` 的默认秘密扫描保持启用，不使用跳过扫描/允许所有秘密参数。

## 发布和兼容阻塞

- **公开完整 VSIX 再分发未获许可审计通过。** 固定 draw.io 的 libavoid/Adaptagrams C++/embind 对应源码和构建材料不完整；sourcemap 和复制 LICENSE 不能替代这些义务。见 `THIRD_PARTY_NOTICES.md`。
- `minds-local` 是本地占位 Publisher，没有注册或上传 Marketplace。
- 首次源码提交前，维护者选择保留远端初始化提交中的 Apache-2.0 LICENSE；package 元数据与中文声明已同步。此前生成的本机 VSIX 不随 Git 提交，也不据此视为已重新构建或获公开发行许可。
- 本机预览构建/打包阶段没有 Git 初始化/提交/推送；后续源码提交与推送为独立操作，不包含 VSIX 或第三方 binary。没有发布 GitHub Release，没有调用付费模型，没有创建外部定时任务，没有 Pages/Kbase 发布。
- 当前只在 Linux/Node 22 自动测试；Windows/macOS、Remote Extension Host、工作区根 symlink 布局等未验证。
- 原生文件保存与 Snapshot 提交、正文与多资源恢复都不是一个原子事务；WorkspaceEdit 前置版本校验不是原子 CAS。
- 本地 raster 图片使用 magic/MIME 检查，未提供完整像素解码/尺寸炸弹审计。工作区 live 图片不自动 GC。
- 同目录重命名可关联历史；跨目录恢复旧快照被明确拒绝，跨工作区历史不自动迁移。

## 本机手工验收清单

- [ ] 安装实际 VSIX，打开 `examples/welcome.md`，检查激活与 Custom Editor。
- [ ] 中英文/emoji/CRLF、中文 IME、快速连续输入、保存与原生 undo/redo。
- [ ] 源码/minds 多面板、两窗口外部竞争；完整冲突草稿不会静默覆盖。
- [ ] @ 菜单、绑定讨论、实际 Provider 的显式发送/取消、diff 接受/拒绝/过期保护。
- [ ] Charts tooltip/标签/数据表/深浅主题/纹理与实际 SVG 导出布局。
- [ ] 真 Excalidraw/draw.io 节点编辑、取消、保存、重开、字体、SVG 导出。
- [ ] 断网与实际 VS Code CSP/iframe origin，无云服务或 CDN fallback。
- [ ] 图片 Blob、多次同内容保存、完整恢复、失败日志、dry-run、7/30 天与 cap。

未勾选项不是自动通过项；请在真正支持的开发机完成后再更新记录。
