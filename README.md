# mcp

个人 MCP server 集合容器。每个子目录是一个独立、零依赖、可直接分发的 MCP server。

## 子项

| 目录 | 说明 | 接入方式 |
| --- | --- | --- |
| `lanhu-vision-mcp/` | 蓝湖设计稿读取（官方 API + 分组枚举）+ 视觉理解/验收（UI 缺陷检测 / E2E 归因）的零依赖 stdio MCP server | 见其内 `README.md` 与 `.mcp.json` |

## 约定

- **新增一个 MCP**：在仓库根建 `<your-mcp>/` 子目录，内部自带 `package.json` / `.mcp.json` / `README.md`，尽量零依赖。
- 每个 MCP server 仅用 Node 内置模块实现 stdio JSON-RPC，可被 Trae / Cursor / Claude Code / opencode 等任意 Agent 通过 `.mcp.json` 注册。
- 登录态 / 密钥放各子目录的 `.auth/`（已被各子目录 `.gitignore` 忽略），**勿提交**。

## License

MIT —— 见 [LICENSE](./LICENSE)。
