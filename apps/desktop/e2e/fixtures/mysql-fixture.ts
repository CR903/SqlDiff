// Preflight E2E fixture：在真实 MySQL 上建 8 表测试库 + cleanup + 版本预检。
//
// 目的：为 `preflight-on-mysql-8.spec.ts` 提供一个覆盖 preflight 9 条规则触发面的
// 真实数据库环境。8 表清单（与 `.trellis/tasks/10-03-preflight-e2e-mysql-8/design.md §1`
// 精确对齐）：
//
//   1. orders_empty        — 有 PK、空表（baseline）
//   2. users_big           — 有 PK、~100 万行（触发 BIG_TABLE_COPY + LARGE_TABLE_INSTANT_ADD）
//   3. products_no_pk      — 无主键（触发 NO_PRIMARY_KEY）
//   4. tags_unique         — 有 UNIQUE 索引（触发 ADD_UNIQUE_INDEX rebuild）
//   5. events_fk           — 有外键引用 users_big
//   6. config_wide         — 100 列宽表（覆盖列多场景）
//   7. audit_pk_unique     — 同时有 PK + UNIQUE 索引
//   8. slow_log_no_index   — 有数据无索引
//
// 边界：
// - 幂等：先 DROP DATABASE IF EXISTS → CREATE，反复调用不会留残留。
// - cleanup 无论测试成败都必须调用（`afterAll` + try/finally）。
// - 密码通过 FixtureConfig 传入，不写死；环境变量解析在 spec 层做。
// - 只使用 mysql2/promise，无新依赖。

import mysql from 'mysql2/promise';

/** 单个 fixture 目标库的连接信息。 */
export interface FixtureConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** 目标库名，例：`sqldiff_preflight_test_8_0_46`；每次调用会 DROP + CREATE。 */
  database: string;
}

/** 连接级参数：短连接即开即闭，避免长连接占用 fixture 机资源。 */
function connectCfg(cfg: FixtureConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    connectTimeout: 15_000,
    multipleStatements: false,
  };
}

