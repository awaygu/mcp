/**
 * 文档生成模块
 * 将合并后的页面数据生成为纯文本结构化需求文档（Markdown）
 *
 * 输出特点：
 * - 纯文本，无截图路径
 * - 结构化：业务流程 / 页面详情 / 配置规则 / 附录
 * - AI Coding Agent 可直接使用
 */
import { flowchartToMermaid, tableToMarkdown } from './vlm.js';
import type { DetailLevel, MergedPage, MergedTable, PageType } from './types.js';

/** 页面类型 → 中文名 */
const TYPE_LABELS: Record<PageType, string> = {
  flowchart: '流程图',
  table: '配置表',
  page: '普通页面',
};

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

  // 按类型分类页面
  const flowchartPages = pages.filter((p) => p.type === 'flowchart');
  const tablePages = pages.filter((p) => p.type === 'table');
  const normalPages = pages.filter((p) => p.type === 'page');

  let doc = '';

  // ─── 标题与元信息 ─────────────────────────────────────────
  doc += `# ${groupName} - 需求文档\n\n`;
  doc += `> 来源: CoDesign 产品原型`;
  if (sourceUrl) doc += ` | 链接: ${sourceUrl}`;
  doc += ` | 页面数: ${pages.length}`;
  doc += ` | 生成时间: ${dateStr}\n\n`;
  doc += `---\n\n`;

  // ─── 一、业务流程 ─────────────────────────────────────────
  if (flowchartPages.length > 0) {
    doc += `## 一、业务流程\n\n`;
    flowchartPages.forEach((page, idx) => {
      doc += generateFlowchartSection(page, idx + 1, detailLevel, flowchartPages.length);
    });
  }

  // ─── 二、页面详情 ─────────────────────────────────────────
  if (normalPages.length > 0) {
    doc += `## 二、页面详情\n\n`;
    normalPages.forEach((page, idx) => {
      doc += generatePageSection(page, idx + 1, detailLevel);
    });
  }

  // ─── 三、配置与规则 ───────────────────────────────────────
  if (tablePages.length > 0) {
    doc += `## 三、配置与规则\n\n`;
    tablePages.forEach((page, idx) => {
      doc += generateTableSection(page, idx + 1, detailLevel);
    });
  }

  // ─── 四、附录 ─────────────────────────────────────────────
  doc += generateAppendix(pages);

  return doc;
}

/**
 * 渲染页面内嵌原型图清单（按尺寸聚合——画布页几十张图不再逐行刷屏）
 */
function renderImages(page: MergedPage): string {
  const imgs = page.images || [];
  if (imgs.length === 0) return '';
  const dims = new Map<string, number>();
  imgs.forEach((im) => {
    const k = `${im.width}×${im.height}`;
    dims.set(k, (dims.get(k) || 0) + 1);
  });
  const dimsText = [...dims.entries()].map(([k, n]) => `${k}${n > 1 ? `×${n}` : ''}`).join('、');
  return `**页面内嵌原型图**：${imgs.length} 张（${dimsText}）\n\n`;
}

/**
 * 渲染未解析页面的文字：画布型页面用空间区块（XY-cut 切分），否则纯文字兜底
 */
