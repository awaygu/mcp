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
  ImageAnalysis,
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
  vlmSegments: VlmResult[],
  imageResults: VlmResult[] = []
): MergedPage {
  const imageAnalysis = imageResults.length
    ? toImageAnalysis(pageData, imageResults)
    : undefined;
  return mergePageResult({
    pageName: pageData.pageName,
    domText: pageData.text || '',
    domTables: pageData.tables || [],
    images: pageData.images || [],
    imageAnalysis,
    sections: pageData.sections,
    blocks: pageData.blocks,
    flow: pageData.flow ?? null,
    vlmSegments,
    type,
    screenshotCount: pageData.segmentCount || 0,
  });
}

/**
 * 内嵌图解析任务：每个内容图一个任务，type='image'（专用 prompt，只提取图内文字）。
 * 与整页分段分开排队，结果也单独收集——不能混进 vlmSegments，否则会被当成页面结构处理。
 */
function imageTasks(pageData: CrawledPage, context?: string): SegmentTask[] {
  const shots = (pageData.imageShots || []).filter((im) => im.localPath);
  return shots.map((im, i) => ({
    imagePath: im.localPath as string,
    type: 'image' as PageType,
    segmentIndex: i + 1,
    totalSegments: shots.length,
    context,
  }));
}

/** 把图片解析结果归并成结构化产物；全占位且无文字的图不输出，避免噪音 */
function toImageAnalysis(pageData: CrawledPage, results: VlmResult[]): ImageAnalysis[] {
  const shots = (pageData.imageShots || []).filter((im) => im.localPath);
  return shots
    .map((im, i) => {
      const r = results[i] || {};
      return {
        src: im.src,
        localPath: im.localPath as string,
        summary: r.summary || '',
        texts: r.texts || [],
        isPlaceholder: r.is_placeholder === true,
        note: r.note || '',
        // _parseError 是布尔标记，必须显式转成文案：否则该图会变成
        // 「summary/texts/error 全空」被下面的 filter 静默丢掉，
        // 文档看上去已覆盖全部内嵌图，实际漏掉的可能正是关键规则图
        error: r._error || (r._parseError ? 'VLM 返回内容无法解析为结构化结果' : undefined),
      };
    })
    .filter((a) => a.texts.length > 0 || a.summary || a.error);
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
  let imageResults: VlmResult[] = [];

  if (vlmEnabled && isVLMConfigured()) {
    if (pageData.segments?.length > 0) {
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
    // 内嵌图定向解析：只对内容图排队，与整页分段互不干扰。
    // 同样独立缓存——与页面分段命中与否无关，否则重复调用会反复烧 VLM 额度
    const imgPaths = (pageData.imageShots || [])
      .map((im) => im.localPath)
      .filter((p): p is string => !!p);
    const imageKey: CacheKeyParams | undefined = imgPaths.length
      ? { url, pageName: pageData.pageName, imagePaths: imgPaths, type: 'image', vlmVersion: getVlmVersion() }
      : undefined;
    const imageCached = imageKey ? getCache(imageKey) : null;
    if (imageCached) {
      imageResults = imageCached;
    } else {
      const imgTasks = imageTasks(pageData, context);
      if (imgTasks.length) {
        imageResults = await analyzeSegmentsGlobal(imgTasks);
        if (!hasParseFailure(imageResults) && imageKey) setCache(imageKey, imageResults);
      }
    }
  }

  return finalize(pageData, type, vlmSegments, imageResults);
}

/** 批量处理时的中间态：记录每页的类型、缓存键与分段在全局队列中的区间 */
interface PreparedPage {
  pageData: CrawledPage;
  type: PageType;
  context?: string;
  key?: CacheKeyParams;
  cached?: VlmResult[] | null;
  failed?: boolean;
  /** 跳过 VLM（未启用/未配置/无截图）：必须显式标记，否则下面摊平任务时会把它当成待解析页 */
  skipVlm?: boolean;
  vlmSegments: VlmResult[] | null;
  taskStart?: number;
  taskEnd?: number;
  /** 内嵌图任务在全局队列中的区间（与页面分段分开记录，结果不混用） */
  imageTaskStart?: number;
  imageTaskEnd?: number;
  imageResults?: VlmResult[];
  /** 内嵌图独立缓存键（与页面分段缓存分开，见下方 processPages 说明） */
  imageKey?: CacheKeyParams;
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
      return { pageData, type, vlmSegments: [], skipVlm: true };
    }

    // 内嵌图与页面分段是两套独立缓存：页面缓存只存 vlmSegments，
    // 若让「页面缓存命中」连带跳过内嵌图任务，第二次跑就会静默丢掉「内嵌图文字」
    // （实测：首次跑有 20 张图与 3 条数值冲突，缓存命中后再跑全部消失）。
    const imgPaths = (pageData.imageShots || [])
      .map((im) => im.localPath)
      .filter((p): p is string => !!p);
    const imageKey: CacheKeyParams | undefined = imgPaths.length
      ? { url, pageName: pageData.pageName, imagePaths: imgPaths, type: 'image', vlmVersion: getVlmVersion() }
      : undefined;
    const imageCached = imageKey ? getCache(imageKey) : null;

    const key = pageCacheKey(pageData, url, type);
    const cached = getCache(key);
    return {
      pageData,
      type,
      context: contextFor?.(pageData),
      key,
      cached,
      vlmSegments: cached || null,
      imageKey,
      imageResults: imageCached || undefined,
    };
  });

  const tasks: SegmentTask[] = [];
  prepared.forEach((item) => {
    if (item.skipVlm || item.failed) return;

    // 内嵌图单独排队：即使该页没有分段截图（如表格页），内容图依然值得解析。
    // 是否排队只取决于图自己的缓存，与页面分段缓存无关。
    if (item.imageKey && !item.imageResults?.length) {
      const imgs = imageTasks(item.pageData, item.context);
      if (imgs.length) {
        item.imageTaskStart = tasks.length;
        tasks.push(...imgs);
        item.imageTaskEnd = tasks.length;
      }
    }

    if (item.cached) return; // 分段已缓存，不再排段
    if (item.pageData.segments?.length) {
      item.taskStart = tasks.length;
      tasks.push(...segmentTasks(item.pageData, item.type, item.context));
      item.taskEnd = tasks.length;
    }
  });

  if (tasks.length > 0) {
    const results = await analyzeSegmentsGlobal(tasks, {
      concurrency,
      onProgress: (done, total) => onProgress?.(`VLM 解析分段 ${done}/${total}`),
    });
    prepared.forEach((item) => {
      if (item.taskStart !== undefined && item.taskEnd !== undefined) {
        const segments = results.slice(item.taskStart, item.taskEnd);
        item.vlmSegments = segments;
        // 失败的段落不写缓存，否则一次网络抖动会被固化，后续重试永远拿不到正确结果
        if (!hasParseFailure(segments) && item.key) setCache(item.key, segments);
      }
      if (item.imageTaskStart !== undefined && item.imageTaskEnd !== undefined) {
        item.imageResults = results.slice(item.imageTaskStart, item.imageTaskEnd);
        // 失败的图不写缓存，否则一次网络抖动会被固化，后续重试永远拿不到正确结果
        if (!hasParseFailure(item.imageResults) && item.imageKey) {
          setCache(item.imageKey, item.imageResults);
        }
      }
    });
  }

  return prepared.map((item) => {
    const result = item.failed
      ? failedResult(item.pageData, item.type, item.pageData.error ?? '页面爬取失败')
      : finalize(item.pageData, item.type, item.vlmSegments || [], item.imageResults || []);

    onPageDone?.(item.pageData.pageName, {
      cached: !!item.cached,
      segments: result._segmentCount || 0,
      result,
    });
    return result;
  });
}
