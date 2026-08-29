// lanhu-client.ts — 蓝湖官方 API 客户端（Cookie 直调，无需浏览器）
// 端点：/api/project/image(稿详情+json_url) · /api/project/project_sectors+images(分组) · /api/account/user_teams(团队) · /workbench abstractfile/list(团队目录)

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeSketch } from './normalize.js';
import type { Credentials, DesignLayer, DesignMeta, DesignResult, SectorInfo, SliceInfo } from './types.js';

const LANHU_API_BASE = 'https://lanhuapp.com';

// cookie 续期/首次配置指引（两种方式，所有过期/缺失提示统一引用）
// 方式1：F12 复制 cookie（快，技术同学）；方式2：跑登录脚本（小白，自动写入）
const RELOGIN_HINT =
  '方式1：浏览器登录蓝湖后按 F12 → Network → 点任意请求 → 复制 Cookie 头整串，写入 .mcp-local/lanhu.cookie（或设 LANHU_COOKIE 环境变量）；' +
  '方式2：双击 lanhu-login.bat（或运行 npm run login），浏览器登录后按 Enter 自动写入 cookie。完成后让 AI 重试。';

// team_id 回退：入参 > URL tid；都缺则报错（tenantId=0 返回空目录，不能兜底）
function resolveTeamId(opts: { teamId?: string; url?: string }): string {
  if (opts.teamId) return opts.teamId;
  if (opts.url) {
    const { teamId } = parseLanhuUrl(opts.url);
    if (teamId && teamId !== '0') return teamId;
  }
  throw new Error('无法定位团队：请传 teamId（来自 lanhu_list_teams）或 url（蓝湖链接提 tid）；纯 cookie 不带 teamId/url 时无法列目录');
}

// 打 user_teams 接口拿原始团队列表（listUserTeams 与 checkAuth 共用，避免重复 fetch/解析）
// 不做鉴权判断，只返回 { status, teams }；上层各自决定怎么处理错误
async function fetchUserTeams(cookie: string): Promise<{ status: number; teams: any[] }> {
  const res = await fetch(`${LANHU_API_BASE}/api/account/user_teams?need_open_related=true`, {
    headers: apiHeaders(cookie),
  });
  if (!res.ok) return { status: res.status, teams: [] };
  const json: any = await res.json();
  return { status: res.status, teams: json?.result || json?.data || [] };
}

// 列账号所属全部团队（/api/account/user_teams），只返回选 teamId 需要的字段，省略敏感项
export async function listUserTeams(
  opts: Credentials
): Promise<{
  teamCount: number;
  teams: Array<{ teamId: string; name: string; role: string; isOwner: boolean; memberNum: number }>;
}> {
  const cookie = resolveCookie(opts);
  const { status, teams } = await fetchUserTeams(cookie);
  // 401/错误体不静默为空，避免调用方误以为账号无团队（auth 作用域：401=cookie 过期/缺字段）
  assertStatusOk(status, 'auth', '团队列表');
  return {
    teamCount: teams.length,
    teams: teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      role: t.role?.display || t.role?.name || '',
      isOwner: !!t.is_team_owner,
      memberNum: Number(t.member_num) || 0,
    })),
  };
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
  if (!opts.cookie) throw new Error(`需要蓝湖登录凭证（二选一）：${RELOGIN_HINT}`);
  return opts.cookie;
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

// 按目标 URL 决定是否携带登录 Cookie：仅 lanhuapp.com（官方 API）发 Cookie，
// CDN/OSS（json_url 标注数据、封面图、切图）一律不发——凭据不外泄到第三方主机，且 CDN 无需凭据
function headersFor(url: string, cookie: string): Record<string, string> {
  const host = new URL(url).hostname;
  const isLanhu = host === 'lanhuapp.com' || host.endsWith('.lanhuapp.com');
  return isLanhu ? apiHeaders(cookie) : { Referer: 'https://lanhuapp.com/' };
}

// 统一 HTTP 错误处理：401 分场景提示，避免一刀切「cookie 过期」误导
// - scope='auth'（探活/全局接口）401 → cookie 确实过期/缺字段 → 重新登录有效
// - scope='resource'（单个稿/项目）401 → 多半是无权访问该资源 → 重新登录无效，要找设计者开权限
// - 非 401 错误 → 原样报 HTTP 状态
class LanhuHttpError extends Error {
  constructor(public status: number, public scope: 'auth' | 'resource', public hint: string) {
    super(hint);
    this.name = 'LanhuHttpError';
  }
}

