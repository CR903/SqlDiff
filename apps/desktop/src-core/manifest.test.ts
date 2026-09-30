// P0 审查报告 manifest 单测：CoverageStatus 全分支、DML 脱敏器、确定性序列化、
// Markdown 交接报告、真实结果 -> manifest -> 重新解析（AC3）、无秘密检查（AC2）。

import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  deriveCoverageStatus,
  manifestFileNames,
  manifestToMarkdown,
  redactDmlSql,
  serializeManifest,
} from './manifest';
import { REVIEW_MANIFEST_VERSION } from './types';
import type {
  CompareRequest,
  CompareResult,
  CompareStats,
  DataTableStatus,
  DiffItem,
  ManifestBuildInput,
  ReviewManifest,
} from './types';

function stats(overrides: Partial<CompareStats> = {}): CompareStats {
  return {
    ALL: 0,
    CREATE: 0,
    DROP: 0,
    CHANGE: 0,
    INDEX: 0,
    DML: { INSERT: 0, DELETE: 0, UPDATE: 0 },
    ...overrides,
  };
}

function result(overrides: Partial<CompareResult> = {}): CompareResult {
  return { items: [], stats: stats(), ...overrides };
}

function request(overrides: Partial<CompareRequest> = {}): CompareRequest {
  return {
    aId: 'a',
    bId: 'b',
    scopes: ['table', 'view', 'procedure', 'function'],
    ...overrides,
  };
}

function input(overrides: Partial<ManifestBuildInput> = {}): ManifestBuildInput {
  return {
    result: result(),
    request: request(),
    aAlias: 'A库',
    bAlias: 'B库',
    appVersion: '0.1.0',
    ...overrides,
  };
}

function item(overrides: Partial<DiffItem> = {}): DiffItem {
  return {
    id: 'table:users:s0',
    objectType: 'table',
    objectName: 'users',
    changeType: 'CHANGE',
    aspects: ['column'],
    risk: 'medium',
    sql: 'ALTER TABLE `users` ADD COLUMN `age` int;',
    ...overrides,
  };
}

function dataStatus(overrides: Partial<DataTableStatus> = {}): DataTableStatus {
  return { a: 'users', b: 'users', status: 'done', ...overrides };
}

// ---------------------------------------------------------------------------
// deriveCoverageStatus：全分支
// ---------------------------------------------------------------------------

