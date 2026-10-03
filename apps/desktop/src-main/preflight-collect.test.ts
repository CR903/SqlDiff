// 生产 Preflight v1 只读采集器单测（Stage 2 of production-preflight）。
//
// 覆盖范围（≥15 用例）：
// - 每个采集函数：成功 + 权限错误 → Unknown + 一般错误 → Unknown（各 3 条）
// - collectTableFacts：105 表 → 2 批查询
// - collectIndexFacts：多索引聚合 → primary_indexes / unique_indexes / foreign_keys
// - collectReplicationFacts：REPLICA 成功 / SLAVE 成功 / 两者失败→not-applicable
// - 跨所有：断言 SQL 无 INSERT / UPDATE / DELETE / SET / FOR UPDATE（字符集短语除外）

import { describe, expect, it } from 'vitest';
import {
  collectGrantFacts,
  collectIndexFacts,
  collectReplicationFacts,
  collectServerFacts,
  collectTableFacts,
  collectVariablesFacts,
} from './preflight-collect';
import type { DbQueryable } from './metadata';

/** 按正则路由返回行的假 DB（返回原始数组而非 mysql2 元组，rowsOf 兼容）。 */
function fakeDb(handlers: Array<{ re: RegExp; rows?: unknown[]; err?: Error }>): DbQueryable & {
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql);
      for (const h of handlers) {
        if (h.re.test(sql)) {
          if (h.err) throw h.err;
          return h.rows ?? [];
        }
      }
      return [];
    },
  };
}

/** 权限类错误：errno + mysql2 code 双路，命中 PERMISSION_ERRNOS / CODES。 */
function permissionErr(): Error {
  return Object.assign(new Error('SELECT command denied'), {
    errno: 1142,
    code: 'ER_TABLEACCESS_DENIED_ERROR',
  });
}

/** 一般错误：无 errno / code，走 classifyCoverageReason → unknown → query-failed。 */
function genericErr(msg = 'socket hang up'): Error {
  return new Error(msg);
}

function factsByKey(facts: Array<{ key: string; value: unknown }>): Map<string, unknown> {
  return new Map(facts.map((f) => [f.key, f.value]));
}

// ---------------------------------------------------------------------------
// collectServerFacts
// ---------------------------------------------------------------------------

describe('collectServerFacts', () => {
  it('成功：8 条事实覆盖版本号 / SQL_MODE / 字符集 / lower_case_table_names', async () => {
    const db = fakeDb([
      {
        re: /SELECT VERSION\(\)/,
        rows: [
          {
            version: '8.0.36',
            version_comment: 'MySQL Community Server - GPL',
            sql_mode: 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES',
            innodb_file_per_table: 1,
            transaction_isolation: 'REPEATABLE-READ',
            lower_case_table_names: 0,
            character_set_server: 'utf8mb4',
            collation_server: 'utf8mb4_0900_ai_ci',
          },
        ],
      },
    ]);
    const r = await collectServerFacts(db);
    expect(r.unknowns.length).toBe(0);
    expect(r.facts.length).toBe(8);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('server.version')).toBe('8.0.36');
    expect(byKey.get('server.sql_mode')).toBe('ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES');
    expect(byKey.get('server.lower_case_table_names')).toBe(0);
    expect(byKey.get('server.character_set_server')).toBe('utf8mb4');
    // 所有 server facts 来源标记为 select-version。
    for (const f of r.facts) expect(f.source).toBe('select-version');
    for (const f of r.facts) expect(f.category).toBe('server');
  });

  it('权限错误 → Unknown { reason: permission-denied }', async () => {
    const db = fakeDb([{ re: /SELECT VERSION\(\)/, rows: [], err: permissionErr() }]);
    const r = await collectServerFacts(db);
    expect(r.facts.length).toBe(0);
    expect(r.unknowns.length).toBe(1);
    expect(r.unknowns[0].reason).toBe('permission-denied');
    expect(r.unknowns[0].category).toBe('server');
    expect(r.unknowns[0].attempt).toContain('SELECT VERSION()');
  });

  it('一般错误 → Unknown { reason: query-failed }', async () => {
    const db = fakeDb([{ re: /SELECT VERSION\(\)/, rows: [], err: genericErr() }]);
    const r = await collectServerFacts(db);
    expect(r.unknowns.length).toBe(1);
    expect(r.unknowns[0].reason).toBe('query-failed');
  });
});

