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
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  openShareLink,
  getPageOutline,
  getSinglePage,
  getGroupPages,
} from './crawler.js';
import {
  isVLMConfigured,
  detectPageType,
  analyzeSegmentsParallel,
  analyzeSingleImage,
  flowchartToMermaid,
  tableToMarkdown,
} from './vlm.js';
import { mergePageResult } from './merger.js';
import { generateRequirementDoc } from './doc-generator.js';
import { getCache, setCache } from './cache.js';
import { closeBrowser } from './browser.js';

// 缓存已打开的链接
const openedUrls = new Set();

async function ensureOpened(url, password) {
  const key = password ? `${url}::${password}` : url;
  if (!openedUrls.has(key)) {
    await openShareLink(url, password);
    openedUrls.add(key);
  }
}

/**
 * 处理单个页面：分段截图 → VLM 解析 → 合并结果
 */
async function processPage(pageData, url, options = {}) {
  const { vlmEnabled = true } = options;

  if (pageData.error) {
    return {
      pageName: pageData.pageName,
      type: 'page',
      domText: '',
      tables: [],
      vlmResult: {},
      warnings: [pageData.error],
      _hasVLM: false,
    };
  }

  // 判断页面类型
  const type = detectPageType(pageData.pageName, pageData.text);

  // VLM 解析
  let vlmSegments = [];
  if (vlmEnabled && isVLMConfigured() && pageData.segments?.length > 0) {
    const cacheKey = {
      url,
      pageName: pageData.pageName,
      imagePaths: pageData.segments,
      type,
    };
    const cached = getCache(cacheKey);

    if (cached) {
      vlmSegments = cached;
    } else {
      vlmSegments = await analyzeSegmentsParallel(pageData.segments, type, {
        pageText: pageData.text,
      });
      setCache(cacheKey, vlmSegments);
    }
  }

  return mergePageResult({
    pageName: pageData.pageName,
    domText: pageData.text,
    domTables: pageData.tables,
    vlmSegments,
    type,
    screenshotCount: pageData.segmentCount || 0,
  });
}

const server = new McpServer({
  name: 'codesign-prd-mcp',
  version: '1.0.0',
});

// ─── 工具1：获取原型页面大纲 ───────────────────────────────────
server.registerTool(
  'get_prototype_outline',
  {
    description: '获取 CoDesign 产品原型的页面目录大纲（左侧导航树），用于了解原型结构和定位需求页面',
    inputSchema: {
      url: z.string().describe('CoDesign 分享链接，如 https://codesign.qq.com/s/xxx'),
      password: z.string().optional().describe('分享链接的访问密码（4位），没有则不填'),
    },
  },
  async ({ url, password }) => {
    try {
      await ensureOpened(url, password);
      const outline = await getPageOutline();

      const lines = ['# 原型页面大纲\n'];
      outline.forEach((item) => {
        const indent = '  '.repeat(item.level);
        const icon = item.isGroup ? '📁' : '📄';
        const index = item.pageIndex !== undefined ? ` (第${item.pageIndex + 1}页)` : '';
        lines.push(`${indent}- ${icon} ${item.name}${index}`);
      });

      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
    description: '获取 CoDesign 原型中单个页面的结构化内容（VLM 解析后纯文本，含组件/交互/表格）',
    inputSchema: {
      url: z.string().describe('CoDesign 分享链接'),
      password: z.string().optional().describe('访问密码'),
      pageName: z.string().describe('页面名称（与左侧目录一致）'),
      vlmEnabled: z.boolean().optional().describe('是否启用 VLM 解析，默认 true'),
    },
  },
  async ({ url, password, pageName, vlmEnabled = true }) => {
    try {
      await ensureOpened(url, password);
      const pageData = await getSinglePage(pageName);
      const merged = await processPage(pageData, url, { vlmEnabled });

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
        merged.tables.forEach((table, i) => {
          if (table.title) result += `**${table.title}**\n\n`;
          result += tableToMarkdown(table) + '\n';
        });
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
      url: z.string().describe('CoDesign 分享链接'),
      password: z.string().optional().describe('访问密码'),
      groupName: z.string().describe('需求分组名称，如"赛季通行证S2优化"'),
      vlmEnabled: z.boolean().optional().describe('是否启用 VLM 解析，默认 true'),
      detailLevel: z
        .enum(['summary', 'standard', 'full'])
        .optional()
        .describe('文档详细程度：summary(精简)/standard(标准)/full(完整)，默认 standard'),
    },
  },
  async ({ url, password, groupName, vlmEnabled = true, detailLevel = 'standard' }) => {
    try {
      await ensureOpened(url, password);

      const pagesData = await getGroupPages(groupName);

      const mergedPages = [];
      for (const pageData of pagesData) {
        const merged = await processPage(pageData, url, { vlmEnabled });
        mergedPages.push(merged);
      }

      const doc = generateRequirementDoc({
        groupName,
        sourceUrl: url,
        pages: mergedPages,
        detailLevel,
      });

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
