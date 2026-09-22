import { describe, expect, it } from 'vitest';
import type { ChangeType, DiffItem } from './types';

// M1 占位冒烟：只确认契约类型可用；M4 在此目录补 diff 单测
//（表新增/缺列/改列/主键/索引；过程新增/删除/变更；视图 OR REPLACE）。
describe('M1 skeleton', () => {
  it('DiffItem shape placeholder', () => {
    const item: DiffItem = {
      id: 'd0',
      objectType: 'table',
      objectName: 'users',
      changeType: 'CREATE',
      stmtKind: 'DDL',
      aspects: ['table'],
      risk: 'low',
      sql: 'SELECT 1;',
    };
    const order: Record<ChangeType, number> = { DROP: 0, CREATE: 1, CHANGE: 2 };
    expect(order[item.changeType]).toBe(1);
  });
});
