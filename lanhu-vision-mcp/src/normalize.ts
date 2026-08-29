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
  if (shape.name) layer.name = shape.name;
  // 切图 URL（hasExportImage 的图层才有，artboard/bitmapLayer 均放在 shape.image）
  if (shape.image?.imageUrl) layer.imageUrl = shape.image.imageUrl;
  if (shape.hasExportImage) layer.hasExportImage = true;
  // 合成图层 opacity × fill opacity × color.a 进最终 alpha（只取 color.value 会丢图层透明度）
  // 注意：opacity=0 是合法值（隐藏图层/透明填充），用 ?? 兜底而非 || 1，否则 0 会被误判成 1；
  // 脏数据（opacity 为非数字字符串 → NaN）视为 1，不吞掉图层
  const rawOpacity = shape.opacity == null ? 1 : Number(shape.opacity);
  const layerOpacity = Number.isFinite(rawOpacity) ? rawOpacity : 1;
  // 从 fill0 里取 fill 自身透明度与 color.a。文本路径的 textStyle.color 是裸 color 对象（无嵌套 .color），
  // 故支持两种形状：fill0.color.a（fill 路径）/ fill0.a（文本 color 路径）。
  const fillOpacityOf = (fill0: any): number => Number(fill0?.opacity ?? 1) || 0;
  const colorAlphaOf = (fill0: any): number => {
    if (fill0 == null) return 1;
    const a = fill0.color?.a ?? fill0.a; // fill 形状：{color:{a}}；文本 color 形状：{a}
    return Number(a ?? 1) || 0;
  };
  // 合成 alpha 后重建颜色串：eff<1 时统一输出 rgba（hex/rgb 都转，透明度不丢——蓝湖界面可见的
  // 60% 文字透明度在 color.a 字段里，蓝湖自产代码会丢，这里补上）；eff>=1 原样保留。
  const applyAlpha = (rawValue: unknown, fill0?: any): string | undefined => {
    if (typeof rawValue !== 'string') return undefined;
    const eff = colorAlphaOf(fill0) * layerOpacity * fillOpacityOf(fill0);
    if (eff >= 1) return rawValue; // 不透明，原样
    const a = Number(eff.toFixed(4));
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rawValue);
    if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
    // hex（#RGB/#RRGGBB）：解析转 rgba，避免 fill/图层透明度被静默丢弃
    const hx = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(rawValue.trim());
    if (hx) {
      let h = hx[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
    }
    return rawValue; // 其它格式无法解析，原样
  };
  if (layer.type === 'text') {
    const rawText = shape.text;
    layer.text = (typeof rawText === 'string' ? rawText : (textStyle?.content ?? rawText?.value ?? '')) || undefined;
    const font = textStyle?.font ?? {};
    layer.fontSize = Number(font.size ?? font.fontSize ?? 0) || undefined;
    layer.fontWeight = Number(font.fontWeight ?? font.weight ?? 0) || undefined;
    layer.fontFamily = font.name ?? font.fontFamily ?? font.postScriptName ?? undefined;
    // 行高 AUTO→'auto'，PIXELS→数值；字间距取 px 值
    if (font.lineHeight) layer.lineHeight = font.lineHeight.unit === 'AUTO' ? 'auto' : Number(font.lineHeight.value) || undefined;
    if (font.letterSpacing && Number(font.letterSpacing.value)) layer.letterSpacing = Number(font.letterSpacing.value);
    if (font.align) layer.align = String(font.align);
    if (font.verticalAlignment) layer.verticalAlign = String(font.verticalAlignment);
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
        .map((st: any) => ({ color: applyAlpha(st.color?.value, { ...st.color, opacity: fill0.opacity }), position: Number(st.position) }))
        .filter((st: any) => st.color);
      if (stops.length) layer.gradient = { stops };
    } else {
      const c = applyAlpha(fill0?.color?.value, fill0);
      if (c) layer.fill = c;
    }
    layer.radius = Number(style.borderRadius ?? style.cornerRadius ?? 0) || undefined;
  }
  // 导出图层透明度：仅当透明度没地方烘（无 fill/gradient/color 的图层，典型是 image 切图）时导出，
  // 供 Agent 自行叠 CSS opacity。有颜色的图层透明度已烘进 rgba alpha，再导出会导致 eff² 双重叠加。
  const hasBakedColor = !!(layer.fill || layer.gradient || layer.color);
  if (layerOpacity < 1 && !hasBakedColor) layer.opacity = Number(layerOpacity.toFixed(4));
  return layer;
}

// 把抓取到的 sketch JSON 归一化为 { layers, meta }（递归遍历嵌套 layers 树）
// 清洗策略：①无样式纯容器层（无 fill/文本/切图/圆角/透明度）过滤不输出，省 30-67% 体积；
// ②保留扁平数组但加 parentPath（容器名链）保分组语义；③meta 报 payloadBytes 供调用方感知数据大小
export function normalizeSketch(json: Record<string, any>): { layers: DesignLayer[]; meta: DesignMeta } {
  const arr = findLayerArray(json) || [];
  const layers: DesignLayer[] = [];
  let droppedCount = 0;
  // isContentful：有视觉信息的图层才输出（容器名不丢，进子层 parentPath）
  const isContentful = (l: DesignLayer): boolean =>
    !!(l.fill || l.gradient || l.color || l.text || l.imageUrl || l.hasExportImage || l.radius || l.opacity != null);
  // parentPath 只收有语义的容器名：自动生成名（Frame_xxx/Group_xxx/编组N/矩形N 等）对 AI 无信息量，
  // 且实测会吃掉过滤省下的字节
  const meaningfulName = (name: string): boolean => !/^(frame|group|编组|矩形|椭圆|形状|切片|蒙版|layer|rect|image|vector|line)[\s_-]?\d*$/i.test(name.trim());
  const walk = (items: unknown[], path: string[]) => {
    for (const s of items) {
      if (!s || typeof s !== 'object') continue;
      const shape = s as Record<string, any>;
      const shapeName = String(shape.name || '');
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
      if (Array.isArray(children) && children.length) walk(children, childPath);
    }
  };
  walk(arr, []);
  const meta: DesignMeta = {
    rawLayerCount: arr.length,
    totalLayerCount: layers.length,
    droppedLayerCount: droppedCount,
    payloadBytes: Buffer.byteLength(JSON.stringify(layers)),
    docName: json?.artboard?.name ?? json?.document?.name ?? json?.name ?? json?.title ?? undefined,
  };
  return { layers, meta };
}
