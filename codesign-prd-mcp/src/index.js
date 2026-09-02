#!/usr/bin/env node
/**
 * CoDesign PRD MCP Server
 *
 * 读取腾讯 CoDesign 产品原型（Axure），分段截图 + VLM 解析，
 * 生成纯文本结构化需求文档，供 AI Coding Agent 使用。
 *
 * MCP 工具：
 *   - get_prototype_outline   获取原型页面大纲
 *   - get_page_content        获取单个页面结构化内容
 *   - get_requirement_doc     获取指定分组的完整需求文档（核心）
 *   - analyze_flowchart       单独分析流程图截图
 *   - cache_stats             查看 VLM 解析缓存占用
 *   - clear_cache             清空 VLM 解析缓存
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { openShareLink, getPageOutline, getSinglePage, getGroupPages } from './crawler.js';
import {
  isVLMConfigured,
  analyzeSingleImage,
  flowchartToMermaid,
  tableToMarkdown,
} from './vlm.js';
import { processPage, processPages } from './pipeline.js';
import { generateRequirementDoc } from './doc-generator.js';
import { clearCache, cacheStats, cacheDir } from './cache.js';
import { closeBrowser, getPage } from './browser.js';

/**
 * 记录浏览器当前所处的链接。不能用「曾经打开过」的集合，
 * 否则 A→B→A 的调用顺序会错误地跳过第二次 A 的导航，导致在 B 的页面上解析 A 的内容。
 */
let currentUrl = null;
let currentPassword = null;

/**
 * url/password 支持环境变量默认值：MCP 配置里设置一次 CODESIGN_URL / CODESIGN_PASSWORD，
 * Agent 后续调用只需传业务参数（如 groupName），不必每次重复带凭据。
 */
function resolveAccess(url, password) {
  const resolvedUrl = url || process.env.CODESIGN_URL || '';
  if (!resolvedUrl) {
    throw new Error('缺少 url 参数，且未设置环境变量 CODESIGN_URL');
  }
  return { url: resolvedUrl, password: password || process.env.CODESIGN_PASSWORD || undefined };
}

async function ensureOpened(url, password) {
  const nextPassword = password ?? null;
  // 浏览器崩溃/被关闭后必须重新导航，否则同 URL 会永久跳过 openShareLink 卡死
  const browserAlive = !!getPage()?.context()?.browser()?.isConnected() && !getPage()?.isClosed();
  if (currentUrl === url && currentPassword === nextPassword && browserAlive) return;

  // 先置空：openShareLink 失败时不会残留错误状态，下次调用必然重新导航
  currentUrl = null;
  currentPassword = null;
  await openShareLink(url, password);
  currentUrl = url;
  currentPassword = nextPassword;
}

/**
 * 串行化所有浏览器操作。浏览器 page 是进程内单例，
 * 并发调用会让导航互相打断，最终读到别的页面的内容。
 */
let lockChain = Promise.resolve();
function withBrowserLock(task) {
  const result = lockChain.then(task, task);
  lockChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function serverVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    if (pkg.version) return pkg.version;
  } catch {}
  return '0.1.0';
}

const server = new McpServer({
  name: 'codesign-prd-mcp',
  version: serverVersion(),
});