function renderDomFallback(page: MergedPage): string {
  if (page.sections?.length) {
    let out = `**空间区块**（画布型页面，按空白带切分为 ${page.sections.length} 块，每块通常对应一个界面/弹窗）：\n\n`;
    page.sections.forEach((sec, i) => {
      const imgNote = sec.images ? ` · 含 ${sec.images} 张内嵌图` : '';
      out += `#### 区块 ${i + 1}（x ${sec.x}-${sec.x + sec.w}，y ${sec.y}-${sec.y + sec.h}${imgNote}）\n\n${sec.text}\n\n`;
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
    if (table.title) {
      out += `**${table.title}**：\n\n`;
    } else {
      out += `**表格 ${i + 1}**：\n\n`;
    }
    out += tableToMarkdown(table) + `\n`;
    if (table.notes) {
      out += `> 备注：${table.notes}\n\n`;
    }
  });
  return out;
}

/** 渲染 VLM 从图片识别的表格时附带的复核提示 */
function renderVlmTableWarning(table: MergedTable): string {
  return table._source === 'vlm'
    ? `> ⚠️ 此表格由 VLM 从图片识别，建议人工复核数据准确性\n\n`
    : '';
}

/**
 * 生成流程图章节
 */
function generateFlowchartSection(
  page: MergedPage,
  index: number,
  detailLevel: DetailLevel,
  totalFlowcharts: number
): string {
  let section = '';
  const fc = page.vlmResult || {};

  if (totalFlowcharts > 1) {
    section += `### 1.${index} ${page.pageName}\n\n`;
  }

  // 流程概述
  if (fc.summary) {
    section += `**流程概述**：${fc.summary}\n\n`;
  }

  // 主流程
  if (fc.main_flow && fc.main_flow.length > 0 && fc.nodes) {
    const nodeMap: Record<string, string> = {};
    fc.nodes.forEach((n) => (nodeMap[n.id] = n.text));
    const flowText = fc.main_flow.map((id) => nodeMap[id] || id).join(' → ');
    section += `**主流程**：${flowText}\n\n`;
  }

  // 分支与判断
  if (fc.branches && fc.branches.length > 0 && fc.nodes) {
    const nodeMap: Record<string, string> = {};
    fc.nodes.forEach((n) => (nodeMap[n.id] = n.text));
    section += `**分支与判断**：\n\n`;
    section += `| 判断节点 | 条件 | 走向 |\n`;
    section += `|---|---|---|\n`;
    fc.branches.forEach((b) => {
      const nodeText = nodeMap[b.node] || b.node;
      (b.conditions || []).forEach((cond, i) => {
        const target = b.targets?.[i];
        const targetText = target ? nodeMap[target] || target : '';
        section += `| ${nodeText} | ${cond} | ${targetText} |\n`;
      });
    });
    section += `\n`;
  }

  // 异常流程
  if (fc.exception_flows && fc.exception_flows.length > 0) {
    section += `**异常流程**：\n\n`;
    fc.exception_flows.forEach((e) => {
      section += `- ${e}\n`;
    });
    section += `\n`;
  }

  // Mermaid 流程图（standard 和 full 级别输出）
  if (detailLevel !== 'summary' && fc.nodes && fc.nodes.length > 0) {
    section += `**流程图**：\n\n`;
    section += flowchartToMermaid(fc) + `\n\n`;
  }

  // full 级别：节点详情
  if (detailLevel === 'full' && fc.nodes && fc.nodes.length > 0) {
    section += `**流程节点详情**：\n\n`;
    section += `| 节点ID | 类型 | 文字 |\n`;
    section += `|---|---|---|\n`;
    fc.nodes.forEach((n) => {
      section += `| ${n.id} | ${n.type} | ${n.text} |\n`;
    });
    section += `\n`;
  }

  // DOM 文字补充（VLM 未配置时）：画布页用空间区块，否则纯文字兜底
  section += renderDomFallback(page);

  return section;
}

/**
 * 生成普通页面章节
 */
function generatePageSection(
  page: MergedPage,
  index: number,
  detailLevel: DetailLevel
): string {
  let section = '';
  const ps = page.vlmResult || {};

  section += `### 2.${index} ${page.pageName}\n\n`;

  // 页面类型和布局
  if (ps.page_type) {
    section += `**页面类型**：${ps.page_type}\n\n`;
  }
  if (ps.layout) {
    section += `**布局结构**：${ps.layout}\n\n`;
  }

  // 页面内嵌原型图
  section += renderImages(page);

  // 核心组件
  if (ps.components && ps.components.length > 0) {
    section += `**核心组件**：\n\n`;
    section += `| 组件名 | 类型 | 说明 |\n`;
    section += `|---|---|---|\n`;
    ps.components.forEach((c) => {
      section += `| ${c.name || ''} | ${c.type || ''} | ${c.description || ''} |\n`;
    });
    section += `\n`;
  }

  // 交互行为
  if (ps.interactions && ps.interactions.length > 0) {
    section += `**交互行为**：\n\n`;
    ps.interactions.forEach((i) => {
      section += `- ${i}\n`;
    });
    section += `\n`;
  }

  // 页面状态
  if (ps.states && ps.states.length > 0 && detailLevel !== 'summary') {
    section += `**页面状态**：\n\n`;
    ps.states.forEach((s) => {
      section += `- ${s}\n`;
    });
    section += `\n`;
  }

  // 视觉层级（full 级别）
  if (detailLevel === 'full' && ps.visual_hierarchy) {
    section += `**视觉层级**：${ps.visual_hierarchy}\n\n`;
  }

  // 关键信息
  if (ps.key_info && ps.key_info.length > 0 && detailLevel !== 'summary') {
    section += `**关键信息**：\n\n`;
    ps.key_info.forEach((k) => {
      section += `- ${k}\n`;
    });
    section += `\n`;
  }

  // 数据表格（如果页面中有表格）
  if (page.tables && page.tables.length > 0) {
    section += renderTables(page.tables);
  }

  // DOM 文字补充（VLM 未配置时）：画布页用空间区块，否则纯文字兜底
  section += renderDomFallback(page);

  return section;
}

/**
 * 生成表格/配置章节
 */
function generateTableSection(
  page: MergedPage,
  index: number,
  // 配置表章节当前不区分详细度，保留参数是为了和各章节渲染函数签名一致
  _detailLevel: DetailLevel
): string {
  let section = '';

  section += `### 3.${index} ${page.pageName}\n\n`;

  // 页面概述（DOM 文字前几行）
  if (page.domText) {
    const firstLines = page.domText.split('\n').slice(0, 5).join('\n');
    section += `**说明**：\n\n${firstLines}\n\n`;
  }

  // 页面内嵌原型图
  section += renderImages(page);

  // 所有表格
  if (page.tables && page.tables.length > 0) {
    page.tables.forEach((table, i) => {
      if (table.title) {
        section += `**${table.title}**：\n\n`;
      } else {
        section += `**表格 ${i + 1}**：\n\n`;
      }
      section += tableToMarkdown(table) + `\n`;
      if (table.notes) {
        section += `> 备注：${table.notes}\n\n`;
      }
      section += renderVlmTableWarning(table);
    });
  }

  // VLM 识别的其他数据
  if (page.vlmResult?.other_data && page.vlmResult.other_data.length > 0) {
    section += `**其他重要信息**：\n\n`;
    page.vlmResult.other_data.forEach((d) => {
      section += `- ${d}\n`;
    });
    section += `\n`;
  }

  return section;
}

/**
 * 生成附录
 */
function generateAppendix(pages: MergedPage[]): string {
  let appendix = `## 四、附录\n\n`;

  // 4.1 解析置信度
  appendix += `### 4.1 解析置信度\n\n`;
  appendix += `| 页面 | 类型 | 解析方式 | 分段数 | 置信度 | 备注 |\n`;
  appendix += `|---|---|---|---|---|---|\n`;

  pages.forEach((p) => {
    const method = p._hasVLM ? 'DOM+VLM' : '仅DOM';
    const segments = p._segmentCount || 0;
    let confidence = '中';
    let remark = '';

    if (p._hasVLM && segments > 1) {
      confidence = '高';
    } else if (p._hasVLM) {
      confidence = '中高';
    } else {
      confidence = '低';
      remark = 'VLM 未配置，仅提取 DOM 文字';
    }

    if (p.warnings && p.warnings.length > 0) {
      remark = p.warnings.join('; ');
      confidence = '待复核';
    }

    appendix += `| ${p.pageName} | ${TYPE_LABELS[p.type] || p.type} | ${method} | ${segments} | ${confidence} | ${remark} |\n`;
  });
  appendix += `\n`;

  // 4.2 待确认项
  const allWarnings: string[] = [];
  pages.forEach((p) => {
    if (p.warnings && p.warnings.length > 0) {
      p.warnings.forEach((w) => {
        allWarnings.push(`[${p.pageName}] ${w}`);
      });
    }
    if (p.vlmResult?._unverifiedNodes) {
      p.vlmResult._unverifiedNodes.forEach((n) => {
        allWarnings.push(`[${p.pageName}] 流程图节点「${n}」未在 DOM 文字中找到，可能为 VLM 误识别`);
      });
    }
    if (p.vlmResult?._unverifiedCells) {
      allWarnings.push(
        `[${p.pageName}] 表格中有 ${p.vlmResult._unverifiedCells.length} 个单元格内容未在 DOM 中找到，建议复核`
      );
    }
  });

  appendix += `### 4.2 待确认项\n\n`;
  if (allWarnings.length > 0) {
    allWarnings.forEach((w) => {
      appendix += `- ${w}\n`;
    });
    appendix += `\n`;
  } else {
    appendix += `无\n\n`;
  }

  return appendix;
}
