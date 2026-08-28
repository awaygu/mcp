// tools.ts — 注册所有 MCP 工具（用官方 SDK + zod）
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchDesignViaApi, readSector, listDirectory, downloadSlices } from './lanhu-client.js';
import { scrapeLanhu } from './scrape.js';
import { callVision, DESIGN_ANALYZE_PROMPT } from './vision.js';
import type { Credentials, DesignResult } from './types.js';

const MOCK_DESIGN: DesignResult = {
  source: 'mock',
  viewport: { width: 390, height: 844 },
  layers: [
    { id: 'bg', type: 'rect', x: 0, y: 0, w: 390, h: 844, fill: '#0E0B1A' },
    { id: 'title', type: 'text', x: 24, y: 64, w: 342, h: 32, text: 'Masked Ball', fontSize: 24, fontWeight: 700, color: '#F5F1FF', fontFamily: 'Inter' },
    { id: 'cta', type: 'rect', x: 24, y: 720, w: 342, h: 48, fill: '#7C5CFF', radius: 12 },
    { id: 'card', type: 'rect', x: 24, y: 120, w: 342, h: 200, fill: '#1A1530', radius: 16 },
  ],
  meta: { rawLayerCount: 4, totalLayerCount: 4 },
};

function jsonContent(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

function credentials(args: { cookie?: string; storageState?: string }): Credentials {
  return {
    cookie: args.cookie || process.env.LANHU_COOKIE,
    storageState: args.storageState || process.env.LANHU_STORAGE_STATE,
  };
}

export function registerTools(server: McpServer): void {
  // 1. 读设计稿
  server.registerTool(
    'lanhu_fetch_design',
    {
      description:
        '读取蓝湖设计稿的结构化图层树（精确 x/y/宽高/色值/字号/圆角/文本）。mode：api=官方Cookie接口(默认,无需浏览器) / scrape=Playwright爬取兜底 / mock=内置示例。analyze=true 时用配置的视觉模型理解设计稿封面图。',
      inputSchema: {
        mode: z.enum(['api', 'scrape', 'mock']).default('api').describe('抽取后端'),
        url: z.string().optional().describe('蓝湖设计稿链接，如 https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy'),
        cookie: z.string().optional().describe('登录 cookie 串（也可用 LANHU_COOKIE）'),
        storageState: z.string().optional().describe('playwright storageState 文件路径（也可用 LANHU_STORAGE_STATE）'),
        analyze: z.boolean().optional().describe('true 时用视觉模型理解封面图，返回 visionAnalysis'),
        screenshot: z.boolean().optional().describe('mode=scrape 时是否返回截屏 base64'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe('mode=scrape 视口'),
        mock: z.boolean().optional().describe('true 时返回内置示例'),
      },
    },
    async (args) => {
      if (process.env.LANHU_MOCK === '1' || args.mock) {
        return jsonContent(MOCK_DESIGN);
      }

      if (args.mode === 'scrape') {
        if (!args.url) throw new Error('scrape 模式需要 url');
        const needShot = !!(args.screenshot || args.analyze);
        const r = await scrapeLanhu(args.url, {
          ...credentials(args),
          viewport: args.viewport,
          screenshot: needShot,
        });
        if (args.analyze && r.screenshotBase64) {
          const analysis = await callVision({ images: [r.screenshotBase64], text: DESIGN_ANALYZE_PROMPT, detail: 'high' });
          const { screenshotBase64, ...rest } = r;
          return jsonContent({ ...rest, visionAnalysis: analysis });
        }
        return jsonContent(r);
      }

      // mode === 'api'（默认）
      if (!args.url) throw new Error('api 模式需要 url');
      const r = await fetchDesignViaApi(args.url, {
        ...credentials(args),
        needCover: !!args.analyze,
      });
      if (args.analyze && r.coverImageBase64) {
        const analysis = await callVision({ images: [r.coverImageBase64], text: DESIGN_ANALYZE_PROMPT, detail: 'high' });
        const { coverImageBase64, ...rest } = r;
        return jsonContent({ ...rest, visionAnalysis: analysis });
      }
      return jsonContent(r);
    }
  );

  // 2. 渲染对比
  server.registerTool(
    'lanhu_verify_render',
    {
      description: '把渲染页截图与设计稿截图调视觉模型做语义对比，返回 matchScore / verdict / diffs。',
      inputSchema: {
        actualImageBase64: z.string().describe('你渲染的页面截图 base64'),
        designImageBase64: z.string().optional().describe('设计稿截图 base64'),
        detail: z.enum(['auto', 'low', 'high']).optional(),
      },
    },
    async (args) => {
      const text =
        'You are a senior frontend reviewer. Compare the RENDERED screenshot (first image) ' +
        'against the DESIGN reference (second image). Output a JSON: ' +
        '{"matchScore":<0-100>,"verdict":"pass|need_fix|fail",' +
        '"diffs":[{"location":"","issue":"","severity":"minor|major|critical"}],' +
        '"suggestions":["..."]}. Only output JSON.';
      const images = [args.actualImageBase64];
      if (args.designImageBase64) images.push(args.designImageBase64);
      return jsonContent(await callVision({ images, text, detail: args.detail || 'high' }));
    }
  );

  // 3. UI 缺陷检测
  server.registerTool(
    'vision_defect_check',
    {
      description: '整页/局部 UI 缺陷检测：重叠、溢出、缺图、对比度、错位等。返回 defects 数组与 pass。',
      inputSchema: {
        imageBase64: z.string().describe('截屏 base64'),
        language: z.string().optional().describe('语言，默认 zh-CN'),
        detail: z.enum(['auto', 'low', 'high']).optional(),
      },
    },
    async (args) => {
      const lang = args.language || 'zh-CN';
      const text =
        `Inspect this UI screenshot (${lang}) for visual defects. Output JSON: ` +
        '{"defects":[{"type":"overlap|overflow|missing_asset|contrast|misalign|other",' +
        '"severity":"minor|major|critical","location":"","description":""}],' +
        '"summary":"","pass":<true|false>}. Only output JSON.';
      return jsonContent(await callVision({ images: [args.imageBase64], text, detail: args.detail || 'auto' }));
    }
  );

  // 4. E2E 归因
  server.registerTool(
    'vision_e2e_triage',
    {
      description: 'E2E 测试失败时，分析截图+DOM 快照+错误文本，给出根因、类别、修复建议。',
      inputSchema: {
        screenshotBase64: z.string().optional().describe('失败时的截屏 base64'),
        domSnapshot: z.string().optional().describe('失败时的 DOM 快照文本'),
        errorText: z.string().optional().describe('错误消息/栈'),
      },
    },
    async (args) => {
      const text =
        'A test failed. Analyze the screenshot and (optional) DOM snapshot + error text. ' +
        'Output JSON: {"rootCause":"","category":"selector|timing|layout|data|auth|other",' +
        '"confidence":<0-1>,"fixSuggestion":"","relatedFiles":[""]}. Only output JSON.';
      const images = args.screenshotBase64 ? [args.screenshotBase64] : [];
      const full = images.length ? text : 'No screenshot provided. ' + text;
      const dom = args.domSnapshot ? `\n\nDOM snapshot:\n${args.domSnapshot}` : '';
      const err = args.errorText ? `\n\nError text:\n${args.errorText}` : '';
      return jsonContent(await callVision({ images, text: full + dom + err, detail: 'auto' }));
    }
  );

  // 5. 列全团队目录（一页地图：项目 → 分组，无需链接）
  server.registerTool(
    'lanhu_list_directory',
    {
      description:
        '一次拉全团队目录（项目 → 分组层），无需蓝湖链接。用于「我不知道链接，想找某活动有几个设计稿」——AI 在这份目录里按分组名匹配，拿到 projectId 后传给 lanhu_read_sector。只到分组层（含 designCount），不展开设计稿名。并行拉取约 2 秒，约 1.6k tokens。',
      inputSchema: {
        cookie: z.string().optional(),
        storageState: z.string().optional(),
      },
    },
    async (args) => jsonContent(await listDirectory(credentials(args)))
  );

  // 6. 按分组批量读
  server.registerTool(
    'lanhu_read_sector',
    {
      description: '读取蓝湖项目下某个分组（需求）的所有设计稿图层树。先用 lanhu_list_directory 看全局目录定位分组名和项目，再传 projectId + 分组名。',
      inputSchema: {
        url: z.string().describe('蓝湖设计稿链接 或 项目 UUID（来自 lanhu_list_directory 的 projectId）'),
        sector: z.string().describe('分组名或分组 id（从 lanhu_list_directory 看到）'),
        cookie: z.string().optional(),
        storageState: z.string().optional(),
      },
    },
    async (args) => jsonContent(await readSector(args.url, args.sector, credentials(args)))
  );

  // 7. 下载切图
  server.registerTool(
    'lanhu_download_slices',
    {
      description:
        '下载蓝湖设计稿切图到本地目录。两种范围（二选一）：传 url 下单稿切图；传 sector + url(项目UUID或该分组任一稿链接) 下整个分组所有稿的切图（跨稿公共 icon 只下一次）。三层去重：URL 去重（同图只下一次，默认开）、skipExisting（本地已存在则跳过，默认开）、sliceNames（只下指定名字的切图）。切图来自蓝湖公开 CDN，无需 cookie。返回下载明细、跳过统计、失败列表。',
      inputSchema: {
        url: z.string().describe('设计稿 URL（含 image_id）或纯 image_id；分组模式传项目 UUID 或该分组任一稿链接'),
        outputPath: z.string().describe('本地输出目录，如 src/assets/activity-xxx/'),
        format: z.enum(['png', 'svg']).optional().describe('切图格式，默认 png'),
        projectId: z.string().optional().describe('项目 UUID（传纯 image_id 时必填；传 URL 自动提取）'),
        sector: z.string().optional().describe('分组名或分组 id：传了就下载该分组所有稿的切图（跨稿合并去重）'),
        sliceNames: z.array(z.string()).optional().describe('只下载指定名字的切图（同名不同 URL 都下，因为它们是不同的图）'),
        skipExisting: z.boolean().optional().describe('本地已存在同名文件则跳过，默认 true（避免重下公共 icon）'),
        cookie: z.string().optional(),
        storageState: z.string().optional(),
      },
    },
    async (args) => jsonContent(
      await downloadSlices(args.url, args.outputPath, {
        ...credentials(args),
        ...(args.format ? { format: args.format } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.sector ? { sector: args.sector } : {}),
        ...(args.sliceNames ? { sliceNames: args.sliceNames } : {}),
        ...(args.skipExisting !== undefined ? { skipExisting: args.skipExisting } : {}),
      })
    )
  );
}