describe('deriveCoverageStatus', () => {
  it('无任何问题 -> ok，counts 为 { ok: 1 }', () => {
    expect(deriveCoverageStatus(result())).toEqual({ kind: 'ok', counts: { ok: 1 } });
  });

  it('结构 skipped permission-denied -> permission-denied', () => {
    const r = result({
      coverage: {
        ok: { table: 1, view: 0, procedure: 0, function: 0 },
        skipped: [{ name: 'secret_tbl', objectType: 'table', reason: 'permission-denied' }],
      },
    });
    expect(deriveCoverageStatus(r)).toEqual({
      kind: 'permission-denied',
      counts: { 'permission-denied': 1 },
    });
  });

  it('结构 skipped object-missing / unknown -> error', () => {
    const r = result({
      coverage: {
        ok: { table: 0, view: 0, procedure: 0, function: 0 },
        skipped: [
          { name: 'gone', objectType: 'view', reason: 'object-missing' },
          { name: 'weird', objectType: 'procedure', reason: 'unknown' },
        ],
      },
    });
    expect(deriveCoverageStatus(r)).toEqual({ kind: 'error', counts: { error: 2 } });
  });

  it('结构 skipped aborted -> aborted', () => {
    const r = result({
      coverage: {
        ok: { table: 0, view: 0, procedure: 0, function: 0 },
        skipped: [{ name: 'big', objectType: 'table', reason: 'aborted' }],
      },
    });
    expect(deriveCoverageStatus(r)).toEqual({ kind: 'aborted', counts: { aborted: 1 } });
  });

  it('数据侧 no-pk / pk-mismatch -> no-row-identity', () => {
    const r = result({
      dataTables: [
        dataStatus({ status: 'skipped', reason: 'no-pk' }),
        dataStatus({ a: 't2', b: 't2', status: 'error', reason: 'pk-mismatch' }),
      ],
    });
    expect(deriveCoverageStatus(r)).toEqual({
      kind: 'no-row-identity',
      counts: { 'no-row-identity': 2 },
    });
  });

  it('数据侧 confirm-needed / skipped over-threshold -> over-threshold', () => {
    const r = result({
      dataTables: [
        dataStatus({ status: 'confirm-needed', reason: 'over-threshold' }),
        dataStatus({ a: 't2', b: 't2', status: 'skipped', reason: 'over-threshold' }),
      ],
    });
    expect(deriveCoverageStatus(r)).toEqual({
      kind: 'over-threshold',
      counts: { 'over-threshold': 2 },
    });
  });

  it('数据侧 fetch-failed -> error', () => {
    const r = result({
      dataTables: [dataStatus({ status: 'error', reason: 'fetch-failed' })],
    });
    expect(deriveCoverageStatus(r)).toEqual({ kind: 'error', counts: { error: 1 } });
  });

  it('visibility.excluded 非空 -> grant-invisible（每个对象计 1）', () => {
    const r = result({
      visibility: {
        excluded: [
          { name: 'secret_tbl', objectType: 'table', side: 'a-only', reason: 'grant-invisible' },
          { name: 'secret_view', objectType: 'view', side: 'b-only', reason: 'grant-invisible' },
        ],
        compared: 3,
        reliable: true,
      },
    });
    expect(deriveCoverageStatus(r)).toEqual({
      kind: 'grant-invisible',
      counts: { 'grant-invisible': 2 },
    });
  });

  it('多种来源累加计数，kind 取优先级最高（grant-invisible > permission-denied）', () => {
    const r = result({
      coverage: {
        ok: { table: 0, view: 0, procedure: 0, function: 0 },
        skipped: [
          { name: 'p1', objectType: 'table', reason: 'permission-denied' },
          { name: 'p2', objectType: 'view', reason: 'permission-denied' },
        ],
      },
      dataTables: [dataStatus({ status: 'error', reason: 'fetch-failed' })],
      visibility: {
        excluded: [{ name: 'hidden', objectType: 'table', side: 'a-only', reason: 'grant-invisible' }],
        compared: 5,
        reliable: true,
      },
    });
    expect(deriveCoverageStatus(r)).toEqual({
      kind: 'grant-invisible',
      counts: { 'permission-denied': 2, error: 1, 'grant-invisible': 1 },
    });
  });

  it('done / pending / running 数据表不产生问题', () => {
    const r = result({
      dataTables: [
        dataStatus(),
        dataStatus({ a: 't2', b: 't2', status: 'pending' }),
        dataStatus({ a: 't3', b: 't3', status: 'running' }),
      ],
    });
    expect(deriveCoverageStatus(r)).toEqual({ kind: 'ok', counts: { ok: 1 } });
  });
});

// ---------------------------------------------------------------------------
// redactDmlSql：字符串 / 数字 / 日期 / Buffer / NULL / 反引号 / 多行 / 注释
// ---------------------------------------------------------------------------

