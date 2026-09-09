/**
 * 文档生成模块
 * 将合并后的页面数据生成为**适合 AI Coding Agent 直接消费**的结构化需求文档
 *
 * 设计原则（相对旧版 innerText 一维文本流的改进）：
 * - **分区输出**：表格 / 流程 / 规则 / 文案 / 交互 / 状态 各自成节，Agent 不用猜哪行是表头
 * - **DOM 优先**：`.table_cell` 网格与连接线几何是确定性结果，排在前面并标注来源
 * - **VLM 补充**：视觉模型产出的组件/交互/状态作为增强，附复核提示，两者不互相覆盖
 * - **来源可追溯**：每个区块标明 DOM(确定性) 还是 VLM(需复核)，文末汇总待确认项
 */
import { flowchartToMermaid, tableToMarkdown } from './vlm.js';
import type { AxureBlock, AxureFlow } from './axure-dom.js';
import type { DetailLevel, MergedPage, MergedTable, PageType } from './types.js';

/** 页面类型 → 中文名 */
const TYPE_LABELS: Record<PageType, string> = {
  flowchart: '流程图',
  table: '配置表',
  page: '普通页面',
};

/** 短文案阈值：单行且不超过该长度判定为「界面文案」，否则算「说明/规则」 */
const SHORT_LABEL_LIMIT = 12;

export interface GenerateDocParams {
  /** 需求分组名称 */
  groupName: string;
  /** 来源链接 */
  sourceUrl?: string;
  /** 合并后的页面数据数组 */
  pages?: MergedPage[];
  /** 详细程度 */
  detailLevel?: DetailLevel;
}

