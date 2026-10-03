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

/**
 * 检查连接是否可用，返回 MySQL 版本号（形如 `8.0.46` / `8.0.46-log` / `8.0.26-...`）。
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
