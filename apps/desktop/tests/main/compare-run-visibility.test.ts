// 授权盲区收窄单测（纯函数层，不需要真实连接）：
// - narrowToSharedVisibility 的交集收窄与 ExcludedObject 标注
// - **AC2 回归**：cov_limited 实证输入下 `secret_tbl` 不再产生 DROP TABLE
// - **AC5**：库级授权账号路径与改动前完全一致（不收窄、无排除对象）
// - 保守降级：判据不可靠时同样收窄
//
// 行文本/SHOW TABLES 结果均取自隔离 MySQL 5.7.18 fixture 实测输出（凭据不入本文件）。

import { describe, expect, it } from 'vitest';
import { compareRun } from '../../src-core/compare';
import { filterMetadataByScopes } from '../../src-core/compare-filter';
import { parseGrantLines, visibilityFor } from '../../src-core/visibility';
import type { ObjectType, VisibilityAssessment } from '../../src-core/types';
import { narrowToSharedVisibility } from '../../src-main/compare-run';
import type { DatabaseMetadata } from '../../src-main/metadata';

const ALL: ObjectType[] = ['table', 'view', 'procedure', 'function'];

/** fixture 的实测 SHOW GRANTS 行（fixture 账号别名固定，密码不落盘）。 */
const GRANTS_LIMITED = [
  "GRANT USAGE ON *.* TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_tgt`.`open_tbl` TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_src`.`open_tbl` TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_tgt`.`secret_tbl` TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_tgt`.`open_view` TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_src`.`open_view` TO 'cov_x'@'127.0.0.1'",
];
const GRANTS_VIEW = [
  "GRANT USAGE ON *.* TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_src`.* TO 'cov_x'@'127.0.0.1'",
];
// AC5 场景：两侧比较库都授到库级 SELECT（AC1 的 cov_view 判别式：A/B 各自的库都被覆盖）。
const GRANTS_DB_LEVEL_BOTH = [
  ...GRANTS_VIEW,
  "GRANT SELECT ON `cov_tgt`.* TO 'cov_x'@'127.0.0.1'",
];
const GRANTS_MIXED = [
  "GRANT USAGE ON *.* TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_src`.* TO 'cov_x'@'127.0.0.1'",
  "GRANT SELECT ON `cov_tgt`.`open_tbl` TO 'cov_x'@'127.0.0.1'",
];

const RELIABLE: VisibilityAssessment = { byDatabase: {}, reliable: true };
const UNRELIABLE: VisibilityAssessment = { byDatabase: {}, reliable: false };

const T_OPEN_A = 'CREATE TABLE `open_tbl` (\n  `id` int NOT NULL,\n  `a` int NULL\n)';
const T_OPEN_B = 'CREATE TABLE `open_tbl` (\n  `id` int NOT NULL\n)';
const T_SECRET = 'CREATE TABLE `secret_tbl` (\n  `id` int NOT NULL\n)';

function meta(partial: Partial<DatabaseMetadata>): DatabaseMetadata {
  return {
    tables: partial.tables ?? {},
    views: partial.views ?? {},
    procedures: partial.procedures ?? {},
    functions: partial.functions ?? {},
  };
}

describe('AC2 回归：受限账号下不再产生假 DROP（cov_limited 实证输入）', () => {
  // fixture 实测：
  //   cov_limited → SHOW TABLES FROM cov_src = open_tbl                （secret_tbl 不可见）
  //   cov_limited → SHOW TABLES FROM cov_tgt = open_tbl, secret_tbl
  const rawA = meta({ tables: { open_tbl: T_OPEN_A } });
  const rawB = meta({ tables: { open_tbl: T_OPEN_B, secret_tbl: T_SECRET } });

  it('对照组（未收窄的既有行为）：确实会产出 DROP TABLE secret_tbl —— 证明本回归有效', () => {
    // 这正是 prd.md §1 记录的缺陷：收窄前 compareRun 无法区分「不存在」与「看不见」。
    const before = compareRun(rawA, rawB);
    expect(before.items).toContainEqual(
      expect.objectContaining({
        objectName: 'secret_tbl',
        changeType: 'DROP',
        sql: 'DROP TABLE `secret_tbl`;\n',
      }),
    );
    expect(before.stats.DROP).toBe(1);
  });

  it('收窄后 secret_tbl 不产生任何 CREATE/DROP，只列入无法比较清单', () => {
    const visA = parseGrantLines(GRANTS_LIMITED);
    const visB = visA; // 同一个账号连两个库
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      visA,
      visB,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.excluded).toEqual([
      { name: 'secret_tbl', objectType: 'table', side: 'b-only', reason: 'grant-invisible' },
    ]);
    const after = compareRun(narrowed.a, narrowed.b);
    // 假 DROP 归零：secret_tbl 既不产 DROP 也不产 CREATE。
    expect(after.items.some((i) => i.objectName === 'secret_tbl')).toBe(false);
    expect(after.items.some((i) => i.changeType === 'DROP' && i.sql.includes('secret_tbl'))).toBe(false);
    expect(after.stats.DROP).toBe(0);
    // 双方都可见的 open_tbl 差异不受影响（收窄不改变已确定对象的正常 diff）。
    expect(after.stats.ALL).toBeGreaterThan(0);
    expect(after.items.every((i) => i.objectName === 'open_tbl')).toBe(true);
    expect(narrowed.compared).toBe(1);
    expect(narrowed.reliable).toBe(true);
  });

  it('反向场景：仅 A 侧可见的对象标 a-only，同样不产生假 CREATE', () => {
    const rawAT = meta({ tables: { open_tbl: T_OPEN_A, hidden_tbl: T_SECRET } });
    const rawBT = meta({ tables: { open_tbl: T_OPEN_B } });
    const vis = parseGrantLines(GRANTS_LIMITED);
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawAT, ALL),
      filterMetadataByScopes(rawBT, ALL),
      vis,
      vis,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.excluded).toEqual([
      { name: 'hidden_tbl', objectType: 'table', side: 'a-only', reason: 'grant-invisible' },
    ]);
    const after = compareRun(narrowed.a, narrowed.b);
    expect(after.items.some((i) => i.objectName === 'hidden_tbl')).toBe(false);
    expect(after.items.some((i) => i.changeType === 'CREATE' && i.sql.includes('hidden_tbl'))).toBe(false);
  });
});

