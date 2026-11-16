# minds 0.2.0 验证记录

日期：2026-11-16。环境：Linux、Node.js 22.16.0、npm 10。只记录实际执行结果，不把 mock、jsdom、SSR 或静态资源校验当作真实 VS Code／Chromium 交互验收。

**交付定位：本机私用预览。** 完整 draw.io 已内置；真实 UI／原生验收有环境阻塞，完整 binary 公开再分发审计未通过，不上传 Marketplace 或公开 Release。

## 自动化结果

- `npm run typecheck`：exit 0。
- 最后一次完整 `npm test`：exit 0，**19 个文件、295 项测试全部通过**（86.87 秒），包含新增视口 wheel 默认行为／缩放边界／合成几何 fit 回归。
- 真实 ECharts SSR 覆盖旧长表和完整 21 行 `chart` 宽表、单个数值轴、0–1.1 domain、300px 高度、用户系列名称／顺序／颜色，以及深浅主题／纹理和 Host SVG 校验。
- CodeMirror／React DOM 覆盖直接编辑标题／粗斜体、只将隐藏标记设为 atomic、任务 checkbox、格式限定范围、@／/ 键盘菜单、代码／邮箱排除、稳定图块 root、远程上方小范围编辑、源码草稿收起／删除／并发拒绝覆盖和 AI 锚点。
- Chart 表单回归覆盖非法数据行原样保留、上版有效图、确认禁用、原始 JSON 为数字／字符串／数组／不完整 JSON 时不崩溃，以及合法草稿的外部变更拒绝。
- 真 Mermaid parser／renderer 覆盖 flowchart／sequence、深浅主题、串行队列、语法错误后恢复、拒绝 config／click／HTML／外部资源，SVG 净化及 Host 校验。组件测试确认当前源码成功渲染前不能应用，非法输入保留原文和有效 SVG。
- 真 draw.io iframe 传输配合模拟 Host Promise，覆盖保存等待、重复保存／取消拒绝、保存失败保留同一 iframe 并重试、Host 关闭失败可重试、卸载后的异步保存不得恢复 iframe。
- Excalidraw 继续使用真实 0.18.1 SDK restore／serialize／export 和本地示例；没有删除原生 SDK 测试或以简化图形引擎替代。

### 测试层次和边界

| 范围 | 实际方法 | 不代表什么 |
| --- | --- | --- |
| 文本／同步 | LF／CRLF、UTF-16／emoji、限定范围提交、版本／操作 ID、领先草稿／冲突 | 不是实际输入法、跨窗口或原生撤销验收 |
| 正文 DOM | jsdom 中真实 CodeMirror／React；正文语义、菜单、锚点及 root 生命周期；图形明确 stub | 不是 Chromium 光标／布局／canvas／CSP 验证 |
| AI | 官方 SDK 模拟 HTTP 流与注入 transport，配置、凭证、取消／拒绝／截断 | 没有付费调用；没有验证真实 Provider 可用性／模型质量 |
| Charts | 真实 ECharts SVG SSR／schema／颜色身份；表单测试只 stub canvas init | 不是真实 tooltip、布局碰撞或截图验收 |
| Mermaid | 真实渲染与组件 gate；jsdom 确定性 SVG geometry shim | 不是实际字体、几何和浏览器布局验收 |
| Excalidraw | 真 SDK native／SVG API；jsdom 字体／canvas shim | 不是互动画布或 VS Code 中保存 UI 验证 |
| draw.io | 固定上游／产物逐文件 hash、原厂声明、来源／origin／phase、XML／SVG、异步 Host 协议 | 不证明完整 iframe 已在 VS Code CSP 下启动 |
| 图形草稿／视口 | jsdom 输入与持久化数据校验、合成几何和 wheel／键盘事件 | 不保证突发进程崩溃的最后动作备份，也不是大图性能／平移布局实测 |
| Storage | 真实 fs、多进程竞争、锁 owner、Manifest／head、Retention／GC／恢复 | 不是 Windows／macOS 文件系统保证或多文件原子事务 |
| Host 保存／恢复 | 模拟 VS Code + 真 fs／SnapshotStore；同内容保存独立记录、恢复 provenance、归档失败分类 | 不是真实原生保存事件链／多面板验收 |