/** 生成「YYYY-MM-DD」格式的日期 */
function todayStamp(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** 控件块分组结果 */
interface BlockGroups {
  /** 说明 / 规则类（多行或长文本） */
  rules: { type: string; lines: string[] }[];
  /** 界面文案类（短标签，去重并计数） */
  labels: { type: string; text: string; count: number }[];
}

/**
 * 把控件块按长度分成「说明/规则」与「界面文案」两类。
 * 原型里按钮/标签文案极多（去购买×4、用户头像×N），去重计数避免刷屏。
 */
function groupBlocks(blocks?: AxureBlock[]): BlockGroups {
  const rules: BlockGroups['rules'] = [];
  const labelMap = new Map<string, { type: string; count: number }>();

  for (const b of blocks || []) {
    if (!b.lines.length) continue;
    if (b.lines.length === 1 && b.lines[0].length <= SHORT_LABEL_LIMIT) {
      const prev = labelMap.get(b.lines[0]);
      if (prev) prev.count += 1;
      else labelMap.set(b.lines[0], { type: b.type, count: 1 });
    } else {
      rules.push({ type: b.type, lines: b.lines });
    }
  }
  return {
    rules,
    labels: [...labelMap.entries()].map(([text, v]) => ({ text, ...v })),
  };
}

/** 渲染内嵌原型图清单（按尺寸聚合，画布页几十张图不逐行刷屏） */
function renderImages(page: MergedPage): string {
  const imgs = page.images || [];
  if (imgs.length === 0) return '';
  const dims = new Map<string, number>();
  imgs.forEach((im) => {
    const k = `${im.width}×${im.height}`;
    dims.set(k, (dims.get(k) || 0) + 1);
  });
  const dimsText = [...dims.entries()].map(([k, n]) => `${k}${n > 1 ? `×${n}` : ''}`).join('、');
  return `**内嵌原型图**：${imgs.length} 张（${dimsText}）\n\n`;
}

/** 渲染未解析页面的文字：画布型页面用空间区块，否则纯文字兜底 */
function renderDomFallback(page: MergedPage): string {
  if (page.sections?.length) {
    let out = `**空间区块**（画布型页面，按大内嵌图锚点切分为 ${page.sections.length} 块，每块通常对应一个界面/弹窗）：\n\n`;
    page.sections.forEach((sec, i) => {
      const imgNote = sec.images ? ` · 含 ${sec.images} 张内嵌图` : '';
      out += `##### 区块 ${i + 1}（x ${sec.x}-${sec.x + sec.w}，y ${sec.y}-${sec.y + sec.h}${imgNote}）\n\n${sec.text}\n\n`;
    });
    return out;
  }
  if (page.domText) {
    return `**页面文字**（未经视觉解析，表格/图形布局可能已丢失）：\n\n${page.domText}\n\n`;
  }
  return '';
}

/** 渲染一组表格（带标题/序号与备注） */
function renderTables(tables: MergedTable[]): string {
  let out = '';
  tables.forEach((table, i) => {
    if (table.title) out += `**${table.title}**：\n\n`;
    else out += `**表格 ${i + 1}**：\n\n`;
    out += tableToMarkdown(table) + `\n`;
    if (table.notes) out += `> 备注：${table.notes}\n\n`;
    if (table._source === 'vlm') {
      out += `> ⚠️ 此表格由 VLM 从图片识别，建议人工复核数据准确性\n\n`;
    }
  });
  return out;
}

/** 空表判定：只有表头没有数据行（埋点/字段定义页很常见） */
function isHeaderOnlyTable(t: MergedTable): boolean {
  return !t.rows?.some((r) => r.some((c) => String(c ?? '').trim()));
}

/**
 * 渲染 DOM 连接线几何还原的流程图（确定性结果，非视觉模型猜测）
 */
function renderDomFlow(flow: AxureFlow, detailLevel: DetailLevel): string {
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  flow.nodes.forEach((n) => { outDeg.set(n.id, 0); inDeg.set(n.id, 0); });
  flow.edges.forEach((e) => {
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  });

  // 无入度=起点、无出度=终点，用于 Mermaid 形状
  const shaped = flow.nodes.map((n) => ({
    id: n.id,
    text: n.text,
    type: (inDeg.get(n.id) || 0) === 0 ? 'start' : (outDeg.get(n.id) || 0) === 0 ? 'end' : 'process',
  }));
  const textOf = new Map(flow.nodes.map((n) => [n.id, n.text]));

  let out = `> 来源：DOM 连接线几何还原（确定性，非视觉模型识别）\n\n`;
  out += `**流程节点**（${flow.nodes.length}）：\n\n`;
  out += `| 节点 | 文字 | 控件类型 |\n|---|---|---|\n`;
  flow.nodes.forEach((n) => { out += `| ${n.id} | ${n.text} | ${n.type} |\n`; });
  out += `\n`;

  out += `**流程连线**（${flow.edges.length}）：\n\n`;
  flow.edges.forEach((e) => {
    const from = textOf.get(e.from) || e.from;
    const to = textOf.get(e.to) || e.to;
    out += `- ${from} ${e.label ? `--[${e.label}]-->` : '-->'} ${to}\n`;
  });
  out += `\n`;

  if (detailLevel !== 'summary') {
    out += `**流程图**：\n\n${flowchartToMermaid({
      nodes: shaped,
      edges: flow.edges.map((e) => ({ from: e.from, to: e.to, condition: e.label })),
    })}\n\n`;
  }
  return out;
}

/** 渲染「说明与规则 + 界面文案」两块（结构化 DOM 提取的主产出） */
function renderBlocks(page: MergedPage, detailLevel: DetailLevel): string {
  const { rules, labels } = groupBlocks(page.blocks);
  if (!rules.length && !labels.length) return '';

  let out = '';
  if (rules.length) {
    out += `**说明与规则**（${rules.length} 条，DOM 确定性提取）：\n\n`;
    rules.forEach((r) => {
      out += `- ${r.lines[0]}\n`;
      r.lines.slice(1).forEach((l) => { out += `  - ${l}\n`; });
    });
    out += `\n`;
  }

  if (labels.length) {
    const limit = detailLevel === 'full' ? Infinity : 60;
    const shown = labels.slice(0, limit);
    out += `**界面文案清单**（${labels.length} 个，已去重；\`类型\` 为 Axure 控件类型）：\n\n`;
    shown.forEach((l) => {
      out += `- ${l.text}${l.count > 1 ? ` ×${l.count}` : ''} \`${l.type}\`\n`;
    });
    if (shown.length < labels.length) {
      out += `- …（其余 ${labels.length - shown.length} 个，用 detailLevel:full 查看全部）\n`;
    }
    out += `\n`;
  }
  return out;
}

/** 渲染 VLM 补充信息（组件/交互/状态/关键信息） */
function renderVlmExtras(page: MergedPage, detailLevel: DetailLevel): string {
  const ps = page.vlmResult || {};
  const has =
    !!ps.components?.length || !!ps.interactions?.length ||
    !!ps.states?.length || !!ps.key_info?.length || !!ps.layout || !!ps.page_type;
  if (!has) return '';

  let out = `**视觉模型补充**（VLM 识别，含推测成分，建议复核）：\n\n`;
  if (ps.page_type) out += `- 页面类型：${ps.page_type}\n`;
  if (ps.layout) out += `- 布局结构：${ps.layout}\n`;
  if (ps.layout || ps.page_type) out += `\n`;

  if (ps.components?.length) {
    out += `| 组件 | 类型 | 说明 |\n|---|---|---|\n`;
    ps.components.forEach((c) => {
      out += `| ${c.name || ''} | ${c.type || ''} | ${c.description || ''} |\n`;
    });
    out += `\n`;
  }
  if (ps.interactions?.length) {
    out += `交互行为：\n`;
    ps.interactions.forEach((i) => { out += `- ${i}\n`; });
    out += `\n`;
  }
  if (ps.states?.length && detailLevel !== 'summary') {
    out += `页面状态：\n`;
    ps.states.forEach((s) => { out += `- ${s}\n`; });
    out += `\n`;
  }
  if (ps.key_info?.length && detailLevel !== 'summary') {
    out += `关键信息：\n`;
    ps.key_info.forEach((k) => { out += `- ${k}\n`; });
    out += `\n`;
  }
  if (detailLevel === 'full' && ps.visual_hierarchy) {
    out += `视觉层级：${ps.visual_hierarchy}\n\n`;
  }
  return out;
}

/** 页面级「待确认」汇总 */
function renderPageWarnings(page: MergedPage): string {
  const items: string[] = [...(page.warnings || [])];
  const v = page.vlmResult || {};
  if (v._unverifiedNodes?.length) {
    items.push(`流程图节点「${v._unverifiedNodes.join('、')}」未在 DOM 文字中找到，可能误识别`);
  }
  if (v._unverifiedCells?.length) {
    items.push(`表格有 ${v._unverifiedCells.length} 个单元格未在 DOM 中找到，建议复核`);
  }
  if (!items.length) return '';
  let out = `**待确认**：\n\n`;
  items.forEach((w) => { out += `- ⚠️ ${w}\n`; });
  out += `\n`;
  return out;
}

/** 生成页面头部元信息（解析来源一眼可见） */
function renderHeader(page: MergedPage): string {
  const parts: string[] = [`类型：${TYPE_LABELS[page.type] || page.type}`];
  const sources: string[] = [];
  if (page.blocks?.length) sources.push('DOM 结构化');
  if (page.flow) sources.push('DOM 流程图拓扑');
  if (page._hasVLM) sources.push('VLM');
  if (sources.length) parts.push(`解析来源：${sources.join(' + ')}`);
  if (page._segmentCount) parts.push(`截图 ${page._segmentCount} 段`);
  return `> ${parts.join(' | ')}\n\n`;
}

/**
 * 生成完整需求文档
 * @returns Markdown 文档
 */
export function generateRequirementDoc({
  groupName,
  sourceUrl = '',
  pages = [],
  detailLevel = 'standard',
}: GenerateDocParams): string {
  const dateStr = todayStamp();

  const flowchartPages = pages.filter((p) => p.type === 'flowchart');
  const tablePages = pages.filter((p) => p.type === 'table');
  const normalPages = pages.filter((p) => p.type === 'page');

  let doc = '';

  doc += `# ${groupName} - 需求文档\n\n`;
  doc += `> 来源: CoDesign 产品原型`;
  if (sourceUrl) doc += ` | 链接: ${sourceUrl}`;
  doc += ` | 页面数: ${pages.length}`;
  doc += ` | 生成时间: ${dateStr}\n\n`;
  doc += `> 阅读说明：表格 / 流程 / 规则来自 DOM 确定性提取，可直接使用；标注「视觉模型补充」的内容来自 VLM，含推测成分；文末「待确认项」需人工核对。\n\n`;
  doc += `---\n\n`;

  if (flowchartPages.length > 0) {
    doc += `## 一、业务流程\n\n`;
    flowchartPages.forEach((page, idx) => {
      doc += generateFlowchartSection(page, idx + 1, detailLevel, flowchartPages.length);
    });
  }

  if (normalPages.length > 0) {
    doc += `## 二、页面详情\n\n`;
    normalPages.forEach((page, idx) => {
      doc += generatePageSection(page, idx + 1, detailLevel);
    });
  }

  if (tablePages.length > 0) {
    doc += `## 三、配置与规则\n\n`;
    tablePages.forEach((page, idx) => {
      doc += generateTableSection(page, idx + 1);
    });
  }

  doc += generateAppendix(pages);
  return doc;
}

/** 生成流程图章节；index 为 null 时不输出标题 */
function generateFlowchartSection(
  page: MergedPage,
  index: number | null,
  detailLevel: DetailLevel,
  totalFlowcharts: number
): string {
  let section = '';
  if (totalFlowcharts > 1 && index !== null) section += `### 1.${index} ${page.pageName}\n\n`;
  section += renderHeader(page);

  const fc = page.vlmResult || {};

  // 优先用 DOM 连接线几何还原的拓扑（确定性）
  if (page.flow && page.flow.nodes.length) {
    section += renderDomFlow(page.flow, detailLevel);
  } else if (fc.nodes?.length) {
    section += `> 来源：视觉模型识别（未从 DOM 连接线还原出拓扑，以下为推测）\n\n`;
    if (fc.summary) section += `**流程概述**：${fc.summary}\n\n`;
    if (fc.main_flow?.length && fc.nodes) {
      const nodeMap: Record<string, string> = {};
      fc.nodes.forEach((n) => { nodeMap[n.id] = n.text; });
      section += `**主流程**：${fc.main_flow.map((id) => nodeMap[id] || id).join(' → ')}\n\n`;
    }
    if (detailLevel !== 'summary') {
      section += `**流程图**：\n\n${flowchartToMermaid(fc)}\n\n`;
    }
    if (detailLevel === 'full' && fc.nodes.length) {
      section += `**流程节点详情**：\n\n| 节点ID | 类型 | 文字 |\n|---|---|---|\n`;
      fc.nodes.forEach((n) => { section += `| ${n.id} | ${n.type} | ${n.text} |\n`; });
      section += `\n`;
    }
  }

  // VLM 的概述/分支/异常流作为补充（DOM 拓扑拿不到这些语义）
  if (page.flow && (fc.summary || fc.branches?.length || fc.exception_flows?.length)) {
    section += `**视觉模型补充**：\n\n`;
    if (fc.summary) section += `- 流程概述：${fc.summary}\n`;
    (fc.branches || []).forEach((b) => {
      section += `- 分支节点 ${b.node}：条件 ${(b.conditions || []).join(' / ')}\n`;
    });
    (fc.exception_flows || []).forEach((e) => { section += `- 异常流：${e}\n`; });
    section += `\n`;
  }

  section += renderBlocks(page, detailLevel);
  section += renderImages(page);
  section += renderPageWarnings(page);
  return section;
}

/** 生成普通页面章节；index 为 null 时不输出标题（单页文档场景由调用方出标题） */
function generatePageSection(
  page: MergedPage,
  index: number | null,
  detailLevel: DetailLevel
): string {
  let section = '';
  if (index !== null) section += `### 2.${index} ${page.pageName}\n\n`;
  section += renderHeader(page);
  section += renderImages(page);

  if (page.tables?.length) section += renderTables(page.tables);
  section += renderBlocks(page, detailLevel);
  section += renderVlmExtras(page, detailLevel);

  // 空间区块 / 纯文字兜底：VLM 没覆盖时用 DOM 结构化结果顶上
  if (!page._hasVLM) section += renderDomFallback(page);
  else if (page.sections?.length && detailLevel === 'full') section += renderDomFallback(page);

  section += renderPageWarnings(page);
  return section;
}

/** 生成表格/配置章节；index 为 null 时不输出标题 */
function generateTableSection(page: MergedPage, index: number | null): string {
  let section = '';
  if (index !== null) section += `### 3.${index} ${page.pageName}\n\n`;
  section += renderHeader(page);
  section += renderImages(page);

  if (page.tables?.length) {
    const filled = page.tables.filter((t) => !isHeaderOnlyTable(t));
    const empty = page.tables.filter(isHeaderOnlyTable);
    if (filled.length) section += renderTables(filled);
    if (empty.length) {
      section += `**字段定义表**（仅有表头，是待填写的字段清单 / 埋点定义，非业务数据）：\n\n`;
      section += renderTables(empty);
    }
  }

  if (page.vlmResult?.other_data?.length) {
    section += `**其他重要信息**（VLM）：\n\n`;
    page.vlmResult.other_data.forEach((d) => { section += `- ${d}\n`; });
    section += `\n`;
  }

  // 配置表页也常有规则说明，来自 DOM 结构化提取
  section += renderBlocks(page, 'standard');
  if (!page._hasVLM && page.domText) {
    const firstLines = page.domText.split('\n').slice(0, 5).join('\n');
    section += `**页面文字**（未视觉解析）：\n\n${firstLines}\n\n`;
  }
  section += renderPageWarnings(page);
  return section;
}

/**
 * 生成单个页面的结构化文档（供 get_page_content 单独读页时使用）
 */
export function generateSinglePageDoc(
  page: MergedPage,
  detailLevel: DetailLevel = 'standard'
): string {
  let doc = `# ${page.pageName}\n\n`;
  if (page.type === 'flowchart') doc += generateFlowchartSection(page, null, detailLevel, 1);
  else if (page.type === 'table') doc += generateTableSection(page, null);
  else doc += generatePageSection(page, null, detailLevel);
  return doc;
}

/** 生成附录 */
function generateAppendix(pages: MergedPage[]): string {
  let appendix = `## 四、附录\n\n`;

  appendix += `### 4.1 解析来源与置信度\n\n`;
  appendix += `| 页面 | 类型 | 解析方式 | 分段数 | 表格 | 控件块 | 置信度 | 备注 |\n`;
  appendix += `|---|---|---|---|---|---|---|---|\n`;

  pages.forEach((p) => {
    const methods: string[] = [];
    if (p.blocks?.length) methods.push('DOM结构化');
    if (p.flow) methods.push('DOM拓扑');
    if (p._hasVLM) methods.push('VLM');
    const method = methods.length ? methods.join('+') : '仅DOM';

    let confidence = '低';
    let remark = '';
    if (p.flow) {
      confidence = '高'; // 连接线几何还原 = 确定性结果
      remark = '流程图拓扑由 DOM 连接线还原';
    } else if (p._hasVLM && (p.blocks?.length || p.tables?.length)) {
      confidence = '中高';
    } else if (p.blocks?.length || p.tables?.length) {
      confidence = '中';
      remark = '未启用 VLM，仅 DOM 确定性提取';
    } else {
      remark = '无有效提取结果';
    }
    if (p.warnings?.length) {
      remark = p.warnings.join('; ');
      confidence = '待复核';
    }

    appendix += `| ${p.pageName} | ${TYPE_LABELS[p.type] || p.type} | ${method} | ${p._segmentCount || 0} | ${p.tables?.length || 0} | ${p.blocks?.length || 0} | ${confidence} | ${remark} |\n`;
  });
  appendix += `\n`;

  appendix += `### 4.2 待确认项\n\n`;
  const allWarnings: string[] = [];
  pages.forEach((p) => {
    (p.warnings || []).forEach((w) => allWarnings.push(`[${p.pageName}] ${w}`));
    const v = p.vlmResult;
    if (v?._unverifiedNodes?.length) {
      allWarnings.push(`[${p.pageName}] 流程图节点「${v._unverifiedNodes.join('、')}」未在 DOM 文字中找到，可能为 VLM 误识别`);
    }
    if (v?._unverifiedCells?.length) {
      allWarnings.push(`[${p.pageName}] 表格有 ${v._unverifiedCells.length} 个单元格未在 DOM 中找到，建议复核`);
    }
  });

  if (allWarnings.length) {
    allWarnings.forEach((w) => { appendix += `- ${w}\n`; });
    appendix += `\n`;
  } else {
    appendix += `无\n\n`;
  }

  return appendix;
}
