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
 * 收集目录树扁平节点（含 DOM 索引）。TDesign 树为扁平渲染，DOM 顺序即大纲顺序，
 * 后续点击按索引定位，天然规避同名节点歧义。
 */
async function collectTreeItems() {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动，请先调用 openShareLink');

  return page.evaluate(() => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return null;

    const items = [];
    tree.querySelectorAll('.t-tree__item').forEach((item, domIndex) => {
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

      items.push({ name, level, isGroup, domIndex });
    });
    return items;
  });
}

/**
 * 按层级栈为扁平节点推导完整路径（祖先分组名 + 自身，用 / 连接）。
 * 同名页面靠路径成为唯一地址，如「赛季通行证S2优化/流程图」。
 * @param {Array<{name: string, level: number, isGroup: boolean, domIndex: number}>} items
 */
export function buildTreePaths(items) {
  const stack = [];
  return items.map((item) => {
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    stack.push({ level: item.level, name: item.name });
    return { ...item, path: stack.map((s) => s.name).join('/') };
  });
}

/**
 * 获取原型页面大纲（左侧目录树，节点带完整路径）
 * @returns {Promise<Array<{name: string, level: number, isGroup: boolean, domIndex: number, path: string, pageIndex?: number}>>}
 */
export async function getPageOutline() {
  const items = (await collectTreeItems()) || [];
  const tree = buildTreePaths(items);

  // 给非分组项分配 pageIndex
  let pageIndex = 0;
  return tree.map((item) => {
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
 * 导航到指定页面（按目录树 DOM 索引点击）
 * @param {number} domIndex - 目标节点在大纲数组中的索引
 * @returns {Promise<{ok: true} | {ok: false, reason: 'stale_outline'}>}
 */
export async function navigateToPageByIndex(domIndex) {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const outcome = await page.evaluate((index) => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return { ok: false, reason: 'stale_outline' };

    const items = Array.from(tree.querySelectorAll('.t-tree__item'));
    const label = items[index]?.querySelector(':scope > .t-tree__label');
    if (!label) return { ok: false, reason: 'stale_outline' };

    label.click();
    return { ok: true };
  }, domIndex);

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

/**
 * 纯函数：在大纲中匹配目标（分组或页面）。
 * 支持：叶子名（唯一时）、完整路径、路径尾部（最后 N 段）。
 * 多种命中时返回候选路径清单，让调用方拿到可行动的提示。
 * @param {Array<{name: string, path: string, isGroup: boolean, domIndex: number}>} outline
 * @param {string} name - 叶子名或路径
 * @param {'any'|'group'} kind - 只匹配分组，或分组与页面都匹配
 * @returns {{ok: true, target: object} | {ok: false, reason: string}}
 */
export function matchTreeTarget(outline, name, kind = 'any') {
  const pool = kind === 'group' ? outline.filter((i) => i.isGroup) : outline;
  if (!pool.length) return { ok: false, reason: `目录中没有任何${kind === 'group' ? '分组' : '节点'}` };

  // 1) 精确路径匹配（唯一地址，直接命中）
  const exactPaths = pool.filter((i) => i.path === name);
  if (exactPaths.length === 1) return { ok: true, target: exactPaths[0] };

  // 2) 精确叶子名匹配（唯一时可用；同名靠路径消歧）
  const exactNames = pool.filter((i) => i.name === name);
  if (exactNames.length === 1) return { ok: true, target: exactNames[0] };

  // 3) 路径尾部匹配（含部分段，如「S2优化/流程图」命中「赛季通行证S2优化/流程图」）
  const pathSuffix = pool.filter((i) => i.path.endsWith(name));
  if (pathSuffix.length === 1) return { ok: true, target: pathSuffix[0] };

  const candidates = [...new Set([...exactPaths, ...exactNames, ...pathSuffix])];
  if (candidates.length > 0) {
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: `「${name}」匹配到 ${candidates.length} 个节点：${candidates
          .map((i) => i.path)
          .join('、')}。请使用完整路径（父分组/页面名）区分`,
      };
    }
    return {
      ok: false,
      reason: `「${name}」匹配到同名节点（路径：${candidates[0].path}），无法区分`,
    };
  }
  return {
    ok: false,
    reason: `目录中未找到「${name}」。可用路径：${pool.map((i) => i.path).join('、')}`,
  };
}

function describeNavigationFailure(pageName, nav) {
  if (nav.reason === 'stale_outline') {
    return '目录树已刷新导致定位失效，请重新调用获取大纲后再试';
  }
  return nav.reason;
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
 * 在目录树中定位分组：叶子名唯一时可用，歧义时返回候选路径清单。
 * @param {Array<{name: string, path: string, isGroup: boolean}>} outline
 * @param {string} name
 * @returns {{ok: true, target: {name: string, path: string, domIndex: number, level: number, isGroup: boolean}} | {ok: false, reason: string}}
 */
function resolveGroup(outline, name) {
  return matchTreeTarget(outline, name, 'group');
}

/**
 * 获取指定分组下所有页面的完整内容
 * @param {string} groupName - 分组名称（如"赛季通行证S2优化/流程图"或叶子名）
 * @param {string} [url] - 分享链接，用于页面级缓存键
 * @returns {Promise<Array<{pageName: string, text: string, tables: any[], images: any[], segments: string[], segmentCount: number, isSegmented: boolean, error?: string}>>}
 */
export async function getGroupPages(groupName, url) {
  const outline = await getPageOutline();
  const located = resolveGroup(outline, groupName);
  if (!located.ok) throw new Error(located.reason);
  const { target } = located;

  let pages;
  if (!target.isGroup) {
    // 传入的其实是页面名，按单页处理
    pages = [{ name: target.name, domIndex: target.domIndex }];
  } else {
    // domIndex 是原始 DOM 序号（可能含无文字节点），遍历须用大纲数组下标，两者不可混用
    const targetIndex = outline.indexOf(target);
    const groupLevel = target.level;
    pages = [];
    for (let i = targetIndex + 1; i < outline.length; i++) {
      const item = outline[i];
      if (item.level <= groupLevel) break;
      if (!item.isGroup) pages.push({ name: item.name, domIndex: item.domIndex });
    }
    // 空分组：退化为解析分组节点自身
    if (pages.length === 0) pages.push({ name: target.name, domIndex: target.domIndex });
  }

  const results = [];
  for (const pageInfo of pages) {
    const nav = await navigateToPageByIndex(pageInfo.domIndex);
    if (!nav.ok) {
      results.push({
        pageName: pageInfo.name,
        text: '',
        tables: [],
        images: [],
        segments: [],
        segmentCount: 0,
        isSegmented: false,
        error: describeNavigationFailure(pageInfo.name, nav),
      });
      continue;
    }

    const { text, tables, images } = await extractPageText();
    const screenshotResult = await screenshotPage(
      `${groupName}_${pageInfo.name}`,
      pageCacheKeyOf(url, pageInfo.name, text)
    );

    results.push({
      pageName: pageInfo.name,
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
 * @param {string} pageName - 页面叶子名或完整路径（父分组/页面名，用于同名页面消歧）
 * @param {string} [url] - 分享链接，用于页面级缓存键
 * @returns {Promise<{pageName: string, text: string, tables: any[], images: any[], segments: string[], segmentCount: number, isSegmented: boolean}>}
 */
export async function getSinglePage(pageName, url) {
  const outline = await getPageOutline();
  const located = matchTreeTarget(outline, pageName, 'any');
  if (!located.ok) throw new Error(located.reason);

  const nav = await navigateToPageByIndex(located.target.domIndex);
  if (!nav.ok) throw new Error(describeNavigationFailure(pageName, nav));

  const { text, tables, images } = await extractPageText();
  const screenshotResult = await screenshotPage(
    pageName,
    pageCacheKeyOf(url, located.target.path, text)
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
