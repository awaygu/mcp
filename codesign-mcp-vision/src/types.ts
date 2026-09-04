/**
 * 全局共享类型定义
 *
 * 数据流向：crawler（DOM/截图） → vlm（视觉解析） → merger（合并校验）
 *          → doc-generator（Markdown） → index（MCP 工具）
 * 这里集中声明各阶段之间传递的结构，避免各模块自定义「鸭子类型」。
 */

// ─── 基础枚举 ─────────────────────────────────────────────────

/** 页面解析类型：流程图 / 配置表 / 普通页面 */
export type PageType = 'flowchart' | 'table' | 'page';

/** 文档详细程度 */
export type DetailLevel = 'summary' | 'standard' | 'full';

// ─── crawler：目录树 ──────────────────────────────────────────

/**
 * 目录树扁平节点。TDesign 树为扁平渲染，DOM 顺序即大纲顺序。
 * domIndex 为原始 DOM 序号（可能含无文字节点），与大纲数组下标不可混用。
 */
export interface TreeNode {
  name: string;
  /** 层级，取自 style 的 --level */
  level: number;
  /** 有 .total-text（子项数量标记）的节点为分组 */
  isGroup: boolean;
  /** 在 .t-tree__item 集合中的下标，用于点击定位 */
  domIndex: number;
}

/** 带完整路径的目录节点：path = 祖先分组名 + 自身，用 / 连接 */
export interface OutlineNode extends TreeNode {
  path: string;
  /** 非分组节点的序号（0-based），分组为 undefined */
  pageIndex?: number;
}

/** 目录树匹配结果（matchTreeTarget） */
export type TreeMatchResult<T> =
  | { ok: true; target: T }
  | { ok: false; reason: string };

/** 导航结果：frameChanged=false 表示点击后 iframe 未切换（纯展开类分组节点） */
export type NavigationResult =
  | { ok: true; frameChanged: boolean }
  | { ok: false; reason: 'stale_outline' };

// ─── crawler：页面内容 ────────────────────────────────────────

/** 页面内嵌原型图元数据（设计稿/插画类大图，DOM 文字提取不到） */
export interface PageImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

/** DOM 提取的表格 */
export interface DomTable {
  headers: string[];
  rows: string[][];
}

/** 从 Axure iframe 中提取的纯文本内容 */
export interface ExtractedContent {
  text: string;
  tables: DomTable[];
  images: PageImage[];
}

// ─── screenshot ───────────────────────────────────────────────

/** 分段截图结果 */
export interface ScreenshotResult {
  /** 分段截图文件的绝对路径（按顺序） */
  segments: string[];
  totalHeight: number;
  segmentCount: number;
  isSegmented: boolean;
}

// ─── crawler → pipeline 的页面原始数据 ────────────────────────

/** crawler 产出的页面数据，是 pipeline 的输入 */
export interface CrawledPage extends ScreenshotResult {
  pageName: string;
  text: string;
  tables: DomTable[];
  images: PageImage[];
  /** 导航失败等原因写入，pipeline 会据此直接产出失败结果 */
  error?: string;
}

// ─── vlm 解析结果 ─────────────────────────────────────────────

export type FlowNodeType =
  | 'start'
  | 'end'
  | 'process'
  | 'decision'
  | 'subflow'
  | 'io';

export interface FlowNode {
  id: string;
  text: string;
  type: FlowNodeType | string;
}

export interface FlowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface FlowBranch {
  node: string;
  conditions: string[];
  targets: string[];
}

/** flowchart 类解析结果 */
export interface VlmFlowchart {
  summary?: string;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  main_flow?: string[];
  branches?: FlowBranch[];
  exception_flows?: string[];
}

export interface VlmTableData {
  title?: string;
  headers?: string[];
  rows?: string[][];
  notes?: string;
}

/** table 类解析结果 */
export interface VlmTableResult {
  tables?: VlmTableData[];
  other_data?: string[];
}

export interface VlmComponent {
  name?: string;
  type?: string;
  position?: string;
  description?: string;
}

/** page 类解析结果 */
export interface VlmPageStructure {
  page_type?: string;
  layout?: string;
  components?: VlmComponent[];
  interactions?: string[];
  states?: string[];
  visual_hierarchy?: string;
  key_info?: string[];
}

/**
 * VLM 输出的内部标记字段。
 * 下划线前缀代表「非模型产出」，由解析/合并流程附加，用于失败判定与交叉验证。
 */
export interface VlmMeta {
  /** 分段序号（1-based），多段合并时用于排序 */
  _segmentIndex?: number;
  _imagePath?: string;
  _type?: PageType;
  /** 请求/网络层错误 */
  _error?: string;
  /** 返回内容不是合法 JSON */
  _parseError?: boolean;
  /** 非法 JSON 的原始返回，便于排查 */
  _raw?: string;
  /** 以下为 merger 交叉验证产出的待复核项 */
  _unverifiedNodes?: string[];
  _unverifiedCells?: string[];
  _unverifiedComponents?: string[];
  /** 合并告警（如所有分段解析失败） */
  _mergeWarning?: string;
  _segmentCount?: number;
  _nodeCount?: number;
  _edgeCount?: number;
}

/**
 * VLM 单段解析结果。三类 Prompt 产出的字段做成了联合——
 * 具体字段是否存在取决于 type，使用处按类型分支访问。
 */
export type VlmResult = VlmFlowchart &
  VlmTableResult &
  VlmPageStructure &
  VlmMeta;

/** 提交给全局并发队列的单段解析任务 */
export interface SegmentTask {
  imagePath: string;
  type: PageType;
  segmentIndex: number;
  totalSegments: number;
  pageText?: string;
}

/** 单张图片解析的选项 */
export interface AnalyzeOptions {
  segmentIndex?: number;
  totalSegments?: number;
  pageText?: string;
}

// ─── merger 合并结果 ──────────────────────────────────────────

/** 合并后的表格；_source=vlm 表示由视觉模型从图片识别，需人工复核 */
export interface MergedTable extends DomTable {
  title?: string;
  notes?: string;
  _source?: 'vlm';
}

/** 合并后的完整页面数据，doc-generator 与 MCP 工具直接消费它 */
export interface MergedPage {
  pageName: string;
  type: PageType;
  domText: string;
  tables: MergedTable[];
  images: PageImage[];
  vlmResult: VlmResult;
  warnings: string[];
  _segmentCount: number;
  _hasVLM: boolean;
}

/** mergePageResult 的入参 */
export interface MergePageInput {
  pageName: string;
  domText: string;
  domTables?: DomTable[];
  images?: PageImage[];
  vlmSegments?: VlmResult[];
  type: PageType;
  screenshotCount?: number;
}

// ─── 缓存 ─────────────────────────────────────────────────────

/** VLM 结果缓存键的构成要素 */
export interface CacheKeyParams {
  url: string;
  pageName: string;
  imagePaths?: string[];
  type: PageType;
  vlmVersion?: string;
}

export interface CacheStats {
  total: number;
  size: number;
  failed?: boolean;
}

// ─── pipeline ─────────────────────────────────────────────────

export interface ProcessOptions {
  vlmEnabled?: boolean;
  concurrency?: number;
  /** 每页处理完成的回调，CLI 用它打印进度 */
  onPageDone?: (
    pageName: string,
    info: { cached: boolean; segments: number; result: MergedPage }
  ) => void;
}
