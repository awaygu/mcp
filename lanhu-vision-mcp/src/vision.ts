// vision.ts — 视觉模型调用（OpenAI 兼容端点）
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const MODEL = process.env.LANHU_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
const API_KEY = process.env.LLM_API_KEY || '';
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

function postJson(urlStr: string, body: unknown, apiKey?: string): Promise<any> {
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

export interface VisionInput {
  images?: string[];
  text: string;
  detail?: string;
}

// 视觉模型调用（图片块放 user 消息；json 模式保证结构化输出）
export async function callVision({ images = [], text, detail = 'auto' }: VisionInput): Promise<any> {
  const content = [
    { type: 'text', text },
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
