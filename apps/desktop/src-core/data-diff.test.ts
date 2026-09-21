// 数据对比二期单测：parseTablePK 联合主键（3例）+ diffDataRows 行级比对（4例）。
import { describe, expect, it } from 'vitest';
import { addslashes, diffDataRows, getDataPKV, sqlLiteral } from './data-diff';
import { parseTablePK } from './data-pk';

const DDL_SINGLE = [
  'CREATE TABLE `users` (',
  '  `id` int NOT NULL,',
  '  `name` varchar(64) DEFAULT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_COMPOSITE = [
  'CREATE TABLE `items` (',
  '  `a` int NOT NULL,',
  '  `b` varchar(32) NOT NULL,',
  '  `v` int DEFAULT NULL,',
  '  PRIMARY KEY (`a`,`b`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_NO_PK = [
  'CREATE TABLE `logs` (',
  '  `id` int DEFAULT NULL,',
  '  `msg` varchar(64) DEFAULT NULL',
  ') ENGINE=InnoDB',
].join('\n');

describe('parseTablePK 联合主键', () => {
  it('单主键 -> 单列', () => {
    expect(parseTablePK(DDL_SINGLE)).toEqual(['id']);
  });
  it('联合主键 -> 全量有序', () => {
    expect(parseTablePK(DDL_COMPOSITE)).toEqual(['a', 'b']);
  });
  it('无主键 -> null（空串/null 同理）', () => {
    expect(parseTablePK(DDL_NO_PK)).toBeNull();
    expect(parseTablePK('')).toBeNull();
    expect(parseTablePK(null)).toBeNull();
  });
});

describe('diffDataRows 行级比对', () => {
  it('insert：仅 A 有 -> 多 VALUES 分批（insertBatch=2，3 行拆 2 条）', () => {
    const rowsA = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ];
    const r = diffDataRows(rowsA, [], ['id'], 'users', 2);
    expect(r.inserts).toHaveLength(2);
    expect(r.inserts[0]).toContain('INSERT INTO `users` VALUES');
    expect(r.inserts[0]).toContain("(1,'a'),(2,'b')");
    expect(r.inserts[1]).toContain("(3,'c')");
    expect(r.deletes).toEqual([]);
    expect(r.updates).toEqual([]);
  });

  it('delete：仅 B 有 -> 按主键逐行 DELETE', () => {
    const r = diffDataRows([], [{ id: 7, name: 'g' }], ['id'], 'users');
    expect(r.inserts).toEqual([]);
    expect(r.updates).toEqual([]);
    expect(r.deletes).toHaveLength(1);
    expect(r.deletes[0]).toBe('DELETE FROM `users` WHERE `id`=7;\n');
  });

  it('update：同键异值 -> 只列变更列；同行跳过；联合主键拼 key', () => {
    const rowsA = [
      { a: 1, b: 'x', v: 10 },
      { a: 1, b: 'y', v: 20 },
    ];
    const rowsB = [
      { a: 1, b: 'x', v: 11 },
      { a: 1, b: 'y', v: 20 },
    ];
    // 联合主键 (1,'x') vs (1,'y') 必须区分。
    expect(getDataPKV({ a: 1, b: 'x' }, ['a', 'b'])).not.toBe(getDataPKV({ a: 1, b: 'y' }, ['a', 'b']));
    const r = diffDataRows(rowsA, rowsB, ['a', 'b'], 'items');
    expect(r.inserts).toEqual([]);
    expect(r.deletes).toEqual([]);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]).toContain('UPDATE `items` SET `v`=10 WHERE');
    expect(r.updates[0].split(' WHERE ')[0]).not.toContain('`a`=');
    expect(r.updates[0]).toContain("`b`='x'");
  });

  it('转义：引号/反斜杠走 addslashes，NULL 生成关键字', () => {
    expect(addslashes("o'clock\\")).toBe("o\\'clock\\\\");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    const r = diffDataRows(
      [{ id: 1, name: "o'clock", nick: null }],
      [],
      ['id'],
      'users',
    );
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0]).toContain("o\\'clock");
    expect(r.inserts[0]).toContain('NULL');
  });
});
