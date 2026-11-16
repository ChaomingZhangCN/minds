# Changelog

## 0.2.0 — 2026-11-16（本机预览版）

- 渲染与编辑一体化：标题、粗斜体、行内代码、删除线、列表、引用直接编辑；任务 checkbox 仅改原始标记，不再活动段落切源码／双击预览切编辑。
- 默认 Markdown Custom Editor（尊重已有显式关联），保留原生源码入口；选区格式／AI 浮动工具栏与键盘可操作的 `/`、`@` 菜单。
- `@` 菜单只填写命令，正文 Cmd/Ctrl+Enter 打开绑定上一段的请求卡片，卡片明确发送才调用 Provider。
- `chart` / `charts` 同时兼容旧长表和 `xKey`／series-array 宽表；保留用户系列名称、顺序、颜色、尺寸和单轴坐标域。新增完整 21 个 query 示例。
- 图形始终同块显示，可展开／收起源码、平移、缩放、适应视口及扩大查看；上方编辑映射稳定 widget，旧源码变更时拒绝覆盖。
- 本地 Mermaid 11.17.2、strict 配置、串行渲染、SVG 净化／导出；非法源码保留有效图，成功校验后才可应用。
- 真 Excalidraw／完整官方 draw.io 原位编辑，不再 App 全屏 modal；等待 Host 保存结果，保存／取消失败保画布并可重试。
- 非法图形 JSON／Chart 数据行原样保留；Webview 本地未应用草稿可复制恢复，删除图块也不静默删除备份，不自动回写。
- 新增正文、草稿、异步保存／关闭、Mermaid、Chart schema／SSR 与浏览器回归用例。浏览器 9 项受 Linux 缺动态库阻塞，macOS／原生 VS Code／IME 未实测。
- 原 Snapshot／Blob、Provider 凭证与信任边界保持不变。完整 VSIX 仍仅供本机私用预览，第三方公开再分发审计未通过。

## 0.1.0 — 2026-11-16（本机预览版）

- 可选 Markdown CustomTextEditor、CodeMirror 即时渲染、限定范围原生提交、CRLF/UTF-16 处理和完整冲突草稿。
- 文档内 @ 菜单、绑定提问/改写卡片、流式/取消、原文/版本验证后接受提案。
- Anthropic 原生官方 SDK 和 OpenAI-compatible 官方 SDK；用户级 Endpoint 审批与 SecretStorage 隔离。
- 真实 ECharts bar/line/pie、表单/JSON、数据表、主题/纹理、安全 SVG 导出。
- 真实 Excalidraw 0.18.1 和全部内置的固定官方 draw.io 离线编辑器/资源。
- 图片不可变 Blob、完整私有 Snapshot、每次保存独立记录、恢复来源和私有恢复日志。
- 100 默认 cap、7 天降采样/30 天过期、head 保留、私有对象安全 GC 和跨进程锁。
- 增加真实 SDK/存储/图形 API 自动测试、本机 Chromium/Extension Host 验收入口和中文示例。

### 发行限制

- 真实浏览器 CSP/画布、原生 undo/redo、IME/多面板和非 Linux 文件系统行为未完成当前环境验收。
- draw.io LGPL 组件对应源码/构建材料审计未完成，完整 VSIX 仅供本机私用预览，不得公开分发。
- 未注册 Publisher，未上传 Marketplace，未调用付费模型，未创建外部定时任务。
