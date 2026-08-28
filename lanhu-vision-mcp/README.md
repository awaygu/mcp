# lanhu-vision-mcp

零依赖 stdio MCP server，让任意支持 MCP 的 coding Agent（Claude Code / Cursor / Trae /
opencode）获得三件事：

- **读蓝湖的眼睛**：通过蓝湖官方 API（Cookie 直调，无需浏览器）取结构化图层树
  （x/y/宽高/色值/字号/圆角/文本），精确数值来自结构化数据，**不靠视觉模型 OCR 截图上的小字**。
- **按项目/分组组织**：`lanhu_list_sectors` 列项目分组，`lanhu_read_sector` 按分组批量读，
  支持「项目 → 分组（需求）→ 设计稿」的完整层级。
- **视觉理解 + 验收**：`analyze` 用配置的视觉模型理解设计稿封面图；`lanhu_verify_render` /
  `vision_defect_check` / `vision_e2e_triage` 做渲染对比、UI 缺陷检测、E2E 失败归因。

TypeScript 实现，基于官方 MCP SDK（`@modelcontextprotocol/sdk` + `zod`）。
你自己的 coding Agent 就是流水线里的"代码生成引擎"——本 MCP 只负责"读设计"和"做验收"。

## 环境要求

- Node.js >= 18

## 安装 & 构建

```bash
npm install      # 装 SDK + zod；playwright 为可选依赖（scrape 兜底用）
npm run build    # tsc 编译到 dist/
```

## 快速开始

### 1. 准备蓝湖登录凭证（官方 API 只需要 Cookie）

```bash
# 一次性登录，保存 playwright storageState（含 cookie，官方 API 从中提取 cookie）
npm i playwright              # 仅 lanhu-login.mjs 需要
node lanhu-login.mjs
#   → 弹出浏览器手动登录蓝湖，回终端按 Enter，写到 .auth/lanhu-storage-state.json（已 gitignore）
```

或直接从浏览器 F12 → Network → 任意请求的 `Cookie` 头复制，配到 `LANHU_COOKIE`。

### 2. 配置视觉模型（analyze / 验收需要）

配置 `DEEPSEEK_API_KEY`（视觉模型 Key），可选 `LANHU_VISION_MODEL`。

### 3. 接入 Agent（项目根 `.mcp.json`）

```json
{
  "mcpServers": {
    "lanhu-vision": {
      "command": "node",
      "args": ["./mcp/lanhu-vision-mcp/dist/index.js"],
      "env": {
        "DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}",
        "VISION_BASE_URL": "https://api.deepseek.com",
        "LANHU_VISION_MODEL": "deepseek-v4-flash-vision-exp",
        "LANHU_STORAGE_STATE": "D:/gutaiwei/dream-site/mcp/lanhu-vision-mcp/.auth/lanhu-storage-state.json"
      }
    }
  }
}
```

`${DEEPSEEK_API_KEY}` 从 shell 环境变量展开，避免密钥入库。

## 工具一览

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `lanhu_fetch_design` | 读单个设计稿图层树（+可选视觉理解） | `url` / `mode`(api/scrape/mock) / `analyze` / `storageState` |
| `lanhu_list_sectors` | 列项目下所有分组（一个分组=一个需求） | `url` / `storageState` |
| `lanhu_read_sector` | 按分组名批量读该分组所有稿的图层树 | `url` / `sector` / `storageState` |
| `lanhu_verify_render` | 渲染页 vs 设计稿 语义对比 | `actualImageBase64` / `designImageBase64` |
| `vision_defect_check` | 整页/局部 UI 缺陷检测 | `imageBase64` / `language` |
| `vision_e2e_triage` | E2E 失败截图+DOM 归因 | `screenshotBase64` / `domSnapshot` / `errorText` |

## 使用示例

> 示例中的 `storageState` 均可用 `cookie` 串替代，或省略（走环境变量 `LANHU_STORAGE_STATE` / `LANHU_COOKIE`）。

### 读单个设计稿

```
lanhu_fetch_design({
  mode: "api",                 // 默认，官方 Cookie 接口
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  storageState: ".auth/lanhu-storage-state.json"
})
```

返回 `{ name, viewport, layers(精确坐标/色值/字号/文本), meta }`。

### 读 + 视觉理解设计稿（双重验证）

```
lanhu_fetch_design({
  mode: "api",
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  storageState: ".auth/lanhu-storage-state.json",
  analyze: true                 // 下载封面图 → 喂给视觉模型 → 返回 visionAnalysis 文字描述
})
```

`analyze` 会返回 `visionAnalysis`（布局/组件/配色/字体的文字理解），**封面图 base64 不进上下文**，
只在 server 内部喂给视觉模型。结合图层树的精确数值做双重验证。

### 列项目分组

```
lanhu_list_sectors({
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  storageState: ".auth/lanhu-storage-state.json"
})
```

返回 `{ sectorCount, sectors: [{ name, designCount, designs: [{name, image_id}] }] }`。

### 按分组批量读（完成某个需求）

```
lanhu_read_sector({
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  sector: "S2通行证",            // 分组名，从 lanhu_list_sectors 获取
  storageState: ".auth/lanhu-storage-state.json"
})
```

返回 `{ sector, designCount, designs: [{ name, viewport, layers, meta }] }`，一次读回该分组所有稿。

### 验收（做完页面后）

