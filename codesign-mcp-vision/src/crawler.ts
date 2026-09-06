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
import type { Frame, Page } from 'playwright';
import { launchBrowser, getPage, waitForNetworkIdle } from './browser.js';
import { capturePageSegments } from './screenshot.js';
import type {
  CrawledPage,
  ExtractedContent,
  NavigationResult,
  OutlineNode,
  ScreenshotResult,
  TreeMatchResult,
  TreeNode,
} from './types.js';

/** 目录节点点击结果：ok=false 表示目录树已刷新，索引失效 */
type ClickOutcome = { ok: true } | { ok: false; reason: 'stale_outline' };

/**
 * 打开 CoDesign 分享链接并输入密码
 */
export async function openShareLink(url: string, password?: string): Promise<void> {
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
async function inputPassword(page: Page, password: string): Promise<void> {
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
async function collectTreeItems(): Promise<TreeNode[] | null> {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动，请先调用 openShareLink');

  return page.evaluate(() => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return null;

    const items: { name: string; level: number; isGroup: boolean; domIndex: number }[] = [];
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
      const level = levelMatch ? parseInt(levelMatch[1], 10) : 0;

      items.push({ name, level, isGroup, domIndex });
    });
    return items;
  });
}

/**
 * 按层级栈为扁平节点推导完整路径（祖先分组名 + 自身，用 / 连接）。
 * 同名页面靠路径成为唯一地址，如「赛季通行证S2优化/流程图」。
 */
export function buildTreePaths<T extends TreeNode>(items: T[]): (T & { path: string })[] {
  const stack: { level: number; name: string }[] = [];
  return items.map((item) => {
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    stack.push({ level: item.level, name: item.name });
    return { ...item, path: stack.map((s) => s.name).join('/') };
  });
}

/**
 * 获取原型页面大纲（左侧目录树，节点带完整路径）
 */