describe('redactDmlSql', () => {
  it('单引号字符串 -> \'***\'，NULL 保留', () => {
    expect(redactDmlSql("INSERT INTO `t` VALUES ('abc', NULL);")).toBe(
      "INSERT INTO `t` VALUES ('***', NULL);",
    );
  });

  it('数字字面量 -> 0（整数/小数/负数/科学计数法）', () => {
    expect(redactDmlSql('UPDATE `t` SET `n`=123, `f`=4.5, `neg`=-1, `big`=1e+21 WHERE `id`=7;')).toBe(
      'UPDATE `t` SET `n`=0, `f`=0, `neg`=-0, `big`=0 WHERE `id`=0;',
    );
  });

  it('日期字面量（本质是字符串）-> \'***\'', () => {
    expect(redactDmlSql("INSERT INTO `t` VALUES ('2024-01-01 00:00:00');")).toBe(
      "INSERT INTO `t` VALUES ('***');",
    );
  });

  it('Buffer/二进制转义串（sqlLiteral 输出为字符串）-> \'***\'', () => {
    expect(redactDmlSql("INSERT INTO `t` VALUES ('\\x00\\x01binary');")).toBe(
      "INSERT INTO `t` VALUES ('***');",
    );
  });

  it('TRUE / FALSE 保留', () => {
    expect(redactDmlSql('UPDATE `t` SET `flag`=TRUE WHERE `id`=1 AND `ok`=FALSE;')).toBe(
      'UPDATE `t` SET `flag`=TRUE WHERE `id`=0 AND `ok`=FALSE;',
    );
  });

  it('反引号标识符含单引号不误伤', () => {
    expect(redactDmlSql("UPDATE `it's` SET `name`='x' WHERE `id`=1;")).toBe(
      "UPDATE `it's` SET `name`='***' WHERE `id`=0;",
    );
  });

  it('反引号加倍转义的标识符整体保留', () => {
    expect(redactDmlSql('INSERT INTO `we``ird` VALUES (1);')).toBe(
      'INSERT INTO `we``ird` VALUES (0);',
    );
  });

  it('字符串内出现反引号仍整体脱敏为 \'***\'', () => {
    expect(redactDmlSql("INSERT INTO `t` VALUES ('a`b`c');")).toBe(
      "INSERT INTO `t` VALUES ('***');",
    );
  });

  it('转义引号与加倍引号正确处理', () => {
    expect(redactDmlSql("INSERT INTO `t` VALUES ('o\\'clock');")).toBe(
      "INSERT INTO `t` VALUES ('***');",
    );
    expect(redactDmlSql("INSERT INTO `t` VALUES ('o''clock');")).toBe(
      "INSERT INTO `t` VALUES ('***');",
    );
  });

  it('多行 DML 与注释保留', () => {
    const sql = [
      "-- 行注释：插入用户",
      "INSERT INTO `users` (`id`, `name`) VALUES",
      "(1, 'a'),",
      "(2, 'b');",
      "/* 块注释 */",
      "UPDATE `users` SET `name`='c' WHERE `id`=1;",
    ].join('\n');
    expect(redactDmlSql(sql)).toBe(
      [
        "-- 行注释：插入用户",
        "INSERT INTO `users` (`id`, `name`) VALUES",
        "(0, '***'),",
        "(0, '***');",
        "/* 块注释 */",
        "UPDATE `users` SET `name`='***' WHERE `id`=0;",
      ].join('\n'),
    );
  });

  it('无数字字面量的 DDL 原样保留（标识符/关键字不动）', () => {
    const ddl = 'CREATE TABLE `users` (`name` text, PRIMARY KEY (`id`));';
    expect(redactDmlSql(ddl)).toBe(ddl);
  });
});

// ---------------------------------------------------------------------------
// buildManifest：投影、demo 拒绝、rollback/explain 排除
// ---------------------------------------------------------------------------

