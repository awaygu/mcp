// vision.ts — 视觉模型调用（OpenAI 兼容端点）
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const MODEL = process.env.LANHU_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
// MT_API_KEY 兜底：部分 MCP 客户端不展开 .mcp.json 里的 env，系统变量更可靠
const API_KEY = process.env.LLM_API_KEY || process.env.MT_API_KEY || '';
// 剥掉尾部 /v1，加不加由 chatEndpoint 统一决定
const BASE_URL = (process.env.VISION_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/v1$/, '');
// VISION_USE_V1=0 切到文档原生的 /chat/completions
const USE_V1 = process.env.VISION_USE_V1 !== '0';
// 不设 max_tokens，长 JSON 会被中途截断
const MAX_TOKENS = Number(process.env.LANHU_VISION_MAX_TOKENS) || 4096;
// DeepSeek 限制：单图 32 MiB、请求体 48 MiB
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
// JSON Output 偶发空 content（官方已知问题），故多次尝试
const MAX_ATTEMPTS = 3;

function chatEndpoint(useV1: boolean): string {
  return `${BASE_URL}${useV1 ? '/v1' : ''}/chat/completions`;
}

// 估算解码后字节数，免得为大图真解一次
function approxBytes(b64: string): number {
  const payload = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

// 超限提前拦截，省掉一次注定 400 的请求
function assertImageLimits(images: string[]): void {
  let total = 0;
  images.forEach((b64, i) => {
    const size = approxBytes(b64);
    total += size;
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(`第 ${i + 1} 张图约 ${(size / 1024 / 1024).toFixed(1)} MiB，超过单图 32 MiB 上限，请先压缩再调用`);
    }
  });
  if (total > MAX_REQUEST_BYTES) {
    throw new Error(`${images.length} 张图合计约 ${(total / 1024 / 1024).toFixed(1)} MiB，超过请求体 48 MiB 上限`);
  }
}

// JSON Output 要求 prompt 含小写 json 字样，否则该模式不生效
function ensureJsonKeyword(text: string): string {
  return text.includes('json') ? text : `${text}\n\nOutput strictly valid json, no extra text.`;
}

// 决定 fetch_design 是否默认 analyze
export function isVisionConfigured(): boolean {
  return Boolean(MODEL) && Boolean(API_KEY);
}

// LANHU_AUTO_ANALYZE=0 可强制关闭
export function isAutoAnalyzeEnabled(): boolean {
  return isVisionConfigured() && process.env.LANHU_AUTO_ANALYZE !== '0';
}

export function visionStatus(): { model: string; baseUrl: string; hasApiKey: boolean; configured: boolean } {
  return { model: MODEL, baseUrl: BASE_URL, hasApiKey: Boolean(API_KEY), configured: isVisionConfigured() };
}

// analyze 用的设计稿理解 prompt：精确数值在 layers 里，视觉模型只做语义理解，禁止 OCR 数值
export const DESIGN_ANALYZE_PROMPT =
  'You are a senior UI/frontend engineer. Precise geometry (x/y/width/height/font sizes/hex colors) ' +
  'is provided separately in a layers field — do NOT read or repeat any numeric values from the image. ' +
  'Your job is ONLY the semantic understanding that data cannot express. Output JSON:\n' +
  '{"page_type":"login|list|detail|dashboard|activity|form|other",' +
  '"layout":"top-down section by section: section_name + height tier (xs<8px / s8-24 / m24-48 / l48-120 / xl>120), ' +
  'e.g. header(l) → banner(xl) → card_list(xl) → tabbar(m)",' +
  '"components":[{"name":"component name",' +
  '"position":"format: \\"<tier>, section: <section_name>\\", tier ∈ top-left/top-center/top-right/bottom-bar/center — e.g. \\"top-left, section: event_header_banner\\" / \\"center, section: gift_list_card\\" / \\"bottom-bar, section: tabbar\\" (STRICT format, no other wording)",' +
  '"type":"button|input|list_item|card|image_banner|tab|header|status_bar|divider|text|icon",' +
  '"interaction":"static|clickable|input|scrollable|stateful(selected/disabled)"}],' +
  '"visual_hierarchy":"stacked layers bottom-up: background → cards → content → overlays; any mask/shadow/gradient overlay MUST be stated",' +
  '"imagery":"for EVERY background/decorative image (including placeholders): 1) what it depicts 2) relation to adjacent text (text-on-image needs a dark scrim / text-on-gradient / standalone no overlay) 3) real asset or placeholder-to-be-replaced; reference components by name",' +
  '"style_atmosphere":"color mood + font character + corner/spacing style (compact/airy) in natural language, NO hex values",' +
  '"notes":"details data cannot express: implied motion, implied truncation, icon metaphors"}\n' +
  'Output discipline: each description ≤30 words; at most 15 components, most important first. Only output JSON.';