/** 建库 + 建 8 表 + 灌数据（`users_big` 翻倍 20 次到 ~100 万行）。 */
export async function createFixtureDatabase(cfg: FixtureConfig): Promise<void> {
  const escapedDb = cfg.database.replace(/`/g, '``');
  // 阶段 1：无 database 上下文，DROP + CREATE DATABASE。
  // 阶段 2：切换到目标库，建表。用两个连接避免 USE 走 prepared statement（MySQL 不支持）。
  const adminConn = await mysql.createConnection(connectCfg(cfg));
  try {
    // 幂等：先清理旧库（若存在），确保 fixture 状态可预测。
    // MySQL 不支持 DROP DATABASE 使用占位符，必须内联；库名已受控（测试用固定名），
    // 但仍做反引号转义防止 SQL 注入。
    await adminConn.execute(`DROP DATABASE IF EXISTS \`${escapedDb}\``);
    // 目标库统一 utf8mb4 + 与生产一致的隔离级别；charset 会影响 DDL 生成的差异面。
    await adminConn.execute(
      `CREATE DATABASE \`${escapedDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await adminConn.end();
  }

  // 阶段 2：切到目标库后建表。
  const conn = await mysql.createConnection({
    ...connectCfg(cfg),
    database: cfg.database,
  });
  try {
    // --- 表 1：orders_empty（有 PK、空表，baseline）---
    await conn.execute(`
      CREATE TABLE orders_empty (
        id BIGINT NOT NULL AUTO_INCREMENT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);

    // --- 表 2：users_big（有 PK、~100 万行；触发 BIG_TABLE_COPY + LARGE_TABLE_INSTANT_ADD）---
    // 数据通过翻倍 INSERT ... SELECT 20 次达到 2^20 = 1,048,576 行，MySQL 8.0 上耗时约 5-15 秒。
    await conn.execute(`
      CREATE TABLE users_big (
        id BIGINT NOT NULL AUTO_INCREMENT,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
    await conn.execute(
      `INSERT INTO users_big (email, name) VALUES ('seed@example.com', 'seed')`,
    );
    // 每轮 INSERT ... SELECT 会把当前行数翻倍：1 → 2 → 4 → … → 2^20 ≈ 100 万。
    for (let i = 0; i < 20; i++) {
      await conn.execute(
        `INSERT INTO users_big (email, name) SELECT CONCAT(id, '@x.com'), name FROM users_big`,
      );
    }

    // --- 表 3：products_no_pk（无主键；触发 NO_PRIMARY_KEY）---
    await conn.execute(`
      CREATE TABLE products_no_pk (
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0.00
      ) ENGINE=InnoDB
    `);

    // --- 表 4：tags_unique（有 UNIQUE 索引；触发 ADD_UNIQUE_INDEX 重建）---
    await conn.execute(`
      CREATE TABLE tags_unique (
        id BIGINT NOT NULL,
        slug VARCHAR(100) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY idx_slug (slug)
      ) ENGINE=InnoDB
    `);

    // --- 表 5：events_fk（有外键引用 users_big）---
    await conn.execute(`
      CREATE TABLE events_fk (
        id BIGINT NOT NULL AUTO_INCREMENT,
        user_id BIGINT NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_user_id (user_id),
        CONSTRAINT fk_events_user FOREIGN KEY (user_id) REFERENCES users_big (id)
      ) ENGINE=InnoDB
    `);

    // --- 表 6：config_wide（宽表；覆盖列多场景）---
    // 列名 c01…c100 用代码循环拼 SQL，避免在字符串里手写 100 行。
    // VARCHAR(15) × 4 (utf8mb4) + 2 字节 offset = 62 字节/列 × 100 = 6200 字节，
    // 稳在 InnoDB COMPACT 8126 字节行限内；同时声明 ROW_FORMAT=DYNAMIC 兜底。
    const wideCols = Array.from({ length: 100 }, (_, i) => {
      const name = `c${String(i + 1).padStart(2, '0')}`;
      return `${name} VARCHAR(15)`;
    });
    await conn.execute(`
      CREATE TABLE config_wide (
        id BIGINT NOT NULL,
        ${wideCols.join(',\n        ')},
        PRIMARY KEY (id)
      ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
    `);

    // --- 表 7：audit_pk_unique（PK + UNIQUE 组合；触发 NO_UNIQUE_INDEX_AFTER_CHANGE 相关面）---
    await conn.execute(`
      CREATE TABLE audit_pk_unique (
        id BIGINT NOT NULL AUTO_INCREMENT,
        audit_key VARCHAR(100) NOT NULL,
        payload JSON,
        PRIMARY KEY (id),
        UNIQUE KEY idx_audit_key (audit_key)
      ) ENGINE=InnoDB
    `);

    // --- 表 8：slow_log_no_index（有数据无索引；对比面）---
    await conn.execute(`
      CREATE TABLE slow_log_no_index (
        ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        msg TEXT
      ) ENGINE=InnoDB
    `);
    await conn.execute(`INSERT INTO slow_log_no_index (msg) VALUES ('bootstrap')`);
  } finally {
    await conn.end();
  }
}

/** DROP DATABASE 完整清理。测试失败也必须调用，避免污染 dev 机器。 */
export async function dropFixtureDatabase(cfg: FixtureConfig): Promise<void> {
  try {
    const conn = await mysql.createConnection(connectCfg(cfg));
    try {
      // 忽略不存在的库（可能已被上一次清理掉，或建库中途失败）。
      const escapedDb = cfg.database.replace(/`/g, '``');
      await conn.execute(`DROP DATABASE IF EXISTS \`${escapedDb}\``);
    } finally {
      await conn.end();
    }
  } catch {
    // 连接失败也不 throw：清理是尽力而为，主 spec 的测试失败不应被 cleanup 掩盖。
    // 但真实残留会在下次 `checkConnection` / 建库时报出来，可观测。
  }
}

// ---------------------------------------------------------------------------
// 双库对比 fixture（UI 导出链路用）
// ---------------------------------------------------------------------------

/**
 * 一次「真实比较」需要的两个库：A（source / 期望）与 B（target）。
 *
 * 为什么不复用上面的单库 `FixtureConfig`：单库 fixture 服务的 API 直调 spec
 * （`preflight-on-mysql-*.spec.ts`）只需要一个目标库跑 preflight；而本任务的
 * `canRunPreflight` 门控要求**真实比较 + ≥1 条表级 DDL 项**，比较天然需要 A / B 两端，
 * 且两端必须指向**不同的 database**（同一个库跟自己比永远零差异，门控永不满足）。
 *
 * 两库共用一台机器的连接信息（同一个 host / port / user / password），
 * 只有 database 不同 —— 这也正是 SqlDiff 的典型用法（同实例跨库比对）。
 */
export interface CompareFixtureConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** A 侧（source / 期望）库名。 */
  sourceDatabase: string;
  /** B 侧（target）库名。 */
  targetDatabase: string;
}

/** 双库 fixture 的表名。A / B 同名不同结构，diff 只会产出列级差异。 */
export const COMPARE_FIXTURE_TABLE = 't_orders';

/** A 侧独有、B 侧缺失的列 —— 它就是那条 ADD COLUMN 的来源。 */
export const COMPARE_FIXTURE_EXTRA_COLUMN = 'note';

function escapeIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * 建 A / B 两个库，构造**确定的表级列差异**。
 *
 * A 侧比 B 侧多一列 `note` → 方向是「A source/期望 → B target」，
 * 生成的 DDL 是把 B 升级到 A 的 `ALTER TABLE t_orders ADD COLUMN note ...`
 * （见 `src-core/diff.ts` 的「Direction is A source/expected to B target」契约）。
 * 这条 DDL 是表级（objectType='table'）且能被 `classifyDdl` 识别为 ADD_COLUMN，
 * 因此同时满足 `canRunPreflight` 的「≥1 条表级 DDL 项」门控与 preflight 的 17 种 DdlOp 分类。
 *
 * 两侧都灌**完全相同的行**：数据对比不在本 spec 的范围内（scope 默认只开结构），
 * 但保持行一致能确保「若将来有人打开数据 scope」时 diff 不会先被 INSERT 噪音污染。
 *
 * 幂等：先 DROP DATABASE IF EXISTS 再 CREATE，重复调用不留残留。
 */
