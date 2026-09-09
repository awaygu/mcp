// i18n.ts — 表格数据整形：表头识别、行/语言/行号过滤，输出对 Agent 友好的结构
import { readSheetRaw, type Credentials } from './shimo-client.js';
import { detectLanguageColumns } from './langmap.js';
import type { SheetData } from './types.js';

/** 单元格 → 文本（数字/公式结果转字符串；null/undefined → ''） */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    // 石墨 values API 偶发返回对象形态（富文本/链接），尽力取文本字段
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.value === 'string') return o.value;
    return JSON.stringify(v);
  }
  return String(v);
}

export interface ReadSheetOptions {
  /** 只保留这些行（石墨 UI 行号，1-based，含表头行 1；传行号时表头始终带出） */
  rows?: number[];
  /** 只保留这些语言列（语言码或表头名，如 ["en","ja"] 或 ["英文","日语"]）。默认全部列 */
  languages?: string[];
  /** 数据行最多返回多少条（默认 200；0 = 不限）。超出时 truncated=true，用 rows 参数按行号取余下数据 */
  limit?: number;
  /** 额外读取列数（默认 26 = A:Z） */
  maxCol?: number;
}

/**
 * 读一个工作表并整形。
 * 表头 = 第 1 行非空单元格；数据行 = 其后所有非空行（完全空白的行跳过）。
 */
export async function readSheet(guid: string, sheet: string, creds: Credentials, opts: ReadSheetOptions = {}): Promise<SheetData> {
  const { rows: rawRows, truncated: paginated } = await readSheetRaw(guid, sheet, creds.cookie, opts.maxCol ?? 26);
  if (!rawRows.length) {
    return { sheet, headers: [], rows: [], totalRows: 0, truncated: false };
  }

  const headerRow = rawRows[0] || [];
  const headers = headerRow.map(cellText);
  // 表头全空：退化为 Col1/Col2… 合成表头
  const hasHeader = headers.some((h) => h.trim());
  const finalHeaders = hasHeader ? headers : headers.map((_, i) => `Col${i + 1}`);

  const langCols = detectLanguageColumns(finalHeaders);

  // 语言过滤：入参可传语言码（en/in/…）或表头原文（英文/印尼语/…）
  let keepCols: number[] | null = null;
  if (opts.languages?.length) {
    const wanted = new Set(opts.languages.map((s) => s.trim().toLowerCase()));
    keepCols = [];
    finalHeaders.forEach((h, i) => {
      const detected = langCols.find((c) => c.index === i);
      if (wanted.has(h.trim().toLowerCase()) || (detected && wanted.has(detected.lang.toLowerCase()))) {
        keepCols!.push(i);
      }
    });
    if (!keepCols.length) {
      throw new Error(
        `语言过滤无匹配列：${opts.languages.join('/')}。该表可用列：${finalHeaders
          .map((h, i) => (h.trim() ? h : `Col${i + 1}`))
          .filter(Boolean)
          .join('、')}`,
      );
    }
  }

  const wantedRows = opts.rows?.length ? new Set(opts.rows) : null;
  const limit = opts.limit === undefined ? 200 : opts.limit;
  const dataRows: SheetData['rows'] = [];
  let total = 0;
  let truncated = paginated;

  for (let i = 1; i < rawRows.length; i++) {
    const cells = (rawRows[i] || []).map(cellText);
    if (!cells.some((c) => c.trim())) continue; // 整行空白跳过
    total++;
    const rowNo = i + 1; // 石墨 UI 行号（1-based）
    // 行号过滤：表头行恒为 1，数据行按传入行号集合过滤
    if (wantedRows && !wantedRows.has(rowNo)) continue;
    const row: SheetData['rows'][number] = { _row: rowNo };
    finalHeaders.forEach((h, ci) => {
      if (keepCols && !keepCols.includes(ci)) return;
      const key = h.trim() || `Col${ci + 1}`;
      const v = cells[ci] ?? '';
      if (v) row[key] = v;
    });
    dataRows.push(row);
    if (limit > 0 && dataRows.length >= limit) {
      truncated = true;
      break;
    }
  }

  return {
    sheet,
    headers: keepCols ? keepCols.map((i) => finalHeaders[i].trim() || `Col${i + 1}`) : finalHeaders.filter((h, i) => h.trim() || !!rawRows.some((r) => r[i])),
    rows: dataRows,
    totalRows: total,
    truncated,
  };
}

/** 从 SheetData 生成「语言 → { key: 文案 }」映射。
 * key 列按 keyColumn > key/文案名/name > 中文 顺序识别；都没有（如被 languages 过滤掉）时退化用行号当 key。 */
export function toLanguageMap(data: SheetData, opts: { keyColumn?: string } = {}): Record<string, Record<string, string>> {
  const keyCandidates = [opts.keyColumn, 'key', 'Key', '文案名', 'name', 'Name', '_key', '中文'].filter(Boolean) as string[];
  const keyCol = keyCandidates.find((c) => data.headers.includes(c));

  const out: Record<string, Record<string, string>> = {};
  data.headers.forEach((h) => {
    if (h === keyCol || h === 'UI') return; // UI 列是翻译备注，不是语言
    const lang = detectLanguageColumns([h])[0]?.lang;
    if (!lang || lang === '_key' || lang === '_ui') return;
    out[lang] = {};
  });

  for (const row of data.rows) {
    const key = keyCol ? String(row[keyCol] ?? row._row) : String(row._row);
    for (const lang of Object.keys(out)) {
      const header = data.headers.find((h) => detectLanguageColumns([h])[0]?.lang === lang);
      if (!header) continue;
      const v = row[header];
      if (v) out[lang][key] = String(v);
    }
  }
  return out;
}
