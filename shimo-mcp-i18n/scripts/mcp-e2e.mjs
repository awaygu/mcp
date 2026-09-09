// mcp-e2e.mjs — 通过 stdio 以 MCP 协议调用 dist/index.js，验证工具注册与调用
// 用法：SHIMO_COOKIE=... node scripts/mcp-e2e.mjs
import { spawn } from 'node:child_process';

const COOKIE = process.env.SHIMO_COOKIE || '';
if (!COOKIE) { console.error('缺 SHIMO_COOKIE'); process.exit(1); }
const DOC = 'https://shimo.im/sheets/I5WLC0kmK9fB9CH8/m7cb0';

const child = spawn('node', ['dist/index.js'], {
  env: { ...process.env, SHIMO_COOKIE: COOKIE },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); } }, 180000);
  });
}

// 1) initialize + tools/list
const init = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'mcp-e2e', version: '0.0.1' },
});
console.log('[init]', init.result?.serverInfo);
await rpc('notifications/initialized', {});

const tools = await rpc('tools/list', {});
console.log('[tools]', tools.result.tools.map((t) => t.name).join(', '));

// 2) check_auth
const auth = await rpc('tools/call', { name: 'shimo_check_auth', arguments: { url: DOC } });
const authData = JSON.parse(auth.result.content[0].text);
console.log('[check_auth]', JSON.stringify({ ok: authData.ok, user: authData.user, file: authData.file?.name }));

// 3) read_sheet 带 rows+languages 组合过滤
const rd = await rpc('tools/call', {
  name: 'shimo_read_sheet',
  arguments: { url: DOC, sheet: '1v1活动', rows: [2, 3, 4], languages: ['zh', 'en'] },
});
const rdData = JSON.parse(rd.result.content[0].text);
console.log('[read_sheet rows=[2,3,4] languages=[zh,en]]');
console.log('  headers:', rdData.headers.join('|'), ' rows:', rdData.rows.length, ' detected:', JSON.stringify(rdData.detectedLanguages));
console.log('  first:', JSON.stringify(rdData.rows[0]));

// 4) read_sheet 默认（不传 rows），看截断提示
const rd2 = await rpc('tools/call', { name: 'shimo_read_sheet', arguments: { url: DOC, sheet: '斋月' } });
const rd2Data = JSON.parse(rd2.result.content[0].text);
console.log('[read_sheet 斋月默认]', 'totalRows:', rd2Data.totalRows, 'returned:', rd2Data.rows.length, 'truncated:', rd2Data.truncated, 'hint:', rd2Data.hint?.slice(0, 60));

// 5) export_xlsx 到临时目录
const ex = await rpc('tools/call', { name: 'shimo_export_xlsx', arguments: { url: DOC, outputPath: '.mcp-local' } });
const exData = JSON.parse(ex.result.content[0].text);
console.log('[export_xlsx]', exData.file, exData.bytes, 'bytes,', exData.sheetCount, 'sheets');

// 6) export_xlsx 单 sheet 模式
const ex2 = await rpc('tools/call', {
  name: 'shimo_export_xlsx',
  arguments: { url: DOC, outputPath: '.mcp-local', sheet: '赛季通行证S2' },
});
const ex2Data = JSON.parse(ex2.result.content[0].text);
console.log('[export_xlsx sheet=赛季通行证S2]', JSON.stringify(ex2Data));

// 7) 单 sheet 模式错误分支：名字不存在时应返回 isError + 候选列表
const ex3 = await rpc('tools/call', { name: 'shimo_export_xlsx', arguments: { url: DOC, sheet: '不存在的表' } });
const ex3Text = ex3.result?.content?.[0]?.text || '';
console.log('[export_xlsx 错误分支]', ex3.result?.isError === true && ex3Text.includes('可用工作表') ? 'OK：isError=true + 候选列表' : `异常：isError=${ex3.result?.isError} text=${ex3Text.slice(0, 100)}`);

console.log('\n✅ MCP 协议层 E2E 通过');
child.kill();
process.exit(0);