describe('AC5：库级授权账号路径与改动前完全一致', () => {
  const rawA = meta({ tables: { open_tbl: T_OPEN_A } });
  const rawB = meta({ tables: { open_tbl: T_OPEN_B, secret_tbl: T_SECRET } });
  const visA = parseGrantLines(GRANTS_DB_LEVEL_BOTH);
  const visB = visA;

  it('两侧都 full → 不收窄、excluded 为空、快照原样透传', () => {
    const fA = filterMetadataByScopes(rawA, ALL);
    const fB = filterMetadataByScopes(rawB, ALL);
    const narrowed = narrowToSharedVisibility(fA, fB, visA, visB, { a: 'cov_src', b: 'cov_tgt' });
    expect(narrowed.excluded).toEqual([]);
    expect(narrowed.a).toBe(fA); // 引用透传：连对象都未重建
    expect(narrowed.b).toBe(fB);
    expect(narrowed.reliable).toBe(true);
    // compared 覆盖两侧对象并集（open_tbl + secret_tbl），界面不显示任何提示。
    expect(narrowed.compared).toBe(2);
  });

  it('两侧都 full → compareRun 输出与改动前逐字段一致', () => {
    const fA = filterMetadataByScopes(rawA, ALL);
    const fB = filterMetadataByScopes(rawB, ALL);
    const narrowed = narrowToSharedVisibility(fA, fB, visA, visB, { a: 'cov_src', b: 'cov_tgt' });
    expect(compareRun(narrowed.a, narrowed.b)).toEqual(compareRun(fA, fB));
  });
});

describe('逐库判定（cov_mixed：A 库级 + B 表级）', () => {
  it('任一侧非 full 即收窄（不假设「有一个库 full 就都完整」）', () => {
    const rawA = meta({ tables: { open_tbl: T_OPEN_A, only_a: T_SECRET } });
    const rawB = meta({ tables: { open_tbl: T_OPEN_B } });
    const visA = parseGrantLines(GRANTS_MIXED); // cov_src → full
    const visB = visA; // 同一个账号连 cov_tgt → partial
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      visA,
      visB,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.excluded).toEqual([
      { name: 'only_a', objectType: 'table', side: 'a-only', reason: 'grant-invisible' },
    ]);
  });

  it('只有 B 侧 partial（B 表级授权看不见的 A 对象同样会造假 CREATE）', () => {
    const rawA = meta({ tables: { t1: T_OPEN_A, t2: T_SECRET } });
    const rawB = meta({ tables: { t1: T_OPEN_B } });
    const visA = parseGrantLines(GRANTS_VIEW); // A 侧库级 → full
    const visB = parseGrantLines(GRANTS_LIMITED); // B 侧表级 → partial
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      visA,
      visB,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.excluded.map((x) => x.name)).toEqual(['t2']);
    expect(narrowed.reliable).toBe(true);
  });
});

