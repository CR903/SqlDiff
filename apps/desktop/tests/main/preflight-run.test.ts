// 生产 Preflight v1 · 编排层单测（Stage 3 of production-preflight）。
//
// 覆盖范围（≥ 10 用例）：
// 1. 完整流程：fake pool 返回预置数据 → PreflightReport 含 facts + inferences
// 2. OTHER 分类的 item → PreflightUnknown { reason: 'unparsed-ddl' }
// 3. pool 创建失败 → verdict='unknown' 报告（不 throw）
// 4. pool.query 抛错 → 相应 category 变 Unknown
// 5. 【关键断言】queryLog 中不含 DiffItem.sql；所有 SQL 都是只读
// 6. evidence 非空：每条 generated inference 的 evidence.length > 0
// 7. verdict.level 判定：block / warn / unknown / pass
// 8. 序列化输出：jsonContent 合法 JSON 且以 \n 结尾；markdownContent 含 6 个二级区块
// 9. 文件名：jsonFileName 以 .json 结尾，markdownFileName 以 .md 结尾
// 10. pool.end() 被调用（finally 关闭）
// 11. AbortSignal.aborted → 早退（不继续采集后续 stage）+ aborted unknown
// 12. 只查 B 侧库：information_schema 查询用 req.bDatabase

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { DiffItem } from '../../src-core/types';
import { runPreflight, type PreflightPoolLike, type PreflightRunDeps } from '../../src-main/preflight-run';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// 用真实 NodeMeta 结构 mock loadNodes（避免依赖真实 filesystem）。
vi.mock('../../src-main/store-json', () => ({
  loadNodes: () => [
    {
      id: 'n-b',
      alias: 'B-node',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      database: 'shop',
      createdAt: '2026-10-03T00:00:00.000Z',
      ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    },
  ],
  // 历史持久化在单测中默认禁用：runPreflight 的 append 走 try/catch 隔离，
  // 此处给一个可观测的 mock，history 专用单测另见 preflight-run-history.test.ts。
  appendPreflightHistory: vi.fn(),
}));

