// M5 SQL 展示工具：本地格式化（sql-formatter，关键字大写）+ 轻量高亮 + 跨环境复制。
// 说明：Monaco 体积大且需 worker 配置，首版用 <pre> + 正则高亮作为 fallback（prd 允许 Monaco 或 <pre>）。

import { format } from 'sql-formatter';
import { toExportSql } from '../src-core/compare';
import type { DiffItem } from '../src-core/types';
import type { SqlDiffApi } from '../src-main/preload';

function ipc(): SqlDiffApi | null {
  try {
    const w = window as unknown as { sqldiff?: SqlDiffApi };
    return w.sqldiff ?? null;
  } catch {
    return null;
  }
}

/** sql-formatter 本地格式化；失败/空串时原样返回（不阻塞展示）。 */
export function formatSqlSafe(sql: string): string {
  const text = sql ?? '';
  if (!text.trim()) return text;
  try {
    return format(text, { language: 'mysql', keywordCase: 'upper' });
  } catch {
    return text;
  }
}

/** 导出/复制文本：头注释（A/B/时间）+ DROP→CREATE→CHANGE 顺序（items 应已排序，函数内再排保底）。 */
export function buildExportText(
  items: DiffItem[],
  opts: { aName?: string; bName?: string; at?: string } = {},
): string {
  const withFormatted = items.map((it) => ({ ...it, sql: formatSqlSafe(it.sql) }));
  return toExportSql(withFormatted, opts);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 轻量 SQL 高亮（注释/关键字/字符串/数字），输出 HTML 字符串供 <pre> 渲染。 */
export function highlightSql(sql: string): string {
  const esc = escapeHtml(sql);
  // 先把注释 / 单引号串 / 反引号标识符暂存为占位符，再做关键字与数字高亮，
  // 避免关键字正则误伤串内文本（如 'CREATE'）或注释内文本导致嵌套 <span>。
  // 占位符仅含 PUA 字符 uE000/uE001（非词字符）：关键字/数字正则无法命中，
  // 且与 SQL 文本几乎不可能碰撞；还原时按捕获组长度定位槽位。
  const slots: string[] = [];
  const stash = (html: string): string => {
    slots.push(html);
    return `\uE000${'\uE001'.repeat(slots.length)}\uE000`;
  };
  let tmp = esc
    .replace(/(--[^\n]*)/g, (m) => stash(`<span class="tok-cmt">${m}</span>`))
    .replace(/('[^']*')/g, (m) => stash(`<span class="tok-str">${m}</span>`))
    .replace(/(`[^`]*`)/g, (m) => stash(`<span class="tok-str">${m}</span>`));
  tmp = tmp
    .replace(
      /\b(CREATE|OR|REPLACE|DROP|TABLE|VIEW|PROCEDURE|FUNCTION|ALTER|CHANGE|COLUMN|ADD|IF|NOT|NULL|EXISTS|DEFAULT|PRIMARY|KEY|INDEX|ENGINE|SELECT|FROM|WHERE|RETURNS|RETURN|DETERMINISTIC|DELIMITER|SUM|AS|AUTO_INCREMENT|BEGIN|END)\b/g,
      '<span class="tok-kw">$1</span>',
    )
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
  return tmp.replace(/\uE000(\uE001+)\uE000/g, (_m, g: string) => slots[g.length - 1] ?? _m);
};

/**
 * 跨环境复制：优先走主进程 sql.copy（Electron 剪贴板），降级用
 * navigator.clipboard，最后用隐藏 textarea + execCommand 兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  const api = ipc();
  if (api) {
    try {
      if (await api.sql.copy(text)) return true;
    } catch {
      // 降级到浏览器剪贴板。
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 降级到 execCommand。
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Blob 文本下载（无主进程时的浏览器回落路径；有主进程时应走 saveTextFile）。 */
export function downloadTextFile(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// -- 导出落盘（主进程另存为对话框）--------------------------------------------

/** 导出结果：saved 带真实落盘路径；canceled 为用户取消（不是错误）；fallback 为无主进程的浏览器下载。 */
export type ExportOutcome =
  | { status: 'saved'; filePath: string }
  | { status: 'canceled' }
  | { status: 'fallback' };

/** 多文件导出结果（报告 JSON+MD 共用一次目录选择）。 */
export type ExportBundleOutcome =
  | { status: 'saved'; filePaths: string[] }
  | { status: 'canceled' }
  | { status: 'fallback' };

/**
 * 导出单个文本文件：优先走主进程「另存为」对话框（用户选目录/文件名），
 * 落盘成功后回传真实路径；无主进程（浏览器预览/离线）回落 Blob 下载。
 */
export async function saveTextFile(
  defaultName: string,
  text: string,
  title: string,
): Promise<ExportOutcome> {
  const api = ipc();
  if (!api) {
    downloadTextFile(defaultName, text, mimeTypeOf(defaultName));
    return { status: 'fallback' };
  }
  const r = await api.file.save({ kind: 'file', defaultName, content: text, title });
  return r.status === 'saved' ? { status: 'saved', filePath: r.filePaths[0] ?? '' } : { status: 'canceled' };
}

/** 批量导出：一次「选目录」写完所有文件（避免连弹 N 次对话框）。 */
export async function saveTextFiles(
  files: { name: string; content: string }[],
  title: string,
): Promise<ExportBundleOutcome> {
  const api = ipc();
  if (!api) {
    files.forEach((f) => downloadTextFile(f.name, f.content, mimeTypeOf(f.name)));
    return { status: 'fallback' };
  }
  return api.file.save({ kind: 'bundle', files, title });
}

const MIME_BY_EXT: Record<string, string> = {
  sql: 'text/sql;charset=utf-8',
  json: 'application/json;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
};

function mimeTypeOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'text/plain;charset=utf-8';
}

/** 导出成功 toast 的统一文案：带真实落盘路径（用户最需要知道的就是这个）。 */
export function exportSavedMessage(prefix: string, filePath: string): string {
  return filePath ? `${prefix}：${filePath}` : prefix;
}
