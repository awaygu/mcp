/**
 * 缓存模块
 * 避免重复调用 VLM，基于截图文件内容哈希做缓存
 *
 * 缓存键：url + pageName + 截图文件 md5
 * 缓存值：VLM 解析结果 JSON
 * 存储位置：.codesign-mcp/cache/{hash}.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.codesign-mcp', 'cache');

/**
 * 确保缓存目录存在
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * 计算文件的 md5 哈希
 * @param {string} filePath
 * @returns {string}
 */
function fileHash(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return createHash('md5').update(data).digest('hex');
  } catch {
    return '';
  }
}

/**
 * 生成缓存键
 * @param {object} params
 * @param {string} params.url - 分享链接
 * @param {string} params.pageName - 页面名称
 * @param {string[]} params.imagePaths - 截图文件路径数组
 * @param {string} params.type - 页面类型
 * @returns {string} 缓存键（md5）
 */
function generateCacheKey({ url, pageName, imagePaths = [], type }) {
  const hashes = imagePaths.map((p) => fileHash(p)).filter(Boolean);
  const raw = `${url}::${pageName}::${type}::${hashes.join(',')}`;
  return createHash('md5').update(raw).digest('hex');
}

/**
 * 获取缓存
 * @param {object} params - 同 generateCacheKey
 * @returns {object|null} 缓存的解析结果，未命中返回 null
 */
export function getCache(params) {
  ensureCacheDir();
  const key = generateCacheKey(params);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  try {
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      return data;
    }
  } catch (err) {
    console.warn('读取缓存失败:', err.message);
  }
  return null;
}

/**
 * 写入缓存
 * @param {object} params - 同 generateCacheKey
 * @param {object} value - 要缓存的解析结果
 */
export function setCache(params, value) {
  ensureCacheDir();
  const key = generateCacheKey(params);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(value, null, 2), 'utf-8');
  } catch (err) {
    console.warn('写入缓存失败:', err.message);
  }
}

/**
 * 检查缓存是否命中
 * @param {object} params
 * @returns {boolean}
 */
export function hasCache(params) {
  return getCache(params) !== null;
}

/**
 * 清空缓存
 */
export function clearCache() {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('清空缓存失败:', err.message);
  }
}

/**
 * 获取缓存统计
 * @returns {{total: number, size: number}}
 */
export function cacheStats() {
  ensureCacheDir();
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
    let totalSize = 0;
    files.forEach((f) => {
      const stat = fs.statSync(path.join(CACHE_DIR, f));
      totalSize += stat.size;
    });
    return { total: files.length, size: totalSize };
  } catch {
    return { total: 0, size: 0 };
  }
}
