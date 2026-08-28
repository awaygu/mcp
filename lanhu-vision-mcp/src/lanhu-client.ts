// lanhu-client.ts — 蓝湖官方 API 客户端（Cookie 直调，无需浏览器）
//
// GET /api/project/image → versions[0].json_url（标注数据）+ detail.url（封面图）
// GET {json_url} → Figma JSON，复用 normalizeSketch 解析
// GET /api/project/project_sectors → 分组列表；GET /api/project/images → 设计稿 name↔id 映射

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeSketch } from './normalize.js';
import type { Credentials, DesignLayer, DesignMeta, DesignResult, SectorInfo, SliceInfo } from './types.js';

const LANHU_API_BASE = 'https://lanhuapp.com';

function loadCookie(storageStatePath: string): string {
  const state = JSON.parse(readFileSync(storageStatePath, 'utf8'));
  return (state.cookies || []).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
}

// 从 storageState 的 localStorage 读 team_id（workbench 列项目用）
function loadTeamId(storageStatePath: string): string {
  const state = JSON.parse(readFileSync(storageStatePath, 'utf8'));
  for (const o of state.origins || []) {
    for (const { name, value } of o.localStorage || []) {
      if (name === 'team_id' && value) return value;
    }
  }
  throw new Error('storageState 里没找到 localStorage.team_id，请重新登录蓝湖');
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

// 接受蓝湖 URL 或项目 UUID，统一返回 project_id
function resolveProjectId(urlOrId: string): string {
  if (!urlOrId) throw new Error('需要蓝湖 URL 或项目 UUID');
  // 看起来是 URL（含 / 或 ?），走解析
  if (/[/?]/.test(urlOrId)) {
    const { projectId } = parseLanhuUrl(urlOrId);
    if (projectId) return projectId;
  }
  // 否则当 UUID（蓝湖 pid 是 8-4-4-4-12 格式）
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(urlOrId)) {
    return urlOrId;
  }
  throw new Error(`无法识别的项目标识：${urlOrId}（应为蓝湖 URL 或项目 UUID）`);
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
  let slices: SliceInfo[] = [];
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
    // 收集切图：遍历图层树，所有 hasExportImage 且带 image.imageUrl 的图层
    slices = collectSlices(ab);
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
    ...(slices.length ? { slices } : {}),
    ...(coverImageBase64 ? { coverImageBase64 } : {}),
  };
}

// 递归收集切图：遍历 artboard 树，收集 hasExportImage 且带 image.imageUrl 的图层
function collectSlices(node: any): SliceInfo[] {
  const out: SliceInfo[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.hasExportImage && n.image?.imageUrl) {
      const f = n.frame || {};
      out.push({
        name: String(n.name || 'slice'),
        imageUrl: n.image.imageUrl,
        ...(n.image.svgUrl ? { svgUrl: n.image.svgUrl } : {}),
        x: Math.round(Number(f.x ?? 0)),
        y: Math.round(Number(f.y ?? 0)),
        w: Math.round(Number(f.width ?? 0)),
        h: Math.round(Number(f.height ?? 0)),
      });
    }
    for (const child of n.layers || []) walk(child);
  };
  walk(node);
  return out;
}

// URL → 短 hash（前 8 位 md5），用作切图文件名防重名
function shortHash(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 8);
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

