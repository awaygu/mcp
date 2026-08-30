#!/usr/bin/env node
// index.ts — lanhu-vision-mcp 入口（官方 SDK + stdio 传输）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  // 未捕获异常兜底：MCP SDK 默认不处理，任一工具异步逃逸会让进程猝死且无日志
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack ?? err.message);
    process.exit(1);
  });

  const server = new McpServer({
    name: 'lanhu-vision-mcp',
    version: '2.0.0',
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅关闭：收到宿主信号时释放 server/transport，避免上层报"管道断开"
  const shutdown = async (signal: string) => {
    console.error(`收到 ${signal}，正在关闭 lanhu-vision-mcp…`);
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  console.error('lanhu-vision-mcp 已启动，等待连接…');
}

main().catch((err) => {
  console.error('启动失败:', err?.message || err);
  process.exit(1);
});
