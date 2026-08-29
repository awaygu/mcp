// vision.ts — 视觉模型调用（OpenAI 兼容端点）
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const MODEL = process.env.LANHU_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
// LLM_API_KEY 优先；MT_API_KEY 为机器级兜底（Inspector/MCP 客户端 env 展开行为不一，系统变量最可靠）
const API_KEY = process.env.LLM_API_KEY || process.env.MT_API_KEY || '';
const BASE_URL = (process.env.VISION_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');

// 视觉模型理解设计稿的 prompt（analyze 用）
export const DESIGN_ANALYZE_PROMPT =
  'You are a senior UI/frontend engineer. Analyze the design screenshot in detail and output a structured ' +
  'JSON description to guide code generation. Include: ' +
  '{"layout":"overall layout & page structure",' +
  '"components":[{"name":"component name","position":"position","type":"type","interaction":"interaction/state"}],' +
  '"colors":"main color palette (hex if inferable)",' +
  '"typography":"font hierarchy & sizes",' +
  '"spacing":"spacing patterns",' +
  '"assets":"image/icon resources",' +
  '"notes":"other details helpful for faithful reproduction"}. Only output JSON.';

// 单次 POST：透出 status + 解析后 JSON；带超时保护（代理延迟波动大，防无限挂起）
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
            // 非 JSON 响应（如 deepseek 401 纯文本 "Authentication Fails (governor)"）→ 报出状态码+原文，替代 JSON.parse 的隐晦 SyntaxError
            reject(new Error(`视觉模型 API 返回 HTTP ${res.statusCode}，响应非 JSON：${text.slice(0, 120)}`));
          }
        });
      }
    );
    // 超时：默认 120s（实测正常调用 11~54s，留足余量），超时销毁连接
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

// 视觉模型调用（图片块放 user 消息；json 模式保证结构化输出）
// 每次调用打 stderr 日志（MCP stdio 下 stdout 是协议通道，调试输出必须走 stderr）
// 空响应自动重试 1 次（代理偶发 200 空内容/错误体，实测重试即恢复）
export async function callVision({ images = [], text, detail = 'auto' }: VisionInput): Promise<any> {
  const content = [
    { type: 'text', text },
    // 已是完整 data URI 直接用（封面 1x JPEG）；否则视为纯 base64 PNG
    ...images.map((b64) => ({
      type: 'image_url',
      image_url: { url: b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`, detail },
    })),
  ];
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
    temperature: 0,
    top_p: 0.95,
  };
  // GLM 系列：thinking 强制 enabled（不支持关闭），clear_thinking:false 保留思考细节提升复杂分析质量；
  // 其它 OpenAI 兼容端点（deepseek 等）不识别这些字段会忽略，为兼容不传 reasoning_effort
  if (/glm/i.test(MODEL)) {
    body.thinking = { type: 'enabled', clear_thinking: false };
    body.reasoning_effort = 'max';
  }

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    const { status, json } = await postJson(`${BASE_URL}/v1/chat/completions`, body, API_KEY);
    // 非 2xx：OpenAI 风格错误体 {error:{message}}；代理可能包成各种形状，尽取 message
    if (status < 200 || status >= 300) {
      const msg = json?.error?.message || json?.message || JSON.stringify(json).slice(0, 150);
      throw new Error(`视觉模型 API HTTP ${status}：${msg}`);
    }
    // 200 但无 choices（代理异常体）或 content 空：记日志重试一次
    const choice = json?.choices?.[0];
    const raw: string = choice?.message?.content || '';
    console.error(`[vision] ${MODEL} ${images.length}图 detail=${detail} attempt=${attempt} → HTTP ${status} 耗时${Date.now() - t0}ms finish=${choice?.finish_reason} tokens=${json?.usage?.total_tokens} contentLen=${raw.length}`);
    if (raw.trim()) {
      // 剥掉可能的 markdown 代码围栏（部分模型不守 json_object 约定）
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
    if (attempt < 2) console.error('[vision] 空响应，1s 后重试…');
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${lastErr!.message}。重试后仍为空，多为模型端/代理异常，请稍后再试。`);
}
