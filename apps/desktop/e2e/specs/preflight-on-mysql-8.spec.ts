import { test, expect } from '@playwright/test';
import { launchElectron, closeElectron, type ElectronHandle } from '../helpers/electron';
import {
  createFixtureDatabase,
  dropFixtureDatabase,
  checkConnection,
  type FixtureConfig,
} from '../fixtures/mysql-fixture';
import {
  buildFixtureItems,
  assertReportStructure,
  assertInstantAddDrop,
  assertOtherGoesToUnknown,
  findFactByKey,
  assertIssue,
  assertFactValue,
  assertFactNumberAtLeast,
} from '../helpers/preflight-fixture';
import type { PreflightReport } from '../../src-core/preflight-types';
import type { NodeMeta } from '../../src-core/types';

/**
 * Preflight E2E on real MySQL 8.x.
 *
 * 跑通两台开发机的版本分叉：
 *   - 192.168.5.9  → MySQL 8.0.46 → DROP_COLUMN INSTANT + rebuild=false
 *   - 192.168.5.15 → MySQL 8.0.26 → DROP_COLUMN INPLACE + rebuild=true
 *
 * 触发方式：
 *   E2E_RUN_PREFLIGHT_MYSQL=1 \
 *   E2E_MYSQL_9_PASSWORD='...' E2E_MYSQL_15_PASSWORD='...' \
 *   npm run e2e:preflight:mysql
 *
 * 环境变量缺失时整套 spec skip，不影响 npm run e2e 主 harness。
 * MySQL 5.7 INPLACE baseline 分支本轮不覆盖，见 follow-up 任务。
 */

interface MysqlEnvConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  versionLabel: string;  // e.g. "8.0.46"
  expectedDropAlgo: 'INSTANT' | 'INPLACE';
}

/** 从环境变量装载一台机器的配置。密码缺失时返回 null。 */
function loadMysqlEnvConfig(suffix: '9' | '15'): MysqlEnvConfig | null {
  const defaultHost = suffix === '9' ? '192.168.5.9' : '192.168.5.15';
  const defaultDatabase = `sqldiff_preflight_test_${suffix === '9' ? '8_0_46' : '8_0_26'}`;
  const host = process.env[`E2E_MYSQL_${suffix}_HOST`] || defaultHost;
  const port = Number(process.env[`E2E_MYSQL_${suffix}_PORT`]) || 3306;
  const user = process.env[`E2E_MYSQL_${suffix}_USER`] || 'root';
  const password = process.env[`E2E_MYSQL_${suffix}_PASSWORD`];
  const database = process.env[`E2E_MYSQL_${suffix}_DATABASE`] || defaultDatabase;
  if (!password) return null;
  return {
    host,
    port,
    user,
    password,
    database,
    versionLabel: suffix === '9' ? '8.0.46' : '8.0.26',
    expectedDropAlgo: suffix === '9' ? 'INSTANT' : 'INPLACE',
  };
}

const cfg9 = loadMysqlEnvConfig('9');
const cfg15 = loadMysqlEnvConfig('15');

// 未显式开启 E2E_RUN_PREFLIGHT_MYSQL=1 或对应机器环境变量缺失时，整套 spec 静默 skip。
const RUN_MYSQL = process.env.E2E_RUN_PREFLIGHT_MYSQL === '1';
const SKIP_MYSQL_9 = !RUN_MYSQL || cfg9 === null;
const SKIP_MYSQL_15 = !RUN_MYSQL || cfg15 === null;

/** 通过 page.evaluate 调 api.preflight.run，返回 PreflightReport（已 parse JSON）。 */
async function runPreflightViaApi(
  page: ElectronHandle['page'],
  bId: string,
  bAlias: string,
  bDatabase: string,
  thresholds?: { bigTableRows?: number; replicaLagSeconds?: number },
): Promise<PreflightReport> {
  const items = buildFixtureItems();
  const jsonContent: string = await page.evaluate(async (args: { bId: string; bAlias: string; bDatabase: string; items: unknown[]; thresholds?: unknown }) => {
    const api = (window as unknown as { sqldiff?: unknown }).sqldiff as {
      preflight: { run: (req: unknown) => Promise<{ jsonContent: string; verdictLevel: string }> };
    };
    if (!api) throw new Error('window.sqldiff.preflight not available');
    const result = await api.preflight.run({
      bId: args.bId,
      bAlias: args.bAlias,
      bDatabase: args.bDatabase,
      items: args.items,
      ...(args.thresholds ? { thresholds: args.thresholds } : {}),
    });
    return result.jsonContent;
  }, { bId, bAlias, bDatabase, items, thresholds });
  return JSON.parse(jsonContent);
}