SVG 回归包含真实 ECharts、Mermaid、Excalidraw 导出，受限原生 draw.io HTML 标签，CSS presentation 属性／escape、嵌入字体、脚本／事件／外部资源、嵌套 SVG、DTD、深度及尺寸限制。不宣称这是完备安全审计。

### 调色板：实际检查，不替换用户颜色

已运行 dataviz validator：

- 内置浅／深色三系列配色的 CVD 和正常视觉分离通过；浅色绿色对背景对比度 WARN（约 2.74），保留数据表、标签与纹理辅助。
- 用户指定 `#94a3b8`／`#f97316`：浅色 lightness、CVD／正常视觉分离通过；灰色 chroma floor **FAIL**，对背景对比度 **WARN**（约 2.5／2.73）。
- 同一自选配色在深色：lightness band 与灰色 chroma floor **FAIL**；CVD／正常视觉分离及背景对比度通过。
- 自选配色两次 validator 均 exit 1，**不是全部检查通过的内置 preset**。按用户原文保留颜色，通过系列名称／数据表／可选纹理提供辅助；没有静默改色。
- 未获得真实图表布局截图，不能宣称没有标签碰撞或溢出。

## 真实运行尝试：环境阻塞

### Chromium／Playwright

Chromium 下载首次 502 后自动重试成功，已经安装；不是“浏览器仍未下载”。实际 `npm run test:browser`：exit 1，9 项都停在 `browserType.launch`，未进入测试正文：

```text
chrome-headless-shell: error while loading shared libraries:
libglib-2.0.so.0: cannot open shared object file: No such file or directory
```

`ldd` 还显示缺少 gobject／gio／atk／atk-bridge／dbus／X11 系列／gbm／xcb／xkbcommon／asound／atspi。未安装系统软件，未绕过权限或混用未验证的 musl 库。**没有浏览器测试通过或真实截图成功记录。**

已提供 9 项浏览器 specs 和明确标记“模拟 Host”的 loopback 测试页：直接编辑、@ 命令确认、浮动工具栏、/ Mermaid、模拟保存历史、完整宽表／草稿／缩放、Mermaid 导出、真原位 Excalidraw／draw.io、外发／CSP 检查与截图。AI／保存／历史仍是模拟 Host，图形引擎使用真生产 bundle。

在有 Chromium 运行库的开发机执行：

```sh
npm run build
npm exec playwright install chromium
npm run test:browser
```

可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。服务只绑定 127.0.0.1；父页 5173，draw.io 5174，不同 origin 隔离。主 Webview 没有 `unsafe-eval`，draw.io CSP 保留精确 inline script hash。该 harness 即使跑通，也不替代实际 VS Code 资源 URL／origin／CSP 验收。

### 原生 VS Code Extension Host

本轮 `npm run test:extension`：exit 1，Linux 没有 DISPLAY，脚本在前置检查明确拒绝启动，**没有运行原生测试**。

已提供 VS Code 1.105.0 独立测试入口，覆盖真 TextDocument／WorkspaceEdit／原生 undo／redo／CRLF／emoji／版本拒绝／保存；需要桌面环境或自行配置 `xvfb-run -a npm run test:extension`。可设置 `VSCODE_EXECUTABLE_PATH`。没有自行安装 Xvfb。中文 IME、快速输入、双窗口、多面板仍需手工验收。

## 构建和安装包

