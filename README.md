# minds

Markdown 即时编辑、文档内 AI、完整离线图形和本地 Snapshot 历史的 VS Code 扩展。

> **0.2.1 本机预览版，不是正式公开发行版。** 完整 draw.io 已内置，未使用在线编辑服务或外部扩展替代。draw.io 内含的 LGPL 组件对应源码/构建材料审计尚未完成，因此不要上传此完整 VSIX 到 Marketplace、公开 Release 或其他公开分发渠道。源码、构建入口和明确的验证状态见下文。

## 安装和开始使用

需要 VS Code **1.105.0+**。开发/构建需要 Node.js **22+**、npm 和 Git（首次取得固定 draw.io 源码时）。

1. 在 VS Code 执行 **Extensions: Install from VSIX…**，选择本地 `minds-0.2.1.vsix`。
2. 打开包含 Markdown 和图形资源的文件工作区。只有确认项目来源安全后才信任工作区。
3. 新打开 `.md` / `.markdown` 时，minds 注册为默认 Custom Editor；已打开的标签页或已有显式编辑器关联仍由 VS Code 决定。如未使用 minds，选择 **Reopen Editor With… → minds Markdown**，或执行 **minds: 打开 Markdown 编辑器**。
4. 打开 `examples/welcome.md` 体验直接编辑、任务列表、Chart、Mermaid、真实 Excalidraw 和 draw.io。`examples/wide-chart.md` 包含完整的 21 个 query 宽表样例。点击图块中的“编辑图形”在当前块内进入真实画布。

正文渲染和编辑在同一个编辑器中，不另开 Markdown 预览页。minds 不修改用户的全局文件关联；“源码”按钮仍可回到 VS Code 原生文本编辑器。

**从 0.2.0 更新：** 0.2.1 修复了正常 Host 初始化消息被误拦截、页面一直显示“正在连接原生文档…”的问题。安装新 VSIX 后执行 **Developer: Reload Window**，再重开文档；不需要改动 Markdown 内容或配置 Provider。若更新后仍卡住，请确认扩展版本为 0.2.1，并检查 **Developer: Toggle Developer Tools** 的 Console；分享错误前去除凭证和文档内容。

命令行安装（已安装 `code` 时）：

```sh
code --install-extension minds-0.2.1.vsix
```

## 正文编辑

- 标题、粗斜体、删除线、行内代码、列表、引用以排版后的正文直接编辑，不再双击进入源码；任务 checkbox 只修改原文的 `[ ]` / `[x]`。
- 选区浮动工具栏提供提问、改写、粗斜体、标题、行内代码和链接；空段落 `/` 菜单可插入正文结构或图形。菜单支持方向键、Enter 和 Escape，退出不删除输入。
- 图形块始终显示，光标进入不会变成整块源码。展开源码在同一块内编辑，支持收起后继续恢复草稿；合法草稿更新图形，应用才写正文。
- 未覆盖语法（例如表格布局和复杂图片引用）保留可编辑源码表示；不声称所有 Markdown 语法均已富文本化。
- 原生 `TextDocument` 是正文真相，按限定范围提交，不将整篇文档富文本化后重新序列化。
- 保留 CRLF/LF 和 UTF-16 偏移；中文、emoji 不拆开。保存、撤销、重做等候当前同步完成，再调用原生 VS Code 操作。
- 外部修改和未提交草稿冲突时暂停同步，保留**完整草稿副本**；先查看、复制或明确合并，不盲目重试覆盖。
- 原始 HTML、外部图片和未经授权的路径不渲染，不默认打开 Markdown 外链。

**注意：** VS Code 的 `WorkspaceEdit` 没有公开的原子 expectedVersion CAS；前置版本/原文校验不能承诺消除所有跨窗口竞争。真实原生撤销、中文 IME、快速输入和多面板行为尚需本机验收，不能用单元测试代替。

## 文档内 @ agent

选中正文，点击浮动工具栏的**提问**或 **AI 改写**（也可使用顶部 **@ 提问／@ 改写**）。在独立空段落输入 `@`，用方向键／Enter 或点击菜单选择 `@ask`／`@writer`，只会填写命令。继续输入问题或改写指令后，按 **Cmd/Ctrl+Enter** 打开绑定上一段正文的请求卡片；没有上一段时绑定空范围。正文中的命令不自动删除。

只有在请求卡片点击**发送**，或在卡片输入框按 **Cmd/Ctrl+Enter**，才会调用配置的 Provider。选择菜单、打开卡片都不外发；邮箱、fence 和缩进代码中的命令不触发。

