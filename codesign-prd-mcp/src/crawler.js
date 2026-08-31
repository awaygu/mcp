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
import { createHash } from 'crypto';
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
 * @returns {Promise<{ok: true} | {ok: false, reason: 'not_found'|'ambiguous', count?: number}>}
 */
export async function navigateToPage(pageName) {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const outcome = await page.evaluate((name) => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return { ok: false, reason: 'not_found' };

    const labels = Array.from(tree.querySelectorAll('.t-tree__label'));
    const matched = labels.filter(
      (label) => label.querySelector('.label-text')?.textContent?.trim() === name
    );

    // 同名节点点第一个会静默跳错页面，这里上报歧义交给调用方决定
    if (matched.length === 0) return { ok: false, reason: 'not_found' };
    if (matched.length > 1) return { ok: false, reason: 'ambiguous', count: matched.length };

    matched[0].click();
    return { ok: true };
  }, pageName);

  if (!outcome.ok) return outcome;

  // 等待 iframe 切换到新页面（URL 变化或元素被替换），替代固定 2s 睡眠
  const oldFrame = await getAxureFrame();
  const oldFrameUrl = oldFrame?.url() || '';
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(250);
    const frame = await getAxureFrame();
    if (!frame) continue;
    if (frame !== oldFrame || frame.url() !== oldFrameUrl) break;
  }
  await waitForNetworkIdle(5000);

  // 等待 iframe 中有内容
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
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

  return { ok: true };
}

function describeNavigationFailure(pageName, nav) {
  if (nav.reason === 'ambiguous') {
    return `页面名「${pageName}」在目录中出现 ${nav.count} 次，无法确定唯一目标，请改用更完整的名称`;
  }
  return `目录中未找到页面「${pageName}」，请对照大纲使用完全一致的页面名称`;
}

/**
 * 提取当前页面的纯文本内容（从 Axure iframe 中提取，含表格与内嵌图片）
 * @returns {Promise<{text: string, tables: Array<{headers: string[], rows: string[][]}>, images: Array<{src: string, alt: string, width: number, height: number}>}>}
 */
export async function extractPageText() {
  const frame = await getAxureFrame();
  if (!frame) {
    return { text: '', tables: [], images: [] };
  }

  const result = await frame.evaluate(() => {
    const container = document.body;
    if (!container) return { text: '', tables: [], images: [] };

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

    // 提取内嵌原型图（设计稿/插画类大图，DOM 文字提取不到，过滤图标小图）
    const images = [];
    container.querySelectorAll('img').forEach((img) => {
      const rect = img.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 40 || height < 40) return;
      images.push({
        src: (img.currentSrc || img.src || '').slice(0, 200),
        alt: img.alt?.trim() || '',
        width,
        height,
      });
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
      images,
    };
  });

  return result;
}

/**
 * 截取当前页面（分段截图，超长页面自动分段）
 * @param {string} filename - 文件名（不含扩展名）
 * @param {string} [pageCacheKey] - 页面级缓存键（url+页面名+文字哈希），命中时跳过截图
 * @returns {Promise<{segments: string[], totalHeight: number, segmentCount: number, isSegmented: boolean}>}
 */
export async function screenshotPage(filename, pageCacheKey) {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const frame = await getAxureFrame();
  return await capturePageSegments(filename, frame, pageCacheKey);
}

/**
 * 页面级缓存键：分享链接 + 页面名 + DOM 文字哈希。
 * Axure 为静态导出，文字不变即可认为页面未变，可复用已有截图。
 */
function pageCacheKeyOf(url, pageName, text) {
  if (!url) return null;
  return createHash('md5').update(`${url}::${pageName}::${text}`).digest('hex');
}

/**
 * 在目录树中定位分组或页面：精确匹配优先，其次模糊匹配，多种可能时抛出候选清单。
 * 原实现取首个模糊匹配，遇到同名分组会静默解析错目标。
 * @returns {{kind: 'group', index: number} | {kind: 'page', name: string}}
 */