// 带超时保护：代理延迟波动大，防无限挂起
async function postJson(urlStr: string, body: unknown, apiKey?: string): Promise<{ status: number; json: any }> {
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
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode || 0, json: JSON.parse(text) });
          } catch {
            // 非 JSON 响应（deepseek 401 返回纯文本）→ 报状态码+原文，别抛隐晦的 SyntaxError
            reject(new Error(`视觉模型 API 返回 HTTP ${res.statusCode}，响应非 JSON：${text.slice(0, 120)}`));
          }
        });
      }
    );
    // 实测正常调用 11~54s，留足余量
    const timeoutMs = Number(process.env.LANHU_VISION_TIMEOUT_MS) || 120_000;
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`视觉模型 API 请求超时（${timeoutMs}ms），可设 LANHU_VISION_TIMEOUT_MS 调整`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export interface VisionInput {
  images?: string[];
  text: string;
  detail?: string;
}

// 日志走 stderr：MCP stdio 下 stdout 是协议通道
export async function callVision({ images = [], text, detail = 'auto' }: VisionInput): Promise<any> {
  assertImageLimits(images);
  const content = [
    { type: 'text', text: ensureJsonKeyword(text) },
    // 格式按文件内容判定，声明的 MIME 不准也无妨
    ...images.map((b64) => ({
      type: 'image_url',
      image_url: { url: b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`, detail },
    })),
  ];
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS,
    temperature: 0,
    top_p: 0.95,
  };
  // GLM 不支持关闭 thinking；其它端点忽略这两个字段
  if (/glm/i.test(MODEL)) {
    body.thinking = { type: 'enabled', clear_thinking: false };
    body.reasoning_effort = 'max';
  }

  let lastErr: Error | null = null;
  let useV1 = USE_V1;
  let triedAltPath = false;
  let triedNoResponseFormat = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    let status = 0;
    let json: any = null;
    try {
      const r = await postJson(chatEndpoint(useV1), body, API_KEY);
      status = r.status;
      json = r.json;
    } catch (e: any) {
      // 网络/DNS/TLS 超时 → 瞬态错误，进入下方统一重试
      status = 0;
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
    // 网关可能只认其中一条路径，换一条重试（一次性，不占重试次数）
    if (status === 404 && !triedAltPath) {
      triedAltPath = true;
      useV1 = !useV1;
      attempt--;
      console.error(`[vision] HTTP 404 → 切换端点为 ${chatEndpoint(useV1)}`);
      continue;
    }
    // 实验性模型可能拒绝 response_format，降级为提示词约束重试（一次性，不占重试次数）
    if (status === 400 && body.response_format && !triedNoResponseFormat
        && /response_format|json_object/i.test(JSON.stringify(json?.error || ''))) {
      triedNoResponseFormat = true;
      delete body.response_format;
      attempt--;
      console.error('[vision] 模型拒绝 response_format → 降级为提示词约束重试');
      continue;
    }
    // 瞬态错误重试：网络(0)、429 限流、5xx 网关/服务端
    const isTransient = status === 0 || status === 429 || status >= 500;
    if (isTransient && attempt < MAX_ATTEMPTS) {
      const delay = 1000 * attempt; // 1s → 2s 线性退避
      const reason = status === 0 ? '网络/超时' : `HTTP ${status}`;
      if (lastErr == null) {
        // status!=0 分支才需拼装错误消息；status=0 已在 catch 中赋值
        lastErr = new Error(`视觉模型 API HTTP ${status}：${json?.error?.message || json?.message || JSON.stringify(json).slice(0, 150)}`);
      }
      console.error(`[vision] ${reason}，${delay}ms 后重试（attempt=${attempt}/${MAX_ATTEMPTS}）：${lastErr.message}`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    // 错误体形状各异，尽取 message
    if (status < 200 || status >= 300) {
      const msg = json?.error?.message || json?.message || JSON.stringify(json).slice(0, 150);
      throw new Error(`视觉模型 API HTTP ${status}：${msg}`);
    }
    const choice = json?.choices?.[0];
    const raw: string = choice?.message?.content || '';
    console.error(`[vision] ${MODEL} ${images.length}图 detail=${detail} attempt=${attempt} → HTTP ${status} 耗时${Date.now() - t0}ms finish=${choice?.finish_reason} tokens=${json?.usage?.total_tokens} contentLen=${raw.length}`);
    if (raw.trim()) {
      // 部分模型不守 json_object 约定，仍套 markdown 围栏
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try {
        return JSON.parse(stripped);
      } catch {
        return { _raw: raw };
      }
    }
    lastErr = new Error(
      `视觉模型返回空 content（HTTP ${status}，finish_reason=${choice?.finish_reason ?? '无choices字段'}，响应体=${JSON.stringify(json).slice(0, 120)}）`
    );
    if (attempt < MAX_ATTEMPTS) {
      console.error(`[vision] 空响应，${attempt}s 后重试…`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`${lastErr!.message}。重试 ${MAX_ATTEMPTS} 次仍为空，多为模型端/代理异常，请稍后再试。`);
}
