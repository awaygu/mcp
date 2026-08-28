#!/usr/bin/env node
/**
 * 验证 harness：拉起 mock 视觉端点 + 启动 server.mjs，
 * 通过标准 JSON-RPC 跑通 initialize / tools/list / 4 个 tools/call，
 * 不依赖真实网络与真实 Key，证明 MCP 集成层成立。
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = 8799;
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// --- 内联 mock 视觉端点（OpenAI 兼容，返回 canned JSON）---
import { createServer } from 'node:http';
const httpServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {}
    const images = (parsed.messages || [])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c) => c.type === 'image_url' || c.type === 'file').length;
    const textAll = (parsed.messages || [])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join(' ');
    const model = parsed.model;
    const fmt = parsed.response_format;
    const isTriage = /rootCause/i.test(textAll);
    const isCompare = images >= 2;
    const content = isTriage
      ? JSON.stringify({
          rootCause: '购票按钮的等待超时，selector ".buy" 在 390px 宽度下被底部安全区遮挡未渲染',
          category: 'selector',
          confidence: 0.82,
          fixSuggestion: '改用 [data-testid="buy"] 并等待可见，或调整 z-index 避免被安全区覆盖',
          relatedFiles: ['src/pages/masked_ball/src/BuyButton.vue'],
        })
      : isCompare
        ? JSON.stringify({
            matchScore: 92,
            verdict: 'need_fix',
            diffs: [{ location: 'cta button', issue: '圆角偏小 2px', severity: 'minor' }],
            suggestions: ['将 border-radius 从 10px 改为 12px'],
          })
        : JSON.stringify({
            defects: [
              { type: 'overlap', severity: 'major', location: 'card', description: '卡片与标题轻微重叠' },
            ],
            summary: '1 个 major 缺陷',
            pass: false,
          });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        mock: true,
        received: { model, images, response_format: fmt },
        choices: [{ message: { role: 'assistant', content } }],
      })
    );
  });
});

function startChild(extraEnv = {}) {
  const child = spawn(
    process.execPath,
    ['server.mjs'],
    {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, VISION_BASE_URL: `http://127.0.0.1:${PORT}`, LANHU_MOCK: '1', ...extraEnv },
    }
  );
  return child;
}

// 帧解析（与 server 同款）
let childBuf = Buffer.alloc(0);
const pending = new Map();
function parseChild(data) {
  childBuf = Buffer.concat([childBuf, data]);
  const out = [];
  while (true) {
    const he = childBuf.indexOf('\r\n\r\n');
    if (he === -1) break;
    const h = childBuf.slice(0, he).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(h);
    if (!m) {
      childBuf = childBuf.slice(he + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    if (childBuf.length < he + 4 + len) break;
    const b = childBuf.slice(he + 4, he + 4 + len);
    childBuf = childBuf.slice(he + 4 + len);
    try {
      out.push(JSON.parse(b.toString('utf8')));
    } catch {}
  }
  return out;
}

let nextId = 1;
function rpc(child, method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    child.stdin.write(payload);
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  await new Promise((r) => httpServer.listen(PORT, r));
  const child = startChild();
  child.stdout.on('data', (d) => {
    for (const frame of parseChild(d)) {
      if (frame.id !== undefined && pending.has(frame.id)) {
        pending.get(frame.id)(frame);
        pending.delete(frame.id);
      }
    }
  });
  const errs = [];
  child.stderr.on('data', (d) => errs.push(d.toString()));

  const init = await rpc(child, 'initialize', { protocolVersion: '2024-11-05' });
  check('initialize 返回 serverInfo', init?.result?.serverInfo?.name === 'lanhu-vision-mcp');

  const list = await rpc(child, 'tools/list', {});
  const names = (list?.result?.tools || []).map((t) => t.name).sort();
  check(
    'tools/list 暴露 4 个工具',
    JSON.stringify(names) ===
      JSON.stringify(['lanhu_fetch_design', 'lanhu_verify_render', 'vision_defect_check', 'vision_e2e_triage']),
    names.join(',')
  );

  const fetchR = await rpc(child, 'tools/call', {
    name: 'lanhu_fetch_design',
    arguments: { mock: true },
  });
  const layers = fetchR?.result?.content?.[0]?.text;
  check('lanhu_fetch_design 返回结构化图层树', layers && layers.includes('layers'), layers ? 'has layers' : 'empty');

  const defectR = await rpc(child, 'tools/call', {
    name: 'vision_defect_check',
    arguments: { imageBase64: PNG_1X1, language: 'zh-CN' },
  });
  const dt = defectR?.result?.content?.[0]?.text || '';
  check('vision_defect_check 调用契约成立', defectR?.result && dt.includes('defects'), dt.slice(0, 60));

  const verifyR = await rpc(child, 'tools/call', {
    name: 'lanhu_verify_render',
    arguments: { actualImageBase64: PNG_1X1, designImageBase64: PNG_1X1 },
  });
  const vt = verifyR?.result?.content?.[0]?.text || '';
  check('lanhu_verify_render 调用契约成立', verifyR?.result && vt.includes('matchScore'), vt.slice(0, 60));

  const triageR = await rpc(child, 'tools/call', {
    name: 'vision_e2e_triage',
    arguments: { errorText: 'Timeout waiting for selector ".buy"' },
  });
  const tt = triageR?.result?.content?.[0]?.text || '';
  check('vision_e2e_triage 调用契约成立', triageR?.result && tt.includes('rootCause'), tt.slice(0, 60));

  // 6. 优雅降级：不装 playwright 时，mode:"scrape" 应返回清晰错误而非崩溃
  //    （证明 server 默认零依赖，其余工具照常可用）
  const noMock = startChild({ LANHU_MOCK: '' });
  const noMockBuf = { b: Buffer.alloc(0) };
  let noMockResolve;
  const noMockRpc = (method, params) =>
    new Promise((resolve) => {
      noMockResolve = resolve;
      const id = 9000;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      noMock.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
      noMock.stdin.write(payload);
    });
  await new Promise((r) => setTimeout(r, 300));
  noMock.stdout.on('data', (d) => {
    noMockBuf.b = Buffer.concat([noMockBuf.b, d]);
    const he = noMockBuf.b.indexOf('\r\n\r\n');
    if (he === -1) return;
    const len = parseInt(/Content-Length:\s*(\d+)/i.exec(noMockBuf.b.slice(0, he).toString('utf8'))?.[1] || '0', 10);
    if (noMockBuf.b.length < he + 4 + len) return;
    const frame = JSON.parse(noMockBuf.b.slice(he + 4, he + 4 + len).toString('utf8'));
    if (frame.id === 9000) noMockResolve(frame);
  });
  const scrapeErr = await noMockRpc('tools/call', {
    name: 'lanhu_fetch_design',
    arguments: { mode: 'scrape', url: 'https://lanhuapp.com/example' },
  });
  const scrapeMsg = scrapeErr?.error?.message || '';
  check(
    'scrape 未装 playwright 时优雅报错',
    scrapeErr?.error && /playwright/i.test(scrapeMsg),
    scrapeMsg.slice(0, 50)
  );
  noMock.kill();

  // 收尾
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n==== ${passed}/${total} checks passed ====`);
  child.kill();
  httpServer.close();
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