function resolveTarget(outline, name) {
  const groups = outline.filter((i) => i.isGroup);
  const pages = outline.filter((i) => !i.isGroup);

  const exactGroups = groups.filter((i) => i.name === name);
  if (exactGroups.length === 1) return { kind: 'group', index: outline.indexOf(exactGroups[0]) };
  if (exactGroups.length > 1) {
    throw new Error(`分组名「${name}」在目录中出现 ${exactGroups.length} 次，请改用更完整的名称`);
  }

  const fuzzyGroups = groups.filter((i) => i.name.includes(name));
  if (fuzzyGroups.length === 1) return { kind: 'group', index: outline.indexOf(fuzzyGroups[0]) };
  if (fuzzyGroups.length > 1) {
    throw new Error(
      `分组名「${name}」模糊匹配到 ${fuzzyGroups.length} 个分组：${fuzzyGroups
        .map((i) => i.name)
        .join(' / ')}。请细化名称后重试`
    );
  }

  // 退化：传入的其实是页面名，按单页处理
  const exactPages = pages.filter((i) => i.name === name);
  if (exactPages.length === 1) return { kind: 'page', name };
  if (exactPages.length > 1) {
    throw new Error(`页面名「${name}」在目录中出现 ${exactPages.length} 次，请改用更完整的名称`);
  }

  throw new Error(
    `未找到分组或页面「${name}」。可用分组：${groups.map((i) => i.name).join(' / ') || '（无）'}`
  );
}

/**
 * 获取指定分组下所有页面的完整内容
 * @param {string} groupName - 分组名称（如"赛季通行证S2优化"）
 * @param {string} [url] - 分享链接，用于页面级缓存键
 * @returns {Promise<Array<{pageName: string, text: string, tables: any[], images: any[], segments: string[], segmentCount: number, isSegmented: boolean, error?: string}>>}
 */
export async function getGroupPages(groupName, url) {
  const outline = await getPageOutline();
  const target = resolveTarget(outline, groupName);

  let pages;
  if (target.kind === 'page') {
    pages = [target.name];
  } else {
    const groupLevel = outline[target.index].level;
    pages = [];
    for (let i = target.index + 1; i < outline.length; i++) {
      const item = outline[i];
      if (item.level <= groupLevel) break;
      if (!item.isGroup) pages.push(item.name);
    }
    // 空分组：退化为解析分组节点自身
    if (pages.length === 0) pages.push(outline[target.index].name);
  }

  const results = [];
  for (const pageName of pages) {
    const nav = await navigateToPage(pageName);
    if (!nav.ok) {
      results.push({
        pageName,
        text: '',
        tables: [],
        images: [],
        segments: [],
        segmentCount: 0,
        isSegmented: false,
        error: describeNavigationFailure(pageName, nav),
      });
      continue;
    }

    const { text, tables, images } = await extractPageText();
    const screenshotResult = await screenshotPage(
      `${groupName}_${pageName}`,
      pageCacheKeyOf(url, pageName, text)
    );

    results.push({
      pageName,
      text,
      tables,
      images,
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
 * @param {string} [url] - 分享链接，用于页面级缓存键
 * @returns {Promise<{pageName: string, text: string, tables: any[], images: any[], segments: string[], segmentCount: number, isSegmented: boolean}>}
 */
export async function getSinglePage(pageName, url) {
  const nav = await navigateToPage(pageName);
  if (!nav.ok) throw new Error(describeNavigationFailure(pageName, nav));

  const { text, tables, images } = await extractPageText();
  const screenshotResult = await screenshotPage(
    pageName,
    pageCacheKeyOf(url, pageName, text)
  );

  return {
    pageName,
    text,
    tables,
    images,
    segments: screenshotResult.segments,
    segmentCount: screenshotResult.segmentCount,
    isSegmented: screenshotResult.isSegmented,
    totalHeight: screenshotResult.totalHeight,
  };
}
