# Chart 宽表：Stock 与 Native 归一化耗时

minds 0.2.0 同时识别 `chart` 和 `charts`。下面保留完整 21 个 query、原始数据、系列名称和用户指定颜色；不需要改写成旧长表。图表与编辑在同一块中，展开源码可修改 JSON，确认前不写正文。

```chart
{
  "type": "bar",
  "title": "Disk，mini-batch 关闭：Stock 与 Native 归一化耗时",
  "width": "100%",
  "height": 300,
  "xKey": "query",
  "yDomain": [0, 1.1],
  "data": [
    {"query":"q0","stock":1,"native":0.513},
    {"query":"q1","stock":1,"native":0.444},
    {"query":"q2","stock":1,"native":0.654},
    {"query":"q3","stock":1,"native":0.909},
    {"query":"q4","stock":1,"native":0.067},
    {"query":"q5","stock":1,"native":0.495},
    {"query":"q7","stock":1,"native":0.066},
    {"query":"q8","stock":1,"native":0.667},
    {"query":"q9","stock":1,"native":0.229},
    {"query":"q12","stock":1,"native":0.806},
    {"query":"q13","stock":1,"native":0.524},
    {"query":"q14","stock":1,"native":0.435},
    {"query":"q15","stock":1,"native":0.455},
    {"query":"q16","stock":1,"native":0.775},
    {"query":"q17","stock":1,"native":0.495},
    {"query":"q18","stock":1,"native":0.218},
    {"query":"q19","stock":1,"native":0.248},
    {"query":"q20","stock":1,"native":0.044},
    {"query":"q21","stock":1,"native":0.606},
    {"query":"q22","stock":1,"native":0.469},
    {"query":"q23","stock":1,"native":0.775}
  ],
  "series": [
    {"key":"stock","name":"Stock Flink","color":"#94a3b8"},
    {"key":"native","name":"FlexNext Native","color":"#f97316"}
  ]
}
```

两个系列共用一个数值轴，范围 0–1.1，画布高度 300px；表格显示原始宽表。灰色不满足严格 categorical chroma 检查，浅色背景对比度有 WARN。保留文档指定配色，请使用系列名称、数据表和纹理辅助；不宣称该自选配色通过全部无障碍色彩检查。
