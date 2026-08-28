# lanhu-vision-mcp

零依赖 stdio MCP server，让任意支持 MCP 的 coding Agent（Claude Code / Cursor / Trae /
opencode）获得三件事：

- **读蓝湖的眼睛**：通过蓝湖官方 API（Cookie 直调，无需浏览器）取结构化图层树
  （x/y/宽高/色值/字号/圆角/文本），精确数值来自结构化数据，**不靠视觉模型 OCR 截图上的小字**。
- **按项目/分组组织**：`lanhu_list_directory` 一次拉全团队目录（**无需链接**，项目→分组一页地图），
  `lanhu_read_sector` 按分组批量读，支持「团队 → 项目 → 分组（需求）→ 设计稿」完整层级。
- **下载切图**：`lanhu_download_slices` 把设计稿切图素材拉到本地 assets，供开发引用。
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

配置 `LLM_API_KEY`（视觉模型 Key），可选 `LANHU_VISION_MODEL`。

### 3. 接入 Agent（项目根 `.mcp.json`）

```json
{
  "mcpServers": {
    "lanhu-vision": {
      "command": "node",
      "args": ["./mcp/lanhu-vision-mcp/dist/index.js"],
      "env": {
        "LLM_API_KEY": "${LLM_API_KEY}",
        "VISION_BASE_URL": "https://api.deepseek.com",
        "LANHU_VISION_MODEL": "deepseek-v4-flash-vision-exp",
        "LANHU_STORAGE_STATE": "./mcp/lanhu-vision-mcp/.auth/lanhu-storage-state.json"
      }
    }
  }
}
```

`${LLM_API_KEY}` 从 shell 环境变量展开，避免密钥入库。

## 工具一览

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `lanhu_fetch_design` | 读单个设计稿图层树（+可选视觉理解） | `url` / `mode`(api/scrape/mock) / `analyze` / `storageState` |
| `lanhu_list_directory` | 一次拉全团队目录（项目→分组，**无需链接**）。约 1.6k tokens | `storageState` |
| `lanhu_read_sector` | 按分组名批量读该分组所有稿的图层树 | `url`(链接/UUID) / `sector` / `storageState` |
| `lanhu_download_slices` | 下载切图到本地目录（单稿或分组批量，三层去重） | `url` / `outputPath` / `sector?` / `sliceNames?` / `skipExisting?` / `format`(png/svg) |
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
  sector: "S2通行证",            // 分组名，从 lanhu_list_directory 看到
  storageState: ".auth/lanhu-storage-state.json"
})
```

返回 `{ sector, designCount, designs: [{ name, viewport, layers, meta }] }`，一次读回该分组所有稿。

### 不知道蓝湖链接，按活动名找分组（一页目录）

当你说"帮我看看海底主题活动有几个设计稿"时，AI 无需你给链接，一次拉全团队目录直接定位：

```
lanhu_list_directory({ storageState: ".auth/lanhu-storage-state.json" })
```

返回一张完整目录（约 1.6k tokens，并行拉取约 2 秒）：

```js
{
  teamId, projectCount: 8, sectorCount: 163,
  directory: [
    { project: "Dreamlive H5/Web 4",
      projectId: "b54e3d95-e07d-4195-ac89-83d6c8b3fa92",
      sectors: [
        { name: "S2通行证", designCount: 18 },
        { name: "海底主题活动", designCount: 5 },
        // ...
      ] },
    // ...更多项目
  ]
}
```

AI 在这份目录里按分组名匹配"海底主题活动" → 拿到所在项目的 `projectId` →
传给 `lanhu_read_sector({ url: projectId, sector: "海底主题活动" })` 读稿。
没匹配上则如实回答未找到，或问用户补充。

> `lanhu_read_sector` 的 `url` 参数同时接受**蓝湖链接**和**项目 UUID**（来自 `lanhu_list_directory` 的 `projectId`）。
> `lanhu_list_directory` 的 `team_id` 从 `storageState` 的 localStorage 自动读取，无需配置。
> 只到分组层（含 designCount），不展开设计稿名——保持轻量；稿名在读 sector 时才按需拉。

### 下载切图到本地项目（开发引用素材）

实现某个设计稿时，把稿里标记导出的切图（icon/图/头像框等）拉到本地 assets。两种范围、三层去重：

**单稿下载**：

```
lanhu_download_slices({
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  outputPath: "src/assets/masked-ball/",
  format: "png"                             // 或 "svg"
})
```

**分组批量下载**（跨稿去重，公共 icon 只下一次）：

```
lanhu_download_slices({
  url: "b54e3d95-...",                      // 项目 UUID 或该分组任一稿链接
  sector: "S2通行证",                         // 分组名（从 lanhu_list_directory 看到）
  outputPath: "src/assets/s2-passport/"
})
```
拉该分组所有稿的切图合并去重。实测 20 稿 194 切图 → URL 去重后 133 张，省 61 张重复。

**只下指定切图**（sliceNames 过滤）：

```
lanhu_download_slices({
  url: "...",
  outputPath: "...",
  sliceNames: ["关闭icon", "返回btn"]        // 只下这几个名字的切图
})
```

返回：
```js
{
  scope: "S2通行证",        // 单稿=稿名，分组=分组名
  outputDir: "/abs/.../src/assets/s2-passport",
  downloaded: 133,          // 实际下载张数
  skipped: { dup: 61, exist: 0 },  // URL 去重跳过 / 本地已存在跳过
  failed: [],               // 下载失败明细（不再静默跳过）
  slices: [{ name, file, bytes, w, h }]  // 全部已落盘+已存在的切片
}
```

三层去重（默认全开，可独立开关）：
1. **URL 去重** —— 蓝湖切图 URL 按图内容 hash 命名，同 URL = 同图，只下一次（解决跨稿+稿内重复）
2. **skipExisting** —— 本地已存在同名文件就跳过（`skipExisting:false` 可强制重下；默认 true）
3. **sliceNames** —— 只下指定名字的切图（同名不同 URL 都下，因为它们是不同的图）

文件名为「图层名 + 短 hash + 扩展名」（清洗非法字符 `/ \ : * ? " < > |`、防重名），AI 拿到 `file` 路径即可在代码里引用。切图来自蓝湖公开 CDN，无需 cookie 即可下载。

