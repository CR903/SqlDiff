import { test, expect } from '@playwright/test';
import { launchElectron, closeElectron, type ElectronHandle } from '../helpers/electron';
import { readRequiredEnv, missingEnvReason } from '../helpers/env-loader';
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
 * Preflight E2E on real MySQL 8.0.46。
 *
 * 8.0.46 是 INSTANT DDL 的能力顶端：ADD_COLUMN（≥8.0.12）与 DROP_COLUMN（≥8.0.29）
 * 双双 INSTANT。版本下界的 INPLACE baseline 由 `preflight-on-mysql-5-7.spec.ts`
 * （MySQL 5.7）覆盖，两台合起来构成"两侧极端"对照。
 * 8.0.12–8.0.28 这段中间地带（DROP 仍 INPLACE）本轮不覆盖，见任务 Out of Scope。
 *
 * 触发方式（只需填好 `.env.e2e`，无需手工 export）：
 *   apps/desktop/.env.e2e 中设置 E2E_RUN_PREFLIGHT_MYSQL=1 与 E2E_MYSQL_9_*，然后
 *   npm run e2e:preflight:mysql
 *
 * 变量名沿用历史 `E2E_MYSQL_9_*`：它现在只是个不透明标签（单机化后 `9` 不再对应任何
 * 具体机器），改名的唯一效果是让已有的 `.env.e2e` 与外部文档失效。版本语义由 describe 名承载。
 *
 * 目标机是虚拟机，**IP 每次重启都会变** —— 因此 host 没有代码默认值：缺失即 skip，
 * 绝不静默去连某个可能已经过期的地址。
 */

interface MysqlEnvConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const ENV_PREFIX = 'E2E_MYSQL_9';
const REQUIRED_KEYS = [`${ENV_PREFIX}_HOST`, `${ENV_PREFIX}_PASSWORD`] as const;

/** 从环境变量装载 8.0.46 机器的配置；host / password 缺失时返回 null（→ skip）。 */
function loadMysqlEnvConfig(): MysqlEnvConfig | null {
  const { values, missing } = readRequiredEnv(process.env, REQUIRED_KEYS);
  if (missing.length > 0) return null;
  return {
    host: values[`${ENV_PREFIX}_HOST`],
    port: Number(process.env[`${ENV_PREFIX}_PORT`]) || 3306,
    user: process.env[`${ENV_PREFIX}_USER`] || 'root',
    password: values[`${ENV_PREFIX}_PASSWORD`],
    database: process.env[`${ENV_PREFIX}_DATABASE`] || 'sqldiff_preflight_test_8_0_46',
  };
}

const cfg = loadMysqlEnvConfig();

// 未显式开启 E2E_RUN_PREFLIGHT_MYSQL=1 或必填变量缺失时，整套 spec 静默 skip。
const RUN_MYSQL = process.env.E2E_RUN_PREFLIGHT_MYSQL === '1';
const SKIP_MYSQL = !RUN_MYSQL || cfg === null;

/** skip 诊断文案：点名缺哪个变量，并说明为什么不能有默认值。 */
function skipReason(): string {
  if (!RUN_MYSQL) return 'E2E_RUN_PREFLIGHT_MYSQL 未置 1（见 apps/desktop/.env.e2e）';
  const { missing } = readRequiredEnv(process.env, REQUIRED_KEYS);
  return missingEnvReason(missing, 'apps/desktop/.env.e2e');
}

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
  fixtureCfg: FixtureConfig,
  sql: string,
): Promise<void> {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: fixtureCfg.host,
    port: fixtureCfg.port,
    user: fixtureCfg.user,
    password: fixtureCfg.password,
    database: fixtureCfg.database,
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

const nodeMeta = cfg ? makeTestNodeMeta(cfg, 'e2e-preflight-9', 'preflight-8.0.46') : null;

let handle: ElectronHandle | null = null;

test.beforeAll(async () => {
  if (SKIP_MYSQL) {
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

test.describe('Preflight E2E on MySQL 8.0.46', () => {
  test.describe.configure({ timeout: 180_000 });

  test('fixture 建库 + preflight 全量断言 + cleanup', async () => {
    if (SKIP_MYSQL) {
      test.skip(true, skipReason());
      return;
    }
    const fixtureCfg: FixtureConfig = {
      host: cfg!.host,
      port: cfg!.port,
      user: cfg!.user,
      password: cfg!.password,
      database: cfg!.database,
    };
    try {
      // 预检连接
      const version = await checkConnection(fixtureCfg);
      expect(version).toMatch(/^8\.0\./);

      // 建 fixture
      await createFixtureDatabase(fixtureCfg);

      // 通过 API 创建测试节点（含 secret）
      const bId = await createTestNodeViaApi(handle!.page, nodeMeta!, cfg!.password);

      // 跑 preflight
      const report = await runPreflightViaApi(
        handle!.page,
        bId,
        'preflight-8.0.46',
        cfg!.database,
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

      // ADD_COLUMN INSTANT + DROP_COLUMN INSTANT（8.0.46 ≥ 8.0.29，两侧都走 INSTANT）
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
      await dropFixtureDatabase(fixtureCfg);
    }
  });

  test('READ_ONLY_TARGET block 触发', async () => {
    if (SKIP_MYSQL) {
      test.skip(true, skipReason());
      return;
    }
    const fixtureCfg: FixtureConfig = {
      host: cfg!.host,
      port: cfg!.port,
      user: cfg!.user,
      password: cfg!.password,
      database: cfg!.database,
    };
    try {
      // 复用上一 test 建的 fixture 库；若不存在则先建
      await createFixtureDatabase(fixtureCfg);

      // 通过 API 创建测试节点
      const bId = await createTestNodeViaApi(handle!.page, nodeMeta!, cfg!.password);

      // 打开 read_only
      await executeOnFixture(fixtureCfg, 'SET GLOBAL read_only=1');

      try {
        const report = await runPreflightViaApi(
          handle!.page,
          bId,
          'preflight-8.0.46',
          cfg!.database,
        );

        // 断言 READ_ONLY_TARGET block（issue id 含 subject）
        assertIssue(report, 'READ_ONLY_TARGET:server', 'block');

        // server.read_only fact 应为 1
        assertFactValue(report, 'server.read_only', 1);
      } finally {
        // 无论成败都还原（残留会影响开发机后续使用）
        await executeOnFixture(fixtureCfg, 'SET GLOBAL read_only=0');
      }
    } finally {
      await dropFixtureDatabase(fixtureCfg);
    }
  });
});