// ─── 工具1：获取原型页面大纲 ───────────────────────────────────
server.registerTool(
  'get_prototype_outline',
  {
    description: '获取 CoDesign 产品原型的页面目录大纲（左侧导航树），用于了解原型结构和定位需求页面',
    inputSchema: {
      url: z.string().optional().describe('CoDesign 分享链接；不传时使用环境变量 CODESIGN_URL'),
      password: z.string().optional().describe('访问密码（4位）；不传时使用环境变量 CODESIGN_PASSWORD'),
    },
  },
  async ({ url, password }) => {
    try {
      const text = await withBrowserLock(async () => {
        const access = resolveAccess(url, password);
        await ensureOpened(access.url, access.password);
        const outline = await getPageOutline();

        const lines = ['# 原型页面大纲\n'];
        outline.forEach((item) => {
          const indent = '  '.repeat(item.level);
          const icon = item.isGroup ? '📁' : '📄';
          const index = item.pageIndex !== undefined ? ` (第${item.pageIndex + 1}页)` : '';
          // 展示完整路径：同名页面靠它消歧，调用方按此传 pageName/groupName
          lines.push(`${indent}- ${icon} ${item.path}${index}`);
        });
        return lines.join('\n');
      });

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `获取大纲失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── 工具2：获取单个页面结构化内容 ─────────────────────────────
server.registerTool(
  'get_page_content',
  {
    description: '获取 CoDesign 原型中单个页面的结构化内容（VLM 解析后纯文本，含组件/交互/表格）。页面同名时传完整路径「父分组/页面名」',
    inputSchema: {
      url: z.string().optional().describe('CoDesign 分享链接；不传时使用环境变量 CODESIGN_URL'),
      password: z.string().optional().describe('访问密码；不传时使用环境变量 CODESIGN_PASSWORD'),
      pageName: z.string().describe('页面名称（叶子名或完整路径「父分组/页面名」，同名页面须用路径区分）'),
      vlmEnabled: z.boolean().optional().describe('是否启用 VLM 解析，默认 true'),
    },
  },
  async ({ url, password, pageName, vlmEnabled = true }) => {
    try {
      const access = resolveAccess(url, password);
      // 爬取需要独占浏览器；VLM 只依赖已落盘的截图，放在锁外避免长时间占用
      const pageData = await withBrowserLock(async () => {
        await ensureOpened(access.url, access.password);
        return await getSinglePage(pageName, access.url);
      });
      const merged = await processPage(pageData, access.url, { vlmEnabled });

      let result = `# ${merged.pageName}\n\n`;
      result += `**页面类型**：${merged.type === 'flowchart' ? '流程图' : merged.type === 'table' ? '配置表' : '普通页面'}\n\n`;

      if (merged.type === 'flowchart' && merged.vlmResult) {
        const fc = merged.vlmResult;
        if (fc.summary) result += `**流程概述**：${fc.summary}\n\n`;
        if (fc.main_flow?.length && fc.nodes) {
          const nodeMap = {};
          fc.nodes.forEach((n) => (nodeMap[n.id] = n.text));
          result += `**主流程**：${fc.main_flow.map((id) => nodeMap[id] || id).join(' → ')}\n\n`;
        }
        if (fc.nodes?.length) {
          result += `**流程节点**：\n\n`;
          fc.nodes.forEach((n) => {
            result += `- [${n.type}] ${n.text}\n`;
          });
          result += '\n';
        }
        if (fc.edges?.length) {
          result += `**连线**：\n\n`;
          fc.edges.forEach((e) => {
            const from = fc.nodes?.find((n) => n.id === e.from)?.text || e.from;
            const to = fc.nodes?.find((n) => n.id === e.to)?.text || e.to;
            result += `- ${from} ${e.condition ? `--[${e.condition}]-->` : '-->'} ${to}\n`;
          });
          result += '\n';
        }
        if (fc.nodes?.length) {
          result += `**流程图（Mermaid）**：\n\n${flowchartToMermaid(fc)}\n\n`;
        }
      } else if (merged.type === 'page' && merged.vlmResult) {
        const ps = merged.vlmResult;
        if (ps.page_type) result += `**页面类型**：${ps.page_type}\n\n`;
        if (ps.layout) result += `**布局结构**：${ps.layout}\n\n`;
        if (ps.components?.length) {
          result += `**核心组件**：\n\n`;
          ps.components.forEach((c) => {
            result += `- [${c.type}] ${c.name}: ${c.description}\n`;
          });
          result += '\n';
        }
        if (ps.interactions?.length) {
          result += `**交互行为**：\n\n`;
          ps.interactions.forEach((i) => (result += `- ${i}\n`));
          result += '\n';
        }
        if (ps.states?.length) {
          result += `**页面状态**：\n\n`;
          ps.states.forEach((s) => (result += `- ${s}\n`));
          result += '\n';
        }
      }

      if (merged.tables?.length) {
        result += `**数据表格**：\n\n`;
        merged.tables.forEach((table) => {
          if (table.title) result += `**${table.title}**\n\n`;
          result += tableToMarkdown(table) + '\n';
        });
      }

      if (merged.images?.length) {
        result += `**页面内嵌原型图**：${merged.images.length} 张\n\n`;
        merged.images.forEach((im) => {
          result += `- ${im.width}x${im.height}${im.alt ? `（${im.alt}）` : ''}\n`;
        });
        result += '\n';
      }

      if (!merged._hasVLM && merged.domText) {
        result += `**页面文字**：\n\n${merged.domText}\n\n`;
      }

      if (merged.warnings?.length) {
        result += `**注意事项**：\n\n`;
        merged.warnings.forEach((w) => (result += `- ⚠️ ${w}\n`));
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `获取页面内容失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── 工具3：获取完整需求文档（核心工具） ────────────────────────
server.registerTool(
  'get_requirement_doc',
  {
    description:
      '【核心】获取 CoDesign 原型中指定需求分组的完整结构化需求文档。自动遍历所有页面，分段截图 + VLM 解析，输出纯文本 PRD（无截图路径），AI Coding Agent 可直接使用',
    inputSchema: {
      url: z.string().optional().describe('CoDesign 分享链接；不传时使用环境变量 CODESIGN_URL'),
      password: z.string().optional().describe('访问密码；不传时使用环境变量 CODESIGN_PASSWORD'),
      groupName: z.string().describe('需求分组名称，如"赛季通行证S2优化"；同名歧义时用完整路径。分组名不确定时可直接调用，失败会返回候选列表'),
      vlmEnabled: z.boolean().optional().describe('是否启用 VLM 解析，默认 true'),
      detailLevel: z
        .enum(['summary', 'standard', 'full'])
        .optional()
        .describe('文档详细程度：summary(精简)/standard(标准)/full(完整)，默认 standard'),
      outputFile: z
        .boolean()
        .optional()
        .describe('true 时文档写入 output/ 目录，返回文件路径+每页摘要而非全文，避免大文档占满上下文；之后按需读取文件'),
    },
  },
  async ({ url, password, groupName, vlmEnabled = true, detailLevel = 'standard', outputFile }) => {
    try {
      const access = resolveAccess(url, password);
      // 爬取阶段独占浏览器（单页顺序导航无法并行）
      const pagesData = await withBrowserLock(async () => {
        await ensureOpened(access.url, access.password);
        return await getGroupPages(groupName, access.url);
      });

      // VLM 阶段不碰浏览器，放在锁外；所有页面的分段统一走一次全局并发
      const mergedPages = await processPages(pagesData, access.url, { vlmEnabled });

      const doc = generateRequirementDoc({
        groupName,
        sourceUrl: access.url,
        pages: mergedPages,
        detailLevel,
      });

      if (outputFile) {
        const safeGroupName = groupName.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
        const outDir = path.join(process.cwd(), 'output');
        mkdirSync(outDir, { recursive: true });
        const filePath = path.join(outDir, `${safeGroupName}_需求文档.md`);
        writeFileSync(filePath, doc, 'utf-8');

        // 返回文件路径 + 每页一行的摘要，Agent 按需读取文件内容
        const typeMap = { flowchart: '流程图', table: '配置表', page: '普通页面' };
        const lines = mergedPages.map((p) => {
          const warn = p.warnings?.length ? ` | ⚠️ ${p.warnings.join(';')}` : '';
          return `- ${p.pageName}（${typeMap[p.type] || p.type}，${p._segmentCount || 0} 段）${warn}`;
        });
        return {
          content: [
            {
              type: 'text',
              text: [
                `文档已生成：${filePath}`,
                `共 ${mergedPages.length} 页，全文请按需读取该文件（可按章节偏移分段读取）。`,
                '',
                ...lines,
              ].join('\n'),
            },
          ],
        };
      }

      return { content: [{ type: 'text', text: doc }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `生成需求文档失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── 工具4：单独分析流程图图片 ─────────────────────────────────
server.registerTool(
  'analyze_flowchart',
  {
    description: '用 VLM 分析一张流程图截图，输出结构化的节点、连线、分支信息和 Mermaid 代码',
    inputSchema: {
      imagePath: z.string().describe('流程图图片的本地文件路径'),
    },
  },
  async ({ imagePath }) => {
    try {
      if (!isVLMConfigured()) {
        return {
          content: [
            {
              type: 'text',
              text: 'VLM_API_KEY 未配置，无法分析流程图。请设置环境变量后重试。',
            },
          ],
          isError: true,
        };
      }

      const flowchart = await analyzeSingleImage(imagePath, 'flowchart', {
        segmentIndex: 1,
        totalSegments: 1,
      });
      const mermaid = flowchartToMermaid(flowchart);

      let result = `# 流程图分析结果\n\n`;
      result += `## 概述\n${flowchart.summary || ''}\n\n`;

      if (flowchart.nodes?.length) {
        result += `## 节点 (${flowchart.nodes.length})\n\n`;
        flowchart.nodes.forEach((n) => {
          result += `- **[${n.type}]** ${n.text} (ID: ${n.id})\n`;
        });
        result += '\n';
      }

      if (flowchart.edges?.length) {
        result += `## 连线 (${flowchart.edges.length})\n\n`;
        flowchart.edges.forEach((e) => {
          const fromText = flowchart.nodes?.find((n) => n.id === e.from)?.text || e.from;
          const toText = flowchart.nodes?.find((n) => n.id === e.to)?.text || e.to;
          result += `- ${fromText} ${e.condition ? `--[${e.condition}]-->` : '-->'} ${toText}\n`;
        });
        result += '\n';
      }

      result += `## Mermaid 代码\n\n${mermaid}\n`;
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `流程图分析失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── 工具5：查看缓存占用 ───────────────────────────────────────
server.registerTool(
  'cache_stats',
  {
    description: '查看 VLM 解析缓存的占用情况（条目数与体积），用于判断是否需要清理',
    inputSchema: {},
  },
  async () => {
    const stats = cacheStats();
    return {
      content: [
        {
          type: 'text',
          text: [
            `VLM 解析缓存：${stats.total} 条，共 ${formatBytes(stats.size)}`,
            `缓存目录：${cacheDir()}`,
            '',
            '缓存键 = md5(分享链接 + 页面名 + 页面类型 + VLM 版本指纹 + 各截图内容哈希)',
            '原型内容变动或调整 Prompt / 更换模型后，旧缓存会自动失效。',
            '注意：解析失败的分段不会被写入缓存，因此失败后可直接重试。',
            '',
            '另有一级页面缓存（.codesign-mcp/pagecache）：DOM 文字未变化时直接复用截图，跳过重复截图；clear_cache 不影响它。',
          ].join('\n'),
        },
      ],
    };
  }
);

// ─── 工具6：清空缓存 ───────────────────────────────────────────
server.registerTool(
  'clear_cache',
  {
    description: '清空 VLM 解析缓存，下次调用将重新请求视觉模型。怀疑缓存内容过时时可执行',
    inputSchema: {},
  },
  async () => {
    const removed = clearCache();
    const text = removed.failed
      ? `清空缓存失败：缓存目录删除被系统拒绝，请检查是否有进程占用 ${cacheDir()} 后重试。`
      : `已清空 VLM 解析缓存：移除 ${removed.total} 条，释放 ${formatBytes(removed.size)}。\n下次调用将重新请求视觉模型。`;
    return {
      content: [{ type: 'text', text }],
      isError: !!removed.failed,
    };
  }
);

// ─── 启动服务器 ────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('MCP Server 启动失败:', err);
  process.exit(1);
});
