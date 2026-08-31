/**
 * Playwright 浏览器管理模块
 * 负责启动浏览器、创建页面、管理生命周期
 */
import { chromium } from 'playwright';

let browser = null;
let page = null;

/**
 * 启动浏览器并创建新页面
 * @param {object} options
 * @param {boolean} options.headless - 是否无头模式，默认 true
 * @param {number} options.timeout - 超时时间 ms，默认 30000
 * @returns {Promise<import('playwright').Page>}
 */
export async function launchBrowser({ headless = true, timeout = 30000 } = {}) {
  if (browser && page) return page;

  browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  context.setDefaultTimeout(timeout);
  page = await context.newPage();

  // 屏蔽不必要的资源，加速加载
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      // 图片需要保留用于截图和 VLM 分析，不拦截
      return route.continue();
    }
    return route.continue();
  });

  return page;
}

/**
 * 获取当前页面实例
 * @returns {import('playwright').Page | null}
 */
export function getPage() {
  return page;
}

/**
 * 关闭浏览器
 */
export async function closeBrowser() {
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

/**
 * 等待页面网络空闲
 * @param {number} timeout - 超时 ms
 */
export async function waitForNetworkIdle(timeout = 10000) {
  if (!page) return;
  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch {
    // networkidle 可能不触发，降级为等待固定时间
    await page.waitForTimeout(2000);
  }
}