// 一次拉全团队目录（项目 → 分组，粒度A：只到分组层，不展开设计稿名）
// workbench 接口：parentId=0 列根，文件夹的数字 id 列其下项目；再对每个项目列分组。
// 并行拉取，~2 秒返回。AI 拿这份"目录页"直接定位活动分组，不必自己编排下钻。
export async function listDirectory(
  opts: Credentials
): Promise<{
  teamId: string;
  projectCount: number;
  sectorCount: number;
  directory: Array<{ project: string; projectId: string; sectors: Array<{ name: string; designCount: number }> }>;
}> {
  const cookie = resolveCookie(opts);
  const headers = { ...apiHeaders(cookie), 'Content-Type': 'application/json' };
  const teamId = opts.storageState ? loadTeamId(opts.storageState) : '';
  if (!teamId) {
    throw new Error('listDirectory 需要 storageState（从中读 localStorage.team_id）；纯 cookie 串暂不支持，请配 LANHU_STORAGE_STATE');
  }

  // 1) 列根目录（folder/project）
  const rootRes = await fetch(`${LANHU_API_BASE}/workbench/api/workbench/abstractfile/list`, {
    method: 'POST', headers, body: JSON.stringify({ tenantId: teamId, parentId: 0 }),
  });
  const rootJson = await rootRes.json();
  const rootItems: any[] = Array.isArray(rootJson.data) ? rootJson.data : [];

  // 2) 并行下钻所有 folder，根目录的 project 直接收
  const folders = rootItems.filter((p) => p.sourceType === 'folder');
  const rootProjects = rootItems.filter((p) => p.sourceType !== 'folder');
  const underFolders = await Promise.all(
    folders.map(async (f) => {
      const r = await fetch(`${LANHU_API_BASE}/workbench/api/workbench/abstractfile/list`, {
        method: 'POST', headers, body: JSON.stringify({ tenantId: teamId, parentId: f.id }),
      });
      const j = await r.json();
      return Array.isArray(j.data) ? j.data : [];
    })
  );
  const allProjects = [...rootProjects, ...underFolders.flat()];

  // 3) 并行列每个项目的分组（复用 listSectorsByProject，只取 name + designCount）
  const perProject = await Promise.all(
    allProjects.map((p) =>
      listSectorsByProject(p.sourceId, opts).then((r) => ({
        project: p.sourceName,
        projectId: p.sourceId,
        sectors: r.sectors.map((s) => ({ name: s.name, designCount: s.designCount })),
      }))
    )
  );

  const sectorCount = perProject.reduce((a, p) => a + p.sectors.length, 0);
  return { teamId, projectCount: perProject.length, sectorCount, directory: perProject };
}

