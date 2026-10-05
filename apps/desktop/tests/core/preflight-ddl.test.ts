// 生产 Preflight v1 · DDL 分类器与 Online DDL 矩阵单测。
//
// 覆盖：
// - classifyDdl 15 种 DdlOp 正例 + 反例 + OTHER 兜底 + 反引号 + 复合 ALTER
// - versionAtLeast 全部分支（含非法字符串）
// - lookupOnlineDdl 五版本 × 主要 Op 矩阵 + 边界（版本 < 5.6 → null、OTHER → null）

import { describe, expect, it } from 'vitest';
import { classifyDdl, lookupOnlineDdl, versionAtLeast } from '../../src-core/preflight-ddl';
import type { DdlOp, OnlineDdlInfo } from '../../src-core/preflight-ddl';

// ---------------------------------------------------------------------------
// classifyDdl · 每种 DdlOp 正例
// ---------------------------------------------------------------------------

describe('classifyDdl · 每种 DdlOp 正例', () => {
  // 说明：`ADD_INDEX` 的 add-regular-INDEX 与 `ADD_UNIQUE_INDEX` / `ADD_PRIMARY_KEY` 之间
  // 存在明确的优先级（先 PRIMARY、再 UNIQUE、再 INDEX），因此同一 SQL 不会被误分类。
  const cases: Array<{
    op: DdlOp;
    sql: string;
    tableName: string | null;
    columnName: string | null;
    indexName: string | null;
    confidence: 'high' | 'medium' | 'low';
  }> = [
    {
      op: 'DROP_TABLE',
      sql: 'DROP TABLE orders',
      tableName: 'orders',
      columnName: null,
      indexName: null,
      confidence: 'high',
    },
    {
      op: 'CREATE_TABLE',
      sql: 'CREATE TABLE t (id INT PRIMARY KEY)',
      tableName: 't',
      columnName: null,
      indexName: null,
      confidence: 'high',
    },
    {
      // RENAME_TABLE 的 tableName 是新表名（TO 之后的目标）。
      op: 'RENAME_TABLE',
      sql: 'RENAME TABLE a TO b',
      tableName: 'b',
      columnName: null,
      indexName: null,
      confidence: 'high',
    },
    {
      // CREATE INDEX 无法从 SQL 判定是否 UNIQUE，confidence 为 medium。
      op: 'CREATE_INDEX',
      sql: 'CREATE INDEX idx ON t (col)',
      tableName: 't',
      columnName: null,
      indexName: 'idx',
      confidence: 'medium',
    },
    {
      op: 'DROP_INDEX_STANDALONE',
      sql: 'DROP INDEX idx ON t',
      tableName: 't',
      columnName: null,
      indexName: 'idx',
      confidence: 'high',
    },
    {
      op: 'ADD_PRIMARY_KEY',
      sql: 'ALTER TABLE t ADD PRIMARY KEY (id)',
      tableName: 't',
      columnName: null,
      indexName: null,
      confidence: 'high',
    },
    {
      // ADD [UNIQUE] INDEX 通过 extractFirstColumnFromIndexOp 提取索引定义的第一个列名。
      op: 'ADD_UNIQUE_INDEX',
      sql: 'ALTER TABLE t ADD UNIQUE INDEX u_idx (col)',
      tableName: 't',
      columnName: 'col',
      indexName: 'u_idx',
      confidence: 'high',
    },
    {
      op: 'ADD_INDEX',
      sql: 'ALTER TABLE t ADD INDEX idx (col)',
      tableName: 't',
      columnName: 'col',
      indexName: 'idx',
      confidence: 'high',
    },
    {
      op: 'DROP_INDEX',
      sql: 'ALTER TABLE t DROP INDEX idx',
      tableName: 't',
      columnName: null,
      indexName: 'idx',
      confidence: 'high',
    },
    {
      op: 'DROP_COLUMN',
      sql: 'ALTER TABLE t DROP COLUMN col',
      tableName: 't',
      columnName: 'col',
      indexName: null,
      confidence: 'high',
    },
    {
      // CHANGE COLUMN old new 的 columnName 取旧列名。
      op: 'CHANGE_COLUMN',
      sql: 'ALTER TABLE t CHANGE COLUMN old_col new_col INT',
      tableName: 't',
      columnName: 'old_col',
      indexName: null,
      confidence: 'high',
    },
    {
      op: 'MODIFY_COLUMN',
      sql: 'ALTER TABLE t MODIFY COLUMN col INT',
      tableName: 't',
      columnName: 'col',
      indexName: null,
      confidence: 'high',
    },
    {
      op: 'ADD_COLUMN',
      sql: 'ALTER TABLE t ADD COLUMN col INT',
      tableName: 't',
      columnName: 'col',
      indexName: null,
      confidence: 'high',
    },
    {
      op: 'CONVERT_TO_CHAR_SET',
      sql: 'ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4',
      tableName: 't',
      columnName: null,
      indexName: null,
      confidence: 'high',
    },
    {
      op: 'CHANGE_ENGINE',
      sql: 'ALTER TABLE t ENGINE=InnoDB',
      tableName: 't',
      columnName: null,
      indexName: null,
      confidence: 'high',
    },
  ];

  for (const c of cases) {
    it(`${c.op}：${c.sql}`, () => {
      const r = classifyDdl(c.sql);
      expect(r).toEqual({
        op: c.op,
        tableName: c.tableName,
        columnName: c.columnName,
        indexName: c.indexName,
        statement: c.sql,
        confidence: c.confidence,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// classifyDdl · 反例（防止关键字优先级被颠倒）
// ---------------------------------------------------------------------------

describe('classifyDdl · 反例（防止优先级颠倒）', () => {
  it('CREATE TABLE orders 不应被判为 DROP_TABLE（关键字 CREATE 明确）', () => {
    const r = classifyDdl('CREATE TABLE orders');
    expect(r.op).toBe('CREATE_TABLE');
    expect(r.op).not.toBe('DROP_TABLE');
  });

  it('ALTER TABLE t DROP INDEX idx 不应被判为 DROP_COLUMN（先匹配 INDEX 关键字）', () => {
    const r = classifyDdl('ALTER TABLE t DROP INDEX idx');
    expect(r.op).toBe('DROP_INDEX');
    expect(r.op).not.toBe('DROP_COLUMN');
  });

  it('ALTER TABLE t ADD PRIMARY KEY (id) 不应被降级为 ADD_COLUMN（先匹配 PRIMARY KEY）', () => {
    const r = classifyDdl('ALTER TABLE t ADD PRIMARY KEY (id)');
    expect(r.op).toBe('ADD_PRIMARY_KEY');
    expect(r.op).not.toBe('ADD_COLUMN');
  });

  it('ALTER TABLE t ADD UNIQUE KEY u (col) 归入 ADD_UNIQUE_INDEX（INDEX 与 KEY 等价）', () => {
    const r = classifyDdl('ALTER TABLE t ADD UNIQUE KEY u (col)');
    expect(r.op).toBe('ADD_UNIQUE_INDEX');
    expect(r.indexName).toBe('u');
  });
});

// ---------------------------------------------------------------------------
// classifyDdl · OTHER 兜底
// ---------------------------------------------------------------------------

describe('classifyDdl · OTHER 兜底', () => {
  const otherCases: Array<[string, string]> = [
    // PARTITION BY 子句本身不是列操作
    ['ALTER TABLE t PARTITION BY RANGE(id)', 'PARTITION BY 非列操作'],
    // ADD PARTITION 是分区变更，非列/索引操作
    ['ALTER TABLE t ADD PARTITION (PARTITION p0 VALUES LESS THAN (1))', 'ADD PARTITION 非列操作'],
    // TRUNCATE 走 DML/DDL 但不在 DdlOp 枚举里
    ['TRUNCATE TABLE t', 'TRUNCATE 非 alter 语句'],
    // CREATE VIEW 不在 v1 DDL 矩阵
    ['CREATE VIEW v AS SELECT 1', 'CREATE VIEW 非表操作'],
    // ANALYZE 不在 DDL 矩阵
    ['ANALYZE TABLE t', 'ANALYZE 非 DDL 修改'],
  ];

  for (const [sql, note] of otherCases) {
    it(`${note}：${sql} → OTHER/low`, () => {
      const r = classifyDdl(sql);
      expect(r).toEqual({
        op: 'OTHER',
        tableName: null,
        columnName: null,
        indexName: null,
        statement: sql,
        confidence: 'low',
      });
    });
  }

  it('空字符串 → OTHER，statement 保持为空', () => {
    expect(classifyDdl('')).toEqual({
      op: 'OTHER',
      tableName: null,
      columnName: null,
      indexName: null,
      statement: '',
      confidence: 'low',
    });
  });

  it('纯空白字符串 trim 后与空串等价', () => {
    expect(classifyDdl('   ')).toEqual({
      op: 'OTHER',
      tableName: null,
      columnName: null,
      indexName: null,
      statement: '',
      confidence: 'low',
    });
  });
});

// ---------------------------------------------------------------------------
// classifyDdl · 反引号标识符
// ---------------------------------------------------------------------------

describe('classifyDdl · 反引号标识符', () => {
  it('ALTER TABLE `my-table` ADD COLUMN `new_col` INT → tableName=my-table, columnName=new_col', () => {
    const r = classifyDdl('ALTER TABLE `my-table` ADD COLUMN `new_col` INT');
    expect(r.op).toBe('ADD_COLUMN');
    expect(r.tableName).toBe('my-table');
    expect(r.columnName).toBe('new_col');
  });

  it('ALTER TABLE t ADD COLUMN `my col` INT → columnName="my col"（反引号允许空格）', () => {
    const r = classifyDdl('ALTER TABLE t ADD COLUMN `my col` INT');
    expect(r.columnName).toBe('my col');
  });

  it('ALTER TABLE t CHANGE COLUMN `old` `new` INT → columnName=old（旧列名）', () => {
    const r = classifyDdl('ALTER TABLE t CHANGE COLUMN `old` `new` INT');
    expect(r.op).toBe('CHANGE_COLUMN');
    expect(r.columnName).toBe('old');
  });
});

// ---------------------------------------------------------------------------
// classifyDdl · 复合 ALTER（首条匹配）
// ---------------------------------------------------------------------------

describe('classifyDdl · 复合 ALTER', () => {
  it('ALTER TABLE t ADD COLUMN a INT, ADD COLUMN b INT → op=ADD_COLUMN，columnName 取首个 "a"', () => {
    const r = classifyDdl('ALTER TABLE t ADD COLUMN a INT, ADD COLUMN b INT');
    expect(r.op).toBe('ADD_COLUMN');
    expect(r.columnName).toBe('a');
    expect(r.statement).toBe('ALTER TABLE t ADD COLUMN a INT, ADD COLUMN b INT');
  });
});

// ---------------------------------------------------------------------------
// versionAtLeast · 全分支
// ---------------------------------------------------------------------------

describe('versionAtLeast', () => {
  it.each([
    ['8.0.36', '8.0.12', true],
    ['8.0.12', '8.0.12', true],
    ['8.0.11', '8.0.12', false],
    ['5.7.44', '8.0.12', false],
    ['8.4.0', '8.0.12', true],
    ['8.0.29', '8.0.29', true],
    ['8.0.28', '8.0.29', false],
  ] as Array<[string, string, boolean]>)(
    'versionAtLeast(%p, %p) = %p',
    (actual, required, expected) => {
      expect(versionAtLeast(actual, required)).toBe(expected);
    },
  );

  it('空字符串视为非法版本 → false', () => {
    expect(versionAtLeast('', '8.0.12')).toBe(false);
  });

  it('非数字前缀字符串视为非法 → false', () => {
    expect(versionAtLeast('not-a-version', '8.0.12')).toBe(false);
  });

  it('required 参数非法 → false（不依赖 actual 是否合法）', () => {
    expect(versionAtLeast('8.0.36', '')).toBe(false);
    expect(versionAtLeast('8.0.36', 'abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lookupOnlineDdl · 版本 × Op 矩阵
// ---------------------------------------------------------------------------

describe('lookupOnlineDdl', () => {
  // 只断言 matrix 中稳定字段（algorithm / lockMode / rebuildsTable / availableFrom），
  // notes 属于说明性文本，允许在版本升级时改写。
  type MatrixEntry = Pick<OnlineDdlInfo, 'algorithm' | 'lockMode' | 'rebuildsTable' | 'availableFrom'>;

  const matrixCases: Array<[DdlOp, string, MatrixEntry | null, string]> = [
    ['ADD_INDEX', '5.7.44', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: false, availableFrom: '5.6' }, '非 UNIQUE 索引不重建'],
    ['ADD_INDEX', '8.0.36', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: false, availableFrom: '5.6' }, 'MySQL 8.0 保持一致'],
    ['ADD_UNIQUE_INDEX', '5.7.44', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: true, availableFrom: '5.6' }, 'UNIQUE 需重建'],
    ['ADD_PRIMARY_KEY', '8.0.36', { algorithm: 'INPLACE', lockMode: 'EXCLUSIVE', rebuildsTable: true, availableFrom: '5.6' }, 'PRIMARY KEY 排他锁 + 重建'],
    ['DROP_INDEX', '8.0.36', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: false, availableFrom: '5.6' }, 'DROP INDEX 不重建'],
    ['ADD_COLUMN', '8.0.11', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: true, availableFrom: '5.6' }, 'INSTANT 之前一律 INPLACE + 重建'],
    ['ADD_COLUMN', '8.0.12', { algorithm: 'INSTANT', lockMode: 'SHARED', rebuildsTable: false, availableFrom: '8.0.12' }, 'INSTANT 阈值（v1 乐观推断）'],
    ['DROP_COLUMN', '8.0.28', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: true, availableFrom: '5.6' }, 'INSTANT 之前一律重建'],
    ['DROP_COLUMN', '8.0.29', { algorithm: 'INSTANT', lockMode: 'NONE', rebuildsTable: false, availableFrom: '8.0.29' }, '8.0.29 起原生 INSTANT'],
    ['MODIFY_COLUMN', '8.0.36', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: true, availableFrom: '5.6' }, 'MODIFY 一律重建'],
    ['CHANGE_COLUMN', '8.0.36', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: true, availableFrom: '5.6' }, 'CHANGE 一律重建'],
    ['CONVERT_TO_CHAR_SET', '8.0.36', { algorithm: 'INPLACE', lockMode: 'SHARED', rebuildsTable: true, availableFrom: '5.6' }, '字符集扩张重建'],
    ['CREATE_TABLE', '8.0.36', { algorithm: 'INPLACE', lockMode: 'EXCLUSIVE-BRIEF', rebuildsTable: false, availableFrom: '5.6' }, 'CREATE TABLE 短暂排他'],
    ['DROP_TABLE', '8.0.36', { algorithm: 'INPLACE', lockMode: 'EXCLUSIVE-BRIEF', rebuildsTable: false, availableFrom: '5.6' }, 'DROP TABLE 短暂排他'],
    ['RENAME_TABLE', '8.0.36', { algorithm: 'INPLACE', lockMode: 'EXCLUSIVE-BRIEF', rebuildsTable: false, availableFrom: '5.6' }, 'RENAME 短暂排他'],
  ];

  for (const [op, ver, expected, note] of matrixCases) {
    it(`${op} @ ${ver}（${note}）`, () => {
      const r = lookupOnlineDdl(op, ver);
      expect(r).not.toBeNull();
      expect(r).toMatchObject(expected as MatrixEntry);
    });
  }

  it('MySQL 5.5（低于 MIN_VERSION 5.6）→ null', () => {
    expect(lookupOnlineDdl('ADD_COLUMN', '5.5.60')).toBeNull();
    expect(lookupOnlineDdl('ADD_INDEX', '5.5.60')).toBeNull();
  });

  it('空版本字符串 → null', () => {
    expect(lookupOnlineDdl('ADD_COLUMN', '')).toBeNull();
  });

  it('OTHER op → null（上层记 unparsed-ddl）', () => {
    expect(lookupOnlineDdl('OTHER', '8.0.36')).toBeNull();
  });

  it('availableFrom 严格等于实际启用阈值', () => {
    expect(lookupOnlineDdl('ADD_COLUMN', '8.0.12')?.availableFrom).toBe('8.0.12');
    expect(lookupOnlineDdl('DROP_COLUMN', '8.0.29')?.availableFrom).toBe('8.0.29');
    expect(lookupOnlineDdl('ADD_INDEX', '8.0.36')?.availableFrom).toBe('5.6');
  });
});
