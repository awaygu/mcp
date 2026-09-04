/**
 * 结果合并模块
 * 负责将多段 VLM 解析结果 + DOM 文字提取结果，合并成完整的页面结构化数据
 *
 * 合并策略：
 * - 流程图：节点去重、连线补全、分支合并
 * - 表格：表格匹配、行去重、截断行补全
 * - 普通页面：组件去重、交互合并、布局拼接
 */
import type {
  FlowBranch,
  FlowEdge,
  FlowNode,
  MergedPage,
  MergedTable,
  MergePageInput,
  PageType,
  VlmFlowchart,
  VlmMeta,
  VlmPageStructure,
  VlmResult,
  VlmTableData,
} from './types.js';

/** 合并后的流程图（含合并过程附加的统计字段） */
type MergedFlowchart = VlmFlowchart & {
  _mergeWarning?: string;
  _segmentCount?: number;
  _nodeCount?: number;
  _edgeCount?: number;
};

/** 表格合并期间用于行去重的内部类型，_rowKeys 会在返回前剥离 */
type TableWithRowKeys = VlmTableData & { _rowKeys?: Set<string> };

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * 计算两个字符串的相似度（0-1）
 * 基于字符级别的 Jaccard 相似度
 */
function stringSimilarity(a: unknown, b: unknown): number {
  if (!a || !b) return 0;
  const s1 = String(a).toLowerCase().trim();
  const s2 = String(b).toLowerCase().trim();
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;

  const set1 = new Set(s1.split(''));
  const set2 = new Set(s2.split(''));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

/**
 * 文本归一化（用于去重比较）
 */
function normalize(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？\n\r\t]/g, '')
    .trim();
}

/** 过滤掉失败或为空的分段 */
function validSegments(segments: VlmResult[]): VlmResult[] {
  return segments.filter((s) => s && !s._error && !s._parseError);
}

// ─── 流程图合并 ───────────────────────────────────────────────

/**
 * 合并多段流程图解析结果
 */
