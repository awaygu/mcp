/**
 * 视觉模型（VLM）调用模块
 * 负责分析截图，输出结构化结果
 *
 * 支持三类解析：
 *   - flowchart: 流程图识别（节点、连线、分支）
 *   - table: 表格数据识别（行列数据）
 *   - page: 普通页面结构识别（布局、组件、交互）
 *
 * 支持多段截图并行解析，默认并发上限 3
 *
 * 环境变量配置：
 *   VLM_API_KEY      - API 密钥（必填）
 *   VLM_BASE_URL     - API 基础 URL，默认 https://api.openai.com/v1
 *   VLM_MODEL        - 模型名称，默认 gpt-4o
 *   VLM_MAX_PARALLEL - 最大并发数，默认 3
 */
import * as fs from 'fs';
import * as path from 'path';

const API_KEY = process.env.VLM_API_KEY || '';
const BASE_URL = process.env.VLM_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.VLM_MODEL || 'gpt-4o';

// 并发限制
const MAX_PARALLEL = Math.max(1, parseInt(process.env.VLM_MAX_PARALLEL || '3', 10) || 3);
const VLM_TIMEOUT = 30000; // 单段超时 30s
const MAX_RETRY = 1; // 失败重试次数

// 改动下方任意 Prompt 时必须递增，否则会命中旧 Prompt 产生的缓存
const PROMPT_VERSION = 'v1';

/**
 * 检查 VLM 是否配置
 */
export function isVLMConfigured() {
  return !!API_KEY;
}

/**
 * 影响解析结果但不体现在入参里的指纹，用于缓存键隔离
 */
export function getVlmVersion() {
  // BASE_URL 参与指纹：换供应商但模型名相同时，避免缓存互相污染
  return `${PROMPT_VERSION}::${MODEL}::${BASE_URL}`;
}

/**
 * 是否存在解析失败的分段（网络错误或返回非法 JSON），用于决定是否写缓存
 */
export function hasParseFailure(segments) {
  return (segments || []).some((s) => !s || s._error || s._parseError);
}

/**
 * 将图片文件转为 base64 data URL
 */
