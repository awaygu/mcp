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
  // 非 text 图层
  fill?: string;
  radius?: number;
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
  source: 'api' | 'scrape' | 'mock';
  url?: string;
  name?: string;
  viewport: { width: number; height: number };
  layers: DesignLayer[];
  meta: DesignMeta;
  visionAnalysis?: unknown;
  coverImageBase64?: string;
  screenshotBase64?: string;
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

export interface Credentials {
  cookie?: string;
  storageState?: string;
}
