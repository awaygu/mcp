// tools.ts — 注册所有 MCP 工具（用官方 SDK + zod）
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fetchDesignViaApi, readSector, listDirectory, listUserTeams, downloadSlices, checkAuth } from './lanhu-client.js';
import { callVision, DESIGN_ANALYZE_PROMPT } from './vision.js';
import { shrinkForVision } from './image.js';
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

// 从 LANHU_COOKIE_FILE 指定文件读 cookie（文件内容就是完整 cookie 串，可含换行/空白，会自动 trim）
// 文件不存在或未设置时返回 undefined，交由 resolveCookie 给出明确报错
function readCookieFile(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const cookie = raw.trim();
    return cookie || undefined;
  } catch {
    return undefined;
  }
}

function credentials(args: { cookie?: string }): Credentials {
  return {
    // cookie 优先级：显式入参 > 环境变量直填 LANHU_COOKIE > 从 LANHU_COOKIE_FILE 指定文件读
    cookie: args.cookie || process.env.LANHU_COOKIE || readCookieFile(process.env.LANHU_COOKIE_FILE),
  };
}

// 视觉工具入参图统一 shrink 到最长边 1568 + JPEG：截图/设计稿 base64 常是 2-4x 大图，
// 先压小再发模型省请求体积与 token；非图片 base64 原样透传（模型自己报错）
async function shrinkB64(b64: string): Promise<string> {
  try {
    const small = await shrinkForVision(Buffer.from(b64, 'base64'));
    return `data:image/jpeg;base64,${small.toString('base64')}`;
  } catch {
    return b64;
  }
}