- 卡片绑定原文选区或段落，讨论内容不默认写入 Markdown。
- 默认只发送选区；可明确选择当前段落或全文，并展开查看实际正文上下文。
- 请求另含固定任务提示、问题及卡片问答历史；不发送图形资源字节、其他工作区文件或凭证。
- 支持流式结果、追问、取消、超时。超过上下文预算时拒绝发送，不静默截断。
- 改写先展示原文/建议，点击**接受改写**才提交。文档版本变化后，旧建议不能应用。
- 模型截断、拒绝、工具调用/非文本结果等不会生成可应用提案。没有自动终端、tools 或跨文件写入能力。

### 配置 Provider

执行 **minds: 配置 AI Provider**，选择：

- **Anthropic**：原生官方 `@anthropic-ai/sdk`，不是 OpenAI shim。默认地址 `https://api.anthropic.com`，默认模型 `claude-opus-5-5`，模型可改。
- **OpenAI-compatible**：官方 `openai` SDK，可连接兼容 API 或 loopback 本地服务。默认地址 `https://api.openai.com/v1`；自行填入服务支持的模型 ID。

配置过程显示并要求确认发送地址。地址仅允许 HTTPS 或 loopback HTTP；API Key 通过密码输入进入 VS Code `SecretStorage`，按 Provider/Endpoint 隔离，不传给 Webview、不进入环境变量 fallback、项目、日志或快照。可执行 **minds: 删除 AI 凭证**。

AI 设置只读取**用户全局/application**配置，忽略工作区、文件夹、语言覆盖。未信任工作区禁止外发。Remote SSH / Dev Container 场景，请求、凭证访问和历史存储位于对应 **Remote Extension Host**，不是自动在桌面端执行。

Anthropic 的服务端 refusal fallback 默认开启，可在 `minds.ai.refusalFallback` 关闭；请求仍在同一 Provider 内，由服务端执行，不在本地偷偷切换模型。服务/模型若不支持相关参数，关闭后重试。

**项目自动测试只使用注入 transport 或官方 SDK 的模拟 HTTP 流，未调用付费模型。** 浏览器测试页明确标记“模拟 Host”，其 AI、保存和历史不是实际 VS Code 功能。

## 图形：原生文件为真相

### Chart / Charts

同时识别单数 `chart` 与复数 `charts` fence，不改写原 fence。两种声明式 JSON 格式均不执行用户 JavaScript。旧版长表格式继续兼容：

```charts
{
  "version": 1,
  "type": "bar",
  "title": "月度请求量",
  "x": "month",
  "y": "requests",
  "data": [
    { "month": "一月", "requests": 120 },
    { "month": "二月", "requests": 180 },
    { "month": "三月", "requests": 150 }
  ]
}
```

旧版字段为 `version/type/title/x/y/data`，多系列可选字符串 `series`。新版宽表使用 `xKey` 与 `series` 定义数组，`version: 1` 可选，例如：

````md
```chart
{
  "type": "bar", "title": "归一化耗时",
  "width": "100%", "height": 300, "xKey": "query", "yDomain": [0, 1.1],
  "data": [{"query":"q0","stock":1,"native":0.513},{"query":"q1","stock":1,"native":0.444}],
  "series": [
    {"key":"stock","name":"Stock Flink","color":"#94a3b8"},
    {"key":"native","name":"FlexNext Native","color":"#f97316"}
  ]
}
```
````

完整 21 行样例在 `examples/wide-chart.md`，未删数据或替换指定颜色。支持 `bar` / `line` / `pie`；单个数值轴，保留系列顺序、名称与颜色，尊重宽高及 `yDomain`。宽／高像素为整数 200–4096；宽度也可为 1%–100%，坐标域必须为有限递增数值。字段、数值、重复类别／系列和尺寸均验证，不接受任意 ECharts option / JS。

真实 ECharts 渲染、表单／JSON 编辑、数据表、tooltip、深浅主题、纹理辅助和 SVG 导出。合法草稿实时预览，确认前不写正文；JSON 或数据行暂时非法时保留原输入和上一版有效图，外部源码变化时拒绝覆盖。用户指定颜色不会偷偷替换：示例灰色不满足严格 categorical chroma 检查，浅色背景对比度有 WARN，请使用系列标签、数据表和纹理辅助；不宣称该自选配色通过全部检查。

首版渲染最多 **3 个系列**，饼图最多 **3 个类别**；不会为超额系列生成颜色或擅自合并“其他”。同类别/系列重复测量需自行明确汇总，缺测保留空隙而非填零。饼图不接受负数、全零或 `series` 字段。共享存储 schema 的上限与 UI 渲染约束不同，超出时会显示明确错误。

### Mermaid

````md
```mermaid
flowchart LR
  A[提出问题] --> B[收集证据] --> C[形成结论]
```
````

本地 Mermaid 11.17.2 按需串行渲染，不连接在线服务。支持块内源码、深浅主题、平移／缩放／适应视口／扩大查看与 SVG 导出；语法错误保留上一版有效图，当前源码成功渲染校验后才允许应用。