export async function getPageOutline(): Promise<OutlineNode[]> {
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
 */
export async function getAxureFrame(): Promise<Frame | null> {
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
 * @param domIndex - 目标节点在大纲数组中的索引
 * @param opts.quick - 快速模式：仅探测 iframe 是否切换（1.5s），用于判断分组节点是否有自身页面
 * @returns frameChanged=false 表示点击后 iframe 未切换（纯展开类分组节点，无自身内容）
 */
export async function navigateToPageByIndex(
  domIndex: number,
  { quick = false }: { quick?: boolean } = {}
): Promise<NavigationResult> {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const outcome = await page.evaluate((index): ClickOutcome => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return { ok: false, reason: 'stale_outline' };

    const items = Array.from(tree.querySelectorAll('.t-tree__item'));
    const label = items[index]?.querySelector<HTMLElement>(':scope > .t-tree__label');
    if (!label) return { ok: false, reason: 'stale_outline' };

    label.click();
    return { ok: true };
  }, domIndex);

  if (!outcome.ok) return outcome;

  // 等待 iframe 切换到新页面（URL 变化或元素被替换），替代固定 2s 睡眠
  const oldFrame = await getAxureFrame();
  const oldFrameUrl = oldFrame?.url() || '';
  let frameChanged = false;
  const probes = quick ? 6 : 24;
  for (let i = 0; i < probes; i++) {
    await page.waitForTimeout(250);
    const frame = await getAxureFrame();
    if (!frame) continue;
    if (frame !== oldFrame || frame.url() !== oldFrameUrl) {
      frameChanged = true;
      break;
    }
  }

  // 快速模式且未切换：纯展开类分组，跳过完整等待（否则每组白等 10s+）
  if (quick && !frameChanged) return { ok: true, frameChanged: false };

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

  return { ok: true, frameChanged };
}

/**
 * 纯函数：在大纲中匹配目标（分组或页面）。
 * 支持：叶子名（唯一时）、完整路径、路径尾部（最后 N 段）。
 * 多种命中时返回候选路径清单，让调用方拿到可行动的提示。
 */
export function matchTreeTarget<T extends { name: string; path: string }>(
  outline: T[],
  name: string,
  kind: 'any' | 'group' = 'any'
): TreeMatchResult<T> {
  const groupsOnly = kind === 'group';
  const pool = groupsOnly
    ? outline.filter((i) => (i as unknown as { isGroup?: boolean }).isGroup)
    : outline;
  if (!pool.length) {
    return { ok: false, reason: `目录中没有任何${groupsOnly ? '分组' : '节点'}` };
  }

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

function describeNavigationFailure(nav: { ok: false; reason: string }): string {
  if (nav.reason === 'stale_outline') {
    return '目录树已刷新导致定位失效，请重新调用获取大纲后再试';
  }
  return nav.reason;
}

/**
 * 提取当前页面的纯文本内容（从 Axure iframe 中提取，含表格与内嵌图片）
 *
 * 表格双通道：
 * ① 真 <table> 元素（少见，保底）；
 * ② DOM 网格重建——Axure 的"表格"由绝对定位 div 按坐标摆出，没有真 <table> 可抓，
 *    innerText 会把行列关系撕碎。改为收集叶子文本块坐标，按 y 聚成行、按 x 起点聚成列，
 *    网格规律性达标才重建成 {headers, rows}（下游渲染为 Markdown 表格）。
 */
export async function extractPageText(): Promise<ExtractedContent> {
  const frame = await getAxureFrame();
  if (!frame) {
    return { text: '', tables: [], images: [] };
  }

  return await frame.evaluate((): ExtractedContent => {
    const container = document.body;
    if (!container) return { text: '', tables: [], images: [] };

    const tables: { headers: string[]; rows: string[][] }[] = [];
    // ① 语义化表格（Axure 导出：.table_cell 单元格带精确坐标，行列天然对齐，实测 21×4 全对）
    //    优先于几何重建——确定性输出，零猜测
    const axureCells = Array.from(container.querySelectorAll('.table_cell'));
    if (axureCells.length >= 4) {
      const items = axureCells.map((cell) => {
        const r = cell.getBoundingClientRect();
        const textEl = cell.querySelector('.text') as HTMLElement | null;
        // innerText 保留单元格内多段文本的换行结构（Axure 每行一个 <p>）
        const text = ((textEl ? textEl.innerText : cell.textContent) || '').replace(/\r/g, '').trim();
        return { x: r.left, y: r.top, text };
      });
      // 行：top 相差 ≤2px 聚为一行；列：left 相差 ≤3px 聚为一列（Axure 网格坐标精确）
      const rowKeys: number[] = [];
      for (const it of [...items].sort((a, b) => a.y - b.y)) {
        if (!rowKeys.length || it.y - rowKeys[rowKeys.length - 1] > 2) rowKeys.push(it.y);
      }
      const colKeys: number[] = [];
      for (const it of [...items].sort((a, b) => a.x - b.x)) {
        if (!colKeys.length || it.x - colKeys[colKeys.length - 1] > 3) colKeys.push(it.x);
      }
      const nearest = (keys: number[], v: number): number => {
        let best = 0;
        let bestD = Infinity;
        keys.forEach((k, i) => {
          const d = Math.abs(v - k);
          if (d < bestD) { bestD = d; best = i; }
        });
        return best;
      };
      const grid: string[][] = Array.from({ length: rowKeys.length }, () =>
        Array.from({ length: colKeys.length }, () => ''));
      for (const it of items) grid[nearest(rowKeys, it.y)][nearest(colKeys, it.x)] = it.text;
      const filled = grid.flat().filter((c) => c !== '').length;
      if (rowKeys.length >= 2 && colKeys.length >= 2 && filled / (rowKeys.length * colKeys.length) >= 0.3) {
        tables.push({ headers: grid[0], rows: grid.slice(1) });
      }
    }

    // 提取真 <table>
    container.querySelectorAll('table').forEach((table) => {
      const headers: string[] = [];
      const rows: string[][] = [];
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
    const images: { src: string; alt: string; width: number; height: number }[] = [];
    const imgRects: Array<{ x: number; y: number; w: number; h: number }> = []; // 坐标仅供画布区块统计，不进返回体
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
      imgRects.push({ x: rect.left, y: rect.top, w: width, h: height });
    });

    // ── DOM 网格表格重建（Axure 定位式表格 → 结构化行列）──
    // 算法（在真实 CoDesign 原型上校准）：
    //   叶子块 = 「最深文本持有者」（Axure 文本控件内部嵌套，children.length 判定会漏）；
    //   行簇 = y 区间重叠过半归同行（单元格多行文字会拆成多个行簇）；
    //   列 = 表头行簇（首个 ≥2 块的行）的文本块区间做锚点，其余块按区间重叠度归列
    //   ——不能用 x 起点聚类：居中单元格每行文字宽度不同，起点完全不同；
    //   逻辑行 = 首列锚点块为记录边界（y 区间制），与上一首列块 y 间距 <25px 视为同格续行；
    //   门槛：锚点列 ≥2、首列有数据、占用列 ≥2，否则维持纯文字输出（防普通版式误判成表格）。
    const gridTables = ((): { headers: string[]; rows: string[][] }[] => {
      interface Block { x: number; r: number; y: number; b: number; text: string }
      const blocks: Block[] = [];
      for (const el of Array.from(container.querySelectorAll('*'))) {
        if (el.closest('table')) continue; // 真 table 已单独提取，避免重复
        const hasDirectText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim());
        if (!hasDirectText) continue;
        const childHoldsText = Array.from(el.children).some((c) =>
          Array.from(c.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim()));
        if (childHoldsText) continue;
        const text = (el.textContent || '').trim();
        if (!text) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        blocks.push({ x: r.left, r: r.right, y: r.top, b: r.bottom, text: text.replace(/\s+/g, ' ') });
        if (blocks.length >= 1500) break;
      }
      if (blocks.length < 9) return []; // 至少 3行×2列 才谈得上表格

      blocks.sort((a, b) => a.y - b.y || a.x - b.x);
      const rowClusters: Block[][] = [];
      let cur: Block[] = [];
      let top = 0;
      let bottom = 0;
      const flushRow = (): void => { if (cur.length) rowClusters.push(cur); cur = []; };
      for (const bk of blocks) {
        if (!cur.length) {
          cur = [bk]; top = bk.y; bottom = bk.b;
          continue;
        }
        const overlap = Math.min(bottom, bk.b) - Math.max(top, bk.y);
        if (overlap > 0.5 * Math.min(bk.b - bk.y, bottom - top)) {
          cur.push(bk);
          top = Math.min(top, bk.y);
          bottom = Math.max(bottom, bk.b);
        } else {
          flushRow();
          cur = [bk]; top = bk.y; bottom = bk.b;
        }
      }
      flushRow();

      const headerIdx = rowClusters.findIndex((r) => r.length >= 2);
      if (headerIdx < 0) return [];
      const headerRow = rowClusters[headerIdx];
      const body = rowClusters.slice(headerIdx + 1);
      const bodyBlocks = body.flat();
      if (!bodyBlocks.length) return [];
      const minX = bodyBlocks.reduce((m, b) => Math.min(m, b.x), Infinity);
      const maxX = bodyBlocks.reduce((m, b) => Math.max(m, b.r), -Infinity);

      // 列检测：块 x 区间的覆盖事件扫描，找「零覆盖缝隙」（≥3px）切列。
      // 不能用表头锚点做列边界——表头文字宽度 ≠ 列宽（实测"修改明细"表头 52px，列实际 340px）；
      // 也不能按块左缘聚类——居中单元格每行起点都不同。零覆盖缝隙是数据驱动的真实列分隔。
      // 事件扫描（左缘+1/右缘-1，+1 先于 -1 排序）保证浮点精确，无分桶误差
      const events: Array<{ x: number; d: number }> = [];
      for (const b of bodyBlocks) {
        events.push({ x: b.x, d: 1 }, { x: b.r, d: -1 });
      }
      events.sort((a, b) => a.x - b.x || a.d - b.d);
      const boundsX: number[] = [minX];
      let active = 0;
      let zeroStart = -1;
      for (const ev of events) {
        const prev = active;
        active += ev.d;
        if (prev > 0 && active === 0) zeroStart = ev.x; // 覆盖归零，缝隙开始
        if (prev === 0 && active > 0) {
          // 缝隙结束：内部缝隙（≥3px）是真实列边界；最左侧的空隙是页边距，不算
          if (zeroStart >= 0 && ev.x - zeroStart >= 3 && zeroStart > minX) boundsX.push((zeroStart + ev.x) / 2);
          zeroStart = -1;
        }
      }
      boundsX.push(maxX);
      const colCount = boundsX.length - 1;
      if (colCount < 2) return []; // 无内部缝隙，非多列表格

      const colOf = (bk: Block): number => {
        let best = 0;
        let bestOv = -1;
        for (let i = 0; i < colCount; i++) {
          const a = boundsX[i];
          const r = boundsX[i + 1];
          const ov = Math.min(r, bk.r) - Math.max(a, bk.x);
          if (ov > bestOv) { bestOv = ov; best = i; }
        }
        return best;
      };

      // 逻辑行：首列（最左列）块为记录边界；与上一首列块 y 间距 <25px 视为同格续行（不拆新记录）。
      // 其余块按「相邻首列块 y 的中点」归记录——模块名常在其明细块的垂直居中位置，按区间起点归会错位
      const col0: Block[] = [];
      for (const row of body) for (const bk of row) if (colOf(bk) === 0) col0.push(bk);
      if (!col0.length) return []; // 首列无数据，非「首列驱动」的表格
      col0.sort((a, b) => a.y - b.y);

      const recTops: number[] = [];
      const records: string[][][] = []; // records[记录][列] = 文本片段
      for (const bk of col0) {
        const lastTop = recTops[recTops.length - 1];
        if (!recTops.length || bk.y - lastTop > 25) {
          recTops.push(bk.y);
          records.push(Array.from({ length: colCount }, () => [] as string[]));
        }
        records[records.length - 1][0].push(bk.text);
      }
      const assignRec = (y: number): number => {
        for (let k = 0; k < recTops.length - 1; k++) {
          if (y < (recTops[k] + recTops[k + 1]) / 2) return k;
        }
        return recTops.length - 1;
      };
      for (const row of body) {
        for (const bk of row) {
          const ci = colOf(bk);
          if (ci === 0) continue; // 首列已随锚点入记录
          records[assignRec(bk.y)][ci].push(bk.text);
        }
      }

      const usedCols = new Set<number>();
      let filled = 0;
      records.forEach((rec) => rec.forEach((c, i) => {
        if (c.length) { usedCols.add(i); filled++; }
      }));
      if (usedCols.size < 2) return [];
      if (filled / (records.length * colCount) < 0.3) return []; // 网格占用率过低，多半是普通版式

      // 门槛 3：单元格体积——真实表格的格子很少超过几百字；
      // 原型画布（整页 UI 界面拼贴）会在这里产生塞满整个屏幕文字的巨型“格子”，必须拒绝
      const maxCell = records.reduce(
        (m, rec) => Math.max(m, ...rec.map((c) => c.join('').length)),
        0
      );
      if (maxCell > 600) return [];
      // 门槛 4：页面含 ≥3 张大尺寸内嵌图（宽≥250 且 高≥200 的手机屏截图）→ 这是原型画布，不是数据表
      if (images.filter((im) => im.width >= 250 && im.height >= 200).length >= 3) return [];
      // 门槛 5：平均每格块数 >4 → 文字碎块远多于网格容量，是自由版式
      if (bodyBlocks.length / (records.length * colCount) > 4) return [];

      // 单元格内多块用 <br> 连接：保留原始换行结构（Markdown 表格内换行的标准写法）
      const cellText = (arr: string[]): string => arr.join('<br>').trim();
      const headerCells: string[][] = Array.from({ length: colCount }, () => []);
      for (const bk of headerRow) headerCells[colOf(bk)].push(bk.text.replace(/\s+/g, ' ').trim());
      const headers = headerCells.map((c) => c.join(' ').trim());
      if (!headers.some(Boolean)) return [];
      const rows = records.map((rec) => rec.map(cellText));
      if (rows.length < 2) return [];
      return [{ headers, rows }];
    })();
    // 语义化表格或真 <table> 已命中时，几何重建不再叠加（避免同内容双表）
    if (!tables.length) tables.push(...gridTables);

    // ── 画布型页面空间切分（XY-cut）：无表格、含大图/长文字时，
    //    按空白带把画布切成区块（每块通常对应一个界面/弹窗），输出结构化 sections ──
    const canvasSections = ((): Array<{ x: number; y: number; w: number; h: number; text: string; images: number }> => {
      if (tables.length > 0) return []; // 表格页是文档型内容，不做画布切分
      const bigImgs = images.filter((im) => im.width >= 250 && im.height >= 200).length;
      interface Blk { x: number; r: number; y: number; b: number; text: string }
      const blocks: Blk[] = [];
      for (const el of Array.from(container.querySelectorAll('*'))) {
        if (el.closest('table')) continue;
        const hasDirectText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim());
        if (!hasDirectText) continue;
        const childHoldsText = Array.from(el.children).some((c) =>
          Array.from(c.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim()));
        if (childHoldsText) continue;
        const t = (el.textContent || '').replace(/[ 	]+/g, ' ').trim();
        if (!t) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        blocks.push({ x: r.left, r: r.right, y: r.top, b: r.bottom, text: t });
        if (blocks.length >= 2000) break;
      }
      if (blocks.length < 12) return [];
      const totalChars = blocks.reduce((m, b) => m + b.text.length, 0);
      if (bigImgs < 3 && totalChars < 3000) return []; // 短文档无需切分

      // 画布切分：以大内嵌图（手机屏截图 ≥250×200）为锚点，文字块按就近原则聚类成界面区块。
      // 不用 XY-cut 空白切分——画布上屏幕之间常有跨屏宽块（箭头/连线/宽表格）连通，零覆盖缝隙不可靠；
      // 大图锚点就是界面本身，语义正确且不受跨屏块干扰
      const out: Array<{ x: number; y: number; w: number; h: number; text: string; images: number }> = [];
      const anchors = imgRects.filter((p) => p.w >= 250 && p.h >= 200).map((a) => ({ ...a }));
      if (anchors.length) {
        const distTo = (bk: Blk, a: { x: number; y: number; w: number; h: number }): number => {
          const cx = (bk.x + bk.r) / 2;
          const cy = (bk.y + bk.b) / 2;
          const dx = Math.max(a.x - cx, 0, cx - (a.x + a.w));
          const dy = Math.max(a.y - cy, 0, cy - (a.y + a.h));
          return Math.hypot(dx, dy);
        };
        const clusters = anchors.map(() => [] as Blk[]);
        const scattered: Blk[] = [];
        for (const bk of blocks) {
          let best = 0;
          let bestD = Infinity;
          anchors.forEach((a, i) => {
            const d = distTo(bk, a);
            if (d < bestD) { bestD = d; best = i; }
          });
          if (bestD <= 400) clusters[best].push(bk);
          else scattered.push(bk);
        }
        const order = anchors
          .map((a, i) => ({ a, i }))
          .sort((p, q) => p.a.y - q.a.y || p.a.x - q.a.x);
        for (const { a, i } of order) {
          const texts = clusters[i]
            .sort((p, q) => p.y - q.y || p.x - q.x)
            .map((b) => b.text);
          if (!texts.length) continue;
          out.push({
            x: Math.round(a.x),
            y: Math.round(a.y),
            w: Math.round(a.w),
            h: Math.round(a.h),
            text: texts.join('\n'),
            images: 0,
          });
        }
        if (scattered.length) {
          scattered.sort((p, q) => p.y - q.y || p.x - q.x);
          out.push({
            x: Math.round(scattered[0].x),
            y: Math.round(scattered[0].y),
            w: 0,
            h: 0,
            text: '【画布散落文字，未邻近任何界面截图】\n' + scattered.map((b) => b.text).join('\n'),
            images: 0,
          });
        }
      }
      return out.length ? out : [];
    })();

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
      sections: canvasSections,
    };
  });
}

