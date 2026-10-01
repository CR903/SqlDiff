// 差异表渲染窗口的纯逻辑（无 React、无 DOM，便于单测）。
//
// 为什么需要它：实测 3135 行全量渲染会产生 57,673 个 DOM 节点，
// 单次筛选阻塞主线程约 3s（Long Task 最高 2003ms）。改为只渲染窗口、
// 滚到底自动加页后，DOM 规模与行数解耦。

/** 一页渲染多少行。200 ≈ 3.7k DOM 元素，兼顾首屏可用与渲染开销。 */
export const ROW_WINDOW = 200;

/** 当前窗口应渲染的切片。limit 超出总长时安全收敛，不会产生空洞。 */
export function windowRows<T>(rows: readonly T[], limit: number): T[] {
  if (limit >= rows.length) return rows.slice();
  return rows.slice(0, Math.max(0, limit));
}

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * 滚动到底部时把窗口加一���；未到底或已到末尾则不变。
 *
 * 阈值用 `ROW_WINDOW` 像素而非 0：用户快滚到底时不会因为差几像素而漏触发，
 * 也不必依赖精确的 scrollHeight（内容随窗口变化会跳动）。
 *
 * 返回**新的** limit 或原值，便于调用方用 === 判断是否需要 setState。
 */
export function nextWindowLimit(
  m: ScrollMetrics,
  currentLimit: number,
  totalRows: number,
  pageSize: number = ROW_WINDOW,
): number {
  const reachedBottom = m.scrollTop + m.clientHeight >= m.scrollHeight - pageSize;
  if (!reachedBottom) return currentLimit;
  if (currentLimit >= totalRows) return currentLimit;
  return Math.min(currentLimit + pageSize, totalRows);
}

/** 是否还有未渲染的行（用于显示「已显示 X / 共 Y」提示）。 */
export function hasMoreRows(shownCount: number, totalRows: number): boolean {
  return shownCount < totalRows;
}