export function registerTools(server: McpServer): void {
  // 1. 读设计稿
  server.registerTool(
    'lanhu_fetch_design',
    {
      description:
        '读取蓝湖设计稿的结构化图层树（精确 x/y/宽高/色值/字号/圆角/文本）。mode：api=官方Cookie接口(默认,无需浏览器) / mock=内置示例。analyze=true 时用配置的视觉模型理解设计稿封面图。' +
        '使用纪律：一次只读当前要实现的那 1 张稿；不要为「了解全貌」批量读稿——分组稿目录用 lanhu_read_sector，它足够定位；返回的 layers 含精确数值，色值/字号从数据取，禁止靠视觉模型 OCR 小字。',
      inputSchema: {
        mode: z.enum(['api', 'mock']).default('api').describe('抽取后端'),
        url: z.string().optional().describe('蓝湖设计稿链接，如 https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy'),
        cookie: z.string().optional().describe('登录 cookie 串（也可用 LANHU_COOKIE / LANHU_COOKIE_FILE）'),
        analyze: z.boolean().optional().describe('true 时用视觉模型理解封面图，返回 visionAnalysis'),
        mock: z.boolean().optional().describe('true 时返回内置示例'),
      },
    },
    async (args) => {
      if (process.env.LANHU_MOCK === '1' || args.mock || args.mode === 'mock') {
        return jsonContent(MOCK_DESIGN);
      }

      // mode === 'api'（默认）
      if (!args.url) throw new Error('api 模式需要 url');
      const r = await fetchDesignViaApi(args.url, {
        ...credentials(args),
        needCover: !!args.analyze,
      });
      if (args.analyze && r.coverImageBase64) {
        // 封面在 client 里已压到 viewport 1x JPEG，这里带 mime 前缀喂模型
        const analysis = await callVision({ images: [`data:image/jpeg;base64,${r.coverImageBase64}`], text: DESIGN_ANALYZE_PROMPT, detail: 'high' });
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
      const images = [await shrinkB64(args.actualImageBase64)];
      if (args.designImageBase64) images.push(await shrinkB64(args.designImageBase64));
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
      return jsonContent(await callVision({ images: [await shrinkB64(args.imageBase64)], text, detail: args.detail || 'auto' }));
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
      const images = args.screenshotBase64 ? [await shrinkB64(args.screenshotBase64)] : [];
      const full = images.length ? text : 'No screenshot provided. ' + text;
      const dom = args.domSnapshot ? `\n\nDOM snapshot:\n${args.domSnapshot}` : '';
      const err = args.errorText ? `\n\nError text:\n${args.errorText}` : '';
      return jsonContent(await callVision({ images, text: full + dom + err, detail: 'auto' }));
    }
  );

  // cookie 探活：判断当前 cookie 是否有效。任何蓝湖工具返回 401/空数据/疑似过期时主动调它二次确认。
  server.registerTool(
    'lanhu_check_auth',
    {
      description:
        '探活当前蓝湖 cookie 是否有效。调一次 user_teams 接口：返回 { ok:true, teamCount, teams } 表示 cookie 有效；返回 { ok:false, reason, hint } 表示失效（reason=cookie_expired/http_xxx/network_error）。用法：①任何蓝湖工具报 401 或返回空数据时，先调本工具确认是否 cookie 过期；②ok=true 但某次调用仍 401 → 是那个具体资源无权访问，重新登录无效，需联系设计者开权限；③ok=false(reason=cookie_expired) 或首次使用无 cookie → 真过期/未配置，提示用户二选一续期：方式1 浏览器 F12 → Network → 复制 Cookie 头写入 .mcp-local/lanhu.cookie；方式2 双击 lanhu-login.bat 或跑 npm run login 自动写入。完成后重试。',
      inputSchema: {
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(await checkAuth(credentials(args)))
  );

  // 列账号所属团队（多团队发现入口）
  server.registerTool(
    'lanhu_list_teams',
    {
      description:
        '列出当前账号加入的全部蓝湖团队（teamId/名称/角色/是否所有者/成员数）。多团队场景先用它发现团队，拿到 teamId 传给 lanhu_list_directory。不传任何参数即可；返回精简字段，省略敏感项。',
      inputSchema: {
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(await listUserTeams(credentials(args)))
  );

  // 5. 列团队目录（项目→分组）
  server.registerTool(
    'lanhu_list_directory',
    {
      description:
        '一次拉团队目录（项目 → 分组层）。用于「想找某活动有几个设计稿」——AI 在这份目录里按分组名匹配，拿到 projectId 后传给 lanhu_read_sector。只到分组层（含 designCount），不展开设计稿名。团队定位优先级：有蓝湖链接传 url（从 tid 提取，最准）；无链接传 teamId（来自 lanhu_list_teams）；两者都没有则报错（无默认团队回退）。并行拉取约 2 秒，约 1.6k tokens。',
      inputSchema: {
        url: z.string().optional().describe('蓝湖链接（任意稿链接即可，从中提取 tid 定位团队）；比 teamId 更准'),
        teamId: z.string().optional().describe('团队 id（来自 lanhu_list_teams）；无 url 时用'),
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(await listDirectory({ ...credentials(args), ...(args.url ? { url: args.url } : {}), ...(args.teamId ? { teamId: args.teamId } : {}) }))
  );

  // 6. 按分组读稿目录
  server.registerTool(
    'lanhu_read_sector',
    {
      description:
        '列出蓝湖项目下某个分组（需求）的所有设计稿目录：稿名/尺寸/层数，不含图层树（全量 layers 会撑爆上下文，故意不返回）。' +
        '用途：先用 lanhu_list_directory 定位分组，再用本工具看分组里有哪几张稿，按稿名挑出要实现的目标，最后用 lanhu_fetch_design 逐张读图层树实现。',
      inputSchema: {
        url: z.string().describe('蓝湖设计稿链接 或 项目 UUID（来自 lanhu_list_directory 的 projectId）'),
        sector: z.string().describe('分组名或分组 id（从 lanhu_list_directory 看到）'),
        cookie: z.string().optional(),
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
        projectId: z.string().optional().describe('项目 UUID（传纯 image_id 时必填；传 URL 自动提取）'),
        sector: z.string().optional().describe('分组名或分组 id：传了就下载该分组所有稿的切图（跨稿合并去重）'),
        sliceNames: z.array(z.string()).optional().describe('只下载指定名字的切图（同名不同 URL 都下，因为它们是不同的图）'),
        skipExisting: z.boolean().optional().describe('本地已存在同名文件则跳过，默认 true（避免重下公共 icon）'),
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(
      await downloadSlices(args.url, args.outputPath, {
        ...credentials(args),
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.sector ? { sector: args.sector } : {}),
        ...(args.sliceNames ? { sliceNames: args.sliceNames } : {}),
        ...(args.skipExisting !== undefined ? { skipExisting: args.skipExisting } : {}),
      })
    )
  );
}