/**
 * 截取当前页面（分段截图，超长页面自动分段）
 * @param filename - 文件名（不含扩展名）
 * @param pageCacheKey - 页面级缓存键（url+页面名+文字哈希），命中时跳过截图
 */
export async function screenshotPage(
  filename: string,
  pageCacheKey?: string | null
): Promise<ScreenshotResult> {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const frame = await getAxureFrame();
  return await capturePageSegments(filename, frame, pageCacheKey ?? undefined);
}

/**
 * 页面级缓存键：分享链接 + 页面名 + DOM 文字哈希 + 截图方案版本。
 * Axure 为静态导出，文字不变即可认为页面未变，可复用已有截图；
 * 截图分段逻辑变化时递增 CAPTURE_SCHEME_VERSION，旧缓存（旧分段清单）自动失效。
 */
const CAPTURE_SCHEME_VERSION = 'v2';

function pageCacheKeyOf(
  url: string | undefined,
  pageName: string,
  text: string
): string | null {
  if (!url) return null;
  return createHash('md5')
    .update(`${url}::${pageName}::${text}::${CAPTURE_SCHEME_VERSION}`)
    .digest('hex');
}

/**
 * 在目录树中定位分组：叶子名唯一时可用，歧义时返回候选路径清单。
 */
function resolveGroup(
  outline: OutlineNode[],
  name: string
): TreeMatchResult<OutlineNode> {
  return matchTreeTarget(outline, name, 'group');
}

