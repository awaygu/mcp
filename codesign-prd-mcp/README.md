# CoDesign PRD MCP Server

读取腾讯 CoDesign 产品原型（Axure），**分段截图 + VLM 视觉解析**，生成纯文本结构化需求文档，供 AI Coding Agent 直接使用。

## 核心特性

- **分段截图**：超长页面自动分段滚动截图（段间重叠 100px），确保内容完整不丢失
- **VLM 解析**：流程图/表格/普通页面三类专用 Prompt，并行调用，输出结构化 JSON
- **结果合并**：多段解析结果自动去重、补全、交叉验证
- **纯文本输出**：AI Coding Agent 只拿结构化文字，不需要看图，不需要处理截图路径
- **缓存机制**：基于截图文件哈希缓存 VLM 结果，重复运行不重复调用
- **三档详细度**：summary / standard / full，适配不同场景

## 技术架构

```
AI Coding Agent (纯文本输入)
        ▲
        │  MCP (stdio)
┌───────┴─────────────────────────────────────────┐
│  codesign-prd-mcp                               │
│                                                  │
│  get_requirement_doc(groupName)                  │
│        │                                         │
│        ▼                                         │
│  ┌──────────┐   ┌──────────┐   ┌────────────┐  │
│  │ 页面遍历  │──▶│ 分段截图  │──▶│ VLM 并行解析│  │
│  │ crawler  │   │screenshot│   │    vlm     │  │
│  └──────────┘   └──────────┘   └─────┬──────┘  │
│        │                            │          │
│        │  DOM 文字                  │ 结构化JSON│
│        ▼                            ▼          │
│  ┌──────────┐   ┌──────────┐   ┌────────────┐  │
│  │ 文字提取  │   │ 结果合并  │◀──│ 解析结果缓存│  │
│  │ extract  │   │  merger  │   │   cache    │  │
│  └──────────┘   └─────┬────┘   └────────────┘  │
│                       │                         │
│                       ▼                         │
│              ┌────────────────┐                 │
│              │  文档生成模块   │                 │
│              │ doc-generator  │                 │
│              └────────┬───────┘                 │
└───────────────────────┼─────────────────────────┘
                        │
                        ▼
              纯文本结构化 PRD（Markdown）
```

## 安装

```bash
cd codesign-prd-mcp
npm install
npx playwright install chromium
```

## MCP 配置

```json
{
  "mcpServers": {
    "codesign-prd": {
      "command": "node",
      "args": ["/path/to/codesign-prd-mcp/src/index.js"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "VLM_BASE_URL": "https://api.openai.com/v1",
        "VLM_MODEL": "gpt-4o"
      }
    }
  }
}
```

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `VLM_API_KEY` | 否 | 视觉模型 API Key，配置后启用流程图/表格/页面自动解析 | - |
| `VLM_BASE_URL` | 否 | API 基础 URL（OpenAI 兼容格式） | `https://api.openai.com/v1` |
| `VLM_MODEL` | 否 | 视觉模型名称 | `gpt-4o` |

> 支持任何 OpenAI 兼容的视觉模型接口（豆包、GPT-4o、Claude 等）。
> 未配置 VLM 时自动降级为仅 DOM 文字提取。

## MCP 工具

### 1. `get_prototype_outline`
获取原型页面目录大纲。

**参数**：`url`（必填）、`password`（可选）

### 2. `get_page_content`
获取单个页面的结构化内容（VLM 解析后纯文本）。

**参数**：`url`、`password`、`pageName`、`vlmEnabled`（默认 true）

### 3. `get_requirement_doc` ⭐ 核心
获取指定需求分组的完整结构化需求文档。自动遍历所有页面，分段截图 + VLM 解析，输出**纯文本 PRD（无截图路径）**。

**参数**：
- `url`（必填）
- `password`（可选）
- `groupName`（必填，如"赛季通行证S2优化"）
- `vlmEnabled`（可选，默认 true）
- `detailLevel`（可选，`summary`/`standard`/`full`，默认 `standard`）

### 4. `analyze_flowchart`
单独分析一张流程图截图，输出节点/连线/分支 + Mermaid。

**参数**：`imagePath`（必填）

## 输出文档结构

