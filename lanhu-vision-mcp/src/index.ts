#!/usr/bin/env node
// index.ts — lanhu-vision-mcp 入口（官方 SDK + stdio 传输）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'lanhu-vision-mcp',
    version: '2.0.0',
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('lanhu-vision-mcp 已启动，等待连接…');
}

main().catch((err) => {
  console.error('启动失败:', err?.message || err);
  process.exit(1);
});
