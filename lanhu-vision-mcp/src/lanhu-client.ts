// lanhu-client.ts — 蓝湖官方 API 客户端（Cookie 直调，无需浏览器）
//
// GET /api/project/image → versions[0].json_url（标注数据）+ detail.url（封面图）
// GET {json_url} → Figma JSON，复用 normalizeSketch 解析
// GET /api/project/project_sectors → 分组列表；GET /api/project/images → 设计稿 name↔id 映射

import { readFileSync } from 'node:fs';
import { normalizeSketch } from './normalize.js';
import type { Credentials, DesignLayer, DesignMeta, DesignResult, SectorInfo } from './types.js';

const LANHU_API_BASE = 'https://lanhuapp.com';

function loadCookie(storageStatePath: string): string {
  const state = JSON.parse(readFileSync(storageStatePath, 'utf8'));
  return (state.cookies || []).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
}

function parseLanhuUrl(url: string): { projectId: string | null; imageId: string | null; teamId: string } {
  const pick = (name: string): string | null => {
    const m = new RegExp(`[?&]${name}=([a-f0-9-]+)`, 'i').exec(url);
    return m ? m[1] : null;
  };
  return {
    projectId: pick('project_id') || pick('pid'),
    imageId: pick('image_id'),
    teamId: pick('tid') || '0',
  };
}

function resolveCookie(opts: Credentials): string {
  const cookie = opts.cookie || (opts.storageState ? loadCookie(opts.storageState) : '');
  if (!cookie) throw new Error('需要蓝湖登录凭证：传 cookie 或 storageState 路径');
  return cookie;
}

function apiHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://lanhuapp.com/web/',
  };
}

// 读单个设计稿（按 imageId）
async function fetchDesignByImageId(
  imageId: string,
  projectId: string,
  cookie: string,
  opts: { needCover?: boolean }
): Promise<DesignResult> {
  const headers = apiHeaders(cookie);

  // 1) 拿详情（封面图 url + json_url）
  const detailRes = await fetch(`${LANHU_API_BASE}/api/project/image?pid=${projectId}&image_id=${imageId}`, { headers });
  const detailJson = await detailRes.json();
  const detail = detailJson?.result || detailJson?.data || {};
  const versions: any[] = detail.versions || [];
  const jsonUrl = versions[0]?.json_url;

  // 2) 拿标注数据解析图层树
  let layers: DesignLayer[] = [];
  let meta: DesignMeta = { rawLayerCount: 0, totalLayerCount: 0 };
  let canvasWidth: number = detail.width || 0;
  let canvasHeight: number = detail.height || 0;
  if (jsonUrl) {
    const jsonRes = await fetch(jsonUrl, { headers });
    const json = await jsonRes.json();
    const norm = normalizeSketch(json);
    layers = norm.layers;
    meta = norm.meta;
    // 画布尺寸取 artboard.frame（图层坐标基准）；detail.width 是蓝湖缩放后的显示尺寸
    const ab = json?.artboard;
    if (ab?.frame) {
      canvasWidth = Math.round(Number(ab.frame.width || 0)) || canvasWidth;
      canvasHeight = Math.round(Number(ab.frame.height || 0)) || canvasHeight;
    }
  }

  // 3) 拿封面图（完整设计截图，仅 needCover 时下载）
  let coverImageBase64: string | undefined;
  if (opts.needCover) {
    const coverUrl = detail.url || versions[0]?.url;
    if (coverUrl) {
      const imgRes = await fetch(coverUrl, { headers: { Cookie: cookie, Referer: 'https://lanhuapp.com/' } });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        coverImageBase64 = buf.toString('base64');
      }
    }
  }

  return {
    source: 'api',
    name: detail.name,
    viewport: { width: canvasWidth, height: canvasHeight },
    layers,
    meta: { ...meta, docName: detail.name ?? meta.docName },
    ...(coverImageBase64 ? { coverImageBase64 } : {}),
  };
}

// 读单个设计稿（从 URL）
export async function fetchDesignViaApi(
  url: string,
  opts: Credentials & { needCover?: boolean }
): Promise<DesignResult> {
  const { projectId, imageId } = parseLanhuUrl(url);
  if (!projectId) throw new Error('无法从 URL 提取 project_id/pid');
  if (!imageId) throw new Error('无法从 URL 提取 image_id');
  const cookie = resolveCookie(opts);
  const r = await fetchDesignByImageId(imageId, projectId, cookie, opts);
  return { ...r, url };
}

// 列项目下所有分组（含每个分组的稿名 + image_id）
export async function listSectors(
  url: string,
  opts: Credentials
): Promise<{ projectId: string; sectorCount: number; sectors: SectorInfo[] }> {
  const { projectId, teamId } = parseLanhuUrl(url);
  if (!projectId) throw new Error('无法从 URL 提取 project_id/pid');
  const cookie = resolveCookie(opts);
  const headers = apiHeaders(cookie);

  const sRes = await fetch(`${LANHU_API_BASE}/api/project/project_sectors?project_id=${projectId}`, { headers });
  const sJson = await sRes.json();
  const sectors: any[] = sJson?.data?.sectors || sJson?.result?.sectors || [];

  const dRes = await fetch(`${LANHU_API_BASE}/api/project/images?project_id=${projectId}&team_id=${teamId}&dds_status=1`, { headers });
  const dJson = await dRes.json();
  const images: any[] = dJson?.data?.images || dJson?.data?.list || dJson?.data || [];
  const nameMap = new Map<string, string>();
  for (const im of images) {
    const id = im.image_id || im.id;
    if (id) nameMap.set(id, im.name || im.image_name || id);
  }

  return {
    projectId,
    sectorCount: sectors.length,
    sectors: sectors.map((s) => ({
      id: s.id,
      name: s.name,
      designCount: (s.images || []).length,
      designs: (s.images || []).map((iid: string) => ({ image_id: iid, name: nameMap.get(iid) || iid })),
    })),
  };
}

// 按分组名批量读该分组下所有设计稿的图层树
export async function readSector(
  url: string,
  sectorName: string,
  opts: Credentials
): Promise<{
  sector: string;
  designCount: number;
  designs: Array<{ image_id: string; name: string; viewport: { width: number; height: number }; layers: DesignLayer[]; meta: DesignMeta }>;
}> {
  const list = await listSectors(url, opts);
  const sector = list.sectors.find((s) => s.name === sectorName || s.id === sectorName);
  if (!sector) {
    throw new Error(`未找到分组「${sectorName}」，可用分组：${list.sectors.map((s) => s.name).join('、')}`);
  }
  const { projectId } = parseLanhuUrl(url);
  const cookie = resolveCookie(opts);

  const designs = [];
  for (const d of sector.designs) {
    const r = await fetchDesignByImageId(d.image_id, projectId!, cookie, {});
    designs.push({ image_id: d.image_id, name: d.name, viewport: r.viewport, layers: r.layers, meta: r.meta });
  }

  return { sector: sector.name, designCount: designs.length, designs };
}
