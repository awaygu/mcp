/**
 * 结果合并模块
 * 负责将多段 VLM 解析结果 + DOM 文字提取结果，合并成完整的页面结构化数据
 *
 * 合并策略：
 * - 流程图：节点去重、连线补全、分支合并
 * - 表格：表格匹配、行去重、截断行补全
 * - 普通页面：组件去重、交互合并、布局拼接
 */

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * 计算两个字符串的相似度（0-1）
 * 基于字符级别的 Jaccard 相似度
 */
function stringSimilarity(a, b) {
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
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？\n\r\t]/g, '')
    .trim();
}

// ─── 流程图合并 ───────────────────────────────────────────────

/**
 * 合并多段流程图解析结果
 * @param {object[]} segments - 各段解析结果数组
 * @returns {object} 合并后的流程图
 */
export function mergeFlowcharts(segments) {
  const validSegments = segments.filter((s) => s && !s._error && !s._parseError);
  if (validSegments.length === 0) {
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

  if (validSegments.length === 1) {
    return validSegments[0];
  }

  // 按段序号排序
  validSegments.sort((a, b) => (a._segmentIndex || 0) - (b._segmentIndex || 0));

  const mergedNodes = [];
  const nodeIdMap = {}; // 旧ID -> 新ID
  const nodeTextMap = {}; // 归一化文字 -> 新ID

  // 1. 合并节点（去重）
  let nodeCounter = 0;
  for (const seg of validSegments) {
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
  const mergedEdges = [];
  const edgeKeySet = new Set();
  for (const seg of validSegments) {
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
  for (let i = 0; i < validSegments.length - 1; i++) {
    const segA = validSegments[i];
    const segB = validSegments[i + 1];
    const lastNodeA = segA.nodes?.[segA.nodes.length - 1];
    const firstNodeB = segB.nodes?.[0];
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
  const mergedMainFlow = [];
  for (const seg of validSegments) {
    for (const nodeId of seg.main_flow || []) {
      const mappedId = nodeIdMap[nodeId] || nodeId;
      if (!mergedMainFlow.includes(mappedId)) {
        mergedMainFlow.push(mappedId);
      }
    }
  }

  // 5. 合并分支
  const mergedBranches = [];
  const branchNodeMap = {};
  for (const seg of validSegments) {
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
  const mergedExceptions = [];
  for (const seg of validSegments) {
    for (const exc of seg.exception_flows || []) {
      const norm = normalize(exc);
      if (!mergedExceptions.some((e) => normalize(e) === norm)) {
        mergedExceptions.push(exc);
      }
    }
  }

  // 7. 合并概述
  const summaries = validSegments
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
    _segmentCount: validSegments.length,
    _nodeCount: mergedNodes.length,
    _edgeCount: mergedEdges.length,
  };
}

// ─── 表格合并 ─────────────────────────────────────────────────

/**
 * 合并多段表格解析结果
 * @param {object[]} segments - 各段解析结果数组
 * @returns {object[]} 合并后的表格数组
 */
export function mergeTables(segments) {
  const validSegments = segments.filter((s) => s && !s._error && !s._parseError);
  if (validSegments.length === 0) return [];

  const allTables = [];
  for (const seg of validSegments) {
    for (const table of seg.tables || []) {
      allTables.push({ ...table, _segmentIndex: seg._segmentIndex });
    }
  }

  if (allTables.length === 0) return [];
  if (allTables.length === 1) return [allTables[0]];

  // 表格匹配：标题相同或 headers 相似度 > 0.7
  const mergedTables = [];
  for (const table of allTables) {
    let matched = null;
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
      for (const row of table.rows || []) {
        const rowKey = normalize(row.join('|'));
        if (!matched._rowKeys) matched._rowKeys = new Set();
        if (!matched._rowKeys.has(rowKey)) {
          matched._rowKeys.add(rowKey);
          matched.rows.push(row);
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
  return mergedTables.map(({ _rowKeys, ...rest }) => rest);
}

/**
 * 计算两个 headers 数组的相似度
 */
function calcHeadersSimilarity(h1, h2) {
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
 * @param {object[]} segments - 各段解析结果数组
 * @returns {object} 合并后的页面结构
 */
export function mergePageStructures(segments) {
  const validSegments = segments.filter((s) => s && !s._error && !s._parseError);
  if (validSegments.length === 0) {
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

  if (validSegments.length === 1) return validSegments[0];

  validSegments.sort((a, b) => (a._segmentIndex || 0) - (b._segmentIndex || 0));

  // 合并组件（名称+类型去重）
  const mergedComponents = [];
  const compKeySet = new Set();
  for (const seg of validSegments) {
    for (const comp of seg.components || []) {
      const key = normalize(comp.name + '|' + comp.type);
      if (!compKeySet.has(key)) {
        compKeySet.add(key);
        mergedComponents.push(comp);
      }
    }
  }

  // 合并交互（去重）
  const mergedInteractions = [];
  for (const seg of validSegments) {
    for (const inter of seg.interactions || []) {
      const norm = normalize(inter);
      if (!mergedInteractions.some((i) => normalize(i) === norm)) {
        mergedInteractions.push(inter);
      }
    }
  }

  // 合并状态（去重）
  const mergedStates = [];
  for (const seg of validSegments) {
    for (const state of seg.states || []) {
      const norm = normalize(state);
      if (!mergedStates.some((s) => normalize(s) === norm)) {
        mergedStates.push(state);
      }
    }
  }

  // 合并关键信息（去重）
  const mergedKeyInfo = [];
  for (const seg of validSegments) {
    for (const info of seg.key_info || []) {
      const norm = normalize(info);
      if (!mergedKeyInfo.some((i) => normalize(i) === norm)) {
        mergedKeyInfo.push(info);
      }
    }
  }

  // 布局描述拼接
  const layouts = validSegments.map((s, i) => {
    const prefix = validSegments.length > 1 ? `[第${i + 1}段] ` : '';
    return prefix + (s.layout || '');
  }).filter(Boolean);

  // 页面类型：取第一个非空
  const pageType = validSegments.find((s) => s.page_type)?.page_type || '';

  // 视觉层级拼接
  const visualHierarchy = validSegments
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
    _segmentCount: validSegments.length,
  };
}

// ─── DOM 与 VLM 交叉验证 ──────────────────────────────────────

/**
 * DOM 文字与 VLM 结果交叉验证
 * @param {string} domText - DOM 提取的文字
 * @param {object} vlmResult - VLM 解析结果
 * @param {'flowchart'|'table'|'page'} type - 页面类型
 * @returns {{verified: object, warnings: string[]}}
 */
export function crossValidate(domText, vlmResult, type) {
  const warnings = [];
  const verified = { ...vlmResult };

  if (!domText || domText.length < 10) {
    warnings.push('DOM 文字提取为空，完全依赖 VLM 识别');
    return { verified, warnings };
  }

  const normDom = normalize(domText);

  if (type === 'flowchart') {
    // 验证节点文字是否在 DOM 中出现
    for (const node of vlmResult.nodes || []) {
      const nodeText = normalize(node.text);
      if (nodeText.length > 2 && !normDom.includes(nodeText.slice(0, 4))) {
        // 节点文字不在 DOM 中，可能是 VLM 误识别或 DOM 提取不全
        // 不删除，只标注
        if (!verified._unverifiedNodes) verified._unverifiedNodes = [];
        verified._unverifiedNodes.push(node.text);
      }
    }
  }

  if (type === 'table') {
    // 验证表格数据
    for (const table of vlmResult.tables || []) {
      for (const row of table.rows || []) {
        for (const cell of row) {
          const cellNorm = normalize(cell);
          if (cellNorm.length > 3 && !normDom.includes(cellNorm.slice(0, 4))) {
            if (!verified._unverifiedCells) verified._unverifiedCells = [];
            verified._unverifiedCells.push(cell);
          }
        }
      }
    }
    if (verified._unverifiedCells?.length > 0) {
      warnings.push(
        `表格中有 ${verified._unverifiedCells.length} 个单元格内容未在 DOM 文字中找到，可能为图片识别，建议人工复核`
      );
    }
  }

  if (type === 'page') {
    // 验证组件名称
    for (const comp of vlmResult.components || []) {
      const compName = normalize(comp.name);
      if (compName.length > 2 && !normDom.includes(compName.slice(0, 3))) {
        if (!verified._unverifiedComponents) verified._unverifiedComponents = [];
        verified._unverifiedComponents.push(comp.name);
      }
    }
  }

  return { verified, warnings };
}

// ─── 统一合并入口 ─────────────────────────────────────────────

/**
 * 合并一个页面的所有解析结果
 * @param {object} params
 * @param {string} params.pageName - 页面名称
 * @param {string} params.domText - DOM 提取的文字
 * @param {object[]} params.domTables - DOM 提取的表格
 * @param {object[]} params.vlmSegments - VLM 多段解析结果
 * @param {'flowchart'|'table'|'page'} params.type - 页面类型
 * @returns {object} 合并后的完整页面数据
 */
export function mergePageResult({ pageName, domText, domTables = [], vlmSegments = [], type, screenshotCount = 0 }) {
  const warnings = [];

  // 1. 合并 VLM 多段结果
  let vlmMerged;
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
  let finalTables = [...domTables];
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
    vlmResult: verified,
    warnings,
    _segmentCount: screenshotCount || vlmSegments.length,
    _hasVLM: vlmSegments.length > 0 && !vlmSegments.every((s) => s._error),
  };
}
