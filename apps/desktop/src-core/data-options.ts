// 小增强 R2：数据对比可调参数的唯一事实来源（主进程 + 渲染层共用）。
// - 分页批量 batchRows：默认 1000，范围 100-5000；
// - 行阈值 threshold：默认 100000，范围 10000-1000000（超阈仍需二次确认，由 data-run 负责）；
// - INSERT 分批 insertBatch：默认 500，范围 100-2000。
// 非法值（非整数/NaN/空串）与越界值一律回落默认（adjusted=true，调用方 toast 提示）。

/** 默认分页批量。 */
export const DEFAULT_BATCH_ROWS = 1000;
/** 分页批量范围。 */
export const MIN_BATCH_ROWS = 100;
export const MAX_BATCH_ROWS = 5000;

/** 默认单表行数阈值。 */
export const DEFAULT_ROW_THRESHOLD = 100_000;
/** 行阈值范围。 */
export const MIN_ROW_THRESHOLD = 10_000;
export const MAX_ROW_THRESHOLD = 1_000_000;

/** 默认 INSERT 多 VALUES 分批行数。 */
export const DEFAULT_INSERT_BATCH = 500;
/** INSERT 分批范围。 */
export const MIN_INSERT_BATCH = 100;
export const MAX_INSERT_BATCH = 2000;

export interface NormalizedOption {
  value: number;
  /** true 表示输入非法/越界，已回落默认（调用方应 toast 提示）。 */
  adjusted: boolean;
}

function norm(input: unknown, min: number, max: number, dflt: number): NormalizedOption {
  let n: number = NaN;
  if (typeof input === 'number') {
    n = input;
  } else if (typeof input === 'string' && input.trim() !== '') {
    n = Number(input.trim());
  }
  if (!Number.isInteger(n) || n < min || n > max) return { value: dflt, adjusted: true };
  return { value: n, adjusted: false };
}

/** 分页批量归一化（100-5000，默认 1000）。 */
export function normalizeBatchRows(input: unknown): NormalizedOption {
  return norm(input, MIN_BATCH_ROWS, MAX_BATCH_ROWS, DEFAULT_BATCH_ROWS);
}

/** 行阈值归一化（10000-1000000，默认 100000）。 */
export function normalizeRowThreshold(input: unknown): NormalizedOption {
  return norm(input, MIN_ROW_THRESHOLD, MAX_ROW_THRESHOLD, DEFAULT_ROW_THRESHOLD);
}

/** INSERT 分批归一化（100-2000，默认 500）。 */
export function normalizeInsertBatch(input: unknown): NormalizedOption {
  return norm(input, MIN_INSERT_BATCH, MAX_INSERT_BATCH, DEFAULT_INSERT_BATCH);
}

export interface DataOptionValues {
  batchRows: number;
  threshold: number;
  insertBatch: number;
}

/** 三项打包归一化（UI 提交 / compare.run 组装 dataOptions 前调用）。 */
export function normalizeDataOptions(input: {
  batchRows?: unknown;
  threshold?: unknown;
  insertBatch?: unknown;
}): DataOptionValues & { adjusted: boolean } {
  const b = normalizeBatchRows(input.batchRows);
  const t = normalizeRowThreshold(input.threshold);
  const i = normalizeInsertBatch(input.insertBatch);
  return {
    batchRows: b.value,
    threshold: t.value,
    insertBatch: i.value,
    adjusted: b.adjusted || t.adjusted || i.adjusted,
  };
}
