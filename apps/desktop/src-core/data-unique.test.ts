// 小增强 R1 单测：UNIQUE 等价行身份资格判定（Q1=仅 NOT NULL）。
import { describe, expect, it } from 'vitest';
import { isColumnNotNull, parseUniqueKeys, qualifyIdentity } from './data-pk';
// 双路径引用兼容：data-unique.ts 重导出同一实现。
import { parseUniqueKeys as parseUniqueKeys2, qualifyIdentity as qualifyIdentity2 } from './data-unique';

const DDL_PK_PLUS_NULLABLE_UNIQUE = [
  'CREATE TABLE `users` (',
  '  `id` int NOT NULL AUTO_INCREMENT,',
  '  `email` varchar(255) DEFAULT NULL,',
  '  PRIMARY KEY (`id`),',
  '  UNIQUE KEY `uk_email` (`email`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_SINGLE_NONNULL_UNIQUE = [
  'CREATE TABLE `users` (',
  '  `id` int DEFAULT NULL,',
  '  `email` varchar(255) NOT NULL,',
  '  UNIQUE KEY `uk_email` (`email`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_COMPOSITE_ALL_NONNULL = [
  'CREATE TABLE `items` (',
  '  `a` int NOT NULL,',
  '  `b` varchar(32) NOT NULL,',
  '  `v` int DEFAULT NULL,',
  '  UNIQUE KEY `uk_ab` (`a`,`b`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_COMPOSITE_WITH_NULLABLE = [
  'CREATE TABLE `items` (',
  '  `a` int NOT NULL,',
  '  `b` varchar(32) DEFAULT NULL,',
  '  UNIQUE KEY `uk_ab` (`a`, `b`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_NO_KEYS = [
  'CREATE TABLE `logs` (',
  '  `id` int DEFAULT NULL,',
  '  `msg` varchar(64) DEFAULT NULL',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_INLINE_UNIQUE = [
  'CREATE TABLE `users` (',
  '  `id` int DEFAULT NULL,',
  "  `email` varchar(255) NOT NULL UNIQUE COMMENT 'login email',",
  '  `nick` varchar(64) DEFAULT NULL',
  ') ENGINE=InnoDB',
].join('\n');

describe('parseUniqueKeys UNIQUE 解析', () => {
  it('具名单列/复合 UNIQUE + 逐列可空标记', () => {
    const keys = parseUniqueKeys(DDL_COMPOSITE_WITH_NULLABLE);
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe('uk_ab');
    expect(keys[0].cols).toEqual(['a', 'b']);
    expect(keys[0].nullable).toEqual([false, true]);
  });

  it('列级内联 UNIQUE 识别为匿名 unique（COMMENT 含引号不干扰）', () => {
    const keys = parseUniqueKeys(DDL_INLINE_UNIQUE);
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBeNull();
    expect(keys[0].cols).toEqual(['email']);
    expect(keys[0].nullable).toEqual([false]);
  });

  it('COMMENT 内 UNIQUE KEY 字面量不误判；空串/null -> []', () => {
    const ddl = [
      'CREATE TABLE `t` (',
      "  `c` varchar(64) DEFAULT NULL COMMENT 'has UNIQUE KEY (`x`) text',",
      '  `id` int NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB',
    ].join('\n');
    expect(parseUniqueKeys(ddl)).toEqual([]);
    expect(parseUniqueKeys('')).toEqual([]);
    expect(parseUniqueKeys(null)).toEqual([]);
  });
});

describe('isColumnNotNull 列级判定', () => {
  it('显式 NOT NULL 为 true；DEFAULT NULL/未知列为 false', () => {
    expect(isColumnNotNull(DDL_SINGLE_NONNULL_UNIQUE, 'email')).toBe(true);
    expect(isColumnNotNull(DDL_SINGLE_NONNULL_UNIQUE, 'id')).toBe(false);
    expect(isColumnNotNull(DDL_SINGLE_NONNULL_UNIQUE, 'missing')).toBe(false);
  });

  it('PRIMARY KEY 隐式非空不计入（行内 PRIMARY KEY 无 NOT NULL 字样按可空）', () => {
    const ddl = ['CREATE TABLE `t` (', '  `id` int PRIMARY KEY,', '  UNIQUE KEY `uk_id` (`id`)', ')'].join('\n');
    expect(isColumnNotNull(ddl, 'id')).toBe(false);
    expect(qualifyIdentity(ddl)).toEqual({
      kind: 'none',
      reason: 'UNIQUE uk_id(id)含可空列：id',
    });
  });
});

describe('qualifyIdentity 资格判定（Q1 仅 NOT NULL）', () => {
  it('有 PK 时优先 PK（可空 UNIQUE 不干扰）', () => {
    expect(qualifyIdentity(DDL_PK_PLUS_NULLABLE_UNIQUE)).toEqual({ kind: 'pk', cols: ['id'] });
  });

  it('单列 NOT NULL UNIQUE -> unique', () => {
    expect(qualifyIdentity(DDL_SINGLE_NONNULL_UNIQUE)).toEqual({
      kind: 'unique',
      cols: ['email'],
      name: 'uk_email',
    });
  });

  it('复合全非空 UNIQUE -> unique', () => {
    expect(qualifyIdentity(DDL_COMPOSITE_ALL_NONNULL)).toEqual({
      kind: 'unique',
      cols: ['a', 'b'],
      name: 'uk_ab',
    });
  });

  it('复合含可空列 -> none，reason 点名可空列', () => {
    const r = qualifyIdentity(DDL_COMPOSITE_WITH_NULLABLE);
    expect(r.kind).toBe('none');
    if (r.kind === 'none') {
      expect(r.reason).toContain('uk_ab');
      expect(r.reason).toContain('b');
    }
  });

  it('无 PK 无 UNIQUE -> none（无唯一键理由）', () => {
    expect(qualifyIdentity(DDL_NO_KEYS)).toEqual({
      kind: 'none',
      reason: '无 PRIMARY KEY 且无 UNIQUE 键',
    });
    expect(qualifyIdentity('')).toEqual({ kind: 'none', reason: '无 PRIMARY KEY 且无 UNIQUE 键' });
    expect(qualifyIdentity(null)).toEqual({ kind: 'none', reason: '无 PRIMARY KEY 且无 UNIQUE 键' });
  });

  it('data-unique 重导出与 data-pk 一致', () => {
    expect(qualifyIdentity2(DDL_SINGLE_NONNULL_UNIQUE)).toEqual(qualifyIdentity(DDL_SINGLE_NONNULL_UNIQUE));
    expect(parseUniqueKeys2(DDL_COMPOSITE_WITH_NULLABLE)).toEqual(parseUniqueKeys(DDL_COMPOSITE_WITH_NULLABLE));
  });
});
