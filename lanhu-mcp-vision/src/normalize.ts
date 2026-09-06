// normalize.ts — 蓝湖 Figma JSON → 结构化图层树归一化
import type { DesignLayer, DesignMeta } from './types.js';

// 判断一个 JSON 是否像设计稿数据
export function isSketchLike(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const keys = Object.keys(json as Record<string, unknown>).map((k) => k.toLowerCase());
  const hit = ['layers', 'shapes', 'artboards', 'artboard', 'children', 'sketch', 'document', 'widgets', 'nodes'];
  return hit.some((k) => keys.includes(k));
}

// 在嵌套对象里找最大的"图层数组"
export function findLayerArray(obj: unknown, depth = 0): unknown[] | null {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  const record = obj as Record<string, unknown>;
  for (const k of ['layers', 'shapes', 'children', 'artboards', 'widgets', 'nodes']) {
    const v = record[k];
    if (Array.isArray(v) && v.length) return v;
  }
  for (const v of Object.values(record)) {
    if (v && typeof v === 'object') {
      const r = findLayerArray(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// 自动生成名（Frame_xxx/编组N/Rectangle 9943…）对 Agent 无信息量，输出前剔除；
// Subtract/Union 等是 Sketch 布尔运算的默认名，同属工具自动名；
// 但蒙版/切片这类词是 verify-spec 去噪信号（NOISE_RE），保留不剔
const AUTO_NAME_RE = /^(frame|group|编组|矩形|椭圆|形状|切片|蒙版|layer|rect|image|vector|line|subtract|union|intersect|difference)[\s_-]?\d*$/i;
const NOISE_MARKER_RE = /^(蒙版|mask|切片|slice)/i;
const isNoiseName = (name: string): boolean =>
  AUTO_NAME_RE.test(name.trim()) && !NOISE_MARKER_RE.test(name.trim());

// Sketch 布尔运算节点的默认名（节点无独立类型标记，只能按默认名识别）：
// 操作数子层从不独立渲染（查看器只渲染布尔结果），整棵子树可折叠
const BOOLEAN_NAME_RE = /^(subtract|union|intersect|difference)([\s_-]?\d*)?$/i;
const subtreeSize = (n: any): number =>
  1 + (Array.isArray(n?.layers) ? n.layers.reduce((a: number, c: any) => a + subtreeSize(c), 0) : 0);

// alpha=1 的颜色用 #hex 表达（信息等价，rgba 形式白费约一半字节）
const shortColor = (s: string): string => {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*1\)$/.exec(s.trim());
  return m ? '#' + [m[1], m[2], m[3]].map((c) => (+c).toString(16).padStart(2, '0')).join('') : s;
};

// 把单个图层归一化成我们的 schema（适配蓝湖 Figma JSON：frame 为绝对坐标、fills[].color.value 存颜色）
export function normalizeShape(shape: Record<string, any>): DesignLayer {
  const frame = shape.frame || shape.rect || shape.boundingBox || shape;
  const x = Math.round(Number(frame.x ?? frame.left ?? 0));
  const y = Math.round(Number(frame.y ?? frame.top ?? 0));
  const w = Math.round(Number(frame.width ?? frame.w ?? 0));
  const h = Math.round(Number(frame.height ?? frame.h ?? 0));
  const style = shape.style || shape.css || {};
  const type = String(shape.type ?? shape.shapeType ?? (shape.text != null ? 'text' : 'rect')).toLowerCase();
  const textStyle = shape.text && typeof shape.text === 'object' ? shape.text.style : null;
  const layer: DesignLayer = {
    type: /text|label|font/i.test(type) ? 'text' : /image|bitmap|img/i.test(type) ? 'image' : 'rect',
    x,
    y,
    w,
    h,
  };
  // 切图标记层的名字是下载句柄（lanhu_download_slices 按 sliceNames 过滤），豁免自动名抑制
  if (shape.name && (shape.hasExportImage || !isNoiseName(String(shape.name)))) layer.name = shape.name;
  // 切图 URL 只留在 slices 清单（collectSlices 从原始树收集），图层上只留 hasExportImage 标记；
  // 非 hasExportImage 的位图层（真正的背景图）保留 imageUrl，Agent 只能靠它引用
  if (shape.hasExportImage) {
    layer.hasExportImage = true;
  } else if (shape.image?.imageUrl) {
    layer.imageUrl = shape.image.imageUrl;
  }
  // 合成 opacity × fill.opacity × color.a；opacity=0 合法故用 ?? 兜底，NaN 视为 1 不吞图层
  const rawOpacity = shape.opacity == null ? 1 : Number(shape.opacity);
  const layerOpacity = Number.isFinite(rawOpacity) ? rawOpacity : 1;
  // 两种形状：fill0.color.a（fill 路径）/ fill0.a（文本 color 路径，textStyle.color 是裸 color 对象）
  const fillOpacityOf = (fill0: any): number => Number(fill0?.opacity ?? 1) || 0;
  const colorAlphaOf = (fill0: any): number => {
    if (fill0 == null) return 1;
    const a = fill0.color?.a ?? fill0.a; // fill 形状：{color:{a}}；文本 color 形状：{a}
    return Number(a ?? 1) || 0;
  };
  // eff<1 统一转 rgba：蓝湖界面可见的 60% 文字透明度在 color.a 里，其自产代码会丢
  const applyAlpha = (rawValue: unknown, fill0?: any): string | undefined => {
    if (typeof rawValue !== 'string') return undefined;
    const colorA = colorAlphaOf(fill0);
    const fillOp = fillOpacityOf(fill0);
    // fill.opacity 与 color.a 是蓝湖导出时同一个 alpha 的两次序列化（实测 50 个 fill：
    // 两者同时 <1 时必然相等，0 例分歧），直接相乘会把 rgba(0,0,0,0.2) 算成 0.04。
    // 仅当两者确实不同（>0.1%）才视为真实的乘性透明度。
    const eff = colorA * layerOpacity * (Math.abs(fillOp - colorA) > 1e-3 ? fillOp : 1);
    if (eff >= 1) return shortColor(rawValue); // 不透明，缩写为 hex
    const a = Number(eff.toFixed(4));
    // 整数字节 rgb(a)：rgba(1,2,3) / rgba(1,2,3,.5)
    const rgbInt = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(rawValue.trim());
    if (rgbInt) return `rgba(${rgbInt[1]},${rgbInt[2]},${rgbInt[3]},${a})`;
    // 百分比 rgb(a)：rgba(100%,50%,0%,.8) — 蓝湖少见，但归一化器需兼容，避免透明度被静默丢弃
    const rgbPct = /^rgba?\((\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%(?:,\s*([\d.]+))?\)$/.exec(rawValue.trim());
    if (rgbPct) {
      const pct2Byte = (p: string) => Math.min(255, Math.max(0, Math.round(parseFloat(p) * 2.55)));
      return `rgba(${pct2Byte(rgbPct[1])},${pct2Byte(rgbPct[2])},${pct2Byte(rgbPct[3])},${a})`;
    }
    // hex（#RGB/#RRGGBB）：解析转 rgba，避免 fill/图层透明度被静默丢弃
    const hx = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(rawValue.trim());
    if (hx) {
      let h = hx[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
    }
    // 其它格式（hsl/named/带空格…）：留痕但仍返回原值，避免丢颜色；透明度未能叠入，用 stderr 告警
    console.error(`[normalize] applyAlpha 无法解析颜色：${rawValue}，透明度 alpha=${a} 未叠入`);
    return rawValue;
  };
  if (layer.type === 'text') {
    const rawText = shape.text;
    layer.text = (typeof rawText === 'string' ? rawText : (textStyle?.content ?? rawText?.value ?? '')) || undefined;
    const font = textStyle?.font ?? {};
    // 字号/行高取整：蓝湖导出常带缩放浮点尾数（如 22.92388153076172），设计意图是整像素
    layer.fontSize = Math.round(Number(font.size ?? font.fontSize ?? 0)) || undefined;
    layer.fontWeight = Number(font.fontWeight ?? font.weight ?? 0) || undefined;
    layer.fontFamily = font.name ?? font.fontFamily ?? font.postScriptName ?? undefined;
    // 行高 AUTO→'auto'，PIXELS→数值（取整）；字间距保留 1 位小数（±0.5px 字距真实存在）
    if (font.lineHeight) layer.lineHeight = font.lineHeight.unit === 'AUTO' ? 'auto' : Math.round(Number(font.lineHeight.value)) || undefined;
    if (font.letterSpacing && Number(font.letterSpacing.value)) layer.letterSpacing = Math.round(Number(font.letterSpacing.value) * 10) / 10;
    // 对齐只输出非默认值（left/top 是默认态，输出去掉省字节）
    const hAlign = font.align ? String(font.align).toLowerCase() : '';
    if (hAlign && hAlign !== 'left') layer.align = hAlign;
    const vAlign = font.verticalAlignment ? String(font.verticalAlignment).toLowerCase() : '';
    if (vAlign && vAlign !== 'top') layer.verticalAlign = vAlign;
    if (font.italic) layer.italic = true;
    if (font.underline) layer.underline = true;
    if (font.linethrough) layer.linethrough = true;
    // 文本色：textStyle.color 是裸 color 对象（{value,a}），传给 applyAlpha（colorAlphaOf 兼容 .a）
    const rawColor = textStyle?.color?.value ?? style.fills?.[0]?.color?.value;
    const c = applyAlpha(rawColor, textStyle?.color ?? style.fills?.[0]);
    if (c) layer.color = c;
  } else {
    const fill0 = style.fills?.[0];
    if (fill0?.type === 'gradient' && fill0.gradient?.stops) {
      // 渐变 fill：提取 stops（color+position），每个 stop 走 applyAlpha 纳入 layer/fill 透明度
      const stops = fill0.gradient.stops
        .map((st: any) => ({ color: applyAlpha(st.color?.value, { ...st.color, opacity: fill0.opacity }), position: Math.round(Number(st.position) * 1000) / 1000 }))
        .filter((st: any) => st.color);
      if (stops.length) layer.gradient = { stops };
    } else {
      const c = applyAlpha(fill0?.color?.value, fill0);
      if (c) layer.fill = c;
    }
    // 圆角：蓝湖 Figma JSON 真值在 paths[].radius（逐角）；顶层 shape.radius 实测恒为全 0 不可信，
    // style.borderRadius/cornerRadius 在该格式中不存在。paths 为空时才回落顶层 radius
    const radiusOf = (r: any): { tl: number; tr: number; bl: number; br: number } | null => {
      if (r == null) return null;
      const tl = Math.round(Number(r.topLeft ?? 0) || 0);
      const tr = Math.round(Number(r.topRight ?? 0) || 0);
      const bl = Math.round(Number(r.bottomLeft ?? 0) || 0);
      const br = Math.round(Number(r.bottomRight ?? 0) || 0);
      return tl || tr || bl || br ? { tl, tr, bl, br } : null;
    };
    let radii = (shape.paths || []).map((p: any) => radiusOf(p?.radius)).filter(Boolean) as Array<{ tl: number; tr: number; bl: number; br: number }>;
    if (!radii.length) radii = [radiusOf(shape.radius)].filter(Boolean) as Array<{ tl: number; tr: number; bl: number; br: number }>;
    if (radii.length) {
      const allSame = radii.every((r) => r.tl === radii[0].tl && r.tr === radii[0].tr && r.bl === radii[0].bl && r.br === radii[0].br);
      const first = radii[0];
      const corners = { topLeft: first.tl, topRight: first.tr, bottomLeft: first.bl, bottomRight: first.br };
      if (allSame && first.tl === first.tr && first.tr === first.bl && first.bl === first.br) {
        // 四角一致：只出 radius 单值，省字节
        layer.radius = first.tl;
      } else {
        layer.borderRadius = corners;
        if (!allSame) layer.radius = Math.max(first.tl, first.tr, first.bl, first.br); // 多 path 不一致时给最大角参考值
      }
    }
    // 描边：取第一条启用中的边框（设计稿极少同一图层多描边）
    const border0 = (style.borders || []).find((b: any) => b.isEnabled !== false);
    if (border0) {
      const bc = applyAlpha(border0.color?.value, { ...border0.color, opacity: border0.opacity });
      if (bc) {
        layer.border = {
          color: bc,
          width: Math.round(Number(border0.width ?? 0) * 100) / 100, // 保留 2 位小数：亚像素描边（0.5px 发丝线）真实存在
          alignment: border0.lineAlignment === 'outside' ? 'outside' : border0.lineAlignment === 'center' ? 'center' : 'inside',
        };
      }
    }
  }
  // 阴影：外/内各取第一条启用项（text 层映射 CSS text-shadow，其余映射 box-shadow）。
  // color.value 自带 alpha（shadow.opacity 字段只是它的回声，不能再乘一遍，否则 0.4 会变 0.16）
  const shadowList = (style.shadows || []).filter((s: any) => s && s.isEnabled !== false && s.color?.value);
  const toShadow = (s: any) => ({
    color: shortColor(String(s.color.value)),
    x: Math.round(Number(s.x ?? 0)),
    y: Math.round(Number(s.y ?? 0)),
    blur: Math.round(Number(s.blur ?? 0)),
    spread: Math.round(Number(s.spread ?? 0)),
  });
  const outerShadow = shadowList.find((s: any) => !s.inset);
  const innerShadow = shadowList.find((s: any) => s.inset);
  if (outerShadow) layer.shadow = toShadow(outerShadow);
  if (innerShadow) layer.innerShadow = toShadow(innerShadow);
  // 只在透明度无处可烘时导出（无 fill/gradient/color，典型是 image 切图）；已烘进 rgba 的再导出会 eff² 双重叠加
  const hasBakedColor = !!(layer.fill || layer.gradient || layer.color);
  if (layerOpacity < 1 && !hasBakedColor) layer.opacity = Number(layerOpacity.toFixed(4));
  return layer;
}

// 清洗：过滤无样式纯容器层（省 30-67% 体积），保留扁平数组但加 parentPath 保分组语义
export function normalizeSketch(json: Record<string, any>): { layers: DesignLayer[]; meta: DesignMeta } {
  const arr = findLayerArray(json) || [];
  const layers: DesignLayer[] = [];
  let droppedCount = 0;
  let walkedCount = 0; // 全树实际遍历的图层数（含被丢弃的容器）
  let backupLayerCount = 0; // 「备份/backup」命名的备用层（实际开发不实现）
  let booleanOperandLayerCount = 0; // 布尔运算的操作数子层（不独立渲染，折叠只留布尔节点）
  // 有「会实际渲染的东西」才输出：涂料(fill/gradient/color)、文字、图片、描边、阴影。
  // 仅透明度/仅圆角不构成渲染——没有填充描边时 opacity 和 radius 谁都看不见（实测设计稿里常见这种空壳层）
  const isContentful = (l: DesignLayer): boolean =>
    !!(l.fill || l.gradient || l.color || l.text || l.imageUrl || l.hasExportImage || l.border || l.shadow || l.innerShadow);
  // 自动生成名对 AI 无信息量，且会吃掉过滤省下的字节（判定同 isNoiseName，但不含蒙版/切片豁免——
  // 这类词不该进 parentPath，只该留在层名上给 verify-spec 去噪用）
  const meaningfulName = (name: string): boolean => !AUTO_NAME_RE.test(name.trim());
  const walk = (items: unknown[], path: string[]) => {
    for (const s of items) {
      if (!s || typeof s !== 'object') continue;
      walkedCount++;
      const shape = s as Record<string, any>;
      // 蓝湖/Figma 的隐藏层（设计者手动关掉可见性）整棵子树都不可见，跳过且不再下钻
      if (shape.visible === false) continue;
      const shapeName = String(shape.name || '');
      // 「备份/backup」命名的备用层实际开发不实现（与 verify-spec 的 NOISE_RE 立场一致），子树一并跳过
      if (/备份|backup/i.test(shapeName)) {
        backupLayerCount += subtreeSize(shape);
        continue;
      }
      const childPath = shapeName && meaningfulName(shapeName) ? [...path, shapeName] : path;
      const layer = normalizeShape(shape);
      if (layer.w > 0 && layer.h > 0) {
        if (isContentful(layer)) {
          if (path.length) layer.parentPath = path.join('/');
          layers.push(layer);
        } else {
          droppedCount++;
        }
      }
      const children = shape.layers;
      if (!Array.isArray(children) || !children.length) continue;
      // 布尔运算节点：操作数从不独立渲染（蓝湖网页上也找不到它们），折叠子树只留布尔节点本身——
      // 其填充与包围盒即布尔结果的近似
      if (BOOLEAN_NAME_RE.test(shapeName.trim())) {
        booleanOperandLayerCount += children.reduce((a: number, c: any) => a + subtreeSize(c), 0);
        continue;
      }
      walk(children, childPath);
    }
  };
  walk(arr, []);

  // 第二遍清洗（面向输出形态，第一遍只滤无效层）：
  // ① 完全在画布外的层（设计师把素材停放在画布旁）不可见，剔除；部分压边的必须保留（真实出画设计）
  // ② 逐字段一致的堆叠副本（Figma 导出伪影）只留最后出现的——顶层样式才是可见样式
  let cleaned = layers;
  let outsideCanvasLayerCount = 0;
  const frame = json?.artboard?.frame;
  const canvasW = Math.round(Number(frame?.width ?? 0));
  const canvasH = Math.round(Number(frame?.height ?? 0));
  if (canvasW > 0 && canvasH > 0) {
    cleaned = cleaned.filter((l) => {
      const outside = l.x + l.w <= 0 || l.y + l.h <= 0 || l.x >= canvasW || l.y >= canvasH;
      if (outside) outsideCanvasLayerCount++;
      return !outside;
    });
  }
  // ② 去重：
  //    普通层——逐字段一致（除名字）的堆叠副本只留最后出现的，顶层样式才是可见样式；
  //    切图标记（hasExportImage）——按几何去重：同一位置同一尺寸的多个导出标记
  //    （编组和子层各标一次，蓝湖网页上确认是同一张图）优先保留 type=image 的那个
  const dedupKeyOf = (l: DesignLayer): string =>
    l.hasExportImage
      ? JSON.stringify(['slice', l.x, l.y, l.w, l.h])
      : JSON.stringify({ ...l, name: undefined });
  const groups = new Map<string, number[]>();
  cleaned.forEach((l, i) => {
    const k = dedupKeyOf(l);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  });
  const winner = new Map<string, number>();
  for (const [k, idxs] of groups) {
    const imageIdxs = idxs.filter((i) => cleaned[i].type === 'image');
    winner.set(k, imageIdxs.length ? imageIdxs[imageIdxs.length - 1] : idxs[idxs.length - 1]);
  }
  let dedupedLayerCount = 0;
  cleaned = cleaned.filter((l, i) => {
    const keep = winner.get(dedupKeyOf(l)) === i;
    if (!keep) dedupedLayerCount++;
    return keep;
  });

  // ③ 遮挡剔除：被上方完全不透明纯色矩形整体盖住的层不可见。
  //    护栏：遮挡物只认纯色不透明填充（渐变/半透明/文案不放行，避免混合模式与渐变透明段的误判）；
  //    文案与切图层永不剔除（文案是 verify-spec 的锚点，切图是素材来源）。
  //    数组顺序 = 绘制顺序（后出现更靠上，已实测验证）。LANHU_PRUNE_OCCLUDED=0 可整体关闭。
  let occludedLayerCount = 0;
  if (process.env.LANHU_PRUNE_OCCLUDED !== '0') {
    const opaqueSolid = (v: unknown): boolean =>
      typeof v === 'string' && (/^#[0-9a-f]{6}$/i.test(v) || /^rgba\(\d+,\s*\d+,\s*\d+,\s*1\)$/.test(v));
    const covered = new Array<boolean>(cleaned.length).fill(false);
    cleaned.forEach((l, i) => {
      if (l.type === 'text' || l.hasExportImage || l.imageUrl) return;
      for (let j = i + 1; j < cleaned.length; j++) {
        const m = cleaned[j];
        if (m.type === 'text' || !opaqueSolid(m.fill)) continue;
        if (m.x <= l.x && m.y <= l.y && m.x + m.w >= l.x + l.w && m.y + m.h >= l.y + l.h) {
          covered[i] = true;
          break;
        }
      }
    });
    cleaned = cleaned.filter((l, i) => {
      if (!covered[i]) return true;
      occludedLayerCount++;
      return false;
    });
  }

  // ④ 出画窄条剔除：可见面积占比过低的纯色矩形（如 84% 出画、只在屏幕边缘露 16% 的窄条）
  //    多为设计师停放在画布旁的素材残留，实现页面时不会用到。
  //    注意：贴边探出的装饰是合法设计模式，误杀时设 LANHU_MIN_VISIBLE_FRACTION=0 关闭（默认 0.25）。
  const minVisibleFrac = Number(process.env.LANHU_MIN_VISIBLE_FRACTION ?? 0.25);
  let sliverLayerCount = 0;
  if (minVisibleFrac > 0 && canvasW > 0 && canvasH > 0) {
    cleaned = cleaned.filter((l) => {
      if (l.type === 'text' || l.hasExportImage || l.imageUrl) return true;
      const vw = Math.min(l.x + l.w, canvasW) - Math.max(l.x, 0);
      const vh = Math.min(l.y + l.h, canvasH) - Math.max(l.y, 0);
      const frac = (Math.max(0, vw) * Math.max(0, vh)) / (l.w * l.h);
      if (frac >= minVisibleFrac) return true;
      sliverLayerCount++;
      return false;
    });
  }

  // ⑤ 碎片装饰带剔除：同一容器内一排首尾相接的微小矢量段（各段高≤8、宽≤24、成带、宽度参差）
  //    ——典型如设计师用几十个矢量拼出的装饰虚线/金色路径，实现页面时不会逐段还原。
  //    反例保护：等宽等距的分段（虚线分隔线/分段进度条，宽度比 <1.3）与不成链的孤立小点
  //    （轮播指示点）不满足条件，保留；文案与切图层永不剔除。LANHU_PRUNE_FRAGMENTS=0 可关闭。
  let fragmentLayerCount = 0;
  if (process.env.LANHU_PRUNE_FRAGMENTS !== '0') {
    const byParent = new Map<string, number[]>();
    cleaned.forEach((l, i) => {
      if (l.type === 'text' || l.hasExportImage || l.imageUrl) return;
      if (l.w > 24 || l.h > 8 || !l.parentPath) return;
      const arr = byParent.get(l.parentPath);
      if (arr) arr.push(i);
      else byParent.set(l.parentPath, [i]);
    });
    const dropIdx = new Set<number>();
    for (const idxs of byParent.values()) {
      // 先按 y 聚水平带（相差 ≤2px 算同一带），带内按 x 串链（首尾间隙/重叠 ≤6px）
      idxs.sort((a, b) => cleaned[a].y - cleaned[b].y || cleaned[a].x - cleaned[b].x);
      let band: number[] = [idxs[0]];
      const flushBand = () => {
        if (band.length >= 4) {
          band.sort((a, b) => cleaned[a].x - cleaned[b].x);
          let run: number[] = [band[0]];
          const flushRun = () => {
            if (run.length >= 4) {
              const ws = run.map((i) => cleaned[i].w);
              if (Math.max(...ws) / Math.min(...ws) >= 1.3) {
                run.forEach((i) => dropIdx.add(i));
                fragmentLayerCount += run.length;
              }
            }
            run = [];
          };
          for (let k = 1; k < band.length; k++) {
            const prev = cleaned[run[run.length - 1]];
            const cur = cleaned[band[k]];
            const gap = cur.x - (prev.x + prev.w);
            if (gap <= 6 && gap >= -6) run.push(band[k]);
            else { flushRun(); run = [band[k]]; }
          }
          flushRun();
        }
        band = [];
      };
      for (let k = 1; k < idxs.length; k++) {
        if (Math.abs(cleaned[idxs[k]].y - cleaned[band[0]].y) <= 2) band.push(idxs[k]);
        else { flushBand(); band = [idxs[k]]; }
      }
      flushBand();
    }
    if (dropIdx.size) cleaned = cleaned.filter((_, i) => !dropIdx.has(i));
  }

  const meta: DesignMeta = {
    rawLayerCount: walkedCount,
    totalLayerCount: cleaned.length,
    droppedLayerCount: droppedCount,
    dedupedLayerCount,
    outsideCanvasLayerCount,
    occludedLayerCount,
    sliverLayerCount,
    fragmentLayerCount,
    backupLayerCount,
    booleanOperandLayerCount,
    payloadBytes: Buffer.byteLength(JSON.stringify(cleaned)),
    docName: json?.artboard?.name ?? json?.document?.name ?? json?.name ?? json?.title ?? undefined,
  };
  return { layers: cleaned, meta };
}
