#!/usr/bin/env node
/**
 * scrape-lanhu.mjs — 普通蓝湖账号的"设计稿结构化抽取"后端（需 playwright）。
 *
 * 由 server.mjs 在 lanhu_fetch_design({ mode: "scrape" }) 时按需动态 import，
 * 因此 server.mjs 默认仍零依赖：不装 playwright 时其余工具照常可用，
 * 只有普通账号爬取模式需要 `npm i playwright && npx playwright install chromium`。
 *
 * 抽取策略（按可靠性排序）：
 *   1) 网络拦截：蓝湖网页会 XHR/fetch 拉取设计数据（sketch JSON），直接解析最准。
 *   2) DOM 兜底：抓可见元素的包围盒 + 计算样式 + 文本，作为结构化近似。
 *
 * ⚠️ 蓝湖网页是 SPA，真实 DOM / 接口字段名可能随版本变化。
 *    本文件用的是"对 sketch 类 JSON 与常见图层字段的宽匹配"——首次接入真实账号时，
 *    请用 `LANHU_SCRAPE_DEBUG=1` 跑一次，检查 captured 里的字段名并据此校准 normalizeSketch。
 */

// 惰性引入 playwright；未安装时抛清晰错误
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'scrape 模式需要 playwright。请在 mcp/lanhu-vision-mcp 目录执行：\n' +
      '  npm i playwright && npx playwright install chromium\n' +
      '或改用 mode:"api"（蓝湖企业版 API，需 LANHU_API_KEY）。'
    );
  }
}

// 判断一个 JSON 是否像设计稿数据
function isSketchLike(json) {
  if (!json || typeof json !== 'object') return false;
  const keys = Object.keys(json).map((k) => k.toLowerCase());
  const hit = ['layers', 'shapes', 'artboards', 'children', 'sketch', 'document', 'widgets', 'nodes'];
  return hit.some((k) => keys.includes(k));
}

// 在嵌套对象里找最大的"图层数组"
function findLayerArray(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const k of ['layers', 'shapes', 'children', 'artboards', 'widgets', 'nodes']) {
    if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findLayerArray(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// 把单个 sketch 图层归一化成我们的 schema
function normalizeShape(shape, parentX = 0, parentY = 0) {
  const frame = shape.frame || shape.rect || shape.boundingBox || shape;
  const x = Number(frame.x ?? frame.left ?? 0) + parentX;
  const y = Number(frame.y ?? frame.top ?? 0) + parentY;
  const w = Number(frame.width ?? frame.w ?? 0);
  const h = Number(frame.height ?? frame.h ?? 0);
  const style = shape.style || shape.css || {};
  const fill = style.fill || style.backgroundColor || shape.fill || (style.fills && style.fills[0]?.color);
  const type = (shape.type || shape.shapeType || (shape.text != null ? 'text' : 'rect')).toString().toLowerCase();
  const layer = {
    id: String(shape.id ?? shape.guid ?? Math.random().toString(36).slice(2)),
    type: /text|label|font/i.test(type) ? 'text' : /image|bitmap|img/i.test(type) ? 'image' : 'rect',
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  };
  if (layer.type === 'text') {
    layer.text = shape.text ?? shape.content ?? '';
    layer.fontSize = Number(style.fontSize ?? style.font?.fontSize ?? 0) || undefined;
    layer.fontWeight = Number(style.fontWeight ?? style.font?.fontWeight ?? 0) || undefined;
    layer.color = typeof fill === 'string' ? fill : undefined;
    layer.fontFamily = style.fontFamily ?? style.font?.fontFamily;
  } else {
    layer.fill = typeof fill === 'string' ? fill : undefined;
    layer.radius = Number(style.borderRadius ?? style.cornerRadius ?? 0) || undefined;
  }
  if (shape.name) layer.name = shape.name;
  return layer;
}

// 把抓取到的 sketch JSON 归一化为 { layers, meta }
function normalizeSketch(json) {
  const arr = findLayerArray(json) || [];
  const layers = arr
    .map((s) => normalizeShape(s))
    .filter((l) => l.w > 0 && l.h > 0)
    .sort((a, b) => b.h * b.w - a.h * a.w);
  const meta = {
    rawLayerCount: arr.length,
    docName: json?.document?.name ?? json?.name ?? json?.title ?? undefined,
  };
  return { layers, meta };
}

// DOM 兜底：抓可见元素包围盒 + 计算样式
function extractDomLayers() {
  const els = Array.from(document.querySelectorAll('*'));
  const out = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.top < -2000) continue;
    const cs = getComputedStyle(el);
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
  // 取面积最大的前 200 个，减少噪声
  return out.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 200);
}

function parseCookie(cookieStr, url) {
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

/**
 * @param {string} url  蓝湖设计稿链接，形如 https://lanhuapp.com/.../project/<id>/page/<pageId>
 * @param {object} opts  { cookie, storageState, viewport, screenshot, wait, timeout, headless }
 */
export async function scrapeLanhu(url, opts = {}) {
  if (!url) throw new Error('scrape 模式需要 url（蓝湖设计稿链接）');
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: opts.headless !== false });
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  if (opts.storageState) {
    // storageState 文件由 lanhu-login.mjs 生成（含已登录的 cookie/localStorage）
    const fs = await import('node:fs');
    const state = JSON.parse(fs.readFileSync(opts.storageState, 'utf8'));
    await context.addCookies(state.cookies || []);
  } else if (opts.cookie) {
    await context.addCookies(parseCookie(opts.cookie, url));
  }

  const captured = [];
  context.on('response', async (response) => {
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

  let layers = [];
  let meta = {};
  if (captured.length) {
    // 选图层数最多的那份
    captured.sort((a, b) => (findLayerArray(b.json)?.length || 0) - (findLayerArray(a.json)?.length || 0));
    const norm = normalizeSketch(captured[0].json);
    layers = norm.layers;
    meta = { ...norm.meta, capturedFrom: captured[0].url };
  } else {
    layers = await page.evaluate(extractDomLayers);
    meta = { fallback: 'dom', note: '未拦截到设计数据 JSON，已用 DOM 包围盒兜底，建议校准' };
  }

  let screenshotBase64;
  if (opts.screenshot) {
    screenshotBase64 = (await page.screenshot({ fullPage: false })).toString('base64');
  }

  await browser.close();
  return {
    source: 'scrape',
    mode: 'scrape',
    url,
    viewport: opts.viewport || { width: 1440, height: 900 },
    layers,
    meta,
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
  };
}
