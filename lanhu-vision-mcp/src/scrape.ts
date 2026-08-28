// scrape.ts — playwright 兜底抽取（官方 API 失败时用）
//
// 抽取策略：优先拦截蓝湖网页 XHR/fetch 拉取的 Figma JSON（最准）；
// 拦截不到则抓可见 DOM 元素的包围盒 + 计算样式作为近似。

import { normalizeSketch, isSketchLike, findLayerArray } from './normalize.js';
import type { Credentials, DesignResult } from './types.js';

// 惰性引入 playwright；未安装时抛清晰错误
async function loadPlaywright(): Promise<any> {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'scrape 模式需要 playwright。请执行：npm i playwright && npx playwright install chromium；' +
      '或改用默认的 mode:"api"（官方 Cookie 接口）。'
    );
  }
}

// DOM 兜底：抓可见元素包围盒 + 计算样式（运行在浏览器上下文）
function extractDomLayers(): any[] {
  const g = globalThis as any;
  const els: any[] = Array.from(g.document.querySelectorAll('*'));
  const out: any[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.top < -2000) continue;
    const cs = g.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const text = (el.textContent || '').trim().slice(0, 60);
    out.push({
      tag: el.tagName.toLowerCase(),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      text: text || undefined,
      bg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : undefined,
      color: cs.color,
      fontSize: cs.fontSize,
      radius: cs.borderRadius,
    });
  }
  return out.sort((a: any, b: any) => b.w * b.h - a.w * a.h).slice(0, 200);
}

function parseCookie(cookieStr: string, url: string): Array<{ name: string; value: string; domain: string; path: string }> {
  const u = new URL(url);
  return cookieStr
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const idx = p.indexOf('=');
      return {
        name: p.slice(0, idx).trim(),
        value: p.slice(idx + 1).trim(),
        domain: u.hostname,
        path: '/',
      };
    });
}

export interface ScrapeOptions extends Credentials {
  viewport?: { width: number; height: number };
  screenshot?: boolean;
  headless?: boolean;
  wait?: number;
  timeout?: number;
}

export async function scrapeLanhu(url: string, opts: ScrapeOptions = {}): Promise<DesignResult> {
  if (!url) throw new Error('scrape 模式需要 url（蓝湖设计稿链接）');
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: opts.headless !== false, channel: 'chrome' });
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });

  if (!opts.storageState && opts.cookie) {
    await context.addCookies(parseCookie(opts.cookie, url));
  }

  const captured: Array<{ url: string; json: any }> = [];
  context.on('response', async (response: any) => {
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const json = await response.json();
      if (isSketchLike(json)) captured.push({ url: response.url(), json });
      if (process.env.LANHU_SCRAPE_DEBUG) {
        console.error(`[scrape] captured ${response.url()} sketch=${isSketchLike(json)}`);
      }
    } catch {
      /* 非 JSON 响应，忽略 */
    }
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: opts.timeout || 60000 }).catch(() => {});
  await page.waitForTimeout(opts.wait || 3500);

  let layers: any[] = [];
  let meta: any = {};
  if (captured.length) {
    captured.sort((a, b) => (findLayerArray(b.json)?.length || 0) - (findLayerArray(a.json)?.length || 0));
    const norm = normalizeSketch(captured[0].json);
    layers = norm.layers;
    meta = { ...norm.meta, capturedFrom: captured[0].url };
  } else {
    layers = await page.evaluate(extractDomLayers);
    meta = { fallback: 'dom', note: '未拦截到设计数据 JSON，已用 DOM 包围盒兜底，建议校准' };
  }

  let screenshotBase64: string | undefined;
  if (opts.screenshot) {
    screenshotBase64 = (await page.screenshot({ fullPage: false })).toString('base64');
  }

  await browser.close();
  return {
    source: 'scrape',
    url,
    viewport: opts.viewport || { width: 1440, height: 900 },
    layers,
    meta,
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
  };
}
