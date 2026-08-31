/**
 * 分段截图模块
 * 负责对超长页面进行分段滚动截图，避免单张截图截不全
 *
 * 策略：
 * - 页面高度 <= 视口 * 1.5：单张截图
 * - 页面高度 > 视口 * 1.5：分段滚动截图，段间重叠 100px
 * - 每段截图后等待渲染稳定
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getPage } from './browser.js';

const SCREENSHOT_DIR = path.join(process.cwd(), '.codesign-mcp', 'screenshots');
const PAGE_CACHE_DIR = path.join(process.cwd(), '.codesign-mcp', 'pagecache');

// 分段截图参数
const VIEWPORT_HEIGHT = 1080;
const OVERLAP = 100; // 段间重叠像素
const RENDER_WAIT = 500; // 滚动后等待渲染时间 ms
const LONG_PAGE_THRESHOLD = 1.5; // 超过视口 1.5 倍才分段

/**
 * 确保截图目录存在
 */
function ensureScreenshotDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

/**
 * 获取安全的文件名
 */
function safeName(name) {
  return name.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
}

/**
 * 检测 iframe 内的滚动容器
 * @param {import('playwright').Frame} frame
 * @returns {Promise<string>} 滚动容器的 selector（用于 evaluate）
 */
async function detectScrollContainer(frame) {
  return await frame.evaluate(() => {
    // 优先检测 body 是否可滚动
    const bodyScrollable =
      document.body.scrollHeight > window.innerHeight + 50;
    if (bodyScrollable) {
      return 'window';
    }
    // 检测内部可滚动 div
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      const style = window.getComputedStyle(div);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.scrollHeight > div.clientHeight + 50
      ) {
        // 找到第一个可滚动的 div，用 class 或 id 标识
        const identifier = div.id
          ? `#${div.id}`
          : div.className
          ? `.${div.className.split(' ')[0]}`
          : null;
        if (identifier) return identifier;
      }
    }
    return 'window'; // 默认 window
  });
}

/**
 * 获取滚动容器的总高度和当前滚动位置
 * @param {import('playwright').Frame} frame
 * @param {string} containerSelector
 * @returns {Promise<{scrollHeight: number, scrollTop: number, clientHeight: number}>}
 */
async function getScrollInfo(frame, containerSelector) {
  return await frame.evaluate((selector) => {
    if (selector === 'window') {
      return {
        scrollHeight: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        ),
        scrollTop: window.scrollY || window.pageYOffset || 0,
        clientHeight: window.innerHeight,
      };
    }
    const el = document.querySelector(selector);
    if (!el) {
      return { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
    }
    return {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    };
  }, containerSelector);
}

/**
 * 滚动到指定位置
 * @param {import('playwright').Frame} frame
 * @param {string} containerSelector
 * @param {number} scrollTop
 */
async function scrollTo(frame, containerSelector, scrollTop) {
  await frame.evaluate(
    ({ selector, top }) => {
      if (selector === 'window') {
        window.scrollTo(0, top);
      } else {
        const el = document.querySelector(selector);
        if (el) el.scrollTop = top;
      }
    },
    { selector: containerSelector, top: scrollTop }
  );
}

/**
 * 截取 iframe 当前可见区域
 * @param {string} filepath - 输出文件路径
 * @returns {Promise<boolean>} 是否成功
 */
async function captureIframeVisible(filepath) {
  const page = getPage();
  if (!page) return false;

  const iframeEl = await page.$('.axure-container iframe');
  if (!iframeEl) return false;

  const box = await iframeEl.boundingBox();
  if (!box || box.width < 10 || box.height < 10) return false;

  try {
    await page.screenshot({
      path: filepath,
      clip: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      animations: 'disabled',
    });
    return true;
  } catch (err) {
    console.error('分段截图失败:', err.message);
    return false;
  }
}

/**
 * 读取页面级缓存（跳过重复截图）
 * 键 = md5(url + 页面名 + DOM 文字哈希)，值 = 分段截图结果
 */
