#!/usr/bin/env node
/**
 * 测试脚本：直接调用 crawler 模块，验证 CoDesign 原型爬取
 * 用法: node scripts/test-crawl.js
 */
import { openShareLink, getPageOutline, getGroupPages, navigateToPage, extractPageText, screenshotPage } from '../src/crawler.js';
import { closeBrowser } from '../src/browser.js';
import * as fs from 'fs';
import * as path from 'path';

const URL = 'https://codesign.qq.com/s/704879443912137';
const PASSWORD = 'XIVO';
const GROUP_NAME = '赛季通行证S2优化';
const OUTPUT_DIR = path.join(process.cwd(), 'output');

async function main() {
  console.log('=== CoDesign 原型爬取测试 ===\n');

  // 1. 打开链接 + 输入密码
  console.log('[1/5] 打开分享链接...');
  await openShareLink(URL, PASSWORD);
  console.log('      链接已打开，密码已输入\n');

  // 2. 获取页面大纲
  console.log('[2/5] 获取页面大纲...');
  const outline = await getPageOutline();
  console.log(`      共 ${outline.length} 个目录项`);
  outline.forEach((item) => {
    const indent = '  '.repeat(item.level);
    const icon = item.isGroup ? '📁' : '📄';
    console.log(`      ${indent}${icon} ${item.name}`);
  });
  console.log('');

  // 3. 找到目标分组
  console.log(`[3/5] 定位分组 "${GROUP_NAME}"...`);
  const groupItem = outline.find((item) => item.name.includes(GROUP_NAME));
  if (!groupItem) {
    console.log('      ❌ 未找到目标分组');
    await closeBrowser();
    process.exit(1);
  }
  console.log(`      ✅ 找到分组，层级: ${groupItem.level}\n`);

  // 4. 获取分组下所有页面
  console.log('[4/5] 爬取分组下所有页面...');
  const pages = await getGroupPages(GROUP_NAME);
  console.log(`      共获取 ${pages.length} 个页面\n`);

  // 5. 输出结果
  console.log('[5/5] 保存结果...');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 保存大纲
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'outline.json'),
    JSON.stringify(outline, null, 2)
  );

  // 保存每个页面的内容
  pages.forEach((page, i) => {
    const safeName = page.pageName.replace(/[^\w\u4e00-\u9fa5]/g, '_');
    const pageDir = path.join(OUTPUT_DIR, `page_${i + 1}_${safeName}`);
    fs.mkdirSync(pageDir, { recursive: true });

    fs.writeFileSync(path.join(pageDir, 'text.txt'), page.text || '');
    fs.writeFileSync(
      path.join(pageDir, 'tables.json'),
      JSON.stringify(page.tables || [], null, 2)
    );

    // 复制截图到输出目录
    if (page.screenshot && fs.existsSync(page.screenshot)) {
      const screenshotDest = path.join(pageDir, 'screenshot.png');
      fs.copyFileSync(page.screenshot, screenshotDest);
    }

    console.log(`      ✅ 页面 ${i + 1}: ${page.pageName}`);
    console.log(`         文字长度: ${(page.text || '').length} 字符`);
    console.log(`         表格数: ${(page.tables || []).length}`);
    console.log(`         截图: ${page.screenshot || '无'}`);
  });

  // 生成汇总 Markdown
  let summary = `# ${GROUP_NAME} - 爬取结果汇总\n\n`;
  summary += `页面数: ${pages.length}\n\n`;
  summary += `---\n\n`;

  pages.forEach((page) => {
    summary += `## ${page.pageName}\n\n`;
    if (page.error) {
      summary += `**错误**: ${page.error}\n\n`;
    } else {
      if (page.text) {
        summary += `### 文字内容\n\n\`\`\`\n${page.text}\n\`\`\`\n\n`;
      }
      if (page.tables?.length) {
        summary += `### 表格 (${page.tables.length}个)\n\n`;
        page.tables.forEach((t, i) => {
          summary += `**表${i + 1}**: ${t.headers?.join(' | ') || ''}\n\n`;
        });
      }
      summary += `截图: \`${page.screenshot}\`\n\n`;
    }
    summary += `---\n\n`;
  });

  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.md'), summary);
  console.log(`\n✅ 全部完成！结果保存在: ${OUTPUT_DIR}`);

  await closeBrowser();
}

main().catch(async (err) => {
  console.error('❌ 测试失败:', err);
  await closeBrowser();
  process.exit(1);
});