/** 在 fixture DB 上执行 SQL（用于 READ_ONLY_TARGET 触发测试）。 */
async function executeOnFixture(
  cfg: FixtureConfig,
  sql: string,
): Promise<void> {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectTimeout: 8000,
  });
  try {
    await conn.execute(sql);
  } finally {
    await conn.end();
  }
}

/** 生成一个测试节点元数据（不带 secret）。secret 通过 nodes.create 单独注入。 */
function makeTestNodeMeta(config: MysqlEnvConfig, id: string, alias: string): Omit<NodeMeta, 'createdAt'> {
  return {
    id,
    alias,
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
  };
}

/** 通过 page.evaluate 调 api.nodes.create 创建节点（含 secret）。返回真实 node.id。 */
async function createTestNodeViaApi(
  page: ElectronHandle['page'],
  meta: Omit<NodeMeta, 'createdAt'>,
  password: string,
): Promise<string> {
  return await page.evaluate(async (args: { meta: Omit<NodeMeta, 'createdAt'>; password: string }) => {
    const api = (window as unknown as { sqldiff?: unknown }).sqldiff as {
      nodes: { create: (input: unknown) => Promise<{ id: string }> };
    };
    if (!api) throw new Error('window.sqldiff.nodes not available');
    const created = await api.nodes.create({
      alias: args.meta.alias,
      host: args.meta.host,
      port: args.meta.port,
      user: args.meta.user,
      database: args.meta.database,
      ssh: args.meta.ssh,
      secret: { password: args.password },
    });
    return created.id;
  }, { meta, password });
}

const node9Meta = cfg9 ? makeTestNodeMeta(cfg9, 'e2e-preflight-9', 'preflight-8.0.46') : null;
const node15Meta = cfg15 ? makeTestNodeMeta(cfg15, 'e2e-preflight-15', 'preflight-8.0.26') : null;

let handle: ElectronHandle | null = null;

test.beforeAll(async () => {
  if (SKIP_MYSQL_9 && SKIP_MYSQL_15) {
    // 两台都跳过，无需启动 Electron。
    return;
  }
  handle = await launchElectron([]);
});

test.afterAll(async () => {
  if (handle) {
    await closeElectron(handle);
  }
});