function assertStatusOk(status: number, scope: 'auth' | 'resource', what: string): void {
  if (status >= 200 && status < 300) return;
  if (status === 401) {
    if (scope === 'auth') {
      throw new LanhuHttpError(401, 'auth',
        `蓝湖鉴权失败（HTTP 401）：cookie 已过期或缺失关键字段。${RELOGIN_HINT}`);
    }
    throw new LanhuHttpError(401, 'resource',
      `无权访问${what}（HTTP 401）：cookie 仍可能有效，但该资源未对你分享。重新登录无效，请联系设计者开通权限，或换一个有权限的${what}。`);
  }
  throw new Error(`请求${what}失败：HTTP ${status}`);
}

// Response 版薄包装：给直接持有 Response 的 fetch 端点用
function assertOk(res: Response, scope: 'auth' | 'resource', what: string): void {
  assertStatusOk(res.status, scope, what);
}

// cookie 探活：复用 fetchUserTeams（同一接口），不抛错，返回结构化 { ok, reason, hint }
// 供 lanhu_check_auth 工具与 401 二次确认用——不抛错是因为 AI 需要拿到结构化结果而非捕获异常
export async function checkAuth(opts: Credentials): Promise<
  | { ok: true; teamCount: number; teams: Array<{ teamId: string; name: string }> }
  | { ok: false; status: number; reason: string; hint: string }
