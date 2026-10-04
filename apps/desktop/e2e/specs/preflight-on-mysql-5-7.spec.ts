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
  assertInplaceBaseline,
  assertOtherGoesToUnknown,
  findFactByKey,
  assertIssue,
  assertNoIssue,
  assertFactValue,
  assertFactNumberAtLeast,
} from '../helpers/preflight-fixture';
import type { PreflightReport } from '../../src-core/preflight-types';
import type { NodeMeta } from '../../src-core/types';

/**
 * Preflight E2E on real MySQL 5.7 (INPLACE baseline)。
 *
 * 验证 8.x 双机未覆盖的版本分叉：
 *   - 192.168.2.84 → MySQL 5.7.x → ADD_COLUMN INPLACE + rebuild / DROP_COLUMN INPLACE + rebuild
 *
 * 三段对比（同一条 DDL 文本）：
 *   - 5.7    (<8.0.12)：ADD INPLACE(rebuild) + DROP INPLACE(rebuild)
 *   - 8.0.26 (<8.0.29)：ADD INSTANT         + DROP INPLACE(rebuild)
 *   - 8.0.46 (≥8.0.29)：ADD INSTANT         + DROP INSTANT
 *
 * 触发方式：
 *   E2E_RUN_PREFLIGHT_MYSQL57=1 \
 *   E2E_MYSQL_57_PASSWORD='...' \
 *   npm run e2e:preflight:mysql57
 *
 * 环境变量缺失或开关未开启时整套 spec skip，不影响 `npm run e2e` 主 harness。
 * 注意：`npm run e2e:preflight:mysql`（8.x，grep "Preflight E2E"）也会加载本文件，
 * 此时因开关/密码缺失而静默 skip；反之本 script 的 grep 只命中 5.7 describe。
 */

interface Mysql57EnvConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** 从环境变量装载 5.7 机器配置。密码缺失时返回 null（→ skip）。 */
function loadMysql57EnvConfig(): Mysql57EnvConfig | null {
  const host = process.env.E2E_MYSQL_57_HOST || '192.168.2.84';
  const port = Number(process.env.E2E_MYSQL_57_PORT) || 3306;
  const user = process.env.E2E_MYSQL_57_USER || 'root';
  const password = process.env.E2E_MYSQL_57_PASSWORD;
  const database = process.env.E2E_MYSQL_57_DATABASE || 'sqldiff_preflight_test_5_7';
  if (!password) return null;
  return { host, port, user, password, database };
}

const cfg57 = loadMysql57EnvConfig();

// 未显式开启 E2E_RUN_PREFLIGHT_MYSQL57=1 或密码缺失时，整套 spec 静默 skip。
const RUN_MYSQL57 = process.env.E2E_RUN_PREFLIGHT_MYSQL57 === '1';
const SKIP_MYSQL57 = !RUN_MYSQL57 || cfg57 === null;

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
function makeTestNodeMeta(config: Mysql57EnvConfig, id: string, alias: string): Omit<NodeMeta, 'createdAt'> {
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

const node57Meta = cfg57 ? makeTestNodeMeta(cfg57, 'e2e-preflight-57', 'preflight-5.7') : null;

let handle: ElectronHandle | null = null;

test.beforeAll(async () => {
  if (SKIP_MYSQL57) {
    // 跳过：无需启动 Electron。
    return;
  }
  handle = await launchElectron([]);
});

test.afterAll(async () => {
  if (handle) {
    await closeElectron(handle);
  }
});

test.describe('Preflight E2E on MySQL 5.7', () => {
  // 5.7 目标机内存较小（3G），users_big 百万行翻倍灌数据可能更慢，timeout 留足。
  test.describe.configure({ timeout: 600_000 });

  test('fixture 建库 + preflight 全量断言 + cleanup', async () => {
    if (SKIP_MYSQL57) {
      test.skip(true, 'E2E_MYSQL_57_PASSWORD 未设置或开关未开启');
      return;
    }
    const cfg: FixtureConfig = {
      host: cfg57!.host,
      port: cfg57!.port,
      user: cfg57!.user,
      password: cfg57!.password,
      database: cfg57!.database,
    };
    try {
      // 预检连接：5.7 真机
      const version = await checkConnection(cfg);
      expect(version).toMatch(/^5\.7\./);

      // 建 fixture（8 表 + users_big 百万行；语法与 8.x 同一套）
      await createFixtureDatabase(cfg);

      // 通过 API 创建测试节点（含 secret）
      const bId57 = await createTestNodeViaApi(handle!.page, node57Meta!, cfg57!.password);

      // 跑 preflight（thresholds.bigTableRows 调低以适配 information_schema 估算值）
      const report = await runPreflightViaApi(
        handle!.page,
        bId57,
        'preflight-5.7',
        cfg57!.database,
        { bigTableRows: 1000 },
      );

      // --- 断言清单（与 8.x 对齐 + 5.7 分叉）---
      assertReportStructure(report);

      // server.mysql_version fact 与真实版本一致
      assertFactValue(report, 'server.mysql_version', version);

      // users_big 数据量断言（information_schema.TABLE_ROWS 是估算值，
      // 此处仅要求 > 0 表示有数据行；精确行数验证留给 SQL 层）
      assertFactNumberAtLeast(report, 'table.users_big.rows', 1);

      // 核心分叉：ADD/DROP COLUMN 在 5.7 上均为 INPLACE + rebuild，且全报告无 INSTANT
      assertInplaceBaseline(report);

      // OTHER 分类落 Unknown
      assertOtherGoesToUnknown(report, 'd11');

      // 同一条 d01（users_big ADD_COLUMN）：5.7 上走 rebuild →
      // BIG_TABLE_COPY block（8.x 上对应的是 LARGE_TABLE_INSTANT_ADD warn）
      assertIssue(report, 'BIG_TABLE_COPY:table.users_big', 'block');

      // LARGE_TABLE_INSTANT_ADD 要求矩阵返回 INSTANT，5.7 永不触发
      assertNoIssue(report, 'LARGE_TABLE_INSTANT_ADD');

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
    if (SKIP_MYSQL57) {
      test.skip(true, 'E2E_MYSQL_57_PASSWORD 未设置或开关未开启');
      return;
    }
    const cfg: FixtureConfig = {
      host: cfg57!.host,
      port: cfg57!.port,
      user: cfg57!.user,
      password: cfg57!.password,
      database: cfg57!.database,
    };
    try {
      await createFixtureDatabase(cfg);

      const bId57 = await createTestNodeViaApi(handle!.page, node57Meta!, cfg57!.password);

      // 打开 read_only
      await executeOnFixture(cfg, 'SET GLOBAL read_only=1');

      try {
        const report = await runPreflightViaApi(
          handle!.page,
          bId57,
          'preflight-5.7',
          cfg57!.database,
        );

        // 断言 READ_ONLY_TARGET block
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