test.describe('Preflight E2E on MySQL 8.0.46', () => {
  test.describe.configure({ timeout: 180_000 });

  test('fixture 建库 + preflight 全量断言 + cleanup', async () => {
    if (SKIP_MYSQL_9) {
      test.skip(true, 'E2E_MYSQL_9_HOST/PASSWORD 未设置或开关未开启');
      return;
    }
    const cfg: FixtureConfig = {
      host: cfg9!.host,
      port: cfg9!.port,
      user: cfg9!.user,
      password: cfg9!.password,
      database: cfg9!.database,
    };
    try {
      // 预检连接
      const version = await checkConnection(cfg);
      expect(version).toContain('8.0');

      // 建 fixture
      await createFixtureDatabase(cfg);

      // 通过 API 创建测试节点（含 secret）
      const bId9 = await createTestNodeViaApi(handle!.page, node9Meta!, cfg9!.password);

      // 跑 preflight
      const report = await runPreflightViaApi(
        handle!.page,
        bId9,
        'preflight-8.0.46',
        cfg9!.database,
        { bigTableRows: 1000 },
      );

      // --- 断言清单 ---
      assertReportStructure(report);

      // server.mysql_version fact 与 fixture 版本一致
      assertFactValue(report, 'server.mysql_version', version);

      // users_big 数据量断言
      // users_big 数据量断言（information_schema.TABLE_ROWS 是估算值，InnoDB 可偏差较大，
      // 此处仅要求 > 0 表示有数据行；精确行数验证留给 SQL 层）
      assertFactNumberAtLeast(report, 'table.users_big.rows', 1);

      // ADD_COLUMN 双机一致 INSTANT
      // DROP_COLUMN 8.0.46 → INSTANT
      assertInstantAddDrop(report, 'INSTANT');

      // OTHER 分类落 Unknown
      assertOtherGoesToUnknown(report, 'd11');

      // users_big 大表 INSTANT ADD → 正面 warn（thresholds.bigTableRows 调低以适配估算值）
      assertIssue(
        report,
        'LARGE_TABLE_INSTANT_ADD:diff-item:d01',
        'warn',
      );

      // verdict 存在
      expect(['pass', 'warn', 'block', 'unknown']).toContain(report.verdict.level);

      // permissions.visibility 存在（'full' | 'partial' | 'none'）
      const visFact = findFactByKey(report, 'permissions.visibility');
      expect(visFact?.value).toMatch(/^(full|partial|none)$/);
    } finally {
      // Cleanup：DROP DATABASE 无论成败
      await dropFixtureDatabase(cfg);
    }
  });

  test('READ_ONLY_TARGET block 触发', async () => {
    if (SKIP_MYSQL_9) {
      test.skip(true, 'E2E_MYSQL_9_HOST/PASSWORD 未设置或开关未开启');
      return;
    }
    const cfg: FixtureConfig = {
      host: cfg9!.host,
      port: cfg9!.port,
      user: cfg9!.user,
      password: cfg9!.password,
      database: cfg9!.database,
    };
    try {
      // 复用上一 test 建的 fixture 库；若不存在则先建
      await createFixtureDatabase(cfg);

      // 通过 API 创建测试节点
      const bId9 = await createTestNodeViaApi(handle!.page, node9Meta!, cfg9!.password);

      // 打开 read_only
      await executeOnFixture(cfg, 'SET GLOBAL read_only=1');

      try {
        const report = await runPreflightViaApi(
          handle!.page,
          bId9,
          'preflight-8.0.46',
          cfg9!.database,
        );

        // 断言 READ_ONLY_TARGET block（issue id 含 subject）
        assertIssue(report, 'READ_ONLY_TARGET:server', 'block');

        // server.read_only fact 应为 1
        assertFactValue(report, 'server.read_only', 1);
      } finally {
        // 无论成败都还原
        await executeOnFixture(cfg, 'SET GLOBAL read_only=0');
      }
    } finally {
      await dropFixtureDatabase(cfg);
    }
  });
});

test.describe('Preflight E2E on MySQL 8.0.26', () => {
  test.describe.configure({ timeout: 180_000 });

  test('fixture 建库 + preflight 全量断言 + cleanup', async () => {
    if (SKIP_MYSQL_15) {
      test.skip(true, 'E2E_MYSQL_15_HOST/PASSWORD 未设置或开关未开启');
      return;
    }
    const cfg: FixtureConfig = {
      host: cfg15!.host,
      port: cfg15!.port,
      user: cfg15!.user,
      password: cfg15!.password,
      database: cfg15!.database,
    };
    try {
      const version = await checkConnection(cfg);
      expect(version).toContain('8.0');

      await createFixtureDatabase(cfg);

      const bId15 = await createTestNodeViaApi(handle!.page, node15Meta!, cfg15!.password);

      const report = await runPreflightViaApi(
        handle!.page,
        bId15,
        'preflight-8.0.26',
        cfg15!.database,
        { bigTableRows: 1000 },
      );

      assertReportStructure(report);
      assertFactValue(report, 'server.mysql_version', version);
      // users_big 数据量断言（information_schema.TABLE_ROWS 是估算值，InnoDB 可偏差较大，
      // 此处仅要求 > 0 表示有数据行；精确行数验证留给 SQL 层）
      assertFactNumberAtLeast(report, 'table.users_big.rows', 1);

      // 8.0.26 < 8.0.29 → DROP_COLUMN 仍是 INPLACE
      assertInstantAddDrop(report, 'INPLACE');

      assertOtherGoesToUnknown(report, 'd11');

      assertIssue(
        report,
        'LARGE_TABLE_INSTANT_ADD:diff-item:d01',
        'warn',
      );

      expect(['pass', 'warn', 'block', 'unknown']).toContain(report.verdict.level);

      const visFact = findFactByKey(report, 'permissions.visibility');
      expect(visFact?.value).toMatch(/^(full|partial|none)$/);
    } finally {
      await dropFixtureDatabase(cfg);
    }
  });
});