export function mergeFlowcharts(segments: VlmResult[]): MergedFlowchart {
  const valid = validSegments(segments);
  if (valid.length === 0) {
    return {
      summary: '',
      nodes: [],
      edges: [],
      main_flow: [],
      branches: [],
      exception_flows: [],
      _mergeWarning: segments.length > 0 ? '所有分段解析失败' : '无解析结果',
    };
  }

  if (valid.length === 1) {
    return valid[0];
  }

  // 按段序号排序
  valid.sort((a, b) => (a._segmentIndex || 0) - (b._segmentIndex || 0));

  const mergedNodes: FlowNode[] = [];
  const nodeIdMap: Record<string, string> = {}; // 旧ID -> 新ID
  const nodeTextMap: Record<string, string> = {}; // 归一化文字 -> 新ID

  // 1. 合并节点（去重）
  let nodeCounter = 0;
  for (const seg of valid) {
    for (const node of seg.nodes || []) {
      const normText = normalize(node.text);
      if (nodeTextMap[normText]) {
        // 重复节点，记录 ID 映射
        nodeIdMap[node.id] = nodeTextMap[normText];
      } else {
        const newId = `n${++nodeCounter}`;
        nodeIdMap[node.id] = newId;
        nodeTextMap[normText] = newId;
        mergedNodes.push({ ...node, id: newId });
      }
    }
  }

  // 2. 合并连线（去重 + ID 映射）
  const mergedEdges: FlowEdge[] = [];
  const edgeKeySet = new Set<string>();
  for (const seg of valid) {
    for (const edge of seg.edges || []) {
      const from = nodeIdMap[edge.from] || edge.from;
      const to = nodeIdMap[edge.to] || edge.to;
      const condition = edge.condition || '';
      const key = `${from}->${to}:${normalize(condition)}`;
      if (!edgeKeySet.has(key)) {
        edgeKeySet.add(key);
        mergedEdges.push({ from, to, condition });
      }
    }
  }

  // 3. 段间连线补全（前一段最后一个节点 -> 后一段第一个节点）
  for (let i = 0; i < valid.length - 1; i++) {
    const segA = valid[i];
    const segB = valid[i + 1];
    const nodesA = segA.nodes;
    const nodesB = segB.nodes;
    const lastNodeA = nodesA?.[nodesA.length - 1];
    const firstNodeB = nodesB?.[0];
    if (lastNodeA && firstNodeB) {
      const from = nodeIdMap[lastNodeA.id];
      const to = nodeIdMap[firstNodeB.id];
      if (from && to && from !== to) {
        const key = `${from}->${to}:`;
        if (!edgeKeySet.has(key)) {
          // 检查是否已有从 from 出发的连线，如果有则不补
          const hasFromEdge = mergedEdges.some((e) => e.from === from);
          if (!hasFromEdge) {
            edgeKeySet.add(key);
            mergedEdges.push({ from, to, condition: '' });
          }
        }
      }
    }
  }

  // 4. 合并主流程
  const mergedMainFlow: string[] = [];
  for (const seg of valid) {
    for (const nodeId of seg.main_flow || []) {
      const mappedId = nodeIdMap[nodeId] || nodeId;
      if (!mergedMainFlow.includes(mappedId)) {
        mergedMainFlow.push(mappedId);
      }
    }
  }

  // 5. 合并分支
  const mergedBranches: FlowBranch[] = [];
  const branchNodeMap: Record<string, FlowBranch> = {};
  for (const seg of valid) {
    for (const branch of seg.branches || []) {
      const nodeId = nodeIdMap[branch.node] || branch.node;
      if (!branchNodeMap[nodeId]) {
        branchNodeMap[nodeId] = { node: nodeId, conditions: [], targets: [] };
        mergedBranches.push(branchNodeMap[nodeId]);
      }
      const existing = branchNodeMap[nodeId];
      (branch.conditions || []).forEach((c, i) => {
        const target = branch.targets?.[i];
        const mappedTarget = target ? nodeIdMap[target] || target : '';
        const condKey = normalize(c);
        if (!existing.conditions.some((ec) => normalize(ec) === condKey)) {
          existing.conditions.push(c);
          existing.targets.push(mappedTarget);
        }
      });
    }
  }

  // 6. 合并异常流
  const mergedExceptions: string[] = [];
  for (const seg of valid) {
    for (const exc of seg.exception_flows || []) {
      const norm = normalize(exc);
      if (!mergedExceptions.some((e) => normalize(e) === norm)) {
        mergedExceptions.push(exc);
      }
    }
  }

  // 7. 合并概述
  const summaries = valid
    .map((s) => s.summary)
    .filter(Boolean)
    .join(' ');

  return {
    summary: summaries || '',
    nodes: mergedNodes,
    edges: mergedEdges,
    main_flow: mergedMainFlow,
    branches: mergedBranches,
    exception_flows: mergedExceptions,
    _segmentCount: valid.length,
    _nodeCount: mergedNodes.length,
    _edgeCount: mergedEdges.length,
  };
}

// ─── 表格合并 ─────────────────────────────────────────────────

/**
 * 合并多段表格解析结果
 */
export function mergeTables(segments: VlmResult[]): VlmTableData[] {
  const valid = validSegments(segments);
  if (valid.length === 0) return [];

  const allTables: VlmTableData[] = [];
  for (const seg of valid) {
    for (const table of seg.tables || []) {
      allTables.push({ ...table, _segmentIndex: seg._segmentIndex } as VlmTableData);
    }
  }

  if (allTables.length === 0) return [];
  if (allTables.length === 1) return [allTables[0]];

  // 表格匹配：标题相同或 headers 相似度 > 0.7
  const mergedTables: TableWithRowKeys[] = [];
  for (const table of allTables) {
    let matched: TableWithRowKeys | null = null;
    for (const existing of mergedTables) {
      // 标题匹配
      if (table.title && existing.title && normalize(table.title) === normalize(existing.title)) {
        matched = existing;
        break;
      }
      // headers 相似度匹配
      const headersSim = calcHeadersSimilarity(table.headers, existing.headers);
      if (headersSim > 0.7) {
        matched = existing;
        break;
      }
    }

    if (matched) {
      // 合并行（去重）
      matched._rowKeys ??= new Set<string>();
      for (const row of table.rows || []) {
        const rowKey = normalize(row.join('|'));
        if (!matched._rowKeys.has(rowKey)) {
          matched._rowKeys.add(rowKey);
          matched.rows = [...(matched.rows || []), row];
        }
      }
      // 合并 notes
      if (table.notes && !matched.notes) {
        matched.notes = table.notes;
      } else if (table.notes && matched.notes && !matched.notes.includes(table.notes)) {
        matched.notes += '; ' + table.notes;
      }
    } else {
      mergedTables.push({
        ...table,
        _rowKeys: new Set((table.rows || []).map((r) => normalize(r.join('|')))),
      });
    }
  }

  // 清理内部字段
  return mergedTables.map(({ _rowKeys: _ignored, ...rest }) => rest);
}

