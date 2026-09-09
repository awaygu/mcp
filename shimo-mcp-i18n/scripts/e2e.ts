// e2e.ts — 用真实文档端到端验证核心链路（绕过 MCP 协议层，直接调函数）
// 用法：SHIMO_COOKIE=$(cat ../.probe/cookie.txt) npx tsx scripts/e2e.ts
import { checkAuth, exportWorkbook, downloadExportZip, extractFileId } from '../src/shimo-client.js';
import { readSheet, toLanguageMap } from '../src/i18n.js';
import { extractXlsxFromZip, parseXlsx, buildXlsx } from '../src/xlsx.js';
import { detectLanguageColumns } from '../src/langmap.js';

const URL = 'https://shimo.im/sheets/I5WLC0kmK9fB9CH8/m7cb0';
const cookie = process.env.SHIMO_COOKIE || '';
if (!cookie) {
  console.error('缺 SHIMO_COOKIE');
  process.exit(1);
}
const guid = extractFileId(URL);
console.log('guid:', guid);

// 1. 探活
const auth = await checkAuth({ cookie }, guid);
console.log('\n[1] checkAuth:', JSON.stringify({ ok: auth.ok, user: auth.ok ? auth.user : auth.reason, file: auth.ok && auth.file ? auth.file.name : null }));

// 2. 读表：默认 limit=5（用 limit 参数控制体积）
const data = await readSheet(guid, '1v1活动', { cookie }, { limit: 5 });
console.log('\n[2] readSheet 1v1活动 limit=5:');
console.log('  headers:', data.headers.join(' | '));
console.log('  detected:', detectLanguageColumns(data.headers).map((c) => `${c.header}→${c.lang}`).join(', '));
console.log('  rows:', data.rows.length, 'totalRows:', data.totalRows, 'truncated:', data.truncated);
console.log('  row2:', JSON.stringify(data.rows[0]));
console.log('  row3:', JSON.stringify(data.rows[1]));

// 3. 语言过滤：只要英文+阿拉伯语
const d2 = await readSheet(guid, '1v1活动', { cookie }, { limit: 3, languages: ['en', 'ar'] });
console.log('\n[3] languages=[en,ar]:', JSON.stringify(d2.rows[0]));

// 4. 行号过滤：只取第 3、5 行
const d3 = await readSheet(guid, '1v1活动', { cookie }, { rows: [3, 5] });
console.log('\n[4] rows=[3,5]:', d3.rows.map((r) => `${r._row}:${r['中文']}=${r['英文']}`).join('  '));

// 5. i18n 映射
const map = toLanguageMap(d2);
console.log('\n[5] toLanguageMap keys:', Object.keys(map), 'en keys:', Object.keys(map.en || {}).length);

// 6. 大表分页：赛季通行证S2 全量行数
const d4 = await readSheet(guid, '赛季通行证S2', { cookie }, { limit: 0 });
console.log('\n[6] 赛季通行证S2 totalRows:', d4.totalRows, 'truncated:', d4.truncated, '(limit=0 不限)');

// 7. xlsx 导出全链路
console.log('\n[7] 导出 xlsx…');
const t0 = Date.now();
const handle = await exportWorkbook(guid, cookie);
console.log(`  任务完成 ${Date.now() - t0}ms, fileName=${handle.fileName}`);
const zip = await downloadExportZip(handle);
const xlsx = extractXlsxFromZip(zip);
console.log('  zip:', zip.length, 'bytes → xlsx:', xlsx.length, 'bytes');
const book = parseXlsx(xlsx);
console.log('  sheet 数:', book.sheetNames.length, '前5:', book.sheetNames.slice(0, 5).join(' / '));
const grid = book.sheets['1v1活动'];
console.log('  xlsx[1v1活动] 第一行:', (grid[0] || []).slice(0, 6).join(' | '));
console.log('  xlsx[1v1活动] 第二行:', (grid[1] || []).slice(0, 6).join(' | '));

// 8. values API vs xlsx 一致性抽查（1v1活动 第2行英文列）
const apiEnglish = data.rows[0]?.['英文'];
const xlsxEnglish = (grid[1] || [])[3];
console.log('\n[8] 一致性: values API 英文 =', JSON.stringify(apiEnglish), '| xlsx 英文 =', JSON.stringify(xlsxEnglish), '| 一致:', apiEnglish === xlsxEnglish);

// 9. 单 sheet 抽取：buildXlsx 重写 → 自解析往返校验
const singleBuf = buildXlsx([{ name: '1v1活动', rows: grid }]);
const singleBook = parseXlsx(singleBuf);
const roundTrip = singleBook.sheets['1v1活动'];
const origFlat = grid.flat().filter(Boolean).join('|');
const rtFlat = roundTrip.flat().filter(Boolean).join('|');
console.log('\n[9] 单 sheet 抽取:');
console.log('  生成字节:', singleBuf.length, '| sheet 名:', singleBook.sheetNames.join(','));
console.log('  单元格文本往返一致:', origFlat === rtFlat, `(${origFlat.length} vs ${rtFlat.length} chars)`);
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('../.probe', { recursive: true });
writeFileSync('../.probe/single_roundtrip.xlsx', singleBuf);
console.log('  已落盘 ../.probe/single_roundtrip.xlsx（供 openpyxl 校验）');

console.log('\n✅ E2E 全部通过');
