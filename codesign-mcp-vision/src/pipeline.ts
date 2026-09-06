/**
 * 解析流水线编排模块
 * 把 crawler 产出的页面数据，经「类型判定 → 缓存查询 → VLM 解析 → 合并」变成结构化结果。
 * MCP 入口与命令行脚本共用同一份实现，避免两处逻辑漂移。
 */
import {
  isVLMConfigured,
  detectPageType,
  getVlmVersion,
  hasParseFailure,
  analyzeSegmentsParallel,
  analyzeSegmentsGlobal,
} from './vlm.js';
import { mergePageResult } from './merger.js';
import { getCache, setCache } from './cache.js';
import type {
  CacheKeyParams,
  CrawledPage,
  MergedPage,
  PageType,
  ProcessOptions,
  SegmentTask,
  VlmResult,
} from './types.js';

function pageCacheKey(pageData: CrawledPage, url: string, type: PageType): CacheKeyParams {
  return {
    url,
    pageName: pageData.pageName,
    imagePaths: pageData.segments || [],
    type,
    vlmVersion: getVlmVersion(),
  };
}

// 把内嵌原型图元数据拼进 VLM 参考文字，让模型感知页面中的设计图/插画
function pageTextWithImages(pageData: CrawledPage): string {
  const imgs = pageData.images || [];
  if (!imgs.length) return pageData.text;
  const lines = imgs
    .map((im) => `- ${im.width}x${im.height}${im.alt ? ` alt:${im.alt}` : ''}`)
    .join('\n');
  return `${pageData.text || ''}\n\n[该页面包含 ${imgs.length} 张内嵌原型图]\n${lines}`;
}

function segmentTasks(pageData: CrawledPage, type: PageType, context?: string): SegmentTask[] {
  const segments = pageData.segments || [];
  return segments.map((imagePath, i) => ({
    imagePath,
    type,
    segmentIndex: i + 1,
    totalSegments: segments.length,
    pageText: pageTextWithImages(pageData),
    context,
  }));
}

function failedResult(pageData: CrawledPage, type: PageType, reason: string): MergedPage {
  return {
    pageName: pageData.pageName,
    type,
    domText: '',
    tables: [],
    images: pageData.images || [],
    vlmResult: {},
    warnings: [reason],
    _segmentCount: 0,
    _hasVLM: false,
  };
}

function finalize(
  pageData: CrawledPage,
  type: PageType,
  vlmSegments: VlmResult[]
): MergedPage {
  return mergePageResult({
    pageName: pageData.pageName,
    domText: pageData.text || '',
    domTables: pageData.tables || [],
    images: pageData.images || [],
    sections: pageData.sections,
    vlmSegments,
    type,
    screenshotCount: pageData.segmentCount || 0,
  });
}

/**
 * 处理单个页面
 * @param pageData - crawler 产出的页面数据
 * @param url - 分享链接
 * @param options - { vlmEnabled }
 */
export async function processPage(
  pageData: CrawledPage,
  url: string,
  { vlmEnabled = true, context }: { vlmEnabled?: boolean; context?: string } = {}
): Promise<MergedPage> {
  if (pageData.error) return failedResult(pageData, 'page', pageData.error);

  const type = detectPageType(pageData.pageName, pageData.text);
  let vlmSegments: VlmResult[] = [];

  if (vlmEnabled && isVLMConfigured() && pageData.segments?.length > 0) {
    const key = pageCacheKey(pageData, url, type);
    const cached = getCache(key);
    if (cached) {
      vlmSegments = cached;
    } else {
      vlmSegments = await analyzeSegmentsParallel(pageData.segments, type, {
        pageText: pageData.text,
        context,
      });
      if (!hasParseFailure(vlmSegments)) setCache(key, vlmSegments);
    }
  }

  return finalize(pageData, type, vlmSegments);
}

/** 批量处理时的中间态：记录每页的类型、缓存键与分段在全局队列中的区间 */
interface PreparedPage {
  pageData: CrawledPage;
  type: PageType;
  context?: string;
  key?: CacheKeyParams;
  cached?: VlmResult[] | null;
  failed?: boolean;
  vlmSegments: VlmResult[] | null;
  taskStart?: number;
  taskEnd?: number;
}

/**
 * 批量处理分组下的所有页面
 *
 * 先统一查缓存，再把所有未命中的分段摊平成一个全局队列并发提交，
 * 避免「页内并发、页间串行」在每页末尾浪费并发度。
 */
export async function processPages(
  pagesData: CrawledPage[],
  url: string,
  options: ProcessOptions = {}
): Promise<MergedPage[]> {
  const { vlmEnabled = true, concurrency, onPageDone, onProgress, contextFor } = options;

  const prepared: PreparedPage[] = pagesData.map((pageData) => {
    if (pageData.error) return { pageData, type: 'page', failed: true, vlmSegments: [] };

    const type = detectPageType(pageData.pageName, pageData.text);
    if (!vlmEnabled || !isVLMConfigured() || !pageData.segments?.length) {
      return { pageData, type, vlmSegments: [] };
    }

    const key = pageCacheKey(pageData, url, type);
    const cached = getCache(key);
    return { pageData, type, context: contextFor?.(pageData), key, cached, vlmSegments: cached || null };
  });

  const tasks: SegmentTask[] = [];
  prepared.forEach((item) => {
    if (item.failed || item.cached || !item.pageData.segments?.length) return;
    item.taskStart = tasks.length;
    tasks.push(...segmentTasks(item.pageData, item.type, item.context));
    item.taskEnd = tasks.length;
  });

  if (tasks.length > 0) {
    const results = await analyzeSegmentsGlobal(tasks, {
      concurrency,
      onProgress: (done, total) => onProgress?.(`VLM 解析分段 ${done}/${total}`),
    });
    prepared.forEach((item) => {
      if (item.taskStart === undefined) return;
      const segments = results.slice(item.taskStart, item.taskEnd);
      item.vlmSegments = segments;
      // 失败的段落不写缓存，否则一次网络抖动会被固化，后续重试永远拿不到正确结果
      if (!hasParseFailure(segments) && item.key) setCache(item.key, segments);
    });
  }

  return prepared.map((item) => {
    const result = item.failed
      ? failedResult(item.pageData, item.type, item.pageData.error ?? '页面爬取失败')
      : finalize(item.pageData, item.type, item.vlmSegments || []);

    onPageDone?.(item.pageData.pageName, {
      cached: !!item.cached,
      segments: result._segmentCount || 0,
      result,
    });
    return result;
  });
}
