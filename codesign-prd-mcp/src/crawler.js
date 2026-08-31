/**
 * CoDesign 产品原型爬取模块
 * 负责：打开分享链接、输入密码、遍历目录、提取页面内容、分段截图
 *
 * CoDesign 原型页面结构：
 * - 密码页: .prototype-password (一个隐藏 input + 4个视觉方块)
 * - 左侧目录: .content__menu .t-tree (TDesign tree 组件)
 *   - 节点: .t-tree__item
 *   - 标签: .t-tree__label (可点击)
 *   - 文字: .label-text
 *   - 数量: .total-text (需过滤)
 *   - 分组图标: .t-folder-icon
 * - 右侧内容: .axure-container (Axure 原型渲染区)
 */
import { launchBrowser, getPage, waitForNetworkIdle } from './browser.js';
import { capturePageSegments } from './screenshot.js';

/**
 * 打开 CoDesign 分享链接并输入密码
 * @param {string} url - 分享链接
 * @param {string} [password] - 访问密码（4位）
 * @returns {Promise<void>}
 */
export async function openShareLink(url, password) {
  const page = await launchBrowser({ headless: true });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(8000);

  // 检测是否需要密码
  let needPassword = false;
  try {
    needPassword = (await page.$('.prototype-password')) !== null;
  } catch {
    needPassword = false;
  }

  if (needPassword && password) {
    await inputPassword(page, password);

    // 点击确定按钮（点击后页面会导航，需要特殊处理）
    try {
      const submitBtn = await page.$('.prototype-password__submit');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
    } catch {
      // 点击可能因导航而报错，忽略
    }

    // 轮询等待目录树出现（页面导航后执行上下文会重建）
    let treeReady = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      try {
        const tree = await page.$('.t-tree');
        if (tree) {
          treeReady = true;
          break;
        }
      } catch {
        // 执行上下文可能还在重建，继续等待
      }
    }

    if (!treeReady) {
      throw new Error('密码验证后未能加载原型页面（未找到目录树）');
    }
    await page.waitForTimeout(1000);
  }
}

/**
 * 输入密码（CoDesign 密码页：一个隐藏 input + 4个视觉方块）
 */
async function inputPassword(page, password) {
  const input = await page.$('.prototype-password__input input, input.t-input__inner');
  if (input) {
    await input.click();
    await input.fill(password);
    await page.waitForTimeout(300);
  } else {
    await page.click('.prototype-password__input');
    await page.keyboard.type(password, { delay: 100 });
  }
}

/**
 * 获取原型页面大纲（左侧目录树）
 * @returns {Promise<Array<{name: string, level: number, isGroup: boolean, pageIndex: number}>>}
 */
export async function getPageOutline() {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动，请先调用 openShareLink');

  const outline = await page.evaluate(() => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return [];

    const items = [];
    const treeItems = tree.querySelectorAll('.t-tree__item');
    treeItems.forEach((item) => {
      const labelText = item.querySelector(':scope > .t-tree__label .label-text');
      const name = labelText?.textContent?.trim();
      if (!name) return;

      // 判断是否是分组：有 total-text（子项数量标记）的就是分组
      const totalText = item.querySelector(':scope > .t-tree__label .total-text');
      const isGroup = !!totalText;

      // 读取 level（从 style 的 --level 变量）
      const style = item.getAttribute('style') || '';
      const levelMatch = style.match(/--level:\s*(\d+)/);
      const level = levelMatch ? parseInt(levelMatch[1]) : 0;

      items.push({ name, level, isGroup });
    });
    return items;
  });

  // 给非分组项分配 pageIndex
  let pageIndex = 0;
  return outline.map((item) => {
    if (!item.isGroup) {
      return { ...item, pageIndex: pageIndex++ };
    }
    return item;
  });
}

/**
 * 获取 Axure 原型的 iframe（内容实际在 blob URL 的 iframe 中）
 * @returns {Promise<import('playwright').Frame | null>}
 */
export async function getAxureFrame() {
  const page = getPage();
  if (!page) return null;

  const iframeEl = await page.$('.axure-container iframe');
  if (iframeEl) {
    const frame = await iframeEl.contentFrame();
    if (frame) return frame;
  }

  const frames = page.frames();
  const blobFrame = frames.find((f) => f.url().startsWith('blob:'));
  return blobFrame || null;
}

/**
 * 导航到指定页面（通过目录树点击）
 * @param {string} pageName - 页面名称
 * @returns {Promise<boolean>} 是否成功
 */
