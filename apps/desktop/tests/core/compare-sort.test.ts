// 补测（10-04-test-gap-backfill R1）：sortDiffItems。
// 该函数此前只在 compare.ts 内部被调用（compareRun :141 / postFilterResult :205），
// 排序规则本身没有任何独立断言——而「导出顺序 = DROP→CREATE→CHANGE」「同表语句保原序」
// 是用户在导出 SQL 里直接依赖的契约，故在此把五级排序键逐条锁死。

import { describe, expect, it } from 'vitest';
import { sortDiffItems } from '../../src-core/compare';
import type { ChangeType, DiffItem, DmlType, ObjectType, StmtAspect } from '../../src-core/types';

type AnyObjectType = ObjectType | 'data';

function item(
  id: string,
  changeType: ChangeType,
  opts: { objectType?: AnyObjectType; objectName?: string; dml?: DmlType; aspects?: StmtAspect[] } = {},
): DiffItem {
  return {
    id,
    objectType: opts.objectType ?? 'table',
    objectName: opts.objectName ?? id.split(':')[1] ?? 'obj',
    changeType,
    aspects: opts.aspects ?? ['table'],
    risk: 'low',
    sql: `-- ${id}`,
    ...(opts.dml ? { dml: opts.dml } : {}),
  };
}

/** 只取排序后的 id 序列，便于断言顺序而非内容。 */
function ids(items: DiffItem[]): string[] {
  return sortDiffItems(items).map((i) => i.id);
}

describe('sortDiffItems：五级排序键', () => {
  it('第一级 changeType：DROP → CREATE → CHANGE', () => {
    const out = ids([
      item('table:c:s0', 'CHANGE'),
      item('table:a:s0', 'CREATE'),
      item('table:b:s0', 'DROP'),
    ]);
    expect(out).toEqual(['table:b:s0', 'table:a:s0', 'table:c:s0']);
  });

  it('第二级 objectType：table → view → procedure → function → data', () => {
    const out = ids([
      item('data:t:s0', 'CREATE', { objectType: 'data', objectName: 't', dml: 'INSERT' }),
      item('function:t', 'CREATE', { objectType: 'function' }),
      item('procedure:t', 'CREATE', { objectType: 'procedure' }),
      item('view:t', 'CREATE', { objectType: 'view' }),
      item('table:t:s0', 'CREATE', { objectType: 'table' }),
    ]);
    expect(out).toEqual(['table:t:s0', 'view:t', 'procedure:t', 'function:t', 'data:t:s0']);
  });

  it('数据行按 dml 排 INSERT → DELETE → UPDATE，优先于 changeType 映射', () => {
    // 映射关系是 INSERT→CREATE / DELETE→DROP / UPDATE→CHANGE；
    // 若按 changeType 排会得到 DELETE 在 INSERT 前，本断言证明 dml 分支优先。
    const out = ids([
      item('data:t:u', 'CHANGE', { objectType: 'data', objectName: 't', dml: 'UPDATE' }),
      item('data:t:d', 'DROP', { objectType: 'data', objectName: 't', dml: 'DELETE' }),
      item('data:t:i', 'CREATE', { objectType: 'data', objectName: 't', dml: 'INSERT' }),
    ]);
    expect(out).toEqual(['data:t:i', 'data:t:d', 'data:t:u']);
  });

  it('第四级 objectName、第五级 id 数字序：同表多语句 s2 < s10 保持原序', () => {
    const out = ids([
      item('table:users:s10', 'CHANGE', { objectName: 'users' }),
      item('table:users:s2', 'CHANGE', { objectName: 'users' }),
      item('table:alpha:s0', 'CHANGE', { objectName: 'alpha' }),
      item('table:zeta:s0', 'CHANGE', { objectName: 'zeta' }),
    ]);
    // 先按对象名 alpha < users < zeta，再在 users 内 s2 < s10（numeric 比较，非字典序）。
    expect(out).toEqual([
      'table:alpha:s0',
      'table:users:s2',
      'table:users:s10',
      'table:zeta:s0',
    ]);
  });

  it('不改入参：返回新数组，原数组顺序保持不变', () => {
    const input = [item('table:a:s0', 'CREATE'), item('table:b:s0', 'DROP')];
    const before = input.map((i) => i.id);
    const out = sortDiffItems(input);
    expect(input.map((i) => i.id)).toEqual(before);
    expect(out).not.toBe(input);
    expect(out.map((i) => i.id)).toEqual(['table:b:s0', 'table:a:s0']);
  });

  it('空数组与单元素数组原样返回（无越界、无 undefined 访问）', () => {
    expect(sortDiffItems([])).toEqual([]);
    const one = item('table:a:s0', 'DROP');
    expect(sortDiffItems([one])).toEqual([one]);
  });
});