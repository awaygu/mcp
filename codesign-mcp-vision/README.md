# CoDesign PRD MCP Server

读取腾讯 CoDesign 产品原型（Axure），**分段截图 + VLM 视觉解析**，生成纯文本结构化需求文档（PRD），供 AI Coding Agent 直接使用——Agent 只拿文字，不需要看图、不需要处理截图路径。

## 功能特性

- **6 个 MCP 工具**：获取原型大纲、读取单页内容、生成整份需求文档、单独分析流程图、查看/清理解析缓存
- **分段截图**：超大页面自动网格分段滚动截图，宽图/长图内容完整不丢失
- **VLM 解析**：流程图 / 表格 / 普通页面三类专用 Prompt 并行调用，输出结构化 JSON
- **结果合并**：多段解析自动去重、补全、交叉验证，文末标注置信度与待确认项
- **纯文本输出**：输出 Markdown PRD，无需在 Agent 上下文里塞截图
- **缓存机制**：基于截图文件哈希缓存 VLM 结果，重复运行不重复付费调用
- **三档详细度**：`summary` / `standard` / `full`，适配不同场景
- **优雅降级**：未配置视觉模型时自动退化为仅 DOM 文字提取

## 安装与运行

```bash
cd codesign-mcp-vision
npm install            # 自动执行 prepare → npm run build 编译到 dist/
npx playwright install chromium   # 仅首次需要
```

常用脚本：

```bash
npm run build      # tsc 编译：src、scripts → dist（仅 .js，不生成 .d.ts / sourcemap）
npm run typecheck  # 只做类型检查
npm run dev        # tsx 直接以 TS 源码启动 MCP Server（stdio，免构建）
npm start          # 运行编译产物 dist/src/index.js
```

## 接入 Agent（MCP 配置）

在 Agent 的 MCP 配置里加上（路径换成你的实际位置）：

```json
{
  "mcpServers": {
    "codesign-mcp-vision": {
      "command": "node",
      "args": ["/path/to/codesign-mcp-vision/dist/src/index.js"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "VLM_BASE_URL": "https://api.openai.com/v1",
        "VLM_MODEL": "gpt-4o"
      }
    }
  }
}
```

> 未构建时也可直接跑源码：把 `command` 换成 `npx tsx`、`args` 换成 `["/path/to/codesign-mcp-vision/src/index.ts"]`。
> `CODESIGN_URL` / `CODESIGN_PASSWORD` 写在 `env` 里后，调用工具时可不传 `url` / `password`。

## MCP 工具一览

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `get_prototype_outline` | 获取原型页面目录大纲（左侧导航树） | `url?` / `password?` |
| `get_page_content` | 读取单个页面的结构化内容（组件/交互/表格/内嵌原型图清单） | `url?` / `password?` / `pageName` / `vlmEnabled?` |
| `get_requirement_doc` ⭐ | 获取指定需求分组的完整 PRD（自动遍历所有页 + 分段截图 + VLM 解析） | `url?` / `password?` / `groupName`(必填) / `vlmEnabled?` / `detailLevel?` / `outputFile?` |
| `analyze_flowchart` | 单独分析一张流程图截图，输出节点/连线/分支 + Mermaid | `imagePath`(必填) |
| `cache_stats` | 查看 VLM 解析缓存的条目数与体积 | 无 |
| `clear_cache` | 清空 VLM 解析缓存，下次调用重新请求视觉模型 | 无 |

`get_requirement_doc` 的 `outputFile: true` 会把文档写入 `output/<分组名>_需求文档.md` 并返回**文件路径 + 每页摘要**，避免大文档占满上下文；之后按需读文件即可。`detailLevel` 默认 `standard`，分组名不确定时直接调用，失败会返回候选列表。

## 命令行脚本

无需 Agent，也能直接用脚本生成文档（链接与密码通过参数传入，不写进代码）：

```bash
# 生成需求文档
npm run generate -- --url=https://codesign.qq.com/s/xxx --group=赛季通行证S2优化 --password=XXXX

# 只验证爬取层（不调视觉模型）
npm run test:crawl -- --url=https://codesign.qq.com/s/xxx --group=赛季通行证S2优化 --password=XXXX

# 也可用环境变量代替参数：CODESIGN_URL / CODESIGN_GROUP / CODESIGN_PASSWORD
```

输出：`output/<分组名>_需求文档_v2.md` 与 `output/<分组名>_merged_v2.json`（结构化数据）。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `VLM_API_KEY` | 否 | - | 视觉模型 API Key，配置后启用流程图/表格/页面自动解析 |
| `VLM_BASE_URL` | 否 | `https://api.openai.com/v1` | API 基础 URL（带不带 `/v1` 均可，自动归一化） |
| `VLM_USE_V1` | 否 | `1` | 设 `0` 切到不带 `/v1` 的 `/chat/completions`（少数网关） |
| `VLM_MODEL` | 否 | `gpt-4o` | 视觉模型名称 |
| `VLM_MAX_PARALLEL` | 否 | `3` | 视觉模型请求最大并发数 |
| `VLM_TIMEOUT_MS` | 否 | `180000` | 单段请求超时（推理型模型单次可达 100s+，勿设太小） |
| `VLM_MAX_ATTEMPTS` | 否 | `3` | 瞬态错误（网络/超时/429/5xx）最大尝试次数 |
| `VLM_MAX_TOKENS` | 否 | `8192` | 单次输出 token 上限 |
| `CODESIGN_URL` | 否* | - | CoDesign 分享链接（*脚本模式必填） |
| `CODESIGN_PASSWORD` | 否 | - | 访问密码，无密码可不填 |

支持任何 OpenAI 兼容的视觉模型接口（豆包、GPT-4o、Claude 等）。

## 已知限制

- **VLM 识别精度**：流程图和表格由 VLM 从图片识别，可能有误差，文档中会标注置信度和待确认项
- **浏览器单例**：进程内只有一个 page，涉及浏览器的工具调用会被串行排队
- **登录态**：仅支持「分享链接 + 密码」访问，不支持需登录的私有原型
- **缓存无 TTL**：缓存只增不减，长期不用可用 `clear_cache` 工具或删除 `.codesign-mcp/cache/` 清理

## License

MIT
