// data-fetch 单测：主键范围分页 key 拼装（2例，假 DbQueryable 断言 SQL/参数/nextKey）。
import { describe, expect, it } from 'vitest';
import { buildPkRangeWhere, fetchPageByPK } from './data-fetch';
import type { DbQueryable } from './metadata';

function fakeDb(rows: Array<Record<string, unknown>>): { db: DbQueryable; seen: Array<{ sql: string; params: unknown[] }> } {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db: DbQueryable = {
    query: (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      return Promise.resolve([rows]);
    },
  };
  return { db, seen };
}

describe('fetchPageByPK 主键范围分页', () => {
  it('单主键首页：无 WHERE + ORDER BY pk + nextKey 取末行', async () => {
    const { db, seen } = fakeDb([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    const page = await fetchPageByPK(db, 'users', ['id'], null, 2);
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toBe('SELECT * FROM `users` ORDER BY `id` ASC LIMIT 2');
    expect(seen[0].params).toEqual([]);
    expect(page.nextKey).toEqual([2]);
    expect(page.rows).toHaveLength(2);
  });

  it('联合主键翻页：行构造器 WHERE + 参数透传', async () => {
    const { db, seen } = fakeDb([{ a: 2, b: 'y', v: 1 }]);
    expect(buildPkRangeWhere(['a', 'b'])).toBe('(`a`,`b`) > (?,?)');
    const page = await fetchPageByPK(db, 'items', ['a', 'b'], [1, 'x'], 1000);
    expect(seen[0].sql).toBe('SELECT * FROM `items` WHERE (`a`,`b`) > (?,?) ORDER BY `a` ASC, `b` ASC LIMIT 1000');
    expect(seen[0].params).toEqual([1, 'x']);
    expect(page.nextKey).toEqual([2, 'y']);
  });
});
