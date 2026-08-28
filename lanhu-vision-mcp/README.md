# lanhu-vision-mcp

零依赖 stdio MCP server，让任意支持 MCP 的 coding Agent（Claude Code / Cursor / Trae /
opencode）获得两件事：

- **读蓝湖的眼睛**：`lanhu_fetch_design` 取结构化图层树（x/y/宽高/色值/字号/圆角），精确数值
  来自结构化数据，**不靠视觉模型 OCR 截图上的小字**。
- **视觉验收的尺子**：`lanhu_verify_render` / `vision_defect_check` / `vision_e2e_triage` 调视觉
  模型（默认 `deepseek-v4-flash-vision-exp`）做渲染对比、UI 缺陷检测、E2E 失败归因。

整个包只用 Node 内置模块（`node:https` / `node:http`），**无任何 npm 依赖**，可独立部署或
直接拷贝给他人使用。你自己的 coding Agent 就是流水线里的"代码生成引擎"——本 MCP 只负责
"读设计"和"做验收"。

## 环境要求

- Node.js >= 18（仅用 ESM + 内置 http/https，无需安装任何依赖）

## 工具一览

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `lanhu_fetch_design` | 读取蓝湖设计稿结构化图层树 | `mode`(api/scrape/mock) / `projectId`+`pageId`(api) / `url`+`cookie`/`storageState`(scrape) / `mock` |
| `lanhu_verify_render` | 渲染页 vs 设计稿 语义对比 | `actualImageBase64` / `designImageBase64` |
| `vision_defect_check` | 整页/局部 UI 缺陷检测 | `imageBase64` / `language` |
| `vision_e2e_triage` | E2E 失败截图+DOM 归因 | `screenshotBase64` / `domSnapshot` / `errorText` |

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 真实调用时必填 | — | 视觉模型 Key |
| `VISION_BASE_URL` | 否 | `https://api.deepseek.com` | 视觉模型端点（验证时可指向 mock） |
| `LANHU_VISION_MODEL` | 否 | `deepseek-v4-flash-vision-exp` | 视觉模型名 |
| `LANHU_CODEGEN_MODEL` | 否 | `deepseek-chat` | 预留：代码生成引擎名（由 Agent 自行调用） |
| `LANHU_API_KEY` | 真实 fetch 时必填 | — | 蓝湖企业版 API key（mode=api） |
| `LANHU_API_BASE` | 否 | `https://api.lanhuapp.com` | 蓝湖企业版接口 base |
| `LANHU_COOKIE` | 否 | — | 普通账号 cookie 串（mode=scrape，也可用入参 `cookie`） |
| `LANHU_STORAGE_STATE` | 否 | — | playwright storageState 文件路径（mode=scrape，由 `lanhu-login.mjs` 生成） |
| `LANHU_SCRAPE_DEBUG` | 否 | — | 设为 `1` 时打印拦截到的蓝湖接口与字段名，用于首次校准 |
| `LANHU_MOCK` | 否 | — | 设为 `1` 时 fetch_design 返回内置示例图层树（无需联网） |

## 普通账号？用 mode=scrape（无需企业版 API）

普通蓝湖账号没有开放 API，改用 Playwright 真实渲染设计页并抽取结构化数据：

```bash
# 1) 安装 playwright（仅 scrape 模式需要；其余工具仍零依赖）
npm i playwright && npx playwright install chromium

# 2) 一次性登录，保存登录态（弹出浏览器手动登录，回车落盘）
node lanhu-login.mjs
#   → 写到 .auth/lanhu-storage-state.json（已被 .gitignore 忽略）

# 3) 在 Agent 对话里让模型这样取设计稿：
#    lanhu_fetch_design({ mode:"scrape", url:"https://lanhuapp.com/.../project/<id>/page/<pageId>",
#                         storageState:".auth/lanhu-storage-state.json" })
```

**抽取策略**：优先拦截蓝湖网页 XHR/fetch 拉取的设计数据 JSON（最准）；若拦截不到，
退回抓可见 DOM 元素的包围盒 + 计算样式 + 文本作为近似。蓝湖网页是 SPA，真实 DOM /
接口字段名可能随版本变化——首次接入真实账号时，用 `LANHU_SCRAPE_DEBUG=1 node server.mjs`
跑一次，检查拦截到的字段名，必要时据此校准 `scrape-lanhu.mjs` 里的 `normalizeSketch`。
截图本身也支持：`lanhu_fetch_design({ mode:"scrape", url, screenshot:true })` 会一并返回页面截屏 base64。