> **关于倍率/平台**：蓝湖客户端可按 `@2x/@3x` 或安卓 `mipmap-xxxhdpi` 选倍率，但官方 API 返回的切图 URL 是单一默认值（安卓端最高分辨率 xxxhdpi/4x）。H5 用 CSS 控制显示尺寸，直接用最高清原图即可，本工具不做平台/倍率选择——如需低倍率图，自行缩放处理。

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
| `LLM_API_KEY` | analyze/验收时必填 | — | 视觉模型 Key |
| `VISION_BASE_URL` | 否 | `https://api.deepseek.com` | 视觉模型端点（验证时可指向 mock） |
| `LANHU_VISION_MODEL` | 否 | `deepseek-v4-flash-vision-exp` | 视觉模型名 |
| `LANHU_COOKIE` | 官方 api 模式必填（或传 storageState） | — | 蓝湖登录 Cookie 串 |
| `LANHU_STORAGE_STATE` | 官方 api 模式必填（或传 cookie） | — | playwright storageState 文件路径，自动提取 cookie（相对路径相对 MCP 子进程 cwd，即工作区根目录） |
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
构建：`docker build -t lanhu-vision-mcp .`，运行时通过 `-e LLM_API_KEY=...` 注入密钥。

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
1. 不知道蓝湖链接时，lanhu_list_directory 一次拉全团队目录（项目→分组），
   在里面按分组名匹配用户说的活动 → 拿到 projectId 传给 lanhu_read_sector。
   没匹配则如实回答未找到或问用户。无需让用户补链接，无需自己下钻。
2. 有链接或项目 UUID 时，lanhu_read_sector({url: 链接或UUID, sector: 分组名}) 批量读该分组所有稿。
3. 实现单个 UI 前 lanhu_fetch_design 取结构化图层树（色值/字号从数据取，不要靠截图 OCR 小字）；
   需要整体视觉理解时加 analyze:true 让视觉模型理解封面图。
4. 需要切图素材时 lanhu_download_slices 下载到项目 assets 目录，代码里引用返回的 file 路径。
5. 实现后把渲染页截图传给 lanhu_verify_render 做对比，或 vision_defect_check 做缺陷检测。
6. E2E 失败时把截图+DOM 传给 vision_e2e_triage 拿根因。
视觉模型的结论只当线索，涉及钱/权限/用户数据的流程必须人审。
```

## 红线（务必遵守）

- `-exp` 模型契约不稳定：`LANHU_VISION_MODEL` 走环境变量，保留像素 diff / axe 兜底。
- **蓝湖小字（色值、字号、间距）只从 `lanhu_fetch_design` 结构化数据取，绝不靠视觉模型 OCR 截图**——
  这是该视觉模型已知短板（图片压缩后 10px 数字/密集文本必读错）。
- 视觉模型判断只当线索；**钱 / 权限 / 用户数据相关流程必须人审或留 fallback**。
