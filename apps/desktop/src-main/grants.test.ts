// 授权探针单测（假 DbQueryable，不连真实 DB）：
// - 只执行固定的 SHOW GRANTS FOR CURRENT_USER()，无参数、无 FOR <user> 变体（R4）
// - 行形状按 mysql2 实测还原（列名是动态的 `Grants for <user>@<host>`）
// - 查询抛错 / 空结果 → reliable:false（不冒泡，不阻断正常比较）
// - 只返回 VisibilityAssessment，不返回授权原文

import { describe, expect, it } from 'vitest';
import { assessVisibility, SQL_SHOW_GRANTS } from './grants';
import type { DbQueryable } from './metadata';

/** mysql2 对 SHOW GRANTS 的真实行形状：单列，列名 `Grants for <user>@<host>`。 */
function grantsDb(lines: string[] | Error): DbQueryable & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    query: (sql: string) => {
      seen.push(sql);
      if (lines instanceof Error) return Promise.reject(lines);
      const rows = lines.map((text) => ({ 'Grants for u@h': text }));
      return Promise.resolve([rows, []]);
    },
  };
}

describe('assessVisibility', () => {
  it('只读当前用户自身授权：SQL 固定为 SHOW GRANTS FOR CURRENT_USER()，无参数', async () => {
    const db = grantsDb(["GRANT SELECT ON `shop`.* TO 'u'@'h'"]);
    const r = await assessVisibility(db);
    expect(db.seen).toEqual(['SHOW GRANTS FOR CURRENT_USER()']);
    expect(SQL_SHOW_GRANTS).not.toMatch(/\bFOR\s+(?!CURRENT_USER)/i); // 不存在 FOR <user> 形式
    expect(SQL_SHOW_GRANTS).not.toContain('%');
    expect(r.reliable).toBe(true);
    expect(r.byDatabase).toEqual({ shop: 'full' });
  });

  it('授权原文不外流：返回值只有库名 → 判定，不含 privilege / 授权语句', async () => {
    const r = await assessVisibility(
      grantsDb(["GRANT SELECT ON `shop`.`t1` TO 'u'@'h' IDENTIFIED BY PASSWORD '*ABC'"]),
    );
    expect(JSON.stringify(r)).toBe('{"byDatabase":{"shop":"partial"},"reliable":true}');
  });

  it('行形状容错：不依赖动态列名（首个字符串单元即可）', async () => {
    const r = await assessVisibility(grantsDb(["GRANT SELECT ON `shop`.* TO 'u'@'h'"]));
    expect(r.byDatabase).toEqual({ shop: 'full' });
  });

  it('取不到字符串单元的行 → 判为未识别 → reliable:false', async () => {
    const r = await assessVisibility({
      query: () => Promise.resolve([[{ nothing: 1 }], []]),
    });
    expect(r.reliable).toBe(false);
    expect(r.byDatabase).toEqual({});
  });

  it('查询抛错（权限 / 连接问题）→ reliable:false，不冒泡', async () => {
    const err = Object.assign(new Error('SHOW GRANTS command denied'), {
      errno: 1142,
      code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR',
    });
    const r = await assessVisibility(grantsDb(err));
    expect(r).toEqual({ byDatabase: {}, reliable: false });
  });

  it('Promise.reject() 无值也必须降级（不依赖 err 形状）', async () => {
    const r = await assessVisibility({ query: () => Promise.reject(undefined) });
    expect(r).toEqual({ byDatabase: {}, reliable: false });
  });

  it('空结果集 → reliable:false（无法证明完整）', async () => {
    expect(await assessVisibility(grantsDb([]))).toEqual({ byDatabase: {}, reliable: false });
  });
});
