/**
 * 通用小工具
 */
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * 统一取出错误信息。strict 模式下 catch 变量是 unknown，
 * 直接用 err.message 会编译失败，这里做一次收口。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * 从当前模块位置向上逐级找 package.json。
 * tsx 直接跑源码（src/）与 tsc 编译产物（dist/src/）相对包根的深度不同，
 * 逐级上溯可以避免写死相对路径。
 */
function findPackageJson(fromUrl: string): string | null {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 读取本包 package.json，失败返回空对象 */
export function readPackageJson(fromUrl: string): Record<string, unknown> {
  const file = findPackageJson(fromUrl);
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 包名版本，取不到时回落到兜底值 */
export function packageVersion(fromUrl: string, fallback = '0.0.0'): string {
  const version = readPackageJson(fromUrl).version;
  return typeof version === 'string' && version ? version : fallback;
}

/** 等待固定毫秒 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把任意文本收敛成安全文件名（保留中英文、数字、下划线、短横线） */
export function safeName(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
}

/** 字节数格式化 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