生产 esbuild 构建已成功，包含 Extension Host CJS、Webview ESM／lazy Mermaid／Excalidraw chunks、本地字体及完整固定 draw.io。声明复制包含 319 个生产依赖元数据和 276 份原声明，是保守依赖超集，不是法律 clearance。实际包体检查发现 `@excalidraw/excalidraw` 0.18.1 npm 目录没有单独 LICENSE/NOTICE，已核对其 MIT 元数据；报告列出未提供独立声明文件的依赖，不将此计为完整许可清理通过。

0.2.0 使用新文件 `/home/admin/workspace/minds-dist/minds-0.2.0.vsix`，保留已有 0.1.0 文件。包体 SHA-256、CRC、ZIP 路径／重复项、实际白名单、所有 dist／示例／文档字节、draw.io 逐文件 hash、npm 声明 hash、字体、VSIX manifest 与源码提交记录在同目录 **`package-report-0.2.0.json`** 和 `minds-0.2.0.vsix.sha256`。未生成这些文件前不视为交付完成。

VSIX 白名单仅包含构建产物、文档、原声明、图标和示例，不包含 minds 顶层源码／测试／node_modules／缓存／凭证／私有历史。原厂 `dist/drawio/mxgraph/src/` 是运行资源，不是被误带入的 minds 源码。vsce 默认秘密扫描保持启用，不使用跳过扫描参数。

VSIX 不限定 OS／CPU，**不是 macOS Intel／Apple Silicon 已实测**。安装扩展无需额外 Node／npm／Git；构建才需要它们。

## 发布与架构边界

- 自有源码 Apache-2.0，原第三方分别保留许可；不因此解除 draw.io libavoid／Adaptagrams 的对应源码／构建义务。见 `THIRD_PARTY_NOTICES.md`。公开完整 binary 再分发未获审计通过。
- `minds-local` 是未注册的本地 Publisher 占位；不 Marketplace／公开 Release／Pages／Kbase 发布，不外部定时任务，不付费模型测试。
- 本次源码在 `feat/unified-editor` 提交；包／dist／缓存／私有数据不入 Git，不自动 push。
- 原生文件保存与 Snapshot 不是同一事务；正文／多资源恢复为可恢复操作，不是原子事务。WorkspaceEdit 的前置校验不是原子 CAS。
- 工作区 live raster 图片不自动 GC；magic／MIME 校验不是完整像素尺寸炸弹审计。
- 同目录重命名可关联历史；跨目录旧快照恢复被拒绝，跨工作区历史不自动迁移。
- 表格等未覆盖语法保留源码编辑；复杂图片引用、触屏／IME／实际光标导航、长文性能、草稿持久化容量与大图性能尚待验收。

## 本机手工验收清单

- [ ] 安装实际 VSIX，确认新 Markdown 默认编辑器及已有显式关联；打开 welcome／wide-chart 示例。
- [ ] 标题／粗斜体／任务直接编辑，中英文／emoji／CRLF／IME／快速输入与原生 undo／redo。
- [ ] 选区工具栏、滚动／链接输入，@／/ 的方向键／Escape／确认；卡片明确发送／取消／过期提案。
- [ ] 两窗口／源码多面板竞争，旧范围不得覆盖；完整正文与图形草稿不丢失。
- [ ] Chart 21 类别／300px／单轴 domain／颜色、真实 tooltip／标签／数据表／深浅主题／纹理／SVG 布局。
- [ ] Mermaid 多块实时编辑／语法失败、平移／缩放／fit／扩大查看及实际导出。
- [ ] 真 Excalidraw／draw.io 节点／连线编辑、保存／取消／失败重试、重开／字体／SVG。
- [ ] 删除图块／关闭重开后本地备份；大图连续动作与状态持久化性能。
- [ ] 断网与真实 VS Code CSP／iframe origin，无云／CDN fallback。
- [ ] Blob、重复保存独立 Snapshot、完整恢复／失败日志、dry-run、7／30 天和 cap。

未勾选项不是通过项；请在真正支持的开发机完成后再更新记录。