// ---------------------------------------------------------------------------
// collectVariablesFacts
// ---------------------------------------------------------------------------

describe('collectVariablesFacts', () => {
  it('成功：7 条事实覆盖 buffer pool / 连接 / 缓冲 / 报文大小', async () => {
    const db = fakeDb([
      {
        re: /@@innodb_buffer_pool_size/,
        rows: [
          {
            innodb_buffer_pool_size: 134217728,
            max_connections: 151,
            tmp_table_size: 16777216,
            sort_buffer_size: 262144,
            thread_cache_size: 9,
            innodb_page_size: 16384,
            max_allowed_packet: 67108864,
          },
        ],
      },
    ]);
    const r = await collectVariablesFacts(db);
    expect(r.unknowns.length).toBe(0);
    expect(r.facts.length).toBe(7);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('variables.innodb_buffer_pool_size')).toBe(134217728);
    expect(byKey.get('variables.max_connections')).toBe(151);
    expect(byKey.get('variables.max_allowed_packet')).toBe(67108864);
    for (const f of r.facts) expect(f.source).toBe('select-sysvars');
  });

  it('权限错误 → Unknown { reason: permission-denied }', async () => {
    const db = fakeDb([{ re: /@@innodb_buffer_pool_size/, rows: [], err: permissionErr() }]);
    const r = await collectVariablesFacts(db);
    expect(r.facts.length).toBe(0);
    expect(r.unknowns[0].reason).toBe('permission-denied');
    expect(r.unknowns[0].category).toBe('variables');
  });

  it('一般错误 → Unknown { reason: query-failed }', async () => {
    const db = fakeDb([{ re: /@@innodb_buffer_pool_size/, rows: [], err: genericErr() }]);
    const r = await collectVariablesFacts(db);
    expect(r.unknowns[0].reason).toBe('query-failed');
  });
});

// ---------------------------------------------------------------------------
// collectTableFacts
// ---------------------------------------------------------------------------