固定 strict 模式、关闭 HTML labels，拒用户 init/config、frontmatter、click、HTML 及外部图片／URL。不执行 bindFunctions；生成的 SVG 经过净化和安全校验，Host 导出时再验证。

### Excalidraw

````md
```excalidraw
{"src":"diagrams/sketch.excalidraw"}
```
````

使用真实 Excalidraw 0.18.1，完整本地字体；原生 JSON 保存到 `.excalidraw`，SVG 只是派生预览/导出。打开时创建草稿，取消不写文件；保存时校验源文件是否变化、有无原生未保存草稿。

不连接云协作、在线图形库或 CDN。不允许 embeddable/iframe/magicframe、远程图片及活动 SVG。CSP 阻止 SDK 自带的 CDN fallback；字体必须随 VSIX 内置。

### draw.io

````md
```drawio
{"src":"diagrams/architecture.drawio"}
```
````

完整官方 Web 编辑器和离线运行资源内置，固定上游提交：

`c72c9a98b7a6ce392556ed04c05e0ff19f43f5c3`

真实 XML load/save/export，原生 `.drawio` XML 为编辑真相。编辑器按需加载到隔离 iframe，校验精确 origin、contentWindow 和协议阶段。关闭插件、云存储、AI、遥测和 service worker；不通过 CDN 加载运行时。

主 Webview 不允许 `unsafe-eval`。draw.io 独立 CSP 保留官方 inline script 精确哈希，不放行任意 inline/eval。SVG 导出允许经过白名单验证的原生 HTML 标签，但拒绝脚本、事件属性、外部资源和活动 HTML。

Excalidraw / draw.io 在当前图块内打开原生编辑器，不使用全屏 Markdown 预览或自制简化画布。保存等待 Host 实际返回；失败保留画布与草稿，可以重试。所有查看视口支持平移、缩放、适应视口、复位、块内扩大查看与 SVG 导出。

**完整资源校验通过不等于真实浏览器 CSP/交互验证通过。** Chromium 已下载，但当前 Linux 缺少 `libglib-2.0.so.0` 等运行库，9 项浏览器测试全部停在启动阶段，未进入正文；真实离线画布与导出仍需本机验证。

### 未应用图形草稿

图块源码、Chart 配置、Excalidraw 原生 JSON 及 draw.io 发出的 autosave/save XML 在 Webview 本地 state 中备份。即使删除图块，顶部“本地未应用图形草稿”仍可查看／复制；不自动重放到正文或资源、不发给 Provider、不写入项目、Git 或 Snapshot。应用、保存、明确取消或确认已复制后移除对应备份。

这不是磁盘级崩溃事务备份。draw.io 只备份已经收到的原生事件；没有收到事件或进程突然崩溃时不能保证最后动作已持久化。大图频繁持久化的性能仍待真实浏览器验收。

## 图片 Blob 与私有历史

点击 **＋ 图片**，或粘贴/拖入 PNG、JPEG、GIF、WebP（单个最多 12 MB）。Host 校验实际类型并以 SHA-256 不可变内容寻址，写入工作区 `.minds/blobs/`，插入普通 Markdown 相对路径。同图片可跨文档/保存版本复用。

- `.minds/blobs/` 是正文的 live 资源，不是可随意删除的缓存，分享文档时需一起分享。
- 私有 Snapshot 位于 `context.globalStorageUri/history/<workspaceHash>`，**不写入项目**，也不随 VSIX 打包。
- 每次成功保存一条独立记录；相同正文/资源可以复用对象，但记录 ID、保存时间仍独立。
- 正文、Charts fence、被引用的 Excalidraw/draw.io 和本地 raster 图片完整归档，不依赖 delta 链。
- 单资源最多 20 MB、一次归档资源总计最多 100 MB；远程、缺失、未知类型或变化中的资源会给出警告，不能声称完整离线恢复。
- 原生文件保存与历史提交不是同一个事务；归档失败会明确报告“正文已保存，但历史归档失败”，不会假装撤回原生保存。

### 历史和恢复

点击 **历史**，查看正文、资源哈希与警告。恢复前先预览和确认；文档或资源存在未保存草稿时拒绝覆盖。恢复并保存只创建一条 `reason=restore` 记录，保留 `restoredFrom`。

恢复先将原文/被覆盖资源持久化到私有 `restore-journals/<id>/`。资源或原生提交失败会尝试回滚，遇到新的外部编辑则不覆盖它，保留备份路径供人工处理；这是一项**可恢复多文件操作，不是原子事务**。首版没有一键跨进程崩溃恢复向导。出错时先保留并检查 `original.md`、`journal.json`、`*.backup`，不要直接删除失败日志。