/**
 * 计算两个 headers 数组的相似度
 */
function calcHeadersSimilarity(h1?: string[], h2?: string[]): number {
  if (!h1 || !h2 || h1.length === 0 || h2.length === 0) return 0;
  if (h1.length !== h2.length) return 0.3;
  let matchCount = 0;
  for (let i = 0; i < h1.length; i++) {
    if (stringSimilarity(h1[i], h2[i]) > 0.6) matchCount++;
  }
  return matchCount / h1.length;
}

// ─── 普通页面合并 ─────────────────────────────────────────────

/**
 * 合并多段普通页面解析结果
 */
export function mergePageStructures(segments: VlmResult[]): VlmPageStructure & VlmMeta {
  const valid = validSegments(segments);
  if (valid.length === 0) {
    return {
      page_type: '',
      layout: '',
      components: [],
      interactions: [],
      states: [],
      visual_hierarchy: '',
      key_info: [],
    };
  }

  if (valid.length === 1) return valid[0];

  valid.sort((a, b) => (a._segmentIndex || 0) - (b._segmentIndex || 0));

  // 合并组件（名称+类型去重）
  const mergedComponents: VlmPageStructure['components'] = [];
  const compKeySet = new Set<string>();
  for (const seg of valid) {
    for (const comp of seg.components || []) {
      const key = normalize(comp.name + '|' + comp.type);
      if (!compKeySet.has(key)) {
        compKeySet.add(key);
        mergedComponents.push(comp);
      }
    }
  }

  // 合并交互（去重）
  const mergedInteractions: string[] = [];
  for (const seg of valid) {
    for (const inter of seg.interactions || []) {
      const norm = normalize(inter);
      if (!mergedInteractions.some((i) => normalize(i) === norm)) {
        mergedInteractions.push(inter);
      }
    }
  }

  // 合并状态（去重）
  const mergedStates: string[] = [];
  for (const seg of valid) {
    for (const state of seg.states || []) {
      const norm = normalize(state);
      if (!mergedStates.some((s) => normalize(s) === norm)) {
        mergedStates.push(state);
      }
    }
  }

  // 合并关键信息（去重）
  const mergedKeyInfo: string[] = [];
  for (const seg of valid) {
    for (const info of seg.key_info || []) {
      const norm = normalize(info);
      if (!mergedKeyInfo.some((i) => normalize(i) === norm)) {
        mergedKeyInfo.push(info);
      }
    }
  }

  // 布局描述拼接
  const layouts = valid
    .map((s, i) => {
      const prefix = valid.length > 1 ? `[第${i + 1}段] ` : '';
      return prefix + (s.layout || '');
    })
    .filter(Boolean);

  // 页面类型：取第一个非空
  const pageType = valid.find((s) => s.page_type)?.page_type || '';

  // 视觉层级拼接
  const visualHierarchy = valid
    .map((s) => s.visual_hierarchy)
    .filter(Boolean)
    .join(' ');

  return {
    page_type: pageType,
    layout: layouts.join('\n'),
    components: mergedComponents,
    interactions: mergedInteractions,
    states: mergedStates,
    visual_hierarchy: visualHierarchy,
    key_info: mergedKeyInfo,
    _segmentCount: valid.length,
  };
}

// ─── DOM 与 VLM 交叉验证 ──────────────────────────────────────

/**
 * DOM 文字与 VLM 结果交叉验证
 */