describe('buildManifest', () => {
  it('从真实 CompareResult 投影出 ReviewManifest（含 scopes/统计/覆盖/可见性）', () => {
    const r = result({
      items: [
        item(),
        item({
          id: 'data:users:users:INSERT:0',
          objectType: 'data',
          objectName: 'users',
          changeType: 'CREATE',
          dml: 'INSERT',
          aspects: ['data'],
          risk: 'low',
          sql: "INSERT INTO `users` VALUES (1,'alice',NULL);",
        }),
      ],
      stats: stats({ ALL: 2, CREATE: 1, CHANGE: 1, DML: { INSERT: 1, DELETE: 0, UPDATE: 0 } }),
      source: 'real',
      coverage: {
        ok: { table: 1, view: 0, procedure: 0, function: 0 },
        skipped: [],
      },
      visibility: { excluded: [], compared: 1, reliable: true },
    });
    const m = buildManifest(
      input({
        result: r,
        request: request({ scopes: ['table', 'data'], includeData: true, tableFilter: 'user' }),
      }),
    );

    expect(m.schemaVersion).toBe(REVIEW_MANIFEST_VERSION);
    expect(m.source).toBe('real');
    expect(m.aAlias).toBe('A库');
    expect(m.bAlias).toBe('B库');
    expect(m.appVersion).toBe('0.1.0');
    expect(m.scope).toEqual({
      scopes: ['table', 'data'],
      includeData: true,
      tableFilter: 'user',
    });
    expect(m.stats).toEqual(r.stats);
    expect(m.items).toHaveLength(2);
    expect(m.coverageStatus.kind).toBe('ok');
    expect(m.coverage).toBeDefined();
    expect(m.visibility).toBeDefined();
  });

  it('demo 结果拒绝导出（manifest: 错误）', () => {
    expect(() =>
      buildManifest(input({ result: result({ source: 'demo' }) })),
    ).toThrow(/^manifest:.*演示结果不可导出/);
  });

  it('不复制 rollback / explain（最小交接报告）', () => {
    const r = result({
      items: [
        item({
          sql: 'ALTER TABLE `users` ADD COLUMN `age` int;',
          risk: 'medium',
        }),
      ],
    });
    r.items[0].rollback = 'ALTER TABLE `users` DROP COLUMN `age`;';
    r.items[0].explain = '新增列';
    const m = buildManifest(input({ result: r }));
    const json = JSON.stringify(m.items[0]);
    expect(json).not.toContain('rollback');
    expect(json).not.toContain('explain');
    expect(json).not.toContain('DROP COLUMN');
  });

  it('无 dataTables / coverage / visibility 时缺省字段不出现', () => {
    const m = buildManifest(input());
    expect(m.dataTables).toBeUndefined();
    expect(m.coverage).toBeUndefined();
    expect(m.visibility).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serializeManifest：byte 稳定、合法 JSON、版本可解析、无秘密
// ---------------------------------------------------------------------------

describe('serializeManifest', () => {
  function sample(): ReviewManifest {
    return buildManifest(
      input({
        result: result({
          items: [
            item(),
            item({
              id: 'data:users:users:INSERT:0',
              objectType: 'data',
              objectName: 'users',
              changeType: 'CREATE',
              dml: 'INSERT',
              aspects: ['data'],
              risk: 'low',
              sql: "INSERT INTO `users` VALUES (1,'alice',NULL);",
            }),
          ],
          stats: stats({ ALL: 2, CREATE: 1, CHANGE: 1, DML: { INSERT: 1, DELETE: 0, UPDATE: 0 } }),
        }),
      }),
    );
  }

  it('输出合法 JSON、schema 版本可解析、以换行结尾', () => {
    const text = serializeManifest(sample());
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as ReviewManifest;
    expect(parsed.schemaVersion).toBe(REVIEW_MANIFEST_VERSION);
    expect(parsed.source).toBe('real');
  });

  it('同输入 byte 稳定（确定性序列化）', () => {
    // buildManifest 每次生成新的 exportedAt（导出时间），因此 byte 稳定性
    // 针对「同一个 manifest 输入」验证：字段顺序即类型声明顺序，序列化不引入抖动。
    const m = sample();
    expect(serializeManifest(m)).toBe(serializeManifest(m));
  });

  it('data 项行值已脱敏，DDL 原样', () => {
    const text = serializeManifest(sample());
    expect(text).toContain("'***'");
    expect(text).not.toContain("'alice'");
    expect(text).not.toContain('VALUES (1,');
    expect(text).toContain('ALTER TABLE `users` ADD COLUMN `age` int;');
  });

  it('无秘密字段与连接凭据（AC2 秘密检查）', () => {
    const text = serializeManifest(sample());
    expect(text).not.toMatch(/"(?:password|sshPassword|privateKey|passphrase|vaultCiphertext|userPassword)"\s*:/);
    expect(text).not.toContain('SecretBundle');
    expect(text.toLowerCase()).not.toContain('ciphertext');
  });
});

// ---------------------------------------------------------------------------
// manifestToMarkdown：头部 + 摘要表 + DDL 块 + 覆盖说明 + 保密声明
// ---------------------------------------------------------------------------

describe('manifestToMarkdown', () => {
  function sample(): ReviewManifest {
    return buildManifest(
      input({
        result: result({
          items: [
            item(),
            item({
              id: 'data:users:users:DELETE:0',
              objectType: 'data',
              objectName: 'users',
              changeType: 'DROP',
              dml: 'DELETE',
              aspects: ['data'],
              risk: 'medium',
              sql: "DELETE FROM `users` WHERE `id`=1 AND `name`='alice';\n",
            }),
          ],
          stats: stats({ ALL: 2, DROP: 1, CHANGE: 1, DML: { INSERT: 0, DELETE: 1, UPDATE: 0 } }),
          source: 'real',
          coverage: {
            ok: { table: 1, view: 0, procedure: 0, function: 0 },
            skipped: [{ name: 'secret_tbl', objectType: 'table', reason: 'permission-denied' }],
          },
          visibility: {
            excluded: [{ name: 'hidden', objectType: 'view', side: 'b-only', reason: 'grant-invisible' }],
            compared: 1,
            reliable: false,
          },
        }),
      }),
    );
  }

  it('含头部（标题/A/B/时间/schemaVersion/appVersion）', () => {
    const md = manifestToMarkdown(sample());
    expect(md).toContain('# SqlDiff 审查报告');
    expect(md).toContain('A（来源）: A库');
    expect(md).toContain('B（目标）: B库');
    expect(md).toContain(`schemaVersion: ${REVIEW_MANIFEST_VERSION}`);
    expect(md).toContain('appVersion: 0.1.0');
  });

  it('含差异摘要表', () => {
    const md = manifestToMarkdown(sample());
    expect(md).toContain('| 对象 | 类型 | 变更 | 风险 |');
    expect(md).toContain('| users | table | CHANGE | medium |');
    expect(md).toContain('| users | data | DELETE | medium |');
  });

  it('含结构 DDL 代码块且 data 项已脱敏', () => {
    const md = manifestToMarkdown(sample());
    expect(md).toContain('```sql');
    expect(md).toContain('ALTER TABLE `users` ADD COLUMN `age` int;');
    expect(md).toContain("DELETE FROM `users` WHERE `id`=0 AND `name`='***';");
    expect(md).not.toContain("'alice'");
  });

  it('含覆盖/可见性说明（skipped、grant-invisible、reliable:false 提示）', () => {
    const md = manifestToMarkdown(sample());
    expect(md).toContain('权限不足');
    expect(md).toContain('secret_tbl');
    expect(md).toContain('仅 B 侧可见');
    expect(md).toContain('hidden');
    expect(md).toContain('已按最保守范围比较');
    expect(md).toContain('覆盖状态：grant-invisible');
  });

  it('含保密声明', () => {
    const md = manifestToMarkdown(sample());
    expect(md).toContain('本报告不含连接凭据');
    expect(md).toContain('数据行值已脱敏');
  });

  it('数据侧状态与原因在报告中可读（no-pk / fetch-failed）', () => {
    const m = buildManifest(
      input({
        result: result({
          dataTables: [
            dataStatus({ status: 'skipped', reason: 'no-pk', message: '无主键' }),
            dataStatus({ a: 't2', b: 't2', status: 'error', reason: 'fetch-failed' }),
            dataStatus({ a: 't3', b: 't3', status: 'confirm-needed', reason: 'over-threshold' }),
          ],
        }),
      }),
    );
    const md = manifestToMarkdown(m);
    expect(md).toContain('数据对比：3 表。');
    expect(md).toContain('跳过（无行身份）');
    expect(md).toContain('失败（拉取失败）');
    // confirm-needed 不重复 reason，避免「超阈待确认（超阈待确认）」。
    expect(md).toContain('超阈待确认');
    expect(md).not.toContain('超阈待确认（超阈待确认）');
  });
});

// ---------------------------------------------------------------------------
// 集成（AC3）：真实 CompareResult -> manifest -> 解析回等价语义
// ---------------------------------------------------------------------------

describe('manifest 集成（AC3）', () => {
  it('一次真实比较结果可导出并重新解析回等价语义', () => {
    const r = result({
      items: [
        item({
          id: 'table:orders:s0',
          objectType: 'table',
          objectName: 'orders',
          changeType: 'CREATE',
          aspects: ['table'],
          risk: 'low',
          sql: 'CREATE TABLE `orders` (`id` bigint NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB;',
        }),
        item({
          id: 'data:orders:orders:UPDATE:0',
          objectType: 'data',
          objectName: 'orders',
          changeType: 'CHANGE',
          dml: 'UPDATE',
          aspects: ['data'],
          risk: 'low',
          sql: "UPDATE `orders` SET `total`=99.5 WHERE `id`=42;\n",
        }),
      ],
      stats: stats({ ALL: 2, CREATE: 1, CHANGE: 1, DML: { INSERT: 0, DELETE: 0, UPDATE: 1 } }),
      source: 'real',
      coverage: {
        ok: { table: 2, view: 0, procedure: 0, function: 0 },
        skipped: [],
      },
      visibility: { excluded: [], compared: 2, reliable: true },
    });
    const m = buildManifest(
      input({
        result: r,
        request: request({ scopes: ['table', 'data'], includeData: true }),
        aAlias: 'prod',
        bAlias: 'staging',
        appVersion: '0.1.0',
      }),
    );
    const parsed = JSON.parse(serializeManifest(m)) as ReviewManifest;

    expect(parsed.schemaVersion).toBe(REVIEW_MANIFEST_VERSION);
    expect(parsed.aAlias).toBe('prod');
    expect(parsed.bAlias).toBe('staging');
    expect(parsed.source).toBe('real');
    expect(parsed.stats).toEqual(r.stats);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      id: 'table:orders:s0',
      objectType: 'table',
      objectName: 'orders',
      changeType: 'CREATE',
      aspects: ['table'],
      risk: 'low',
    });
    expect(parsed.items[1]).toMatchObject({
      id: 'data:orders:orders:UPDATE:0',
      objectType: 'data',
      objectName: 'orders',
      changeType: 'CHANGE',
      dml: 'UPDATE',
      aspects: ['data'],
      risk: 'low',
    });
    // 数据项行值已脱敏（不出现 99.5 / 42）。
    expect(parsed.items[1].sql).not.toContain('99.5');
    expect(parsed.items[1].sql).not.toContain('`id`=42');
    expect(parsed.items[1].sql).toContain("`total`=0 WHERE `id`=0");
    // 覆盖/可见性报告可重新展示。
    expect(parsed.coverage).toEqual(r.coverage);
    expect(parsed.visibility).toEqual(r.visibility);
    expect(parsed.coverageStatus.kind).toBe('ok');
  });

  it('manifestFileNames 生成含时间戳且 Windows 兼容的文件名', () => {
    const names = manifestFileNames('2026-09-30T10:00:00.000Z');
    expect(names.jsonFileName).toBe('sqldiff-review-2026-09-30T10-00-00-000Z.json');
    expect(names.markdownFileName).toBe('sqldiff-review-2026-09-30T10-00-00-000Z.md');
  });
});