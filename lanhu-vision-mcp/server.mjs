#!/usr/bin/env node
/**
 * lanhu-vision-mcp — 零依赖 stdio MCP server（可独立部署 / 直接分发给他人使用）
 *
 * 把"蓝湖 → 代码 → 验证"流水线里可复用的能力暴露成 4 个 MCP 工具，
 * 让任何支持 MCP 的 coding Agent（Claude Code / Cursor / Trae / opencode）都能调用：
 *
 *   1. lanhu_fetch_design   读取蓝湖设计稿的结构化图层树（精确数值，不靠 OCR 小字）
 *   2. lanhu_verify_render  把"你渲染的页面截图" vs "蓝湖设计稿" 调视觉模型做语义对比
 *   3. vision_defect_check  整页/局部截屏的 UI 缺陷检测（方案 B）
 *   4. vision_e2e_triage    E2E 失败时的截图+DOM 归因（方案 C）
 *
 * 视觉模型调用契约与之前在 Vitest 里验证过的一致：
 *   model = deepseek-v4-flash-vision-exp / 图片块放 user 消息 / response_format=json_object
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY   必填（真实调用时）
 *   VISION_BASE_URL    可选，默认 https://api.deepseek.com（沙箱验证时指向 mock）
 *   LANHU_VISION_MODEL 可选，默认 deepseek-v4-flash-vision-exp
 *   LANHU_CODEGEN_MODEL 可选，默认 deepseek-chat
 *   LANHU_API_KEY      蓝湖企业版 API key（真实 fetch 时）
 *   LANHU_MOCK         设为 1 时 fetch_design 返回内置示例图层树（无需联网）
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const MODEL = process.env.LANHU_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
const TEXT_MODEL = process.env.LANHU_CODEGEN_MODEL || 'deepseek-chat';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = (process.env.VISION_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const LANHU_MOCK = process.env.LANHU_MOCK === '1';

// ---------------------------------------------------------------------------
// MCP 传输层（JSON-RPC 2.0 over stdio，LSP 风格 Content-Length 分帧）
// ---------------------------------------------------------------------------
let inBuf = Buffer.alloc(0);
let pending = []; // { resolve, reject } 按请求的 id 排队

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function parseFrames(data) {
  inBuf = Buffer.concat([inBuf, data]);
  const out = [];
  while (true) {
    const headerEnd = inBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = inBuf.slice(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      inBuf = inBuf.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    if (inBuf.length < headerEnd + 4 + len) break;
    const body = inBuf.slice(headerEnd + 4, headerEnd + 4 + len);
    inBuf = inBuf.slice(headerEnd + 4 + len);
    try {
      out.push(JSON.parse(body.toString('utf8')));
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP 辅助：POST JSON 到 OpenAI 兼容端点
// ---------------------------------------------------------------------------
function postJson(urlStr, body, apiKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const data = JSON.stringify(body);
    const req = lib(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 视觉模型调用（图片块必须放 user 消息；json 模式保证结构化输出）
// ---------------------------------------------------------------------------
async function callVision({ images = [], text, detail = 'auto' }) {
  const content = [
    { type: 'text', text: text },
    ...images.map((b64) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}`, detail },
    })),
  ];
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
    temperature: 0,
  };
  const res = await postJson(`${BASE_URL}/v1/chat/completions`, body, API_KEY);
  const raw = res?.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

// 1. 读取蓝湖结构化设计数据（mock / 企业版 API / 普通账号 scrape 三条路径）
async function lanhuFetchDesign(args) {
  const mode = args.mode || 'api';
  if (LANHU_MOCK || args.mock) {
    return {
      source: 'mock',
      viewport: { width: 390, height: 844 },
      layers: [
        { id: 'bg', type: 'rect', x: 0, y: 0, w: 390, h: 844, fill: '#0E0B1A' },
        { id: 'title', type: 'text', x: 24, y: 64, w: 342, h: 32, text: 'Masked Ball', fontSize: 24, fontWeight: 700, color: '#F5F1FF', fontFamily: 'Inter' },
        { id: 'cta', type: 'button', x: 24, y: 720, w: 342, h: 48, label: '立即购票', fill: '#7C5CFF', radius: 12, textColor: '#FFFFFF' },
        { id: 'card', type: 'rect', x: 24, y: 120, w: 342, h: 200, fill: '#1A1530', radius: 16 },
      ],
    };
  }
  if (mode === 'scrape') {
    // 普通账号：用 Playwright 真实渲染页面并抽取（需 playwright）
    const { scrapeLanhu } = await import('./scrape-lanhu.mjs');
    return scrapeLanhu(args.url, {
      cookie: args.cookie || process.env.LANHU_COOKIE,
      storageState: args.storageState || process.env.LANHU_STORAGE_STATE,
      viewport: args.viewport,
      screenshot: args.screenshot,
      headless: args.headless,
    });
  }
  // 真实路径：蓝湖企业版结构化接口（需 LANHU_API_KEY）
  const key = process.env.LANHU_API_KEY || args.apiKey;
  if (!key) throw new Error('真实蓝湖抽取需要 LANHU_API_KEY（mode=api）；普通账号请用 mode:"scrape"（需 playwright）；或设 LANHU_MOCK=1 走示例');
  const apiBase = process.env.LANHU_API_BASE || 'https://api.lanhuapp.com';
  const url = `${apiBase}/v1/designs/${args.projectId}/${args.pageId}`;
  const res = await postJson(url, {}, key);
  return res;
}

// 2. 渲染页 vs 设计稿 语义对比（方案 D 验证端）
async function lanhuVerifyRender(args) {
  const text =
    'You are a senior frontend reviewer. Compare the RENDERED screenshot (first image) ' +
    'against the DESIGN reference (second image). Output a JSON: ' +
    '{"matchScore":<0-100>,"verdict":"pass|need_fix|fail",' +
    '"diffs":[{"location":"","issue":"","severity":"minor|major|critical"}],' +
    '"suggestions":["..."]}. Only output JSON.';
  const images = [args.actualImageBase64];
  if (args.designImageBase64) images.push(args.designImageBase64);
  return callVision({ images, text, detail: args.detail || 'high' });
}

// 3. UI 缺陷检测（方案 B）
async function visionDefectCheck(args) {
  const lang = args.language || 'zh-CN';
  const text =
    `Inspect this UI screenshot (${lang}) for visual defects. Output JSON: ` +
    '{"defects":[{"type":"overlap|overflow|missing_asset|contrast|misalign|other",' +
    '"severity":"minor|major|critical","location":"","description":""}],' +
    '"summary":"","pass":<true|false>}. Only output JSON.';
  return callVision({ images: [args.imageBase64], text, detail: args.detail || 'auto' });
}

// 4. E2E 失败归因（方案 C）
async function visionE2ETriage(args) {
  const text =
    'A test failed. Analyze the screenshot and (optional) DOM snapshot + error text. ' +
    'Output JSON: {"rootCause":"","category":"selector|timing|layout|data|auth|other",' +
    '"confidence":<0-1>,"fixSuggestion":"","relatedFiles":[""]}. Only output JSON.';
  const images = args.screenshotBase64 ? [args.screenshotBase64] : [];
  const full = images.length
    ? text
    : 'No screenshot provided. ' + text;
  const dom = args.domSnapshot ? `\n\nDOM snapshot:\n${args.domSnapshot}` : '';
  const err = args.errorText ? `\n\nError text:\n${args.errorText}` : '';
  return callVision({ images, text: full + dom + err, detail: 'auto' });
}

// ---------------------------------------------------------------------------
// 工具注册表
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'lanhu_fetch_design',
    description: '读取蓝湖设计稿的结构化图层树（精确 x/y/宽高/色值/字号/圆角）。优先用此而非 OCR 截图小字。支持三种 mode：api(企业版,需LANHU_API_KEY) / scrape(普通账号,需playwright) / mock(示例)。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['api', 'scrape', 'mock'], description: '抽取后端：api=企业版接口(默认) / scrape=普通账号Playwright爬取 / mock=内置示例' },
        projectId: { type: 'string', description: '蓝湖项目 ID（mode=api 用）' },
        pageId: { type: 'string', description: '蓝湖页面 ID（mode=api 用）' },
        url: { type: 'string', description: '蓝湖设计稿链接（mode=scrape 用），如 https://lanhuapp.com/.../project/<id>/page/<pageId>' },
        apiKey: { type: 'string', description: '蓝湖 API key（mode=api，也可用 LANHU_API_KEY 环境变量）' },
        cookie: { type: 'string', description: '登录 cookie 串（mode=scrape 用，也可用 LANHU_COOKIE），格式 k=v;k2=v2' },
        storageState: { type: 'string', description: 'playwright storageState 文件路径（mode=scrape 用，也可用 LANHU_STORAGE_STATE），含已登录态' },
        screenshot: { type: 'boolean', description: 'mode=scrape 时是否一并返回页面截屏 base64' },
        viewport: { type: 'object', description: 'mode=scrape 视口，如 {"width":1440,"height":900}' },
        mock: { type: 'boolean', description: 'true 时返回内置示例图层树（无需联网）' },
      },
    },
  },
  {
    name: 'lanhu_verify_render',
    description: '把"渲染页截图"与"蓝湖设计稿截图"调视觉模型做语义对比，返回 matchScore / verdict / diffs。',
    inputSchema: {
      type: 'object',
      properties: {
        actualImageBase64: { type: 'string', description: '你渲染的页面截图 base64' },
        designImageBase64: { type: 'string', description: '蓝湖设计稿截图 base64（可选）' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'] },
      },
      required: ['actualImageBase64'],
    },
  },
  {
    name: 'vision_defect_check',
    description: '整页/局部 UI 缺陷检测：重叠、溢出、缺图、对比度、错位等。返回 defects 数组与 pass。',
    inputSchema: {
      type: 'object',
      properties: {
        imageBase64: { type: 'string', description: '截屏 base64' },
        language: { type: 'string', description: '语言，默认 zh-CN' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'] },
      },
      required: ['imageBase64'],
    },
  },
  {
    name: 'vision_e2e_triage',
    description: 'E2E 测试失败时，分析截图+DOM 快照+错误文本，给出根因、类别、修复建议。',
    inputSchema: {
      type: 'object',
      properties: {
        screenshotBase64: { type: 'string', description: '失败时的截屏 base64' },
        domSnapshot: { type: 'string', description: '失败时的 DOM 快照文本' },
        errorText: { type: 'string', description: '错误消息/栈' },
      },
    },
  },
];

const HANDLERS = {
  lanhu_fetch_design: lanhuFetchDesign,
  lanhu_verify_render: lanhuVerifyRender,
  vision_defect_check: visionDefectCheck,
  vision_e2e_triage: visionE2ETriage,
};

function toolResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// JSON-RPC 调度
// ---------------------------------------------------------------------------
function handleMessage(msg) {
  if (msg.id === undefined) {
    // notification（如 initialized）→ 不回复
    return;
  }
  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'lanhu-vision-mcp', version: '1.0.0' },
        },
      });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;
    case 'tools/call':
      (async () => {
        const fn = HANDLERS[msg.params?.name];
        if (!fn) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${msg.params?.name}` } });
          return;
        }
        try {
          const result = await fn(msg.params?.arguments || {});
          send({ jsonrpc: '2.0', id, result: toolResult(result) });
        } catch (e) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e?.message || e) } });
        }
      })();
      break;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported method ${msg.method}` } });
  }
}

process.stdin.on('data', (chunk) => {
  for (const frame of parseFrames(chunk)) handleMessage(frame);
});
process.stdin.on('end', () => process.exit(0));