export async function createCompareFixtureDatabases(cfg: CompareFixtureConfig): Promise<void> {
  const adminConn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    connectTimeout: 15_000,
    multipleStatements: false,
  });
  try {
    for (const db of [cfg.sourceDatabase, cfg.targetDatabase]) {
      const escaped = escapeIdent(db);
      await adminConn.execute(`DROP DATABASE IF EXISTS ${escaped}`);
      await adminConn.execute(
        `CREATE DATABASE ${escaped} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    }
  } finally {
    await adminConn.end();
  }

  // A 侧：有 note 列。
  const srcConn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.sourceDatabase,
    connectTimeout: 15_000,
  });
  try {
    await srcConn.execute(`
      CREATE TABLE ${escapeIdent(COMPARE_FIXTURE_TABLE)} (
        id INT NOT NULL AUTO_INCREMENT,
        code VARCHAR(32) NOT NULL,
        ${escapeIdent(COMPARE_FIXTURE_EXTRA_COLUMN)} VARCHAR(64) NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await srcConn.execute(
      `INSERT INTO ${escapeIdent(COMPARE_FIXTURE_TABLE)} (code, ${escapeIdent(COMPARE_FIXTURE_EXTRA_COLUMN)}) VALUES (?, ?), (?, ?), (?, ?)`,
      ['A-001', '来自 A 侧的备注', 'A-002', null, 'A-003', '第三条'],
    );
  } finally {
    await srcConn.end();
  }

  // B 侧：缺 note 列（结构差异的唯一来源）。
  const tgtConn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.targetDatabase,
    connectTimeout: 15_000,
  });
  try {
    await tgtConn.execute(`
      CREATE TABLE ${escapeIdent(COMPARE_FIXTURE_TABLE)} (
        id INT NOT NULL AUTO_INCREMENT,
        code VARCHAR(32) NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await tgtConn.execute(
      `INSERT INTO ${escapeIdent(COMPARE_FIXTURE_TABLE)} (code) VALUES (?), (?), (?)`,
      ['A-001', 'A-002', 'A-003'],
    );
  } finally {
    await tgtConn.end();
  }
}

/**
 * DROP 掉两个库（AC6 的执行点）。
 *
 * 与 `dropFixtureDatabase` 同策略：**尽力而为、不 throw** —— 清理失败不应把
 * 真正的断言失败顶掉。但残留是可观测的：调用方应在 spec 结束后独立执行
 * `SHOW DATABASES LIKE 'sqldiff%'` 复核（本任务的 AC6 就是这么要求的）。
 */
export async function dropCompareFixtureDatabases(cfg: CompareFixtureConfig): Promise<void> {
  try {
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      connectTimeout: 15_000,
    });
    try {
      for (const db of [cfg.sourceDatabase, cfg.targetDatabase]) {
        await conn.execute(`DROP DATABASE IF EXISTS ${escapeIdent(db)}`);
      }
    } finally {
      await conn.end();
    }
  } catch {
    // 连接失败也不 throw：见函数注释。
  }
}

/**
 * 列出当前机器上所有 `sqldiff%` 开头的库（AC6 的复核工具）。
 *
 * 故意返回原始列表而不是布尔值：cleanup 报告要能贴出「实际还剩哪些库」，
 * 一个 true/false 说不清是哪个残留。
 */
export async function listSqldiffDatabases(
  cfg: Pick<FixtureConfig, 'host' | 'port' | 'user' | 'password'>,
): Promise<string[]> {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    connectTimeout: 15_000,
  });
  try {
    const [rows] = await conn.execute("SHOW DATABASES LIKE 'sqldiff%'");
    return (rows as Array<Record<string, unknown>>).map((r) => String(r.Database));
  } finally {
    await conn.end();
  }
}

/**
 * 检查连接是否可用，返回 MySQL 版本号（形如 `8.0.46` / `5.7.44-log`）。
 * 用于 spec 的 beforeAll 预检：连接不通时 skip 整个 describe，避免 flaky。
 */
export async function checkConnection(cfg: FixtureConfig): Promise<string> {
  const conn = await mysql.createConnection(connectCfg(cfg));
  try {
    const [rows] = await conn.execute('SELECT VERSION() AS v');
    const row = (rows as Array<Record<string, unknown>>)[0];
    const v = row?.v;
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`checkConnection: 拿到空版本号，row=${JSON.stringify(row)}`);
    }
    return v;
  } finally {
    await conn.end();
  }
}
