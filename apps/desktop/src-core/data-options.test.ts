// 小增强 R2 单测：UI 可调参数默认值 / 合法直通 / 非法越界回落默认。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BATCH_ROWS,
  DEFAULT_INSERT_BATCH,
  DEFAULT_ROW_THRESHOLD,
  normalizeBatchRows,
  normalizeDataOptions,
  normalizeInsertBatch,
  normalizeRowThreshold,
} from './data-options';

describe('normalizeBatchRows 分页批量（默认 1000，范围 100-5000）', () => {
  it('默认值语义：undefined/空串/NaN -> 默认 + adjusted', () => {
    expect(DEFAULT_BATCH_ROWS).toBe(1000);
    expect(normalizeBatchRows(undefined)).toEqual({ value: 1000, adjusted: true });
    expect(normalizeBatchRows('')).toEqual({ value: 1000, adjusted: true });
    expect(normalizeBatchRows(NaN)).toEqual({ value: 1000, adjusted: true });
    expect(normalizeBatchRows('abc')).toEqual({ value: 1000, adjusted: true });
  });

  it('范围内直通（数字与数字串均可）', () => {
    expect(normalizeBatchRows(100)).toEqual({ value: 100, adjusted: false });
    expect(normalizeBatchRows(5000)).toEqual({ value: 5000, adjusted: false });
    expect(normalizeBatchRows('2000')).toEqual({ value: 2000, adjusted: false });
  });

  it('越界/非整数回落默认', () => {
    expect(normalizeBatchRows(99)).toEqual({ value: 1000, adjusted: true });
    expect(normalizeBatchRows(5001)).toEqual({ value: 1000, adjusted: true });
    expect(normalizeBatchRows(1.5)).toEqual({ value: 1000, adjusted: true });
    expect(normalizeBatchRows(-10)).toEqual({ value: 1000, adjusted: true });
  });
});

describe('normalizeRowThreshold 行阈值（默认 100000，范围 10000-1000000）', () => {
  it('默认值语义', () => {
    expect(DEFAULT_ROW_THRESHOLD).toBe(100_000);
    expect(normalizeRowThreshold(undefined)).toEqual({ value: 100_000, adjusted: true });
  });

  it('范围内直通', () => {
    expect(normalizeRowThreshold(10_000)).toEqual({ value: 10_000, adjusted: false });
    expect(normalizeRowThreshold(1_000_000)).toEqual({ value: 1_000_000, adjusted: false });
  });

  it('越界回落默认', () => {
    expect(normalizeRowThreshold(9999)).toEqual({ value: 100_000, adjusted: true });
    expect(normalizeRowThreshold(1_000_001)).toEqual({ value: 100_000, adjusted: true });
  });
});

describe('normalizeInsertBatch INSERT 分批（默认 500，范围 100-2000）', () => {
  it('默认值语义', () => {
    expect(DEFAULT_INSERT_BATCH).toBe(500);
    expect(normalizeInsertBatch(null)).toEqual({ value: 500, adjusted: true });
  });

  it('范围内直通 / 越界回落', () => {
    expect(normalizeInsertBatch(100)).toEqual({ value: 100, adjusted: false });
    expect(normalizeInsertBatch(2000)).toEqual({ value: 2000, adjusted: false });
    expect(normalizeInsertBatch(99)).toEqual({ value: 500, adjusted: true });
    expect(normalizeInsertBatch(2001)).toEqual({ value: 500, adjusted: true });
  });
});

describe('normalizeDataOptions 三项打包', () => {
  it('全合法 -> 原值 + adjusted=false', () => {
    expect(normalizeDataOptions({ batchRows: 2000, threshold: 50_000, insertBatch: 300 })).toEqual({
      batchRows: 2000,
      threshold: 50_000,
      insertBatch: 300,
      adjusted: false,
    });
  });

  it('任一非法 -> 该项回落 + adjusted=true', () => {
    expect(normalizeDataOptions({ batchRows: 99999, threshold: 'oops', insertBatch: 300 })).toEqual({
      batchRows: 1000,
      threshold: 100_000,
      insertBatch: 300,
      adjusted: true,
    });
  });
});
