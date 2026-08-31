#!/usr/bin/env node
/**
 * 命令行工具：爬取指定需求分组，生成纯文本结构化需求文档
 * 用法: node scripts/generate-prd.js
 *
 * 流程：打开链接 → 遍历页面 → 分段截图 → VLM解析 → 合并 → 生成文档
 */
import { openShareLink, getPageOutline, getGroupPages } from '../src/crawler.js';
import { closeBrowser } from '../src/browser.js';
import { isVLMConfigured, detectPageType, analyzeSegmentsParallel } from '../src/vlm.js';
import { mergePageResult } from '../src/merger.js';
import { generateRequirementDoc } from '../src/doc-generator.js';
import { getCache, setCache } from '../src/cache.js';
import * as fs from 'fs';
import * as path from 'path';

const URL = 'https://codesign.qq.com/s/704879443912137';
const PASSWORD = 'XIVO';
const GROUP_NAME = '赛季通行证S2优化';
const OUTPUT_DIR = path.join(process.cwd(), 'output');

async function processPage(pageData, url) {
  if (pageData.error) {
    return {
      pageName: pageData.pageName,
      type: 'page',
      domText: '',
      tables: [],
      vlmResult: {},
      warnings: [pageData.error],
      _hasVLM: false,
    };
  }

  const type = detectPageType(pageData.pageName, pageData.text);
  let vlmSegments = [];

  if (isVLMConfigured() && pageData.segments?.length > 0) {
    const cacheKey = {
      url,
      pageName: pageData.pageName,
      imagePaths: pageData.segments,
      type,
    };
    const cached = getCache(cacheKey);
    if (cached) {
      vlmSegments = cached;
      console.log(`      [缓存命中] ${pageData.pageName}`);
    } else {
      console.log(`      [VLM解析] ${pageData.pageName} (${pageData.segmentCount}段)`);
      vlmSegments = await analyzeSegmentsParallel(pageData.segments, type, {
        pageText: pageData.text,
      });
      setCache(cacheKey, vlmSegments);
    }
  }

  return mergePageResult({
    pageName: pageData.pageName,
    domText: pageData.text,
    domTables: pageData.tables,
    vlmSegments,
    type,
    screenshotCount: pageData.segmentCount || 0,
  });
}

async function main() {
  console.log('=== 生成需求文档（分段截图 + VLM 解析版）===\n');

  const vlmOn = isVLMConfigured();
  console.log(`VLM 状态: ${vlmOn ? '已启用' : '未配置（仅 DOM 提取）'}\n`);

  // 1. 打开链接
  console.log('[1/5] 打开 CoDesign 链接...');
  await openShareLink(URL, PASSWORD);

  // 2. 获取大纲
  console.log('[2/5] 获取页面大纲...');
  const outline = await getPageOutline();
  const groupItem = outline.find((i) => i.name.includes(GROUP_NAME));
  console.log(`      目标分组: ${groupItem?.name}`);

  // 3. 爬取分组页面（含分段截图）
  console.log('[3/5] 爬取分组页面（分段截图）...');
  const pagesData = await getGroupPages(GROUP_NAME);
  console.log(`      共 ${pagesData.length} 个页面`);
  pagesData.forEach((p) => {
    const segInfo = p.isSegmented ? `, ${p.segmentCount}段截图` : ', 单张截图';
    console.log(`      - ${p.pageName}: ${(p.text || '').length}字符${segInfo}`);
  });

  // 4. VLM 解析 + 合并
  console.log('[4/5] VLM 解析 + 结果合并...');
  const mergedPages = [];
  for (const pageData of pagesData) {
    const merged = await processPage(pageData, URL);
    mergedPages.push(merged);
  }

  // 5. 生成文档
  console.log('[5/5] 生成纯文本结构化需求文档...');
  const doc = generateRequirementDoc({
    groupName: GROUP_NAME,
    sourceUrl: URL,
    pages: mergedPages,
    detailLevel: 'standard',
  });

  // 保存
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${GROUP_NAME}_需求文档_v2.md`);
  fs.writeFileSync(outputPath, doc);

  // 保存合并后的结构化数据
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${GROUP_NAME}_merged_v2.json`),
    JSON.stringify(mergedPages, null, 2)
  );

  console.log(`\n✅ 需求文档已生成: ${outputPath}`);
  console.log(`✅ 结构化数据: ${path.join(OUTPUT_DIR, `${GROUP_NAME}_merged_v2.json`)}`);

  // 打印摘要
  console.log(`\n=== 内容摘要 ===`);
  mergedPages.forEach((p) => {
    const typeMap = { flowchart: '流程图', table: '配置表', page: '普通页面' };
    const vlmInfo = p._hasVLM ? 'VLM解析' : '仅DOM';
    const warnInfo = p.warnings?.length ? `, ${p.warnings.length}个警告` : '';
    console.log(`- ${p.pageName} [${typeMap[p.type]}] (${vlmInfo}${warnInfo})`);
  });

  await closeBrowser();
}

main().catch(async (err) => {
  console.error('❌ 生成失败:', err);
  await closeBrowser();
  process.exit(1);
});