// 列项目下所有分组（核心：按 projectId，不依赖 URL）
export async function listSectorsByProject(
  projectId: string,
  opts: Credentials
): Promise<{ projectId: string; sectorCount: number; sectors: SectorInfo[] }> {
  const cookie = resolveCookie(opts);
  const headers = apiHeaders(cookie);
  // team_id 用于 /api/project/images，从 URL 取或默认 0；按 project 查时用 0 兜底
  const teamId = '0';

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
// url 参数接受蓝湖 URL 或项目 UUID
export async function readSector(
  url: string,
  sectorName: string,
  opts: Credentials
): Promise<{
  sector: string;
  designCount: number;
  designs: Array<{ image_id: string; name: string; viewport: { width: number; height: number }; layers: DesignLayer[]; meta: DesignMeta }>;
}> {
  const projectId = resolveProjectId(url);
  const list = await listSectorsByProject(projectId, opts);
  const sector = list.sectors.find((s) => s.name === sectorName || s.id === sectorName);
  if (!sector) {
    throw new Error(`未找到分组「${sectorName}」，可用分组：${list.sectors.map((s) => s.name).join('、')}`);
  }
  const cookie = resolveCookie(opts);

  const designs = [];
  for (const d of sector.designs) {
    const r = await fetchDesignByImageId(d.image_id, projectId, cookie, {});
    designs.push({ image_id: d.image_id, name: d.name, viewport: r.viewport, layers: r.layers, meta: r.meta });
  }

  return { sector: sector.name, designCount: designs.length, designs };
}

// 下载切图到本地目录
//
// 两种范围（二选一）：
//   - 单稿：传 urlOrImageId（设计稿 URL / image_id）
//   - 分组：传 sector（分组名）+ urlOrImageId（项目 UUID 或该分组任一稿链接）
//
// 三层去重（默认全开）：
//   1. URL 去重 —— 蓝湖切图 URL 按图内容 hash 命名，同 URL = 同图，只下一次（解决跨稿+稿内重复）
//   2. skipExisting —— 本地已存在文件就跳过（下次开发别的需求不重下公共 icon）
//   3. sliceNames —— 只下指定名字的切图（同名不同 URL 都下，因为它们是不同的图）
//
// 失败不再静默：返回 failed 列表
export async function downloadSlices(
  urlOrImageId: string,
  outputPath: string,
  opts: Credentials & {
    format?: 'png' | 'svg';
    projectId?: string;
    sector?: string;
    sliceNames?: string[];
    skipExisting?: boolean;
  }
): Promise<{
  scope: string;          // 单稿=稿名，分组=分组名
  outputDir: string;
  downloaded: number;
  skipped: { dup: number; exist: number };
  failed: Array<{ name: string; url: string; status: number }>;
  slices: Array<{ name: string; file: string; bytes: number; w: number; h: number }>;
}> {
  const useSvg = opts.format === 'svg';
  const skipExist = opts.skipExisting !== false; // 默认 true
  const nameFilter = opts.sliceNames?.length ? new Set(opts.sliceNames) : null;

  // ── 1. 收集切图清单（单稿 or 分组）─────────────────
  let scope: string;
  let rawSlices: SliceInfo[];

  if (opts.sector) {
    // 分组模式：拉该分组所有稿的切图，合并
    const projectId = resolveProjectId(urlOrImageId);
    const cookie = resolveCookie(opts);
    const secList = await listSectorsByProject(projectId, opts);
    const sector = secList.sectors.find((s) => s.name === opts.sector || s.id === opts.sector);
    if (!sector) {
      throw new Error(`未找到分组「${opts.sector}」，可用分组：${secList.sectors.map((s) => s.name).join('、')}`);
    }
    rawSlices = [];
    for (const d of sector.designs) {
      const r = await fetchDesignByImageId(d.image_id, projectId, cookie, {});
      rawSlices.push(...(r.slices || []));
    }
    scope = sector.name;
  } else {
    // 单稿模式
    let imageId: string | null = null;
    let projectId = opts.projectId || '';
    if (/[/?]/.test(urlOrImageId)) {
      const parsed = parseLanhuUrl(urlOrImageId);
      imageId = parsed.imageId;
      projectId = parsed.projectId || projectId;
    } else {
      imageId = urlOrImageId;
    }
    if (!imageId) throw new Error('无法从输入解析 image_id，请传设计稿 URL 或 image_id');
    if (!projectId) throw new Error('下载切图需要 projectId：传 URL 自动提取，或显式传 projectId');
    const cookie = resolveCookie(opts);
    const design = await fetchDesignByImageId(imageId, projectId, cookie, {});
    rawSlices = design.slices || [];
    scope = design.name || imageId;
  }

  if (!rawSlices.length) {
    return { scope, outputDir: path.resolve(outputPath), downloaded: 0, skipped: { dup: 0, exist: 0 }, failed: [], slices: [] };
  }

  // ── 2. 去重 + 过滤 ────────────────────────────────
  const dir = path.resolve(outputPath);
  mkdirSync(dir, { recursive: true });

  const seenUrl = new Set<string>();      // URL 去重
  const pending: SliceInfo[] = [];
  let dupCount = 0;
  for (const s of rawSlices) {
    const src = useSvg && s.svgUrl ? s.svgUrl : s.imageUrl;
    if (!src) continue;
    if (nameFilter && !nameFilter.has(s.name)) continue;   // sliceNames 过滤
    if (seenUrl.has(src)) { dupCount++; continue; }        // URL 去重
    seenUrl.add(src);
    pending.push(s);
  }

  // ── 3. 下载（skipExisting + 失败收集）──────────────
  const out: Array<{ name: string; file: string; bytes: number; w: number; h: number }> = [];
  const failed: Array<{ name: string; url: string; status: number }> = [];
  let existCount = 0;

  for (const s of pending) {
    const src = useSvg && s.svgUrl ? s.svgUrl : s.imageUrl;
    const ext = useSvg && s.svgUrl ? 'svg' : 'png';
    const cleanName = String(s.name).replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
    const hash = shortHash(src);
    const fileName = `${cleanName}_${hash}.${ext}`;
    const filePath = path.join(dir, fileName);

    // skipExisting：本地已存在就跳过（不重复下载）
    if (skipExist && existsSync(filePath)) {
      existCount++;
      out.push({ name: s.name, file: filePath, bytes: 0, w: s.w, h: s.h });
      continue;
    }

    let res: Response;
    try {
      res = await fetch(src, { headers: { Referer: 'https://lanhuapp.com/' } });
    } catch {
      failed.push({ name: s.name, url: src, status: 0 });
      continue;
    }
    if (!res.ok) {
      failed.push({ name: s.name, url: src, status: res.status });
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(filePath, buf);
    out.push({ name: s.name, file: filePath, bytes: buf.length, w: s.w, h: s.h });
  }

  return {
    scope,
    outputDir: dir,
    downloaded: out.filter((s) => s.bytes > 0).length,
    skipped: { dup: dupCount, exist: existCount },
    failed,
    slices: out,
  };
}
