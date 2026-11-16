# 欢迎使用 minds

这是 minds 0.2.0 本机预览示例。新打开 Markdown 默认使用 minds；已有编辑器关联时可选择 **Reopen Editor With → minds Markdown**。正文渲染和编辑在一起，不另开预览。

直接点击**粗体正文**、*斜体正文*或标题修改文字。选中文字使用浮动格式工具栏；空段落输入 `/`，用方向键／Enter 插入正文结构或图形。

- [ ] 直接修改排版后的正文
- [ ] 点击 checkbox 检查原文标记变化
- [ ] 展开同块源码，确认图形始终可见

试着修改这一段：minds 让文档仍然是普通 Markdown，而图形、图片和本地历史通过明确引用关联起来。选中本段，点击工具栏“@ 提问”或“@ 改写”，配置 Provider 后审阅结果，不自动应用。

## 文档内提问

在空段落输入 `@`，选择 `@writer` 或 `@ask`，只会填写命令。继续输入指令后按 **Cmd/Ctrl+Enter** 打开绑定上一段的卡片；卡片点击发送（或卡片输入框同一快捷键）才外发。不删除正文命令。以下代码中的命令只是文本：

```text
@ask
@writer
user@example.com
```

## 声明式 Charts

### 比较：柱状图

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

### 趋势：两个真实测量系列

```charts
{
  "version": 1,
  "type": "line",
  "title": "团队月度完成项",
  "x": "month",
  "y": "items",
  "series": "team",
  "data": [
    { "month": "一月", "items": 8, "team": "文档" },
    { "month": "二月", "items": 12, "team": "文档" },
    { "month": "三月", "items": 10, "team": "文档" },
    { "month": "一月", "items": 6, "team": "图形" },
    { "month": "二月", "items": 9, "team": "图形" },
    { "month": "三月", "items": 14, "team": "图形" }
  ]
}
```

点击“数据表”检查数值，点击“纹理辅助”观察非颜色区分；不要将缺测自动填成零。

完整 21 行 `chart` 宽表例子在 [wide-chart.md](wide-chart.md)。单数／复数 fence 都支持；块内源码草稿可以收起再展开，非法 JSON 不会丢失或覆盖正文。

## 本地 Mermaid

```mermaid
flowchart LR
  A[提出问题] --> B[收集证据] --> C[形成结论] --> D[分享与迭代]
```

展开源码实时编辑；只有当前源码成功渲染校验后才能应用。可平移、缩放、适应视口、扩大查看和导出 SVG，不连接线上服务。

## 真实手绘画布

```excalidraw
{"src":"diagrams/sketch.excalidraw"}
```

点击“编辑图形”，新增形状，先取消观察文件不变，再保存并重开。不是 SVG 到简化画布的转换。

## 完整离线 draw.io

```drawio
{"src":"diagrams/architecture.drawio"}
```

打开后使用官方工具添加连接线、节点或第二页，保存为原生 XML；SVG 只是导出结果。当前完整 VSIX 的公开再分发许可审计未完成，请仅本机私用预览。

## 图片与 Snapshot

![本地示例图片](assets/minds.png)

这个小图由构建脚本生成。也可点击“＋ 图片”、粘贴或拖入自己的 PNG/JPEG/GIF/WebP，检查生成的 `.minds/blobs/` 相对引用。

连续保存两次，即使内容没有变化，也应该看到两条历史记录。选择旧记录先查看完整正文、资源和警告，再确认恢复为新快照。工作区 live 图片不自动 GC。

## 验收最后一步

光标进入正文或图块时不切回整块源码，图形编辑也在当前块内完成。保存失败应保留原生画布／草稿；删除图块后，可在顶部“本地未应用图形草稿”中复制备份。

中文 IME、快速输入、原生撤销和多面板并发需要在真正 VS Code 中验收；当前 Linux 的 Chromium 启动缺系统库，不能以模拟／jsdom 测试证明真实 UI 已通过。