```
vision_defect_check({ imageBase64: "<渲染页截图>", language: "zh-CN" })
lanhu_verify_render({ actualImageBase64: "<渲染页>", designImageBase64: "<设计稿>" })
vision_e2e_triage({ screenshotBase64: "<失败截图>", domSnapshot: "<DOM>", errorText: "<报错>" })
```

## 抽取后端（mode）

| mode | 说明 | 依赖 |
|---|---|---|
| `api`（默认） | 蓝湖官方 Cookie 接口：`GET /api/project/image` → `json_url` 图层树 + `detail.url` 封面图 | 仅 Cookie |
| `scrape` | Playwright 爬取兜底（拦截 FigmaJSON / DOM 包围盒） | playwright + 浏览器 |
| `mock` | 内置示例图层树 | 无 |

官方 `api` 模式是主力：不依赖浏览器渲染画布，直接拿 `detail.url` 封面图（完整设计稿截图），
比截图/爬 DOM 稳、快、准。`scrape` 只作无 API 时的兜底。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | analyze/验收时必填 | — | 视觉模型 Key |
| `VISION_BASE_URL` | 否 | `https://api.deepseek.com` | 视觉模型端点（验证时可指向 mock） |
| `LANHU_VISION_MODEL` | 否 | `deepseek-v4-flash-vision-exp` | 视觉模型名 |
| `LANHU_CODEGEN_MODEL` | 否 | `deepseek-chat` | 预留：代码生成引擎名（由 Agent 自行调用） |
| `LANHU_COOKIE` | 官方 api 模式必填（或传 storageState） | — | 蓝湖登录 Cookie 串 |
| `LANHU_STORAGE_STATE` | 官方 api 模式必填（或传 cookie） | — | playwright storageState 文件路径，自动提取 cookie |
| `LANHU_SCRAPE_DEBUG` | 否 | — | 设为 `1` 时打印拦截到的蓝湖接口与字段名（scrape 校准用） |
| `LANHU_MOCK` | 否 | — | 设为 `1` 时 fetch_design 返回内置示例（无需联网） |

## 开发 / 类型检查

```bash
npm run typecheck   # tsc --noEmit，类型检查
npm run dev         # tsx 直接跑 src/index.ts（开发模式，无需先 build）
npm run build       # tsc 编译到 dist/
```

## 三种部署 / 分发方式

### 方式 A：拷贝即用（最简单，推荐给同事）
把整个 `lanhu-vision-mcp/` 目录发给对方，对方 `npm install && npm run build` 后，
用绝对或相对路径指到 `dist/index.js` 即可。

### 方式 B：npm 全局安装 / npx
```bash
npm i -g lanhu-vision-mcp     # 发布后；或本地：npm link
lanhu-vision-mcp              # 等价于 node dist/index.js
# 或一次性：npx -p lanhu-vision-mcp lanhu-vision-mcp
```

### 方式 C：Docker（团队统一运行时，可选）
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
CMD ["node", "dist/index.js"]
```
构建：`docker build -t lanhu-vision-mcp .`，运行时通过 `-e DEEPSEEK_API_KEY=...` 注入密钥。

## 接入各 coding Agent

所有 Agent 都接受同一份 MCP 配置。把上面「快速开始」的 `.mcp.json` 内容写进项目根
（Claude Code / Cursor / Trae / opencode 通用；Cursor 用 `.cursor/mcp.json`，opencode 用
`.opencode/mcp.json`，字段一致）。

- **Claude Code**：`~/.claude.json` 或项目 `.mcp.json`；可用 `settings.json` 的
  `PostToolUse` Hook 做到"改完 `.vue` 自动截屏 → `vision_defect_check` 验收"。
- **opencode**：`.opencode/mcp.json` + `hooks` 同样支持自动验收闭环。
- **Cursor**：`.cursor/mcp.json`；无原生 Hook，靠 `Rules`（`.cursor/rules`）让 Agent
  主动调工具，验收门禁放 CI 更稳。
- **Trae**：`.trae/mcp.json`；无原生 Hook，靠 `AGENTS`/规则 + SOLO 模式驱动。

## 给 Agent 的提示词骨架（建议写进 CLAUDE.md / AGENTS.md）

```
你可用 lanhu-vision MCP：
1. 实现某个需求/分组前，先 lanhu_list_sectors 看分组，再 lanhu_read_sector 批量读该分组所有稿。
2. 实现单个 UI 前 lanhu_fetch_design 取结构化图层树（色值/字号从数据取，不要靠截图 OCR 小字）；
   需要整体视觉理解时加 analyze:true 让视觉模型理解封面图。
3. 实现后把渲染页截图传给 lanhu_verify_render 做对比，或 vision_defect_check 做缺陷检测。
4. E2E 失败时把截图+DOM 传给 vision_e2e_triage 拿根因。
视觉模型的结论只当线索，涉及钱/权限/用户数据的流程必须人审。
```

## 红线（务必遵守）

- `-exp` 模型契约不稳定：`LANHU_VISION_MODEL` 走环境变量，保留像素 diff / axe 兜底。
- **蓝湖小字（色值、字号、间距）只从 `lanhu_fetch_design` 结构化数据取，绝不靠视觉模型 OCR 截图**——
  这是该视觉模型已知短板（图片压缩后 10px 数字/密集文本必读错）。
- 视觉模型判断只当线索；**钱 / 权限 / 用户数据相关流程必须人审或留 fallback**。