describe('保守降级：判据不可靠一律收窄', () => {
  const rawA = meta({ tables: { open_tbl: T_OPEN_A } });
  const rawB = meta({ tables: { open_tbl: T_OPEN_B, secret_tbl: T_SECRET } });

  it('reliable:false → 仍按 partial 处理并收窄（query failed / 8.0 角色授权）', () => {
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      UNRELIABLE,
      UNRELIABLE,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.reliable).toBe(false);
    expect(narrowed.excluded.map((x) => x.name)).toEqual(['secret_tbl']);
    expect(compareRun(narrowed.a, narrowed.b).stats.DROP).toBe(0);
  });

  it('由数据库引起的 reliable:false（如 SHOW GRANTS 权限不足）→ 保守收窄', () => {
    const fake: VisibilityAssessment = { byDatabase: { cov_src: 'full' }, reliable: false };
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      fake,
      RELIABLE,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.excluded.map((x) => x.name)).toEqual(['secret_tbl']);
  });

  it('库名大小写与授权不一致 → 不可证明 full，仍收窄（不得因回落而漏出假 DROP）', () => {
    // `lower_case_table_names = 0`（Linux 默认）下 COV_TGT 与 cov_tgt 是两个不同的库。
    // 账号只对 `cov_tgt` 有库级 SELECT；节点 B 却配成了 `COV_TGT`，于是该连接读不到
    // 任何对象 → B 侧快照为空。若这里按大小写不敏感回落判成 full 而不收窄，
    // A 侧 open_tbl 就会变成假 DROP TABLE。
    const grantOnLower = parseGrantLines([
      "GRANT SELECT ON `cov_tgt`.* TO 'u'@'%'",
      "GRANT SELECT ON `cov_src`.* TO 'u'@'%'",
    ]);
    const emptyB = meta({});
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(emptyB, ALL),
      grantOnLower,
      grantOnLower,
      { a: 'cov_src', b: 'COV_TGT' },
    );
    expect(visibilityFor(grantOnLower, 'COV_TGT')).toBe('partial'); // 不做大小写回落
    expect(narrowed.excluded).toEqual([
      { name: 'open_tbl', objectType: 'table', side: 'a-only', reason: 'grant-invisible' },
    ]);
    expect(compareRun(narrowed.a, narrowed.b).stats.DROP).toBe(0);
    // 对照：两侧库名大小写与授权一致时都判 full，完全不收窄 —— 证明上一条
    // 确实是因为大小写对不上才收窄，不是别的理由。
    const exact = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      grantOnLower,
      grantOnLower,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(exact.excluded).toEqual([]);
  });
});

describe('收窄的其他边界', () => {
  it('null 跳过不变量不受影响：SHOW CREATE 失败的对象既不 diff 也不进 excluded', () => {
    const rawA = meta({ tables: { open_tbl: T_OPEN_A, nulled: null } });
    const rawB = meta({ tables: { open_tbl: T_OPEN_B, nulled: null } });
    const vis = parseGrantLines(GRANTS_LIMITED);
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      vis,
      vis,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    // 两侧都在交集里（可见），但 SHOW CREATE 失败 → 由 compareRun 的 null 跳过处理，
    // 不属于「授权不可见」，不进 excluded。
    expect(narrowed.excluded).toEqual([]);
    expect(Object.keys(narrowed.a.tables)).toEqual(['open_tbl', 'nulled']);
    expect(compareRun(narrowed.a, narrowed.b).items.some((i) => i.objectName === 'nulled')).toBe(false);
  });

  it('四类对象都参与收窄（视图/过程/函数同样标注 objectType）', () => {
    const rawA = meta({
      tables: { t: T_OPEN_A },
      views: { v: 'CREATE VIEW `v` AS SELECT 1' },
      procedures: { p: 'CREATE PROCEDURE `p`() BEGIN END' },
      functions: { f: 'CREATE FUNCTION `f`() RETURNS INT RETURN 1' },
    });
    const rawB = meta({ tables: { t: T_OPEN_B } });
    const vis = parseGrantLines(GRANTS_LIMITED);
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ALL),
      filterMetadataByScopes(rawB, ALL),
      vis,
      vis,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.excluded).toEqual(
      expect.arrayContaining([
        { name: 'v', objectType: 'view', side: 'a-only', reason: 'grant-invisible' },
        { name: 'p', objectType: 'procedure', side: 'a-only', reason: 'grant-invisible' },
        { name: 'f', objectType: 'function', side: 'a-only', reason: 'grant-invisible' },
      ]),
    );
    expect(narrowed.compared).toBe(1);
  });

  it('scopes 之外的对象已被 filterMetadataByScopes 裁掉，不会误入 excluded', () => {
    const rawA = meta({ tables: { t: T_OPEN_A }, views: { v: 'CREATE VIEW `v` AS SELECT 1' } });
    const rawB = meta({ tables: { t: T_OPEN_B } });
    const vis = parseGrantLines(GRANTS_LIMITED);
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(rawA, ['table']),
      filterMetadataByScopes(rawB, ['table']),
      vis,
      vis,
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.excluded).toEqual([]);
    expect(narrowed.compared).toBe(1);
  });

  it('收窄结果为空时 compared 为 0，不会虚报范围', () => {
    const narrowed = narrowToSharedVisibility(
      filterMetadataByScopes(meta({ tables: { a: T_OPEN_A } }), ALL),
      filterMetadataByScopes(meta({ tables: { b: T_SECRET } }), ALL),
      parseGrantLines(GRANTS_LIMITED),
      parseGrantLines(GRANTS_LIMITED),
      { a: 'cov_src', b: 'cov_tgt' },
    );
    expect(narrowed.compared).toBe(0);
    expect(narrowed.excluded).toHaveLength(2);
    expect(compareRun(narrowed.a, narrowed.b).items).toEqual([]);
  });
});
