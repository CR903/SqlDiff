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

/** Blob 下载 .sql 文件（渲染进程直做，不经主进程，离线可用）。 */
export function downloadSqlFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/sql;charset=utf-8' });
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