describe('collectTableFacts', () => {
  it('成功：单表 9 条事实覆盖 rows / 空间 / 引擎 / row_format / auto_increment / update_time / checksum', async () => {
    const db = fakeDb([
      {
        re: /information_schema\.tables/,
        rows: [
          {
            table_name: 'orders',
            table_rows: 12345,
            data_length: 5242880,
            index_length: 262144,
            data_free: 1024,
            engine: 'InnoDB',
            row_format: 'DYNAMIC',
            auto_increment: 12346,
            update_time: '2026-10-03T08:00:00.000Z',
            checksum: '1234567890',
          },
        ],
      },
    ]);
    const r = await collectTableFacts(db, 'shop', ['orders']);
    expect(r.unknowns.length).toBe(0);
    expect(r.facts.length).toBe(9);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('table.orders.rows')).toBe(12345);
    expect(byKey.get('table.orders.data_length')).toBe(5242880);
    expect(byKey.get('table.orders.index_length')).toBe(262144);
    expect(byKey.get('table.orders.data_free')).toBe(1024);
    expect(byKey.get('table.orders.engine')).toBe('InnoDB');
    expect(byKey.get('table.orders.row_format')).toBe('DYNAMIC');
    expect(byKey.get('table.orders.auto_increment')).toBe(12346);
    expect(byKey.get('table.orders.update_time')).toBe('2026-10-03T08:00:00.000Z');
    expect(byKey.get('table.orders.checksum')).toBe(1234567890);
    for (const f of r.facts) expect(f.source).toBe('information-schema.tables');
  });

  it('权限错误 → Unknown { reason: permission-denied }', async () => {
    const db = fakeDb([{ re: /information_schema\.tables/, rows: [], err: permissionErr() }]);
    const r = await collectTableFacts(db, 'shop', ['orders']);
    expect(r.facts.length).toBe(0);
    expect(r.unknowns.length).toBe(1);
    expect(r.unknowns[0].reason).toBe('permission-denied');
    expect(r.unknowns[0].category).toBe('table');
  });

  it('一般错误 → Unknown { reason: query-failed }', async () => {
    const db = fakeDb([{ re: /information_schema\.tables/, rows: [], err: genericErr() }]);
    const r = await collectTableFacts(db, 'shop', ['orders']);
    expect(r.unknowns[0].reason).toBe('query-failed');
  });

  it('105 表分批：分成 2 批查询（100 + 5），占位符数量正确', async () => {
    const db = fakeDb([{ re: /information_schema\.tables/, rows: [] }]);
    const tables = Array.from({ length: 105 }, (_, i) => `t${i}`);
    const r = await collectTableFacts(db, 'shop', tables);
    expect(r.facts.length).toBe(0);
    expect(r.unknowns.length).toBe(0);
    expect(db.queries.length).toBe(2);
    const placeholders = (s: string) => (s.match(/\?/g) ?? []).length;
    // 每批含 1 个 ?（table_schema）+ N 个 ?（table_name）。
    expect(placeholders(db.queries[0])).toBe(101);
    expect(placeholders(db.queries[1])).toBe(6);
  });

  it('空表列表 → 不查询、不产 Unknown（快速短路）', async () => {
    const db = fakeDb([{ re: /.*/, rows: [] }]);
    const r = await collectTableFacts(db, 'shop', []);
    expect(db.queries.length).toBe(0);
    expect(r.facts.length).toBe(0);
    expect(r.unknowns.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectIndexFacts
// ---------------------------------------------------------------------------

describe('collectIndexFacts', () => {
  it('多索引聚合：PRIMARY + UNIQUE + 普通索引 → primary_indexes / unique_indexes 正确分组', async () => {
    const db = fakeDb([
      {
        re: /information_schema\.statistics/,
        rows: [
          { table_name: 't1', index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 },
          { table_name: 't1', index_name: 'PRIMARY', column_name: 'ts', seq_in_index: 2, non_unique: 0 },
          { table_name: 't1', index_name: 'idx_unique', column_name: 'email', seq_in_index: 1, non_unique: 0 },
          { table_name: 't1', index_name: 'idx_reg', column_name: 'status', seq_in_index: 1, non_unique: 1 },
        ],
      },
      { re: /key_column_usage/, rows: [] },
    ]);
    const r = await collectIndexFacts(db, 'shop', ['t1']);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('table.t1.primary_indexes')).toEqual(['PRIMARY']);
    // PRIMARY 是隐式唯一，与显式 idx_unique 都归 unique_indexes。
    expect(byKey.get('table.t1.unique_indexes')).toEqual(['PRIMARY', 'idx_unique']);
    expect(byKey.get('table.t1.indexes.PRIMARY.columns')).toEqual(['id', 'ts']);
    expect(byKey.get('table.t1.indexes.PRIMARY.non_unique')).toBe(0);
    expect(byKey.get('table.t1.indexes.PRIMARY.is_primary')).toBe(true);
    expect(byKey.get('table.t1.indexes.idx_unique.is_primary')).toBe(false);
    expect(byKey.get('table.t1.indexes.idx_reg.non_unique')).toBe(1);
    expect(byKey.get('table.t1.indexes.idx_reg.is_primary')).toBe(false);
    for (const f of r.facts) expect(f.source).toBe('information-schema.statistics');
  });

  it('外键聚合：t1 的两个 FK 约束各自生成 foreign_keys fact', async () => {
    const db = fakeDb([
      { re: /information_schema\.statistics/, rows: [] },
      {
        re: /key_column_usage/,
        rows: [
          { table_name: 't1', constraint_name: 'fk_t1_a', column_name: 'a_id' },
          { table_name: 't1', constraint_name: 'fk_t1_b', column_name: 'b_id' },
          // 库中其他表的外键，应被 filter 掉。
          { table_name: 'other_table', constraint_name: 'fk_other', column_name: 'x' },
        ],
      },
    ]);
    const r = await collectIndexFacts(db, 'shop', ['t1']);
    const keys = r.facts.map((f) => f.key);
    expect(keys).toContain('table.t1.foreign_keys.fk_t1_a');
    expect(keys).toContain('table.t1.foreign_keys.fk_t1_b');
    expect(keys).not.toContain('table.other_table.foreign_keys.fk_other');
    for (const f of r.facts) {
      if (f.key.startsWith('table.t1.foreign_keys.')) {
        expect(f.source).toBe('information-schema.key-column-usage');
      }
    }
  });

  it('权限错误（statistics 查询）→ Unknown { reason: permission-denied }', async () => {
    const db = fakeDb([
      { re: /information_schema\.statistics/, rows: [], err: permissionErr() },
      { re: /key_column_usage/, rows: [] },
    ]);
    const r = await collectIndexFacts(db, 'shop', ['t1']);
    expect(r.unknowns.some((u) => u.reason === 'permission-denied' && u.category === 'index')).toBe(true);
  });

  it('一般错误（foreign_keys 查询）→ Unknown { reason: query-failed }', async () => {
    const db = fakeDb([
      { re: /information_schema\.statistics/, rows: [] },
      { re: /key_column_usage/, rows: [], err: genericErr() },
    ]);
    const r = await collectIndexFacts(db, 'shop', ['t1']);
    expect(r.unknowns.some((u) => u.reason === 'query-failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectReplicationFacts
// ---------------------------------------------------------------------------

describe('collectReplicationFacts', () => {
  const SYSVARS_ROWS = [
    { server_id: 1, read_only: 'OFF', super_read_only: 'OFF', log_bin: 1, gtid_mode: 'ON' },
  ];

  it('SHOW REPLICA STATUS 成功：replication facts 来源 show-replica-status', async () => {
    const db = fakeDb([
      { re: /SHOW REPLICA STATUS/, rows: [{ Seconds_Behind_Source: 5 }] },
      { re: /@@server_id/, rows: SYSVARS_ROWS },
    ]);
    const r = await collectReplicationFacts(db);
    expect(r.unknowns.length).toBe(0);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('replication.seconds_behind_master')).toBe(5);
    expect(byKey.get('replication.is_replica')).toBe(true);
    expect(byKey.get('server.read_only')).toBe('OFF');
    expect(byKey.get('server.gtid_mode')).toBe('ON');
    for (const f of r.facts.filter((f) => f.key.startsWith('replication.'))) {
      expect(f.source).toBe('show-replica-status');
    }
    // 不应降级到 SHOW SLAVE STATUS。
    expect(db.queries.some((q) => q.includes('SLAVE STATUS'))).toBe(false);
  });

  it('REPLICA 失败降级 SLAVE：来源 show-slave-status，使用 Seconds_Behind_Master', async () => {
    const db = fakeDb([
      { re: /SHOW REPLICA STATUS/, rows: [], err: genericErr('command not found') },
      { re: /SHOW SLAVE STATUS/, rows: [{ Seconds_Behind_Master: 3 }] },
      { re: /@@server_id/, rows: SYSVARS_ROWS },
    ]);
    const r = await collectReplicationFacts(db);
    expect(r.unknowns.length).toBe(0);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('replication.seconds_behind_master')).toBe(3);
    for (const f of r.facts.filter((f) => f.key.startsWith('replication.'))) {
      expect(f.source).toBe('show-slave-status');
    }
  });

  it('两条 SHOW 都失败 → 唯一 Unknown { reason: not-applicable, subject: replication.status }', async () => {
    const db = fakeDb([
      { re: /SHOW REPLICA STATUS/, rows: [], err: genericErr('command not found') },
      { re: /SHOW SLAVE STATUS/, rows: [], err: genericErr('command not found') },
      { re: /@@server_id/, rows: SYSVARS_ROWS },
    ]);
    const r = await collectReplicationFacts(db);
    // 5 条 sysvars facts 仍在。
    expect(r.facts.length).toBe(5);
    // 唯一 Unknown：replication.status not-applicable。
    expect(r.unknowns.length).toBe(1);
    expect(r.unknowns[0].category).toBe('replication');
    expect(r.unknowns[0].subject).toBe('replication.status');
    expect(r.unknowns[0].reason).toBe('not-applicable');
    expect(r.unknowns[0].attempt).toContain('SHOW REPLICA STATUS');
    expect(r.unknowns[0].attempt).toContain('SHOW SLAVE STATUS');
  });
});

// ---------------------------------------------------------------------------
// collectGrantFacts
// ---------------------------------------------------------------------------

describe('collectGrantFacts', () => {
  it('库级 SELECT 授权 → visibility=full / reliable=true', async () => {
    const db = fakeDb([
      {
        re: /SHOW GRANTS FOR CURRENT_USER/,
        rows: [{ 'Grants for u@h': "GRANT SELECT ON `shop`.* TO 'u'@'h'" }],
      },
    ]);
    const r = await collectGrantFacts(db);
    expect(r.unknowns.length).toBe(0);
    expect(r.facts.length).toBe(2);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('permissions.visibility')).toBe('full');
    expect(byKey.get('permissions.reliable')).toBe(true);
    for (const f of r.facts) {
      expect(f.source).toBe('show-grants-for-current-user');
      expect(f.category).toBe('permissions');
    }
  });

  it('表级 USAGE + SELECT 混合 → visibility=partial / reliable=true', async () => {
    const db = fakeDb([
      {
        re: /SHOW GRANTS FOR CURRENT_USER/,
        rows: [
          { 'Grants for u@h': "GRANT USAGE ON *.* TO 'u'@'h'" },
          { 'Grants for u@h': "GRANT SELECT ON `shop`.`t1` TO 'u'@'h'" },
        ],
      },
    ]);
    const r = await collectGrantFacts(db);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('permissions.visibility')).toBe('partial');
    expect(byKey.get('permissions.reliable')).toBe(true);
  });

  it('权限错误 → Unknown { reason: permission-denied } + visibility=none / reliable=false', async () => {
    const db = fakeDb([{ re: /SHOW GRANTS FOR CURRENT_USER/, rows: [], err: permissionErr() }]);
    const r = await collectGrantFacts(db);
    expect(r.facts.length).toBe(2);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('permissions.visibility')).toBe('none');
    expect(byKey.get('permissions.reliable')).toBe(false);
    expect(r.unknowns.length).toBe(1);
    expect(r.unknowns[0].reason).toBe('permission-denied');
    expect(r.unknowns[0].subject).toBe('permissions.reliable');
  });

  it('一般错误 → Unknown { reason: query-failed } + visibility=none / reliable=false', async () => {
    const db = fakeDb([{ re: /SHOW GRANTS FOR CURRENT_USER/, rows: [], err: genericErr() }]);
    const r = await collectGrantFacts(db);
    expect(r.unknowns[0].reason).toBe('query-failed');
    expect(factsByKey(r.facts).get('permissions.reliable')).toBe(false);
  });

  it('8.0 角色授权（GRANT `role` TO，无 ON）→ 降级 reliable=false（不猜为 full）', async () => {
    const db = fakeDb([
      {
        re: /SHOW GRANTS FOR CURRENT_USER/,
        rows: [{ 'Grants for u@h': "GRANT `r_admin` TO 'u'@'h'" }],
      },
    ]);
    const r = await collectGrantFacts(db);
    const byKey = factsByKey(r.facts);
    expect(byKey.get('permissions.reliable')).toBe(false);
    expect(byKey.get('permissions.visibility')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 跨所有采集器：只读 SQL 硬边界
// ---------------------------------------------------------------------------

describe('跨所有采集器：只读硬边界', () => {
  it('所有 SQL 无 INSERT / UPDATE / DELETE / SET（CHARACTER SET 除外） / FOR UPDATE', async () => {
    const db = fakeDb([
      { re: /SELECT VERSION\(\)/, rows: [] },
      { re: /@@innodb_buffer_pool_size/, rows: [] },
      { re: /@@server_id/, rows: [] },
      // 其余匹配不到的返回 []，不 throw，便于一次跑完全部采集器。
      { re: /information_schema\.tables/, rows: [] },
      { re: /information_schema\.statistics/, rows: [] },
      { re: /key_column_usage/, rows: [] },
      { re: /SHOW GRANTS FOR CURRENT_USER/, rows: [] },
      // SHOW REPLICA STATUS / SHOW SLAVE STATUS 让两条都"成功但空"，避免走 err 分支。
      { re: /SHOW REPLICA STATUS/, rows: [] },
      { re: /SHOW SLAVE STATUS/, rows: [] },
    ]);
    // 并发跑，捕获全部 SQL。
    await Promise.all([
      collectServerFacts(db),
      collectVariablesFacts(db),
      collectTableFacts(db, 'shop', ['t1']),
      collectIndexFacts(db, 'shop', ['t1']),
      collectReplicationFacts(db),
      collectGrantFacts(db),
    ]);
    expect(db.queries.length).toBeGreaterThan(0);
    // 允许 SET 出现在 "CHARACTER SET" 语境（当前 SQL 里其实没有；预留兼容未来字符集 DDL 判定）。
    for (const sql of db.queries) {
      const cleaned = sql.replace(/\bCHARACTER\s+SET\b/gi, '');
      expect(cleaned).not.toMatch(/\bINSERT\b/i);
      expect(cleaned).not.toMatch(/\bUPDATE\b/i);
      expect(cleaned).not.toMatch(/\bDELETE\b/i);
      expect(cleaned).not.toMatch(/\bSET\b/i);
      expect(cleaned).not.toMatch(/\bFOR\s+UPDATE\b/i);
      // 允许字面字符集短语残留（例如未来 SELECT 里出现 CHARACTER SET，此处不做限制）。
      // 只断言写操作关键字不存在。
    }
  });

  it('所有采集器均无 throw：任意 SQL 抛错最终都返回 { facts, unknowns }', async () => {
    // 极端场景：所有 SQL 都抛错。
    const db: DbQueryable = {
      query: async () => {
        throw new Error('total outage');
      },
    };
    const [server, vars, tables, indexes, repl, grants] = await Promise.all([
      collectServerFacts(db),
      collectVariablesFacts(db),
      collectTableFacts(db, 'shop', ['t1']),
      collectIndexFacts(db, 'shop', ['t1']),
      collectReplicationFacts(db),
      collectGrantFacts(db),
    ]);
    // 每个采集器都返回对象（不 throw），且含 unknown。
    for (const r of [server, vars, tables, indexes, repl, grants]) {
      expect(Array.isArray(r.facts)).toBe(true);
      expect(Array.isArray(r.unknowns)).toBe(true);
    }
    // 除 replication（走 not-applicable 分支）外，其它应各产至少 1 条 query-failed / not-applicable unknown。
    expect(server.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(vars.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(tables.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(indexes.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(repl.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(grants.unknowns.length).toBeGreaterThanOrEqual(1);
  });
});