/**
 * 获取指定分组下所有页面的完整内容（含分组节点自身的内容页）
 *
 * CoDesign 分组节点点击后右侧可能显示自身页面（如挂在分组上的说明页），
 * 也可能只是展开/收起目录。策略：先快速点击分组节点探测 iframe 是否切换，
 * 切换且非空白才把分组自身页计入结果，再遍历子页面。
 *
 * @param groupName - 分组名称（如"赛季通行证S2优化/流程图"或叶子名）
 * @param url - 分享链接，用于页面级缓存键
 * @param opts.pageNames - 只处理指定页面（叶子名或完整路径），未命中的名字返回合成错误页
 * @param opts.onProgress - 逐页进度回调（MCP 层转发为 progress 通知）
 */
export async function getGroupPages(
  groupName: string,
  url?: string,
  opts?: { pageNames?: string[]; onProgress?: (message: string) => void }
): Promise<CrawledPage[]> {
  const outline = await getPageOutline();
  const located = resolveGroup(outline, groupName);
  if (!located.ok) throw new Error(located.reason);
  const { target } = located;

  const results: CrawledPage[] = [];

  // 1) 分组节点自身内容探测
  if (target.isGroup) {
    opts?.onProgress?.('探测分组自身内容页');
    const before = await extractPageText();
    const selfNav = await navigateToPageByIndex(target.domIndex, { quick: true });
    if (selfNav.ok) {
      const { text, tables, images, sections } = await extractPageText();
      // URL 未切换但文字变化也算切换（防同 URL 重渲染），空白页（无文字无图）不计入
      const switched = selfNav.frameChanged || text !== before.text;
      if (switched && (text.trim() || images.length > 0)) {
        const screenshotResult = await screenshotPage(
          `${groupName}_分组页`,
          pageCacheKeyOf(url, target.path, text)
        );
        results.push({
          pageName: target.name,
          text,
          tables,
          images,
          sections,
          segments: screenshotResult.segments,
          segmentCount: screenshotResult.segmentCount,
          isSegmented: screenshotResult.isSegmented,
          totalHeight: screenshotResult.totalHeight,
        });
      }
    }
  }

  // 2) 遍历分组下的子页面
  let pages: { name: string; path: string; domIndex: number }[];
  if (!target.isGroup) {
    // 传入的其实是页面名，按单页处理
    pages = [{ name: target.name, path: target.path, domIndex: target.domIndex }];
  } else {
    // domIndex 是原始 DOM 序号（可能含无文字节点），遍历须用大纲数组下标，两者不可混用
    const targetIndex = outline.indexOf(target);
    const groupLevel = target.level;
    pages = [];
    for (let i = targetIndex + 1; i < outline.length; i++) {
      const item = outline[i];
      if (item.level <= groupLevel) break;
      if (!item.isGroup) pages.push({ name: item.name, path: item.path, domIndex: item.domIndex });
    }
  }

  // pageNames 过滤（叶子名或完整路径均可匹配）；未命中的名字收集起来，最后生成合成错误页
  let unmatchedNames: string[] = [];
  let availableNames: string[] = [];
  if (opts?.pageNames?.length) {
    availableNames = pages.map((p) => p.name);
    const wanted = [...new Set(opts.pageNames.map((n) => n.trim()).filter(Boolean))];
    const matchedWanted = new Set<string>();
    pages = pages.filter((p) => {
      const hit = wanted.find((w) => w === p.name || w === p.path);
      if (hit) matchedWanted.add(hit);
      return hit !== undefined;
    });
    unmatchedNames = wanted.filter((w) => !matchedWanted.has(w));
  }

  opts?.onProgress?.(`开始抓取 ${pages.length} 个页面`);
  let done = 0;
  for (const pageInfo of pages) {
    done++;
    opts?.onProgress?.(`抓取页面 ${done}/${pages.length}：${pageInfo.name}`);
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
        totalHeight: 0,
        error: describeNavigationFailure(nav),
      });
      continue;
    }

    const { text, tables, images, sections } = await extractPageText();
    const screenshotResult = await screenshotPage(
      `${groupName}_${pageInfo.name}`,
      pageCacheKeyOf(url, pageInfo.name, text)
    );

    results.push({
      pageName: pageInfo.name,
      text,
      tables,
      images,
      sections,
      segments: screenshotResult.segments,
      segmentCount: screenshotResult.segmentCount,
      isSegmented: screenshotResult.isSegmented,
      totalHeight: screenshotResult.totalHeight,
    });
  }

  // pageNames 里未命中的名字合成错误页返回（附可用页面清单），Agent 据此纠正后重调
  for (const w of unmatchedNames) {
    results.push({
      pageName: w,
      text: '',
      tables: [],
      images: [],
      segments: [],
      segmentCount: 0,
      isSegmented: false,
      totalHeight: 0,
      error: `分组「${groupName}」下未找到页面「${w}」，可用页面：${availableNames.join('、') || '（该分组下没有独立页面）'}`,
    });
  }

  return results;
}

/**
 * 获取单个页面的完整内容
 * @param pageName - 页面叶子名或完整路径（父分组/页面名，用于同名页面消歧）
 * @param url - 分享链接，用于页面级缓存键
 */
export async function getSinglePage(pageName: string, url?: string): Promise<CrawledPage> {
  const outline = await getPageOutline();
  const located = matchTreeTarget(outline, pageName, 'any');
  if (!located.ok) throw new Error(located.reason);

  const nav = await navigateToPageByIndex(located.target.domIndex);
  if (!nav.ok) throw new Error(describeNavigationFailure(nav));

  const { text, tables, images, sections } = await extractPageText();
  const screenshotResult = await screenshotPage(
    pageName,
    pageCacheKeyOf(url, located.target.path, text)
  );

  return {
    pageName,
    text,
    tables,
    images,
    sections,
    segments: screenshotResult.segments,
    segmentCount: screenshotResult.segmentCount,
    isSegmented: screenshotResult.isSegmented,
    totalHeight: screenshotResult.totalHeight,
  };
}