```markdown
# {分组名} - 需求文档

## 一、业务流程
- 流程概述
- 主流程（节点 → 连接）
- 分支与判断（表格）
- 异常流程
- 流程图（Mermaid 代码）

## 二、页面详情
- 页面类型、布局结构
- 核心组件（表格：组件名/类型/说明）
- 交互行为
- 页面状态
- 数据表格

## 三、配置与规则
- 所有配置表、奖励表、参数表
- VLM 从图片识别的表格标注"建议复核"

## 四、附录
- 解析置信度（每页：类型/解析方式/分段数/置信度/备注）
- 待确认项（VLM 与 DOM 不一致、识别不清晰的内容）
```

## 命令行工具

```bash
# 生成需求文档
node scripts/generate-prd.js

# 输出：
# output/赛季通行证S2优化_需求文档_v2.md
# output/赛季通行证S2优化_merged_v2.json（结构化数据）
```

## 项目结构

```
codesign-prd-mcp/
├── src/
│   ├── index.js          # MCP Server 入口（4个工具）
│   ├── browser.js        # Playwright 浏览器管理
│   ├── crawler.js        # CoDesign 爬取（密码/目录/导航/文字提取）
│   ├── screenshot.js     # 分段滚动截图（核心新增）
│   ├── vlm.js            # 视觉模型（三类Prompt/并行调用/限流）
│   ├── merger.js         # 结果合并（去重/补全/交叉验证）
│   ├── doc-generator.js  # 文档生成（纯文本结构化PRD）
│   └── cache.js          # VLM 结果缓存（文件哈希）
├── scripts/
│   ├── generate-prd.js   # 命令行生成需求文档
│   └── test-crawl.js     # 爬取测试
├── output/               # 输出目录
├── .codesign-mcp/
│   ├── screenshots/      # 分段截图
│   └── cache/            # VLM 解析缓存
└── package.json
```

## 分段截图策略

| 参数 | 默认值 | 说明 |
|---|---|---|
| 视口高度 | 1080px | 每段截图高度 |
| 段间重叠 | 100px | 防止内容截断在边界 |
| 渲染等待 | 500ms | 滚动后等待渲染稳定 |
| 分段阈值 | 1.5x | 超过视口 1.5 倍才分段 |
| 最大段数 | 20 | 安全限制 |

**滚动容器检测**：自动检测 iframe 内的滚动容器（window 或可滚动 div），适配不同原型结构。

## VLM 解析策略

| 页面类型 | 判断规则 | 解析目标 |
|---|---|---|
| flowchart | 名称含"流程/flow/架构/状态图" | 节点、连线、分支条件、异常流、Mermaid |
| table | 名称含"奖励/配置/规则/参数/列表" | 表格行列数据、字段说明、枚举值 |
| page | 其他 | 页面布局、组件列表、交互行为、状态 |

**并发控制**：同时最多 3 个 VLM 请求，单段超时 30s，失败重试 1 次。

## CoDesign 页面结构（已逆向）

| 区域 | 选择器 | 说明 |
|---|---|---|
| 密码页 | `.prototype-password` | 一个隐藏 input + 4 个视觉方块 |
| 密码输入框 | `.prototype-password__input input` | 直接 fill 完整密码 |
| 目录树 | `.t-tree` | TDesign tree 组件 |
| 目录节点 | `.t-tree__item` | style 中 `--level: N` 表示层级 |
| 节点文字 | `.label-text` | 页面/分组名称 |
| 分组标记 | `.total-text` | 有此元素的是分组 |
| 内容容器 | `.axure-container` | Axure 原型外层容器 |
| 原型内容 | `.axure-container iframe` | blob URL iframe，实际内容在这里 |

## 已知限制

1. **VLM 识别精度**：流程图和表格由 VLM 从图片识别，可能存在误差，文档中会标注置信度和待确认项
2. **动态内容**：Axure 原型一般为静态导出，如遇滚动后动态加载的内容，可能需要增加等待时间
3. **CoDesign 改版**：依赖 CoDesign DOM 结构，平台改版后可能需要更新选择器
4. **登录态**：当前仅支持分享链接+密码访问，不支持需要登录的私有原型

## License

MIT