> {
  // 未配置 cookie 时也返回结构化结果（不抛错），与工具描述的首次使用分支一致
  if (!opts.cookie) {
    return { ok: false, status: 0, reason: 'no_cookie', hint: `未配置蓝湖 cookie。${RELOGIN_HINT}` };
  }
  try {
    const { status, teams } = await fetchUserTeams(opts.cookie!);
    if (status >= 200 && status < 300) {
      return { ok: true, teamCount: teams.length, teams: teams.map((t) => ({ teamId: t.id, name: t.name })) };
    }
    return {
      ok: false,
      status,
      reason: status === 401 ? 'cookie_expired' : `http_${status}`,
      hint: status === 401 ? `cookie 已过期或无效。${RELOGIN_HINT}` : `蓝湖返回 HTTP ${status}，稍后重试或检查网络。`,
    };
  } catch (e: any) {
    return { ok: false, status: 0, reason: 'network_error', hint: `网络请求失败：${e?.message || e}` };
  }
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
  assertOk(detailRes, 'resource', '设计稿');
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
    const jsonRes = await fetch(jsonUrl, { headers: headersFor(jsonUrl, cookie) });
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

  // 3) 拿封面图（完整设计截图，仅 needCover 时下载；headersFor 保证 CDN 不带 Cookie）
  let coverImageBase64: string | undefined;
  if (opts.needCover) {
    const coverUrl = detail.url || versions[0]?.url;
    if (coverUrl) {
      const imgRes = await fetch(coverUrl, { headers: headersFor(coverUrl, cookie) });
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

// 一次拉全团队目录（项目→分组，不展开设计稿名）：workbench parentId=0 列根，folder id 下钻项目，再并列项目分组
export async function listDirectory(
  opts: Credentials & { teamId?: string; url?: string }
): Promise<{
  teamId: string;
  projectCount: number;
  sectorCount: number;
  directory: Array<{ project: string; projectId: string; sectors: Array<{ name: string; designCount: number }> }>;
}> {
  const cookie = resolveCookie(opts);
  const headers = { ...apiHeaders(cookie), 'Content-Type': 'application/json' };
  const teamId = resolveTeamId(opts);

  // 1) 列根目录（folder/project）
  const rootRes = await fetch(`${LANHU_API_BASE}/workbench/api/workbench/abstractfile/list`, {
    method: 'POST', headers, body: JSON.stringify({ tenantId: teamId, parentId: 0 }),
  });
  assertOk(rootRes, 'auth', '团队目录');
  const rootJson = await rootRes.json();
  const rootItems: any[] = Array.isArray(rootJson.data) ? rootJson.data : [];

  // 2) 并行下钻所有 folder，根目录的 project 直接收
  const folders = rootItems.filter((p) => p.sourceType === 'folder');
  const rootProjects = rootItems.filter((p) => p.sourceType !== 'folder');
  // 尽力而为：单个 folder 下钻失败（401/500/非JSON）只收集进 folderErrors，不整体抛错
  const folderErrors: string[] = [];
  const underFolders = await Promise.all(
    folders.map(async (f) => {
      try {
        const r = await fetch(`${LANHU_API_BASE}/workbench/api/workbench/abstractfile/list`, {
          method: 'POST', headers, body: JSON.stringify({ tenantId: teamId, parentId: f.id }),
        });
        if (!r.ok) {
          folderErrors.push(String(f.name || f.id));
          return [];
        }
        const j = await r.json();
        return Array.isArray(j.data) ? j.data : [];
      } catch {
        folderErrors.push(String(f.name || f.id));
        return [];
      }
    })
  );
  const allProjects = [...rootProjects, ...underFolders.flat()];

  // 3) 并行列每个项目的分组（复用 listSectorsByProject，只取 name + designCount）
  // 尽力而为：单个项目无权限/失败只记录，不影响其余项目——目录列举的意义就是「能看到什么列什么」
  const failedProjects: Array<{ project: string; projectId: string; error: string }> = [];
  const perProject = (
    await Promise.all(
      allProjects.map((p) =>
        listSectorsByProject(p.sourceId, opts)
          .then((r) => ({
            ok: true as const,
            value: {
              project: p.sourceName,
              projectId: p.sourceId,
              sectors: r.sectors.map((s) => ({ name: s.name, designCount: s.designCount })),
            },
          }))
          .catch((e: any) => {
            failedProjects.push({ project: p.sourceName, projectId: p.sourceId, error: e?.message || String(e) });
            return { ok: false as const };
          })
      )
    )
  ).filter((r) => r.ok).map((r) => (r as { ok: true; value: any }).value);

  const sectorCount = perProject.reduce((a, p) => a + p.sectors.length, 0);
  return {
    teamId,
    projectCount: perProject.length,
    sectorCount,
    directory: perProject,
    ...(failedProjects.length ? { failedProjects } : {}),
    ...(folderErrors.length ? { failedFolders: folderErrors } : {}),
  };
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
  assertOk(sRes, 'resource', '项目分组');
  const sJson = await sRes.json();
  const sectors: any[] = sJson?.data?.sectors || sJson?.result?.sectors || [];

  const dRes = await fetch(`${LANHU_API_BASE}/api/project/images?project_id=${projectId}&team_id=${teamId}&dds_status=1`, { headers });
  assertOk(dRes, 'resource', '项目设计稿列表');
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

  // 并行抓取该分组所有稿（彼此独立的 API 必须并行，禁止串行 await）；单稿失败不整体挂，记入 failed
  const failed: Array<{ image_id: string; name: string; error: string }> = [];
  const okDesigns = (
    await Promise.all(
      sector.designs.map((d) =>
        fetchDesignByImageId(d.image_id, projectId, cookie, {})
          .then((r) => ({
            ok: true as const,
            value: { image_id: d.image_id, name: d.name, viewport: r.viewport, layers: r.layers, meta: r.meta },
          }))
          .catch((e: any) => {
            failed.push({ image_id: d.image_id, name: d.name, error: e?.message || String(e) });
            return { ok: false as const };
          })
      )
    )
  ).filter((r) => r.ok).map((r) => (r as { ok: true; value: any }).value);

  return {
    sector: sector.name,
    designCount: okDesigns.length,
    designs: okDesigns,
    ...(failed.length ? { failed } : {}),
  };
}

// 下载切图到本地目录。范围：单稿传 urlOrImageId；分组传 sector + urlOrImageId（项目UUID或该分组任一稿链接）
// 三层去重：URL 去重（同图只下一次）/ skipExisting（本地已存在跳过）/ sliceNames（只下指定名）。失败入 failed 列表
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
  designErrors?: string[]; // 分组模式下读取失败的稿（尽力而为：其余稿照常下载）
}> {
  const useSvg = opts.format === 'svg';
  const skipExist = opts.skipExisting !== false; // 默认 true
  const nameFilter = opts.sliceNames?.length ? new Set(opts.sliceNames) : null;

  let scope: string;
  let rawSlices: SliceInfo[];
  let designErrors: string[] | undefined;

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
    const secErrors: string[] = [];
    // 并行抓取该分组所有稿的切图清单（独立 API 并行，禁止串行 await）；
    // 尽力而为：单稿失败只记录进 designErrors，已抓到的切图照常下载
    await Promise.all(
      sector.designs.map((d) =>
        fetchDesignByImageId(d.image_id, projectId, cookie, {})
          .then((r) => rawSlices.push(...(r.slices || [])))
          .catch((e: any) => secErrors.push(`${d.name}: ${e?.message || e}`))
      )
    );
    if (secErrors.length) designErrors = secErrors;
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
    ...(designErrors ? { designErrors } : {}),
  };
}