function readPageCache(key) {
  try {
    const file = path.join(PAGE_CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // 截图文件可能被手动清理，缺任何一个都视为失效
    if (!data.segments?.length || !data.segments.every((p) => fs.existsSync(p))) return null;
    return data;
  } catch {
    return null;
  }
}

function writePageCache(key, result) {
  try {
    if (!fs.existsSync(PAGE_CACHE_DIR)) {
      fs.mkdirSync(PAGE_CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(PAGE_CACHE_DIR, `${key}.json`), JSON.stringify(result), 'utf-8');
  } catch (err) {
    console.warn('写入页面缓存失败:', err.message);
  }
}

/**
 * 分段截取当前页面（Axure iframe 内容）
 * @param {string} filename - 基础文件名（不含扩展名）
 * @param {import('playwright').Frame} frame - Axure iframe
 * @param {string} [pageCacheKey] - 页面级缓存键，命中且截图文件齐全时直接复用
 * @returns {Promise<{segments: string[], totalHeight: number, segmentCount: number, isSegmented: boolean}>}
 */
export async function capturePageSegments(filename, frame, pageCacheKey) {
  if (pageCacheKey) {
    const cached = readPageCache(pageCacheKey);
    if (cached) return cached;
  }

  ensureScreenshotDir();
  const finish = (result) => {
    if (pageCacheKey && result.segments.length) writePageCache(pageCacheKey, result);
    return result;
  };

  // 文件名加当前页面 URL 哈希前缀：避免不同分享链接的同名页面覆盖彼此的截图
  const pageUrl = getPage()?.url() || '';
  const urlKey = pageUrl ? createHash('md5').update(pageUrl).digest('hex').slice(0, 8) : 'nolink';
  const baseName = `${urlKey}_${safeName(filename)}`;

  if (!frame) {
    // 没有 iframe，降级为单张全页截图
    const page = getPage();
    const filepath = path.join(SCREENSHOT_DIR, `${baseName}.png`);
    if (page) {
      await page.screenshot({ path: filepath, fullPage: true, animations: 'disabled' });
    }
    return finish({ segments: [filepath], totalHeight: 0, segmentCount: 1, isSegmented: false });
  }

  // 检测滚动容器
  const containerSelector = await detectScrollContainer(frame);

  // 获取滚动信息
  const scrollInfo = await getScrollInfo(frame, containerSelector);
  const { scrollHeight, clientHeight } = scrollInfo;

  // 短页面：单张截图
  if (scrollHeight <= clientHeight * LONG_PAGE_THRESHOLD || scrollHeight <= VIEWPORT_HEIGHT) {
    const filepath = path.join(SCREENSHOT_DIR, `${baseName}.png`);
    // 滚动到顶部
    await scrollTo(frame, containerSelector, 0);
    await new Promise((r) => setTimeout(r, RENDER_WAIT));
    const ok = await captureIframeVisible(filepath);
    if (!ok) {
      // 降级：全页截图
      const page = getPage();
      if (page) await page.screenshot({ path: filepath, fullPage: true, animations: 'disabled' });
    }
    return finish({
      segments: [filepath],
      totalHeight: scrollHeight,
      segmentCount: 1,
      isSegmented: false,
    });
  }

  // 长页面：分段截图
  const segments = [];
  const segmentHeight = clientHeight > 0 ? clientHeight : VIEWPORT_HEIGHT;
  const step = Math.max(segmentHeight - OVERLAP, 100);

  let currentScroll = 0;
  let segmentIndex = 0;

  while (currentScroll < scrollHeight) {
    // 滚动到当前位置
    await scrollTo(frame, containerSelector, currentScroll);
    await new Promise((r) => setTimeout(r, RENDER_WAIT));

    // 截图
    const segFilepath = path.join(
      SCREENSHOT_DIR,
      `${baseName}_part${String(segmentIndex + 1).padStart(2, '0')}.png`
    );
    const ok = await captureIframeVisible(segFilepath);
    if (ok) {
      segments.push(segFilepath);
    } else {
      console.warn(`分段 ${segmentIndex + 1} 截图失败，跳过`);
    }

    segmentIndex++;
    currentScroll += step;

    // 安全限制：最多 20 段
    if (segmentIndex >= 20) break;
  }

  // 滚动回顶部
  await scrollTo(frame, containerSelector, 0);

  return finish({
    segments,
    totalHeight: scrollHeight,
    segmentCount: segments.length,
    isSegmented: segments.length > 1,
  });
}

/**
 * 单张截图（兼容旧接口，内部调用分段截图）
 * @param {string} filename
 * @param {import('playwright').Frame} [frame]
 * @returns {Promise<string>} 第一张截图的路径
 */
export async function captureSinglePage(filename, frame) {
  const result = await capturePageSegments(filename, frame);
  return result.segments[0] || '';
}