> ⚠️ 沙箱/无浏览器环境跑不了真实 scrape；本包 `verify.mjs` 已验证"未装 playwright 时
> scrape 模式会优雅报错而非崩溃"，保证 server 默认零依赖、其余工具照常可用。

## 本地自测（无需 Key / 无需联网）

```bash
node verify.mjs
# 期望输出：==== 7/7 checks passed ====
```

`verify.mjs` 会拉起一个 mock 视觉端点 + 启动 `server.mjs`，用标准 JSON-RPC 跑通
`initialize` / `tools/list` / 4 个 `tools/call`，证明集成层成立。

## 三种部署 / 分发方式

### 方式 A：拷贝即用（最简单，推荐给同事）
直接把整个 `lanhu-vision-mcp/` 目录发给对方，对方用绝对或相对路径指到 `server.mjs` 即可。

### 方式 B：npm 全局安装 / npx
```bash
npm i -g lanhu-vision-mcp     # 发布后；或本地：npm link
lanhu-vision-mcp              # 等价于 node server.mjs
# 或一次性：npx -p lanhu-vision-mcp lanhu-vision-mcp
```

### 方式 C：Docker（团队统一运行时，可选）
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
CMD ["node", "server.mjs"]
```
构建：`docker build -t lanhu-vision-mcp .`，运行时通过 `-e DEEPSEEK_API_KEY=...` 注入密钥。

## 接入各 coding Agent

所有 Agent 都接受同一份 MCP 配置。把下面内容写进项目根的 `.mcp.json`（Claude Code /
Cursor / Trae / opencode 通用；Cursor 用 `.cursor/mcp.json`，opencode 用
`.opencode/mcp.json`，字段一致）：

```json
{
  "mcpServers": {
    "lanhu-vision": {
      "command": "node",
      "args": ["./mcp/lanhu-vision-mcp/server.mjs"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-xxx",
        "VISION_BASE_URL": "https://api.deepseek.com",
        "LANHU_VISION_MODEL": "deepseek-v4-flash-vision-exp",
        "LANHU_API_KEY": "可选-蓝湖企业版key"
      }
    }
  }
}
```

- **Claude Code**：`~/.claude.json` 或项目 `.mcp.json`；可用 `settings.json` 的
  `PostToolUse` Hook 做到"改完 `.vue` 自动截屏 → `vision_defect_check` 验收"。
- **opencode**：`.opencode/mcp.json` + `hooks` 同样支持自动验收闭环。
- **Cursor**：`.cursor/mcp.json`；无原生 Hook，靠 `Rules`（`.cursor/rules`）让 Agent
  主动调工具，验收门禁放 CI 更稳。
- **Trae**：`.trae/mcp.json`；无原生 Hook，靠 `AGENTS`/规则 + SOLO 模式驱动。

## 给 Agent 的提示词骨架（建议写进 CLAUDE.md / AGENTS.md）

```
你可用 lanhu-vision MCP：
1. 实现 UI 前先 lanhu_fetch_design 取结构化图层树做依据（色值/字号从数据取，不要靠截图 OCR 小字）。
2. 实现后把渲染页截图传给 lanhu_verify_render 做对比，或 vision_defect_check 做缺陷检测。
3. E2E 失败时把截图+DOM 传给 vision_e2e_triage 拿根因。
视觉模型的结论只当线索，涉及钱/权限/用户数据的流程必须人审。
```

## 红线（务必遵守）

- `-exp` 模型契约不稳定：`LANHU_VISION_MODEL` 走环境变量，保留像素 diff / axe 兜底。
- **蓝湖小字（色值、字号、间距）只从 `lanhu_fetch_design` 结构化数据取，绝不靠视觉模型 OCR 截图**——
  这是该视觉模型已知短板（图片压缩后 10px 数字/密集文本必读错）。
- 视觉模型判断只当线索；**钱 / 权限 / 用户数据相关流程必须人审或留 fallback**。
