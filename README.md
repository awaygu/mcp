# mcp

个人 MCP server 集合容器。每个子目录是一个独立、零依赖、可直接分发的 MCP server。

## 子项

| 目录 | 说明 | 接入方式 |
| --- | --- | --- |
| `lanhu-mcp-vision/` | 蓝湖设计稿读取（官方 API + 分组枚举）+ 视觉理解/验收（UI 缺陷检测 / E2E 归因）的零依赖 stdio MCP server | 见其内 `README.md` 与 `.mcp.json` |
| `codesign-mcp-vision/` | 腾讯 CoDesign 原型（Axure）读取：分段截图 + VLM 视觉解析，生成纯文本结构化需求文档（PRD）的 stdio MCP server | 见其内 `README.md` |
| `shimo-mcp-i18n/` | 石墨文档多语言翻译表读取（Cookie 直调 values API，行号/语言过滤）+ xlsx 导出与 i18n JSON 生成的 stdio MCP server | 见其内 `README.md` 与 `.mcp.json` |

## 约定

- **新增一个 MCP**：在仓库根建 `<your-mcp>/` 子目录，内部自带 `package.json` / `.mcp.json` / `README.md`，尽量零依赖。
- 每个 MCP server 仅用 Node 内置模块实现 stdio JSON-RPC，可被 Trae / Cursor / Claude Code / opencode 等任意 Agent 通过 `.mcp.json` 注册。
- 登录态 / 密钥放各子目录的 `.auth/`（已被各子目录 `.gitignore` 忽略），**勿提交**。

## 本地调试（MCP Inspector）

三个 MCP 共用官方调试工具 [MCP Inspector](https://github.com/modelcontextprotocol/inspector)：命令行参数与环境变量可写进本地配置文件，Web UI 里可视化调用工具、查看 JSON-RPC 报文，免每次重填。

仓库根建 `inspector.config.json`（已 gitignore，含明文密钥勿提交），`env` 写法与各项目 `.mcp.json` 的 env 块一致，可互搬：

```json
{
  "mcpServers": {
    "shimo-i18n": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/mcp/shimo-mcp-i18n",
      "env": { "SHIMO_COOKIE_FILE": "./.mcp-local/shimo.cookie" }
    },
    "lanhu-vision": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/mcp/lanhu-mcp-vision",
      "env": {
        "VLM_API_KEY": "sk-xxx",
        "VLM_BASE_URL": "https://api.deepseek.com",
        "VLM_MODEL": "deepseek-v4-flash-vision-exp",
        "LANHU_COOKIE_FILE": "./.mcp-local/lanhu.cookie"
      }
    },
    "codesign-vision": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/mcp/codesign-mcp-vision",
      "env": { "VLM_API_KEY": "sk-xxx" }
    }
  }
}
```

```bash
npx @modelcontextprotocol/inspector --config inspector.config.json   # Web UI，下拉选 server
```

要点：

- **`env` 即注入 server 进程的环境变量**；**`cwd` 写绝对路径**钉住子项目目录（官方文档未定义相对路径的解析基准），这样 `./.mcp-local/*.cookie` 相对路径才可靠——示例中 `/path/to/mcp` 是占位符，实际填本机仓库绝对路径。各项目完整环境变量表见其内 `README.md`。
- **改代码免 build**：`command` 换 `"npx"`、`args` 换 `["tsx", "src/index.ts"]`（tsx 已在各项目 devDependencies）。
- **三种加载方式**：`--config <path>` 只读（Inspector 保证不回写文件，明文密钥安全，文件缺失报错）；`--catalog <path>` 可写（UI 内编辑后保存回文件，首次不存在自动播种）；不带参数用全局 `~/.mcp-inspector/mcp.json`（可用 `MCP_CATALOG_PATH` 改）。`--config` 与 `--catalog` 互斥。
- **`--server <名字>` 仅 `--cli` 模式生效**，可脱离 UI 脚本化调试：
  `npx @modelcontextprotocol/inspector --config inspector-config.json --server shimo-i18n --cli --method tools/list`
- 配置文件**不支持 `${VAR}` 插值**：密钥要么写实际值（配合 gitignore），要么只传 `*_COOKIE_FILE` 路径、真实 cookie 留 `.mcp-local/`。
- **环境变量优先级：工具入参 > 环境变量 > cookie 文件**。曾设过的 `LANHU_COOKIE` / `SHIMO_COOKIE` 环境变量会压制文件内容——`login` 脚本续期写入文件后仍 401，就是旧环境变量在生效，删掉或统一走文件方式。
- **npx / npm link**：三个子包均声明 `bin`，`npm install && npm run build` 后于子目录 `npm link` 即得全局命令；发布 npm 后 `npx -p <pkg> <pkg>` 可用。开发期 Agent 接入建议直接 `node` + `dist/index.js` 绝对路径（Windows 下部分 Agent 拉 npx 需 `cmd /c` 包一层）。

## License

MIT —— 见 [LICENSE](./LICENSE)。