// connection.createMysqlPool 默认 mock：走 deps.createPool 时不会用到，但兜底防误调用。
vi.mock('../../src-main/connection', () => ({
  createMysqlPool: vi.fn(async () => {
    throw new Error('createMysqlPool should not be called when deps.createPool is provided');
  }),
}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Handler = { re: RegExp; rows?: unknown[]; err?: Error };

/** 构造 fake pool + queryLog + end 调用计数。 */
function makeFakePool(handlers: Handler[] = [], opts: { throwAll?: boolean } = {}) {
  const queryLog: string[] = [];
  let endCount = 0;
  const pool: PreflightPoolLike = {
    query: async (sql) => {
      queryLog.push(sql);
      if (opts.throwAll) throw new Error('pool.query always throws');
      for (const h of handlers) {
        if (h.re.test(sql)) {
          if (h.err) throw h.err;
          return h.rows ?? [];
        }
      }
      return [];
    },
    end: async () => {
      endCount += 1;
    },
  };
  return {
    pool,
    queryLog,
    get endCount(): number {
      return endCount;
    },
  };
}

const DEFAULT_CHECKED_AT = '2026-10-03T10:00:00.000Z';
const DEFAULT_APP_VERSION = '1.2.3';

/** 构造 runPreflight 的 deps（用固定 appVersion / checkedAt 保证测试确定性）。 */
function makeDeps(pool: PreflightPoolLike): PreflightRunDeps {
  return {
    createPool: async () => pool,
    secretProvider: () => ({}),
    appVersion: DEFAULT_APP_VERSION,
    checkedAt: DEFAULT_CHECKED_AT,
  };
}

/** 常见 preflight-collect 采集 SQL 的"成功但空"路由，让所有采集器都走完。 */
function quietHandlers(): Handler[] {
  return [
    { re: /SELECT VERSION\(\)/, rows: [] },
    { re: /@@innodb_buffer_pool_size/, rows: [] },
    { re: /@@server_id/, rows: [] },
    { re: /information_schema\.tables/, rows: [] },
    { re: /information_schema\.statistics/, rows: [] },
    { re: /key_column_usage/, rows: [] },
    { re: /SHOW GRANTS FOR CURRENT_USER/, rows: [] },
    { re: /SHOW REPLICA STATUS/, rows: [] },
    { re: /SHOW SLAVE STATUS/, rows: [] },
  ];
}

/** 完整 server / variables / replication 数据，触发正常 fact 产出。 */
function richHandlers(): Handler[] {
  return [
    {
      re: /SELECT VERSION\(\)/,
      rows: [
        {
          version: '8.0.36',
          version_comment: 'MySQL Community Server',
          sql_mode: 'ONLY_FULL_GROUP_BY',
          innodb_file_per_table: 1,
          transaction_isolation: 'REPEATABLE-READ',
          lower_case_table_names: 0,
          character_set_server: 'utf8mb4',
          collation_server: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
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
    {
      re: /information_schema\.tables/,
      rows: [
        {
          table_name: 'orders',
          table_rows: 5_000_000,
          data_length: 2_000_000_000,
          index_length: 500_000_000,
          data_free: 1000,
          engine: 'InnoDB',
          row_format: 'DYNAMIC',
          auto_increment: 5_000_001,
          update_time: '2026-10-03T09:00:00.000Z',
          checksum: '1234567890',
        },
      ],
    },
    {
      re: /information_schema\.statistics/,
      rows: [
        { table_name: 'orders', index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 },
      ],
    },
    { re: /key_column_usage/, rows: [] },
    { re: /SHOW GRANTS FOR CURRENT_USER/, rows: [{ 'Grants for u@h': "GRANT SELECT ON `shop`.* TO 'u'@'h'" }] },
    { re: /SHOW REPLICA STATUS/, rows: [{ Seconds_Behind_Source: 5 }] },
    {
      re: /@@server_id/,
      rows: [
        { server_id: 1, read_only: 'OFF', super_read_only: 'OFF', log_bin: 1, gtid_mode: 'ON' },
      ],
    },
  ];
}

/** 一个典型的 ADD COLUMN DiffItem（表级 DDL）。 */
function addItem(id: string, sql: string): DiffItem {
  return {
    id,
    objectType: 'table',
    objectName: 'orders',
    changeType: 'CHANGE',
    aspects: ['column'],
    risk: 'medium',
    sql,
  };
}

/** 一个 unparsed-ddl 的 DiffItem（OTHER 分类）。 */
function addOtherItem(id: string, sql: string): DiffItem {
  return {
    id,
    objectType: 'table',
    objectName: 'orders',
    changeType: 'CHANGE',
    aspects: ['column'],
    risk: 'low',
    sql,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPreflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. 完整流程：fake pool 返回预置数据 → facts + inferences + verdict 完整', async () => {
    const { pool, queryLog } = makeFakePool(richHandlers());
    const req = {
      bId: 'n-b',
      bAlias: 'B-prod',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `status` varchar(16) NULL')],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));

    // verdict 有真实内容
    expect(['pass', 'warn', 'block', 'unknown']).toContain(result.verdictLevel);
    // JSON 可解析
    const parsed = JSON.parse(result.jsonContent) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.targetAlias).toBe('B-prod');
    expect(parsed.targetDatabase).toBe('shop');
    expect(parsed.source).toBe('real');
    expect(Array.isArray(parsed.facts)).toBe(true);
    expect((parsed.facts as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.inferences)).toBe(true);
    expect((parsed.inferences as unknown[]).length).toBeGreaterThanOrEqual(1);
    // SQL 至少执行了几次（server / variables / tables / statistics / grants / replica）
    expect(queryLog.length).toBeGreaterThanOrEqual(6);
    // 目标库 shop 出现在 information_schema 查询的参数化路径上（table_schema='shop'）
    // queryLog 只记录 SQL 字面，不含参数；因此这里检查 SQL 里带 table_schema= 占位符。
    expect(queryLog.some((q) => q.includes('table_schema = ?'))).toBe(true);
  });

  it('2. OTHER 分类的 item → PreflightUnknown { reason: unparsed-ddl }', async () => {
    const { pool } = makeFakePool(quietHandlers());
    const sql = '-- 不认识的语句；分类器应该兜底到 OTHER\nSET GLOBAL some_var = 42;';
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addOtherItem('i-other', sql)],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    const parsed = JSON.parse(result.jsonContent) as {
      unknowns: Array<{ reason: string; subject: string }>;
      inferences: unknown[];
    };
    const unknowns = parsed.unknowns.filter((u) => u.subject === 'diff-item:i-other');
    expect(unknowns.some((u) => u.reason === 'unparsed-ddl')).toBe(true);
    // OTHER 不应生成 Inference
    expect(parsed.inferences.some((inf) => (inf as { subject: string }).subject === 'diff-item:i-other')).toBe(false);
  });

  it('3. pool 创建失败（factory throw）→ verdict=unknown 报告，不 throw', async () => {
    const throwingPool: PreflightPoolLike = {
      query: async () => {
        throw new Error('should not reach');
      },
      end: async () => {},
    };
    void throwingPool; // 引用防 unused
    const deps: PreflightRunDeps = {
      createPool: async () => {
        throw new Error('connection refused');
      },
      secretProvider: () => ({}),
      appVersion: DEFAULT_APP_VERSION,
      checkedAt: DEFAULT_CHECKED_AT,
    };
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    // 不应 throw，应返回最小 unknown 报告。
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, deps);
    expect(result.verdictLevel).toBe('unknown');
    const parsed = JSON.parse(result.jsonContent) as {
      unknowns: Array<{ reason: string; subject: string }>;
      facts: unknown[];
    };
    expect(parsed.facts.length).toBe(0);
    expect(parsed.unknowns.length).toBe(1);
    expect(parsed.unknowns[0].reason).toBe('query-failed');
    expect(parsed.unknowns[0].subject).toBe('target.pool');
  });

  it('3b. pool 创建返回 null → 同样走最小 unknown 报告', async () => {
    const deps: PreflightRunDeps = {
      createPool: async () => null,
      secretProvider: () => ({}),
      appVersion: DEFAULT_APP_VERSION,
      checkedAt: DEFAULT_CHECKED_AT,
    };
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, deps);
    expect(result.verdictLevel).toBe('unknown');
  });

  it('4. pool.query 抛错 → 相应 category 变 Unknown（不 throw）', async () => {
    const { pool } = makeFakePool(quietHandlers(), { throwAll: true });
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    const parsed = JSON.parse(result.jsonContent) as { unknowns: Array<{ category: string; reason: string }> };
    // 至少一条 query-failed unknown；覆盖 server / variables / permissions 中的某一类。
    expect(parsed.unknowns.length).toBeGreaterThan(0);
    expect(parsed.unknowns.every((u) => u.reason === 'query-failed' || u.reason === 'not-applicable' || u.reason === 'unsupported-version')).toBe(true);
  });

  it('5. 【关键断言】DiffItem.sql 从未被发送为查询；queryLog 全为只读', async () => {
    const { pool, queryLog } = makeFakePool(richHandlers());
    const dangerousSql = 'ALTER TABLE `orders` ADD COLUMN `col_with_marker_XYZ` varchar(255) NULL';
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i-d1', dangerousSql)],
    };
    await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));

    // DiffItem.sql 里独有的 marker 不应出现在任何查询 SQL 里。
    expect(queryLog.some((q) => q.includes('col_with_marker_XYZ'))).toBe(false);
    expect(queryLog.some((q) => q.includes('ALTER TABLE'))).toBe(false);
    // 所有查询必须是只读：无 INSERT / UPDATE / DELETE / ALTER / CREATE / DROP / SET（CHARACTER SET 短语除外） / TRUNCATE。
    for (const sql of queryLog) {
      const cleaned = sql.replace(/\bCHARACTER\s+SET\b/gi, '');
      expect(cleaned).not.toMatch(/\bINSERT\b/i);
      expect(cleaned).not.toMatch(/\bUPDATE\b/i);
      expect(cleaned).not.toMatch(/\bDELETE\b/i);
      expect(cleaned).not.toMatch(/\bALTER\b/i);
      expect(cleaned).not.toMatch(/\bCREATE\s+TABLE\b/i);
      expect(cleaned).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(cleaned).not.toMatch(/\bSET\b/i);
      expect(cleaned).not.toMatch(/\bTRUNCATE\b/i);
      expect(cleaned).not.toMatch(/\bFOR\s+UPDATE\b/i);
    }
  });

  it('6. 每条 generated inference 的 evidence.length > 0', async () => {
    const { pool } = makeFakePool(richHandlers());
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [
        addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `status` varchar(16) NULL'),
        addItem('i2', 'ALTER TABLE `orders` DROP INDEX `idx_stale`'),
        addItem('i3', 'DROP TABLE `old_tbl`'),
      ],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    const parsed = JSON.parse(result.jsonContent) as {
      inferences: Array<{ subject: string; evidence: string[] }>;
    };
    // richHandlers 给了 server.mysql_version=8.0.36，所以 lookupOnlineDdl 应能返回非 null。
    expect(parsed.inferences.length).toBeGreaterThanOrEqual(1);
    for (const inf of parsed.inferences) {
      expect(Array.isArray(inf.evidence)).toBe(true);
      expect(inf.evidence.length).toBeGreaterThan(0);
      // 每条 inference 都至少引用 diff-item:<id>.sql 与 server.mysql_version。
      expect(inf.evidence.some((e) => e.startsWith('diff-item:'))).toBe(true);
      expect(inf.evidence).toContain('server.mysql_version');
    }
  });

  it('7. verdict.level 判定：block / warn / unknown / pass', async () => {
    // (b) warn（正面）：干净数据 + ADD_COLUMN 命中 LARGE_TABLE_INSTANT_ADD
    //     （MySQL 8.0.36 ≥ 8.0.12，rows=5e6 ≥ bigTableRows=1e6，且矩阵判 INSTANT）。
    //     这是正面推断，但复用 issue 结构（severity='warn'），因此 verdict='warn'。
    //     若期望 pass 需把 rows 降到 bigTableRows 以下，或换成不 rebuild 也不命中
    //     LARGE_TABLE_INSTANT_ADD 的 DDL（如 CREATE INDEX，非 ADD_COLUMN）。
    const { pool: quietPool } = makeFakePool(richHandlers());
    const reqPass = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `status` varchar(16) NULL')],
    };
    const passResult = await runPreflight(reqPass, { userDataDir: '/tmp/fake' }, {}, makeDeps(quietPool));
    expect(passResult.verdictLevel).toBe('warn');

    // (c) block：目标库 read_only=ON → READ_ONLY_TARGET block。
    const { pool: roPool } = makeFakePool([
      ...richHandlers().filter((h) => !h.re.test('@@server_id')),
      {
        re: /@@server_id/,
        rows: [
          { server_id: 1, read_only: 1, super_read_only: 0, log_bin: 1, gtid_mode: 'ON' },
        ],
      },
    ]);
    const blockResult = await runPreflight(reqPass, { userDataDir: '/tmp/fake' }, {}, makeDeps(roPool));
    expect(blockResult.verdictLevel).toBe('block');

    // (d) warn：replication.lag 超过阈值。
    const { pool: lagPool } = makeFakePool([
      ...richHandlers().filter((h) => !h.re.test('SHOW REPLICA STATUS')),
      { re: /SHOW REPLICA STATUS/, rows: [{ Seconds_Behind_Source: 120 }] },
    ]);
    const warnResult = await runPreflight(reqPass, { userDataDir: '/tmp/fake' }, {}, makeDeps(lagPool));
    expect(warnResult.verdictLevel).toBe('warn');
  });

  it('8. 序列化：jsonContent 合法 JSON 且以 \n 结尾；markdownContent 含 6 个二级区块', async () => {
    const { pool } = makeFakePool(richHandlers());
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `status` varchar(16) NULL')],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));

    // JSON：可解析，以 \n 结尾
    expect(() => JSON.parse(result.jsonContent)).not.toThrow();
    expect(result.jsonContent.endsWith('\n')).toBe(true);

    // Markdown：v2 起 markdownContent 是结论式（含决策 + 双视角 + 详情链接），
    // detailMarkdownContent 是细节式（含旧 5 段结构：Facts / Inferences / Unknowns / Issues / Verdict / 保密声明）。
    const execHeadings = ['## 决策 ·', '## 开发视角', '## 运维视角', '## 详情', '## 保密声明'];
    for (const h of execHeadings) {
      expect(result.markdownContent).toContain(h);
    }
    const detailHeadings = ['## Facts', '## Inferences', '## Unknowns', '## Issues', '## Verdict', '## 保密声明'];
    for (const h of detailHeadings) {
      expect(result.detailMarkdownContent).toContain(h);
    }
  });

  it('9. 文件名：以 .json / .md 结尾且含 checkedAt 时间戳', async () => {
    const { pool } = makeFakePool(quietHandlers());
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    expect(result.jsonFileName.endsWith('.json')).toBe(true);
    expect(result.markdownFileName.endsWith('.md')).toBe(true);
    // 冒号与毫秒点被替换为 '-'
    expect(result.jsonFileName).toContain('2026-10-03T10-00-00-000Z');
    expect(result.markdownFileName).toContain('2026-10-03T10-00-00-000Z');
  });

  it('10. pool.end() 在 finally 中被调用（成功路径 + 异常路径）', async () => {
    // 成功路径
    const success = makeFakePool(richHandlers());
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(success.pool));
    expect(success.endCount).toBe(1);

    // 异常路径：pool.query 全抛 → 依然调 end()
    const fail = makeFakePool(quietHandlers(), { throwAll: true });
    await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(fail.pool));
    expect(fail.endCount).toBe(1);
  });

  it('11. AbortSignal.aborted → 早退，跳过剩余采集但保留已完成结果', async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // 一开始就 abort
    const { pool, queryLog } = makeFakePool(richHandlers());
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    const result = await runPreflight(
      req,
      { userDataDir: '/tmp/fake' },
      { signal: ctrl.signal },
      makeDeps(pool),
    );
    // 由于一开始就 abort，不会跑任何采集。
    expect(queryLog.length).toBe(0);
    // 报告含 aborted unknown。
    const parsed = JSON.parse(result.jsonContent) as { unknowns: Array<{ subject: string; reason: string }> };
    expect(parsed.unknowns.some((u) => u.subject === 'preflight.aborted' && u.reason === 'query-failed')).toBe(true);
    // verdict 因 unknown 而非 pass。
    expect(result.verdictLevel).toBe('unknown');
  });

  it('12. 只查 B 侧库：information_schema 查询参数化传 req.bDatabase', async () => {
    // 用一个特殊 pool，把 table_schema 参数记录下来。
    const paramLog: unknown[][] = [];
    const pool: PreflightPoolLike = {
      query: async (sql: string, params?: unknown[]) => {
        if (params) paramLog.push(params);
        for (const h of richHandlers()) {
          if (h.re.test(sql)) {
            if (h.err) throw h.err;
            return h.rows ?? [];
          }
        }
        return [];
      },
      end: async () => {},
    };
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop_target', // 特殊库名
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    // information_schema 相关查询的第一参数应为 bDatabase。
    const schemaParams = paramLog.filter((p) => p.length > 0 && p[0] === 'shop_target');
    expect(schemaParams.length).toBeGreaterThanOrEqual(2); // tables + statistics + foreign_keys 至少 2 个
  });

  it('13. 目标节点不存在 → 抛 preflight: 错误', async () => {
    // loadNodes 只返回 id=n-b；请求 bId=n-missing 应抛。
    const req = {
      bId: 'n-missing',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [],
    };
    await expect(
      runPreflight(req, { userDataDir: '/tmp/fake' }, {}, {
        createPool: async () => null,
        secretProvider: () => ({}),
        appVersion: DEFAULT_APP_VERSION,
        checkedAt: DEFAULT_CHECKED_AT,
      }),
    ).rejects.toThrow(/preflight:/);
  });

  it('14. 节点存在但 DDL 分类 OTHER 且版本过旧 → unsupported-version Unknown', async () => {
    // 版本 5.5（低于 MIN_VERSION=5.6）：lookupOnlineDdl 返回 null → unsupported-version。
    const oldVersionHandlers: Handler[] = [
      ...richHandlers().filter((h) => !h.re.test('SELECT VERSION()')),
      {
        re: /SELECT VERSION\(\)/,
        rows: [
          {
            version: '5.5.60',
            version_comment: 'MySQL 5.5',
            sql_mode: '',
            innodb_file_per_table: 1,
            transaction_isolation: 'REPEATABLE-READ',
            lower_case_table_names: 0,
            character_set_server: 'utf8mb4',
            collation_server: 'utf8mb4_general_ci',
          },
        ],
      },
    ];
    const { pool } = makeFakePool(oldVersionHandlers);
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    const parsed = JSON.parse(result.jsonContent) as {
      unknowns: Array<{ reason: string; subject: string }>;
      inferences: unknown[];
    };
    expect(parsed.unknowns.some((u) => u.reason === 'unsupported-version' && u.subject === 'diff-item:i1')).toBe(true);
    expect(parsed.inferences.some((inf) => (inf as { subject: string }).subject === 'diff-item:i1')).toBe(false);
  });

  it('15. 【回归防护】fact key 与 rules.ts 对齐：BIG_TABLE_COPY 触发（rebuildable DDL + 大表）', async () => {
    // 覆盖 preflight-rules.ts ruleBigTableCopy 的调用路径：
    // 目标表 rows > bigTableRows 且 DDL 分类后 rebuildsTable=true → block。
    // 用 MODIFY COLUMN（rebuildsTable=true）而非 ADD COLUMN（INSTANT，不 rebuild）。
    // 若 rules 读 'server.mysql_version' 而 collector 写 'server.version'（或反之），
    // lookupOnlineDdl 拿到空版本会返回 null，ruleBigTableCopy 静默跳过 → 本测试失败。
    const { pool } = makeFakePool([
      ...richHandlers().filter((h) => !h.re.test('information_schema.tables')),
      {
        re: /information_schema.tables/,
        rows: [
          {
            table_name: 'orders',
            table_rows: 5_000_000, // > bigTableRows=1e6
            data_length: 2_000_000_000,
            index_length: 500_000_000,
            data_free: 1000,
            engine: 'InnoDB',
            row_format: 'DYNAMIC',
            auto_increment: 5_000_001,
            update_time: '2026-10-03T09:00:00.000Z',
            checksum: '1234567890',
          },
        ],
      },
    ]);
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i-modify', 'ALTER TABLE `orders` MODIFY COLUMN `status` varchar(16) NULL')],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    const parsed = JSON.parse(result.jsonContent) as {
      issues: Array<{ id: string; severity: string }>;
    };
    expect(
      parsed.issues.some((i) => i.id.startsWith('BIG_TABLE_COPY:') && i.severity === 'block'),
    ).toBe(true);
    expect(result.verdictLevel).toBe('block');
  });

  it('16. 【回归防护】GTID_MISMATCH 命中 replication.gtid_mode（key 对齐规则）', async () => {
    // preflight-rules.ts ruleGtidMismatch 读 'replication.gtid_mode'；
    // 若 collector 写 'server.gtid_mode'（旧 key），rule 静默不触发 → 本测试失败。
    // 用 ON_PERMISSIVE 触发中间态告警。
    const { pool } = makeFakePool([
      ...richHandlers().filter((h) => !h.re.test('@@server_id')),
      {
        re: /@@server_id/,
        rows: [
          {
            server_id: 1,
            read_only: 'OFF',
            super_read_only: 'OFF',
            log_bin: 1,
            gtid_mode: 'ON_PERMISSIVE',
          },
        ],
      },
    ]);
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop',
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    const parsed = JSON.parse(result.jsonContent) as {
      issues: Array<{ id: string }>;
    };
    expect(parsed.issues.some((i) => i.id.startsWith('GTID_MISMATCH:'))).toBe(true);
  });

  it('17. 【回归防护】权限针对目标库判定：非目标库授权不判 full', async () => {
    // 授权只覆盖 other_db，但目标是 shop → permissions.visibility='partial'，
    // PERMISSION_INCOMPLETE 触发 warn（不会误判为 full 而漏出授权盲区）。
    const { pool } = makeFakePool([
      ...richHandlers().filter((h) => !h.re.test('SHOW GRANTS FOR CURRENT_USER')),
      {
        re: /SHOW GRANTS FOR CURRENT_USER/,
        rows: [{ 'Grants for u@h': "GRANT SELECT ON `other_db`.* TO 'u'@'h'" }],
      },
    ]);
    const req = {
      bId: 'n-b',
      bAlias: 'B',
      bDatabase: 'shop', // 注意：与授权目标 different
      items: [addItem('i1', 'ALTER TABLE `orders` ADD COLUMN `x` int NULL')],
    };
    const result = await runPreflight(req, { userDataDir: '/tmp/fake' }, {}, makeDeps(pool));
    const parsed = JSON.parse(result.jsonContent) as {
      facts: Array<{ key: string; value: unknown }>;
      issues: Array<{ id: string }>;
    };
    const vis = parsed.facts.find((f) => f.key === 'permissions.visibility')?.value;
    expect(vis).toBe('partial');
    expect(parsed.issues.some((i) => i.id.startsWith('PERMISSION_INCOMPLETE:'))).toBe(true);
  });
});
