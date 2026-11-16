# 第三方声明与发行边界

minds 自有代码沿用仓库根目录 Apache-2.0 LICENSE；该声明不改变任何第三方许可。安装包包含第三方代码、字体和完整 draw.io 编辑器资源，它们分别适用自己的许可与版权声明。

## npm 依赖

核心直接依赖包括 React / CodeMirror / ECharts / Excalidraw / MarkdownIt / DOMPurify / fast-xml-parser / proper-lockfile / Zod、官方 Anthropic SDK 和官方 OpenAI SDK。精确安装版本以 `package-lock.json` 为准。

每次完整构建会为**全部已安装生产依赖**（保守超集，不等于每个包都被打进 JS）复制 LICENSE/LICENCE/NOTICE/COPYING/COPYRIGHT/AUTHORS 原始文件和字体声明，并生成：

- `dist/licenses/npm/manifest.json`：包名、版本、许可元数据、来源、声明文件及 SHA-256。
- `dist/licenses/npm/<package>/…`：原始声明文件。

构建保留元数据和许可文件不是法律审计结论，未知许可或缺失声明仍需发布前人工核实。esbuild sourcemap 也不能替代 LGPL 的完整对应源码/构建材料义务。

## 完整 draw.io

上游：<https://github.com/jgraph/drawio>

固定提交：`c72c9a98b7a6ce392556ed04c05e0ff19f43f5c3`。锁定的源文件哈希和完整 runtime 汇总在 `vendor/drawio-upstream.json`；生成后的逐文件验证和修改说明在 `dist/drawio/minds-runtime-manifest.json`。

保留与该固定版本一起提供的全部相关 LICENSE/NOTICE/README/VERSION，不将整个目录笼统标成 Apache-2.0 或 MIT。已发现的不同义务包括：

- 根代码 Apache-2.0。
- templates 的 CC-BY-4.0。
- img/stencils/shapes 中额外关于不得用于 Atlassian 产品/Marketplace/plugin 软件资源的限制；minds 不是 Atlassian 产品，但仍保留原声明，不代表适用于任意再分发场景。
- Architects Daughter 字体 OFL 1.1，构建从上游 TTF metadata 提取并保留原声明。
- libavoid-js LGPL 2.1。

### 公开再分发审计未通过

该固定版本包含编译后的 `libavoid.min.js`，其 README 表明涉及 Adaptagrams C++ 和自定义 embind。当前固定仓库未给出完整对应 C++/embind 源码及可重建编译材料；它也内嵌在 `extensions.min.js` 中，删除单个目录不能冒充去除了组件或满足义务。

**完整 VSIX 当前只交付给本机私用预览，不上传 Marketplace、公开 Release 或其他公开 binary 分发渠道。** 本文件不构成法律意见；维护者公开发行前需完成相应源码、构建材料、通知及其他许可义务，并确认适用条件。

不以在线编辑器、外部 VS Code 插件、自制简化编辑器或擅自更换上游版本绕过“全部内置”要求。构建安全修改（offline/local 参数、CSP、禁云/插件/eval/SW/遥测）保留在 manifest 中，固定源码缓存不被改写。

## Excalidraw 与字体

Excalidraw 0.18.1 的库、字体和其依赖按各自的原声明保留。`dist/excalidraw/fonts/` 为本地运行字体，`dist/licenses/npm/` 收录在包中发现的字体声明。主 CSP 阻止原厂 CDN fallback；没有依靠外网许可链接替代本地字体或声明。

## 其他说明

minds 不打包 Apache Paimon/JVM；文档中的 Paimon-inspired 是架构参考，不是依赖、合作、认证或最新实现一致性的声明。

本工程自动测试未使用真实 AI 凭证；测试页面的模拟响应不代表模型能力或厂商背书。
