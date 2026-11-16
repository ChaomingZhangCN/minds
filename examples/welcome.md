# 欢迎使用 minds

这是本机预览示例。用 VS Code 打开这个文件所在工作区，再选择 **Reopen Editor With → minds Markdown**。

试着修改这一段：minds 让文档仍然是普通 Markdown，而图形、图片和本地历史通过明确引用关联起来。选中本段，点击工具栏“@ 提问”或“@ 改写”，配置 Provider 后审阅结果，不自动应用。

## 文档内提问

在空白行输入 `@writer`，再点击菜单中的改写选项。仅输入命令不会删除文字或发送请求。以下代码中的命令只是文本：

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

把光标移到这里让上面的块显示预览。中文 IME、快速输入、原生撤销和多面板并发需要在真正 VS Code 中验收，不以模拟页面证明它们已通过。