文档跨目录移动后，相对资源路径可能失效；首版拒绝直接恢复其他目录的旧快照，建议在原目录恢复副本。同目录重命名可继续关联历史；跨工作区历史不会自动迁移。

### Retention 与维护

默认策略：

| 设置 | 默认 | 行为 |
| --- | --- | --- |
| `minds.history.maxSnapshotsPerDocument` | 100 | 硬上限，head 计入 |
| `minds.history.detailedRetentionDays` | 7 | 近 7 天详细保存；受上限约束 |
| `minds.history.expireAfterDays` | 30 | 非 head 达到 30 天过期 |
| `minds.history.timeZone` | UTC | 7–30 天保留每天最后一版 |
| `minds.history.maintenanceIntervalMinutes` | 60 | 扩展运行期间周期整理 |
| `minds.history.gcGraceHours` | 24 | 私有无引用对象 GC 保护期 |

head 永远保留；先为未过期的每日代表预留，再用剩余名额保留近 7 天最新记录，原始 `savedAt` 不随整理刷新。maxSnapshots 是记录数限制，不是磁盘容量配额。

保存提交、扩展启用及周期维护整理过期/降采样结果。VS Code 关闭时不运行外部定时任务，下次启用补做。可在历史面板或命令中 dry-run 后明确确认整理。

GC **仅删除私有历史对象**，经过持久化观察、保护期和两次完整引用校验；未知引用、损坏 index/manifest、失效锁 fail-closed。跨进程 owner token 不因心跳短暂停顿夺取仍存活进程的锁。

**不自动 GC 工作区 live 图片。** 任意其他编辑器、其他窗口的未保存引用无法完整观测，minds 不据此删除用户图片。完整共享备份和灾难恢复仍应使用 Git/独立备份。

## 本机开发与验收

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run package
```

首次构建从官方 Git 获取固定 draw.io 到 `.cache/drawio-upstream/`，随后逐文件校验资源；缓存命中不代表跳过校验。构建复制本地字体、保留第三方声明，esbuild 打包 Extension Host/Webview。`package` 只生成本地 VSIX，不上传市场、不创建 Publisher、不提交或推送 Git。

- F5：使用 `.vscode/launch.json` 的 Extension Development Host，打开示例。
- `npm run watch`：源码持续构建。
- `npm run dev:webview`：明确的**模拟 Host**测试页，`http://127.0.0.1:5173`；完整 draw.io 单独在 loopback 5174，不是线上产品或真实保存验证。
- `npm exec playwright install chromium` 后 `npm run test:browser`：使用真正 Chromium 检查 Webview、@ 菜单、绑定卡片和离线图形。可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定自己已安装的 Chromium。
- `npm run test:extension`：真实 VS Code Extension Host。Linux 需要桌面 DISPLAY，或自行使用 `xvfb-run -a npm run test:extension`；支持 `VSCODE_EXECUTABLE_PATH` 指定可执行文件。独立测试安装不调用模型。

测试层次和实际运行结果见 `VALIDATION.md`。本地数据仅在可信、支持相关文件系统 API 的环境下可用；当前自动测试基于 Linux/Node 22，Windows/macOS 文件系统行为尚未验证。

### 手动必须验收

1. 中英文、emoji、CRLF，连续快速输入，中文 IME 选词期间不丢字。
2. 保存、原生 undo/redo；源码与 minds 多面板来回切换，两窗口并发保留冲突草稿。
3. @ 菜单、绑定段落提问、流式取消、接受/拒绝，文档变化后旧建议拒绝。
4. Charts 修改/导出；Excalidraw/draw.io 添加节点、取消、保存、重开、SVG 导出；断网和严格 CSP。
5. 导入图片、多次同内容保存、历史恢复、归档失败提醒、dry-run、7/30 天和 cap 策略。

## 发布说明与许可证

- `minds-local` 只是本机 Publisher 占位符，**没有注册**。
- 当前完整 binary 的公开再分发审计未通过。不要把本机 VSIX 推到 GitHub Release 或 Marketplace。
- 公开发布前：完成全部第三方源码/许可义务与真实 UI/原生验收，再由维护者注册 Publisher、替换标识、补齐仓库/发行信息、使用 vsce 验证并发布。发布凭证不能进仓库。
- minds 自有代码沿用仓库 **Apache-2.0**；这**不覆盖**第三方。许可详情见 `THIRD_PARTY_NOTICES.md` 与安装包 `dist/licenses/`、`dist/drawio/THIRD-PARTY-NOTICES.txt`。
- Snapshot/Blob 架构受 Apache Paimon 的不可变对象、Snapshot/head/引用设计启发；不集成 Paimon/JVM，不声称核实或复现其最新 Blob 实现。