export async function navigateToPage(pageName) {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const clicked = await page.evaluate((name) => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return false;
    const labels = tree.querySelectorAll('.t-tree__label');
    for (const label of labels) {
      const labelText = label.querySelector('.label-text');
      if (labelText?.textContent?.trim() === name) {
        label.click();
        return true;
      }
    }
    return false;
  }, pageName);

  if (clicked) {
    await page.waitForTimeout(2000);
    await waitForNetworkIdle(5000);

    // 等待 iframe 中有内容
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      try {
        const frame = await getAxureFrame();
        if (frame) {
          const text = await frame.evaluate(() => document.body?.innerText?.trim() || '');
          if (text.length > 5) break;
        }
      } catch {
        // frame 可能还在加载
      }
    }
  }

  return clicked;
}

/**
 * 提取当前页面的纯文本内容（从 Axure iframe 中提取，含表格）
 * @returns {Promise<{text: string, tables: Array<{headers: string[], rows: string[][]}>}>}
 */
export async function extractPageText() {
  const frame = await getAxureFrame();
  if (!frame) {
    return { text: '', tables: [] };
  }

  const result = await frame.evaluate(() => {
    const container = document.body;
    if (!container) return { text: '', tables: [] };

    // 提取表格
    const tables = [];
    container.querySelectorAll('table').forEach((table) => {
      const headers = [];
      const rows = [];
      const allRows = table.querySelectorAll('tr');
      allRows.forEach((row, idx) => {
        const cells = row.querySelectorAll('th, td');
        const rowData = Array.from(cells).map((c) => c.textContent?.trim() || '');
        if (idx === 0) {
          headers.push(...rowData);
        } else {
          rows.push(rowData);
        }
      });
      if (headers.length > 0 || rows.length > 0) {
        tables.push({ headers, rows });
      }
    });

    // 提取纯文本
    const rawText = container.innerText || container.textContent || '';
    const textLines = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    return {
      text: textLines.join('\n'),
      tables,
    };
  });

  return result;
}

/**
 * 截取当前页面（分段截图，超长页面自动分段）
 * @param {string} filename - 文件名（不含扩展名）
 * @returns {Promise<{segments: string[], totalHeight: number, segmentCount: number, isSegmented: boolean}>}
 */
export async function screenshotPage(filename) {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const frame = await getAxureFrame();
  return await capturePageSegments(filename, frame);
}

/**
 * 获取指定分组下所有页面的完整内容
 * @param {string} groupName - 分组名称（如"赛季通行证S2优化"）
 * @returns {Promise<Array<{pageName: string, text: string, tables: any[], segments: string[], segmentCount: number, isSegmented: boolean, error?: string}>>}
 */
export async function getGroupPages(groupName) {
  const outline = await getPageOutline();

  const groupIndex = outline.findIndex((item) => item.name.includes(groupName));
  if (groupIndex === -1) {
    throw new Error(`未找到分组: ${groupName}`);
  }

  const groupLevel = outline[groupIndex].level;
  const pages = [];

  for (let i = groupIndex + 1; i < outline.length; i++) {
    const item = outline[i];
    if (item.level <= groupLevel) break;
    if (!item.isGroup && item.level > groupLevel) {
      pages.push(item.name);
    }
  }

  if (pages.length === 0) {
    pages.push(groupName);
  }

  const results = [];
  for (const pageName of pages) {
    const success = await navigateToPage(pageName);
    if (!success) {
      results.push({
        pageName,
        text: '',
        tables: [],
        segments: [],
        segmentCount: 0,
        isSegmented: false,
        error: '页面导航失败',
      });
      continue;
    }

    const { text, tables } = await extractPageText();
    const screenshotResult = await screenshotPage(`${groupName}_${pageName}`);

    results.push({
      pageName,
      text,
      tables,
      segments: screenshotResult.segments,
      segmentCount: screenshotResult.segmentCount,
      isSegmented: screenshotResult.isSegmented,
      totalHeight: screenshotResult.totalHeight,
    });
  }

  return results;
}

/**
 * 获取单个页面的完整内容
 * @param {string} pageName
 * @returns {Promise<{pageName: string, text: string, tables: any[], segments: string[], segmentCount: number, isSegmented: boolean}>}
 */
export async function getSinglePage(pageName) {
  const success = await navigateToPage(pageName);
  if (!success) throw new Error(`无法导航到页面: ${pageName}`);

  const { text, tables } = await extractPageText();
  const screenshotResult = await screenshotPage(pageName);

  return {
    pageName,
    text,
    tables,
    segments: screenshotResult.segments,
    segmentCount: screenshotResult.segmentCount,
    isSegmented: screenshotResult.isSegmented,
    totalHeight: screenshotResult.totalHeight,
  };
}
