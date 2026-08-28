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
    id: String(shape.id ?? shape.guid ?? Math.random().toString(36).slice(2)),
    type: /text|label|font/i.test(type) ? 'text' : /image|bitmap|img/i.test(type) ? 'image' : 'rect',
    x,
    y,
    w,
    h,
  };
  if (shape.name) layer.name = shape.name;
  // 切图 URL（hasExportImage 的图层才有，artboard/bitmapLayer 均放在 shape.image）
  if (shape.image?.imageUrl) {
    layer.imageUrl = shape.image.imageUrl;
    if (shape.image.svgUrl) layer.svgUrl = shape.image.svgUrl;
  }
  if (shape.hasExportImage) layer.hasExportImage = true;
  if (layer.type === 'text') {
    const rawText = shape.text;
    layer.text = (typeof rawText === 'string' ? rawText : (textStyle?.content ?? rawText?.value ?? '')) || undefined;
    const font = textStyle?.font ?? {};
    layer.fontSize = Number(font.size ?? font.fontSize ?? 0) || undefined;
    layer.fontWeight = Number(font.fontWeight ?? font.weight ?? 0) || undefined;
    layer.fontFamily = font.name ?? font.fontFamily ?? font.postScriptName ?? undefined;
    const c = textStyle?.color?.value ?? style.fills?.[0]?.color?.value;
    if (typeof c === 'string') layer.color = c;
  } else {
    const c = style.fills?.[0]?.color?.value;
    if (typeof c === 'string') layer.fill = c;
    layer.radius = Number(style.borderRadius ?? style.cornerRadius ?? 0) || undefined;
  }
  return layer;
}

// 把抓取到的 sketch JSON 归一化为 { layers, meta }（递归遍历嵌套 layers 树）
export function normalizeSketch(json: Record<string, any>): { layers: DesignLayer[]; meta: DesignMeta } {
  const arr = findLayerArray(json) || [];
  const layers: DesignLayer[] = [];
  const walk = (items: unknown[]) => {
    for (const s of items) {
      if (!s || typeof s !== 'object') continue;
      layers.push(normalizeShape(s as Record<string, any>));
      const children = (s as Record<string, any>).layers;
      if (Array.isArray(children) && children.length) walk(children);
    }
  };
  walk(arr);
  const filtered = layers.filter((l) => l.w > 0 && l.h > 0);
  const meta: DesignMeta = {
    rawLayerCount: arr.length,
    totalLayerCount: filtered.length,
    docName: json?.artboard?.name ?? json?.document?.name ?? json?.name ?? json?.title ?? undefined,
  };
  return { layers: filtered, meta };
}