function imageToBase64(imagePath) {
  const ext = path.extname(imagePath).slice(1);
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const data = fs.readFileSync(imagePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

/**
 * 调用视觉模型（OpenAI 兼容接口）
 * @param {Array} content - 消息内容（text + image_url）
 * @param {object} options
 * @returns {Promise<string>}
 */
async function callVLM(content, options = {}) {
  if (!API_KEY) {
    throw new Error('VLM_API_KEY 未配置，请设置环境变量');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || VLM_TIMEOUT);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content }],
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens ?? 4000,
        response_format: options.responseFormat,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`VLM 调用失败 (${response.status}): ${errText}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * 带重试的 VLM 调用
 */
async function callVLMWithRetry(content, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      return await callVLM(content, options);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// ─── 页面类型判断 ─────────────────────────────────────────────

/**
 * 根据页面名称和 DOM 文字判断页面类型
 * @param {string} pageName
 * @param {string} [domText]
 * @returns {'flowchart'|'table'|'page'}
 */
export function detectPageType(pageName, domText = '') {
  const name = pageName.toLowerCase();
  const text = (domText || '').toLowerCase();

  // 流程图页面
  if (/流程|flow|流转|架构|状态图|时序|泳道/.test(name)) {
    return 'flowchart';
  }
  if (/流程|flow|流转|状态机/.test(text.slice(0, 500))) {
    return 'flowchart';
  }

  // 表格/配置页面
  if (/奖励|配置|规则|参数|列表|权限|字典|枚举|价格|套餐/.test(name)) {
    return 'table';
  }
  if (/\|.*\|.*\|/.test(domText || '') || /等级|奖励|配置项|参数值/.test(text.slice(0, 1000))) {
    return 'table';
  }

  return 'page';
}

// ─── 三类解析 Prompt ──────────────────────────────────────────

/**
 * 流程图解析 Prompt
 * @param {number} segmentIndex - 当前段序号（1-based）
 * @param {number} totalSegments - 总段数
 */
function flowchartPrompt(segmentIndex, totalSegments) {
  const segmentHint =
    totalSegments > 1
      ? `\n注意：这是长流程图的第 ${segmentIndex}/${totalSegments} 段，可能包含不完整的节点，只输出你能看清的部分。节点 ID 用 n${segmentIndex}_1, n${segmentIndex}_2... 格式。`
      : '';

  return `你是一个资深产品需求分析师。这是一张产品业务流程图截图，请仔细识别并提取完整的流程信息。
请输出 JSON 格式，结构如下：
{
  "summary": "用2-3句话概括这个流程图的核心业务流程",
  "nodes": [
    {"id": "n1", "text": "节点文字", "type": "start|end|process|decision|subflow|io"}
  ],
  "edges": [
    {"from": "n1", "to": "n2", "condition": "连线上的条件文字，没有则为空字符串"}
  ],
  "main_flow": ["n1", "n2", "n3"],
  "branches": [
    {"node": "n2", "conditions": ["条件A", "条件B"], "targets": ["n3", "n4"]}
  ],
  "exception_flows": ["异常流程描述，如果没有则为空数组"]
}
注意事项：
1. 节点类型判断：圆角矩形=start/end，矩形=process，菱形=decision，双线矩形=subflow，平行四边形=io
2. 连线方向很重要，注意箭头指向
3. 判断节点的每个分支条件都要提取
4. 如果图中有泳道/分区，在 summary 中说明${segmentHint}
5. 只输出 JSON，不要输出其他文字`;
}

/**
 * 表格解析 Prompt
 */
function tablePrompt(segmentIndex, totalSegments) {
  const segmentHint =
    totalSegments > 1
      ? `\n注意：这是长页面的第 ${segmentIndex}/${totalSegments} 段，表格可能被截断，只输出你能看清的行。`
      : '';

  return `你是一个数据表格识别专家。请分析这张截图中的所有表格，输出严格的 JSON：
{
  "tables": [
    {
      "title": "表格标题（如果有）",
      "headers": ["列1", "列2", "列3"],
      "rows": [["值1", "值2", "值3"]],
      "notes": "表格备注或脚注（如果有）"
    }
  ],
  "other_data": ["截图中其他重要的文字信息，如说明文字、注意事项等"]
}
注意：
1. 仔细识别每个单元格的内容，包括数字、单位、特殊符号
2. 合并单元格要在对应行中体现
3. 如果表格有分组/分类，在 title 或 notes 中说明${segmentHint}
4. 只输出 JSON，不要输出其他文字`;
}

/**
 * 普通页面结构解析 Prompt
 */
function pagePrompt(segmentIndex, totalSegments, pageText = '') {
  const textHint = pageText
    ? `\n\n页面已提取的文字内容（辅助参考）：\n${pageText.slice(0, 2000)}`
    : '';
  const segmentHint =
    totalSegments > 1
      ? `\n注意：这是长页面的第 ${segmentIndex}/${totalSegments} 段，只描述你能看清的区域。`
      : '';

  return `你是一个资深前端工程师和产品分析师。这是一张产品原型页面截图，请分析页面结构。${textHint}
请输出 JSON 格式：
{
  "page_type": "页面类型（如：列表页/详情页/表单页/仪表盘/个人中心/弹窗等）",
  "layout": "布局结构描述（如：顶部导航+左侧菜单+内容区+底部操作栏）",
  "components": [
    {"name": "组件名称", "type": "按钮/列表/卡片/表单/表格/Tab/弹窗/进度条/标签等", "position": "位置描述", "description": "功能说明和当前状态"}
  ],
  "interactions": ["可交互元素及预期行为，如点击按钮弹出确认框"],
  "states": ["页面可能的状态，如空状态/加载态/错误态/已签到/未签到"],
  "visual_hierarchy": "视觉层级说明（什么是主操作、什么是次要信息、什么是装饰元素）",
  "key_info": ["页面中的关键信息元素，如标题、数据展示、状态标识、金额数字等"]
}${segmentHint}
只输出 JSON，不要输出其他文字`;
}

// ─── 单段解析 ─────────────────────────────────────────────────

/**
 * 解析单张截图
 * @param {string} imagePath - 图片路径
 * @param {'flowchart'|'table'|'page'} type - 页面类型
 * @param {object} options - { segmentIndex, totalSegments, pageText }
 * @returns {Promise<object>} 解析结果
 */
export async function analyzeSingleImage(imagePath, type, options = {}) {
  const { segmentIndex = 1, totalSegments = 1, pageText = '' } = options;

  const imageUrl = imageToBase64(imagePath);
  let prompt;

  switch (type) {
    case 'flowchart':
      prompt = flowchartPrompt(segmentIndex, totalSegments);
      break;
    case 'table':
      prompt = tablePrompt(segmentIndex, totalSegments);
      break;
    case 'page':
    default:
      prompt = pagePrompt(segmentIndex, totalSegments, pageText);
      break;
  }

  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: imageUrl } },
  ];

  const result = await callVLMWithRetry(content, {
    temperature: type === 'page' ? 0.2 : 0.1,
    maxTokens: 4000,
    responseFormat: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(result);
    return {
      ...parsed,
      _segmentIndex: segmentIndex,
      _imagePath: imagePath,
      _type: type,
    };
  } catch {
    return {
      _raw: result,
      _segmentIndex: segmentIndex,
      _imagePath: imagePath,
      _type: type,
      _parseError: true,
    };
  }
}

// ─── 多段并行解析 ─────────────────────────────────────────────

/**
 * 跨页面的全局并发解析：把多个页面的分段摊平成一个队列统一消费。
 * 相比「页内并发、页间串行」，可以避免每页末尾的并发度浪费。
 * @param {Array<{imagePath: string, type: string, segmentIndex: number, totalSegments: number, pageText?: string}>} tasks
 * @param {object} options - { concurrency }
 * @returns {Promise<object[]>} 解析结果数组（按输入顺序）
 */
export async function analyzeSegmentsGlobal(tasks, options = {}) {
  const concurrency = Math.max(1, options.concurrency || MAX_PARALLEL);
  const results = new Array(tasks.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < tasks.length) {
      const idx = currentIndex++;
      const task = tasks[idx];
      try {
        results[idx] = await analyzeSingleImage(task.imagePath, task.type, {
          segmentIndex: task.segmentIndex,
          totalSegments: task.totalSegments,
          pageText: task.pageText,
        });
      } catch (err) {
        results[idx] = {
          _error: err.message,
          _segmentIndex: task.segmentIndex,
          _imagePath: task.imagePath,
          _type: task.type,
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results;
}

/**
 * 并行解析单个页面的多段截图（并发上限 MAX_PARALLEL）
 * @param {string[]} imagePaths - 图片路径数组
 * @param {'flowchart'|'table'|'page'} type - 页面类型
 * @param {object} options - { pageText }
 * @returns {Promise<object[]>} 解析结果数组（按输入顺序）
 */
export async function analyzeSegmentsParallel(imagePaths, type, options = {}) {
  return analyzeSegmentsGlobal(
    imagePaths.map((imagePath, i) => ({
      imagePath,
      type,
      segmentIndex: i + 1,
      totalSegments: imagePaths.length,
      pageText: options.pageText,
    }))
  );
}

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * 将流程图分析结果转为 Mermaid 语法
 */
export function flowchartToMermaid(flowchart) {
  if (!flowchart.nodes || flowchart.nodes.length === 0) {
    return '```mermaid\nflowchart TD\n    A[无法解析流程图]\n```';
  }

  const shapeMap = {
    start: '([%text%])',
    end: '([%text%])',
    process: '[%text%]',
    decision: '{%text%}',
    subflow: '[[%text%]]',
    io: '[/%text%/]',
  };

  let mermaid = '```mermaid\nflowchart TD\n';

  flowchart.nodes.forEach((node) => {
    const shape = shapeMap[node.type] || '[%text%]';
    const label = shape.replace('%text%', node.text.replace(/"/g, "'").replace(/\n/g, ' '));
    mermaid += `    ${node.id}${label}\n`;
  });

  (flowchart.edges || []).forEach((edge) => {
    const condition = edge.condition ? `|${edge.condition}|` : '';
    mermaid += `    ${edge.from} -->${condition} ${edge.to}\n`;
  });

  mermaid += '```';
  return mermaid;
}

/**
 * 将表格数据转为 Markdown 表格
 */
export function tableToMarkdown(table) {
  if (!table.headers || table.headers.length === 0) return '';
  let md = `| ${table.headers.join(' | ')} |\n`;
  md += `| ${table.headers.map(() => '---').join(' | ')} |\n`;
  (table.rows || []).forEach((row) => {
    md += `| ${row.join(' | ')} |\n`;
  });
  return md;
}

/**
 * 兼容旧接口：分析单张流程图
 */
export async function analyzeFlowchart(imagePath) {
  return await analyzeSingleImage(imagePath, 'flowchart', { segmentIndex: 1, totalSegments: 1 });
}

/**
 * 兼容旧接口：分析单张页面结构
 */
export async function analyzePageStructure(imagePath, pageText = '') {
  return await analyzeSingleImage(imagePath, 'page', { segmentIndex: 1, totalSegments: 1, pageText });
}
