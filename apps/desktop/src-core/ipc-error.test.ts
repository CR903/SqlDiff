// P1a 回归：sanitizeIpcError 剥 Electron 前缀（四类输入）。
import { describe, expect, it } from 'vitest';
import { sanitizeIpcError } from './ipc-error';

describe('sanitizeIpcError', () => {
  it('Electron 前缀 + 内层 Error：只留中文 message', () => {
    const err = new Error(
      "Error invoking remote method 'compare.run': Error: compare: A 槽节点不存在（n-prod），请重新选择",
    );
    expect(sanitizeIpcError(err)).toBe('compare: A 槽节点不存在（n-prod），请重新选择');
  });

  it('Electron 前缀无内层 Error：同样剥离', () => {
    const err = new Error(
      "Error invoking remote method 'data.tables': data: A / B 节点不存在，请重新选择",
    );
    expect(sanitizeIpcError(err)).toBe('data: A / B 节点不存在，请重新选择');
  });

  it('纯中文无前缀：原样返回', () => {
    const err = new Error('compare: A / B 不能是同一节点（交换方向请用 ⇄ 交换）');
    expect(sanitizeIpcError(err)).toBe('compare: A / B 不能是同一节点（交换方向请用 ⇄ 交换）');
  });

  it('非 Error 输入：字符串直消毒，null 回落未知错误', () => {
    expect(sanitizeIpcError("Error invoking remote method 'conn.test': Error: 连接超时")).toBe(
      '连接超时',
    );
    expect(sanitizeIpcError('连接成功')).toBe('连接成功');
    expect(sanitizeIpcError(null)).toBe('未知错误');
    expect(sanitizeIpcError(undefined)).toBe('未知错误');
  });
});