export function crossValidate(
  domText: string,
  vlmResult: VlmResult,
  type: PageType
): { verified: VlmResult; warnings: string[] } {
  const warnings: string[] = [];
  const verified: VlmResult = { ...vlmResult };

  if (!domText || domText.length < 10) {
    warnings.push('DOM 文字提取为空，完全依赖 VLM 识别');
    return { verified, warnings };
  }

  const normDom = normalize(domText);

  if (type === 'flowchart') {
    // 验证节点文字是否在 DOM 中出现
    const unverifiedNodes = verified._unverifiedNodes || [];
    for (const node of vlmResult.nodes || []) {
      const nodeText = normalize(node.text);
      if (nodeText.length > 2 && !normDom.includes(nodeText.slice(0, 4))) {
        // 节点文字不在 DOM 中，可能是 VLM 误识别或 DOM 提取不全
        // 不删除，只标注
        unverifiedNodes.push(node.text);
      }
    }
    if (unverifiedNodes.length > 0) verified._unverifiedNodes = unverifiedNodes;
  }

  if (type === 'table') {
    // 验证表格数据
    const unverifiedCells = verified._unverifiedCells || [];
    for (const table of vlmResult.tables || []) {
      for (const row of table.rows || []) {
        for (const cell of row) {
          const cellNorm = normalize(cell);
          if (cellNorm.length > 3 && !normDom.includes(cellNorm.slice(0, 4))) {
            unverifiedCells.push(cell);
          }
        }
      }
    }
    if (unverifiedCells.length > 0) {
      verified._unverifiedCells = unverifiedCells;
      warnings.push(
        `表格中有 ${unverifiedCells.length} 个单元格内容未在 DOM 文字中找到，可能为图片识别，建议人工复核`
      );
    }
  }

  if (type === 'page') {
    // 验证组件名称
    const unverifiedComponents = verified._unverifiedComponents || [];
    for (const comp of vlmResult.components || []) {
      const compName = normalize(comp.name);
      if (compName.length > 2 && !normDom.includes(compName.slice(0, 3))) {
        unverifiedComponents.push(comp.name ?? '');
      }
    }
    if (unverifiedComponents.length > 0) verified._unverifiedComponents = unverifiedComponents;
  }

  return { verified, warnings };
}

// ─── 统一合并入口 ─────────────────────────────────────────────

/**
 * 合并一个页面的所有解析结果
 */
export function mergePageResult({
  pageName,
  domText,
  domTables = [],
  images = [],
  vlmSegments = [],
  type,
  screenshotCount = 0,
}: MergePageInput): MergedPage {
  const warnings: string[] = [];

  // VLM 全段解析失败：显式告警，避免静默降级为纯 DOM/空输出
  if (vlmSegments.length > 0 && vlmSegments.every((s) => !s || s._error || s._parseError)) {
    warnings.push(
      '该页面所有分段 VLM 解析失败，已降级为纯 DOM 输出，建议检查 VLM_API_KEY / 网络后重试'
    );
  }

  // 1. 合并 VLM 多段结果
  let vlmMerged: VlmResult;
  switch (type) {
    case 'flowchart':
      vlmMerged = mergeFlowcharts(vlmSegments);
      break;
    case 'table':
      vlmMerged = { tables: mergeTables(vlmSegments) };
      break;
    case 'page':
    default:
      vlmMerged = mergePageStructures(vlmSegments);
      break;
  }

  // 2. 交叉验证
  const { verified, warnings: validateWarnings } = crossValidate(domText, vlmMerged, type);
  warnings.push(...validateWarnings);

  // 3. 合并 DOM 表格与 VLM 表格
  const finalTables: MergedTable[] = [...domTables];
  if (type === 'table' && verified.tables) {
    // VLM 识别的表格补充到 DOM 表格后
    for (const vTable of verified.tables) {
      // 检查是否与 DOM 表格重复
      const isDuplicate = finalTables.some(
        (dt) => calcHeadersSimilarity(dt.headers, vTable.headers) > 0.8
      );
      if (!isDuplicate) {
        finalTables.push({
          headers: vTable.headers || [],
          rows: vTable.rows || [],
          title: vTable.title,
          notes: vTable.notes,
          _source: 'vlm', // 标记来源
        });
      }
    }
  }

  return {
    pageName,
    type,
    domText,
    tables: finalTables,
    images,
    vlmResult: verified,
    warnings,
    _segmentCount: screenshotCount || vlmSegments.length,
    _hasVLM: vlmSegments.length > 0 && !vlmSegments.every((s) => s._error),
  };
}
