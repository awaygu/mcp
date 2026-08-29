// 蓝湖设计稿结构化数据类型定义

export type LayerKind = 'text' | 'image' | 'rect';

export interface DesignLayer {
  id: string;
  type: LayerKind;
  x: number;
  y: number;
  w: number;
  h: number;
  name?: string;
  // text 图层
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  fontFamily?: string;
  lineHeight?: number | string;   // 'auto' 或 px 值
  letterSpacing?: number;         // px
  align?: string;                 // 水平对齐 left|center|right|justify
  verticalAlign?: string;
  italic?: boolean;
  underline?: boolean;
  linethrough?: boolean;
  // 非 text 图层
  fill?: string;
  gradient?: { stops: Array<{ color: string; position: number }> };
  radius?: number;
  // 图层透明度（仅无 fill/gradient/color 的图层导出，如 image 切图——有颜色的图层透明度已烘进 rgba
  // alpha，再叠此字段会双重叠加；image 图层 Agent 需自行写 CSS opacity）
  opacity?: number;
  // 切图（hasExportImage 的图层）：开发时下载引用
  imageUrl?: string;
  svgUrl?: string;
  hasExportImage?: boolean;
}

export interface DesignMeta {
  rawLayerCount: number;
  totalLayerCount: number;
  docName?: string;
  capturedFrom?: string;
  fallback?: string;
  note?: string;
}

export interface DesignResult {
  source: 'api' | 'mock';
  url?: string;
  name?: string;
  viewport: { width: number; height: number };
  layers: DesignLayer[];
  meta: DesignMeta;
  visionAnalysis?: unknown;
  coverImageBase64?: string;
  // 切图清单（hasExportImage 的图层，开发时下载引用）
  slices?: SliceInfo[];
}

export interface SectorDesign {
  image_id: string;
  name: string;
}

export interface SectorInfo {
  id: string;
  name: string;
  designCount: number;
  designs: SectorDesign[];
}

// 切图信息（一个设计稿的导出图层）
export interface SliceInfo {
  name: string;
  imageUrl: string;     // PNG
  svgUrl?: string;      // SVG
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Credentials {
  cookie?: string;
}
