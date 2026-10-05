import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchElectron, closeElectron, type ElectronHandle } from '../helpers/electron';
import { readRequiredEnv, missingEnvReason } from '../helpers/env-loader';
import { assertNoSecrets } from '../helpers/assertions';
import {
  checkConnection,
  createCompareFixtureDatabases,
  dropCompareFixtureDatabases,
  listSqldiffDatabases,
  COMPARE_FIXTURE_TABLE,
  type CompareFixtureConfig,
} from '../fixtures/mysql-fixture';
import { preflightFileNames } from '../../src-core/preflight';
import type { PreflightReport } from '../../src-core/preflight-types';

/**
 * 导出 UI 全链路 E2E：真实比较 → 运行 Preflight → 导出 Preflight 报告 → 导出审查报告。
 *
 * ## 为什么必须做「真实比较」
 *
 * `导出 Preflight 报告` 读的是 renderer 的 React state `lastPreflightResult`
 * （App.tsx `handleExportPreflight`），而 `运行 Preflight` 的门控是
 * `resultSource === 'real' && lastCompareRequest != null && !comparing && items.some(table)`。
 * 已有的 `preflight-on-mysql-*.spec.ts` 全走 `page.evaluate(() => api.preflight.run(...))`，
 * **API 直调既不设这个 state 也不满足门控**，因此它们验证不到 UI 层。
 * 所以本 spec 必须自己驱动一次真实比较 —— 这也是 AC5 的要求。
 *
 * ## 为什么全程零 page.evaluate
 *
 * 连节点都通过 UI 建（点「＋ 新增」填表保存），而不是 `api.nodes.create` + 刷新列表：
 * `page.evaluate` 只能「旁路观察」，一旦用它做节点注入或调用业务 API，
 * 「真实点击可达」这个结论就不再成立。选择器全部用 role / placeholder，
 * 靠语义定位而非 CSS 顺序耦合。
 *
 * ## 选哪台机器
 *
 * 8.0.46（`E2E_MYSQL_9_*`）：
 *  1. 该机账号是 root@%，有全局 ALL PRIVILEGES → 建/删两个库不需要额外 GRANT；
 *  2. ≥ 8.0.12，ADD COLUMN 走 INSTANT，报告里有真实算法判定而非全 INPLACE 的退化形态；
 *  3. 与既有 `preflight-on-mysql-8.spec.ts` 同机 → 同一次 harness 里可一并证明既有真机用例未回归。
 * 5.7 机（root 仅 root@localhost）需要专用远程账号 + 逐库 GRANT，本轮不引入。
 *
 * 触发方式（只需填好 `.env.e2e`，无需手工 export）：
 *   E2E_RUN_EXPORT_UI=1 + E2E_MYSQL_9_* → npm run e2e:export:ui
 * 未开启时整套 spec 静默 skip，`npm run e2e` 主 harness 保持安静。
 */

/**
 * 本 spec 会把 **`.env.e2e` 里的真实密码**打进 UI 的密码框（不这样就连不上真机、
 * 跑不出真实比较）。因此必须显式处理 trace：
 *
 * **Playwright 不会对 `type=password` 的输入做掩码。** 实测（2026-10-05，playwright-core
 * 1.63）：明文原样出现在 `trace.zip` 的 `test.trace` 里，两处都带：
 *   `{"title":"Fill \"<明文>\""}` 与 `{"params":{"value":"<明文>"}}`
 * 而 `playwright.config.ts` 是 `trace: 'retain-on-failure'` —— 本 spec 一旦失败，
 * 真机密码就留在 `e2e/test-results/` 下（该目录已 gitignore，入库被挡住，
 * 但本地磁盘上的明文仍然可见，且 HTML 报告会把 trace 一并打包）。
 *
 * 所以本 spec 默认 `trace: 'off'`，需要排查 UI 时用 `E2E_TRACE=1` 临时打开，
 * 排查完删掉 `e2e/test-results/`。代价是默认没有 trace（改用 `error-context.md`
 * 与 list reporter 报错定位）——这是「秘密不落盘」与「失败可诊断」之间的显式取舍，
 * 偏向安全。
 */
test.use({ trace: process.env.E2E_TRACE === '1' ? 'on' : 'off' });

const ENV_PREFIX = 'E2E_MYSQL_9';
const REQUIRED_KEYS = [`${ENV_PREFIX}_HOST`, `${ENV_PREFIX}_PASSWORD`] as const;

/** 独立开关：与既有 `E2E_RUN_PREFLIGHT_MYSQL` 分开，避免误伤主 harness。 */
const RUN_EXPORT_UI = process.env.E2E_RUN_EXPORT_UI === '1';

interface MysqlEnvConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

function loadMysqlEnvConfig(): MysqlEnvConfig | null {
  const { values, missing } = readRequiredEnv(process.env, REQUIRED_KEYS);
  if (missing.length > 0) return null;
  return {
    host: values[`${ENV_PREFIX}_HOST`],
    port: Number(process.env[`${ENV_PREFIX}_PORT`]) || 3306,
    user: process.env[`${ENV_PREFIX}_USER`] || 'root',
    password: values[`${ENV_PREFIX}_PASSWORD`],
  };
}

const env = loadMysqlEnvConfig();
const SKIP = !RUN_EXPORT_UI || env === null;

/** skip 诊断文案：点名缺哪个变量 / 哪个开关，并说明为什么不能有默认地址。 */
function skipReason(): string {
  if (!RUN_EXPORT_UI) return 'E2E_RUN_EXPORT_UI 未置 1（见 apps/desktop/.env.e2e）';
  const { missing } = readRequiredEnv(process.env, REQUIRED_KEYS);
  return missingEnvReason(missing, 'apps/desktop/.env.e2e');
}

/** 双库 fixture 的库名：都用 `sqldiff` 前缀，AC6 的 `SHOW DATABASES LIKE 'sqldiff%'` 一次覆盖。 */
const SOURCE_DB = 'sqldiff_export_e2e_src';
const TARGET_DB = 'sqldiff_export_e2e_tgt';

const SOURCE_ALIAS = 'e2e-导出A源库';
const TARGET_ALIAS = 'e2e-导出B目标库';

function fixtureConfig(): CompareFixtureConfig {
  return {
    host: env!.host,
    port: env!.port,
    user: env!.user,
    password: env!.password,
    sourceDatabase: SOURCE_DB,
    targetDatabase: TARGET_DB,
  };
}

let handle: ElectronHandle | null = null;
/**
 * 「欠一次清理」标记，**在建库之前**置位。
 *
 * 为什么不能等建库成功再置位：`createCompareFixtureDatabases` 会先建源库再建目标库，
 * 中途抛错（第二个库建失败、连接被断）时第一个库已经落盘。若那时标记还是 false，
 * `afterAll` 会跳过删除 → 真机上残留一个库 → AC6「无残留数据库」失守。
 */
let cleanupOwed = false;

test.beforeAll(async () => {
  if (SKIP) return;
  // 预检：连不通就直接让本 spec 的用例 skip，而不是在超时后报错。
  // 版本断言放在置位之前：版本不符时尚未建库，无需清理。
  const version = await checkConnection({
    host: env!.host,
    port: env!.port,
    user: env!.user,
    password: env!.password,
    database: SOURCE_DB,
  });
  expect(version).toMatch(/^8\./);
  cleanupOwed = true;
  await createCompareFixtureDatabases(fixtureConfig());
  handle = await launchElectron([]);
});

test.afterAll(async () => {
  if (handle) await closeElectron(handle);
  // 判据只看 `cleanupOwed`：它在建库**之前**置位，所以「建库中途抛错」这条
  // 会留残留的路径同样被覆盖；而 SKIP 时从未置位，不会去连库。
  // drop 走 `DROP DATABASE IF EXISTS`、连接失败也不 throw（「尽力而为」），
  // 所以重复删库无害，漏删才是真事故。
  if (cleanupOwed) await dropCompareFixtureDatabases(fixtureConfig());
  cleanupOwed = false;
});

/**
 * Preflight / Manifest 产物里的**固定保密声明**。
 *
 * 它**刻意**提到「passphrase / 私钥 / Vault 密文」这些词——那是保密承诺本身
 * （「本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）…」），不是泄漏。
 * 判字段名黑名单前必须先摘掉这句，否则每次导出都会假红。
 *
 * 与 `tests/core/preflight-export-secrets.test.ts` 的 `CONFIDENTIALITY_NOTES` 是同一组文案，
 * 但两边**刻意不共享**（单测不能 import `e2e/`，反之亦然）。单边修改时请同步另一边。
 */
const CONFIDENTIALITY_NOTES = [
  '本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）与未经裁定的行值。',
  '本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）；数据行值已脱敏。',
] as const;

function stripConfidentialityNotes(content: string): string {
  return CONFIDENTIALITY_NOTES.reduce((acc, note) => acc.split(note).join(''), content);
}

/**
 * 判据：字段名层 + **值层**（R2）。
 *
 * 值层在 E2E 层的形态与 B1 单测不同、且更强：单测用 `fake-sentinel-*` 哨兵值，
 * 而这里手上就有 `.env.e2e` 里的**真实密码**，可以在运行时直接断言它没出现在任何导出物里。
 * 密码从 `process.env` 读、不写进本文件 —— 既拿到最强的值层证据，又不把秘密写进仓库（AC10）。
 *
 * 字段名层复用 `../helpers/assertions.ts:assertNoSecrets`（DataGrip/DBeaver 已在用），
 * 但**先摘掉保密声明**：那句承诺本身列举了 `passphrase`，不摘会每次假红。
 * DataGrip/DBeaver 产物没有这句，所以那边不需要摘——这是产物差异，不是判据缺失。
 *
 * 注意 `tests/core/preflight-export-secrets.test.ts` 另有一套 §11.1 判据（带保密声明摘除
 * 与授权语句正则），两边**刻意不共享**：单测侧不能 import `e2e/`，而这里用不到那些额外判据
 * （Preflight / Manifest 产物里没有 DataGrip 的 `save-password` / `authType` 枚举值需要白名单）。
 * 单边修改时请同步另一边的注释。
 */
function assertNoCredentialLeak(content: string, label: string, realPassword: string): void {
  const stripped = stripConfidentialityNotes(content);
  // 非空转自证：Markdown 产物里必须真的摘掉了保密声明。
  // JSON 产物本来就不含这句，strip 后与原文相同属正常，所以用「声明特征仍在」区分两种情况：
  // 特征还在 = 产品改了文案而本文件的副本没跟上 → 那句里的 `passphrase` 会被
  // assertNoSecrets 当成真实泄漏，报出完全误导的「秘密字段泄漏：passphrase」。
  // 这里先把它报成文案漂移，失败信息直指真正的原因与修法。
  if (stripped === content && content.includes('本报告不含连接凭据')) {
    throw new Error(
      `导出物 ${label} 的保密声明文案与产品不一致（stripConfidentialityNotes 未命中）`
      + '——请同步 src-core/preflight.ts / src-core/manifest.ts 的文案到 CONFIDENTIALITY_NOTES',
    );
  }
  assertNoSecrets(stripped);
  if (content.includes(realPassword)) {
    throw new Error(`导出物 ${label} 泄漏了真实数据库密码`);
  }
}

/** 等 toast 出现并返回其文本。toast 2.2s 自动消失，所以用高频轮询抓。 */
async function waitForToast(page: ElectronHandle['page'], needle: string): Promise<string> {
  const handle_ = await page.waitForFunction(
    (n: string) => {
      const el = document.querySelector('.toast.show');
      const text = el?.textContent ?? '';
      return text.includes(n) ? text : false;
    },
    needle,
    { timeout: 30_000, polling: 50 },
  );
  return String(await handle_.jsonValue());
}

/** 走 UI 新建一个节点（点「＋ 新增」→ 填表 → 「保存」）。全程真实点击，无 page.evaluate。 */
async function createNodeViaUi(
  page: ElectronHandle['page'],
  node: { alias: string; host: string; port: number; user: string; password: string; database: string },
): Promise<void> {
  await page.getByRole('button', { name: '新增' }).click();
  const dialog = page.getByRole('dialog', { name: '新增节点' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  // 用 placeholder 定位：弹窗内唯一，且不依赖 label 文本里的「*」标记。
  await dialog.getByPlaceholder('prod-主库').fill(node.alias);
  await dialog.getByPlaceholder('127.0.0.1').fill(node.host);
  await dialog.getByPlaceholder('3306').fill(String(node.port));
  await dialog.getByPlaceholder('root').fill(node.user);
  // 密码框：SSH 未启用时弹窗内只有一个 type=password。
  await dialog.locator('input[type="password"]').first().fill(node.password);
  await dialog.getByPlaceholder('shop').fill(node.database);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });
}

test.describe('导出 UI E2E：对比 → Preflight → 两个导出', () => {
  // 一次真实比较 + preflight 只读采集 + 两次 bundle 落盘，且目标是远程虚拟机。
  test.describe.configure({ timeout: 240_000 });

  test('真实点击跑完 compare → preflight → 导出，产出 3 个 Preflight 文件 + Manifest 文件且无凭据泄漏', async () => {
    if (SKIP) {
      test.skip(true, skipReason());
      return;
    }
    const { page, downloadsDir } = handle!;
    const cfg = env!;

    // --- 1. 通过 UI 建两个节点（真实表单路径，凭据走 vault）---
    await createNodeViaUi(page, {
      alias: SOURCE_ALIAS,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: SOURCE_DB,
    });
    await createNodeViaUi(page, {
      alias: TARGET_ALIAS,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: TARGET_DB,
    });

    // --- 2. 点击节点卡片自动填入 A / B 槽 ---
    await page.locator('.node-card', { hasText: SOURCE_ALIAS }).locator('.node-alias').click();
    await page.locator('.node-card', { hasText: TARGET_ALIAS }).locator('.node-alias').click();
    await expect(page.locator('.slot').first().locator('.slot-node')).toHaveText(SOURCE_ALIAS);
    await expect(page.locator('.slot').nth(1).locator('.slot-node')).toHaveText(TARGET_ALIAS);

    // --- 3. 真实比较 ---
    const compareBtn = page.getByRole('button', { name: '对比 ⚡' });
    await expect(compareBtn).toBeEnabled();
    await compareBtn.click();

    // 「运行 Preflight」变可用 == 真实比较完成 **且** 至少 1 条表级 DDL 项
    // （canRunPreflight 的两个真实结果前置条件，一个断言同时覆盖）。
    //
    // 用 poll 而不是裸 toBeEnabled：比较失败时 preflightBtn 会一直 disabled，
    // 裸断言只会抛一句「元素未 enabled」。把错误卡文案一起带进返回值，
    // 失败时能直接看出是连不上库还是权限问题。
    const preflightBtn = page.getByRole('button', { name: '运行 Preflight' });
    await expect
      .poll(
        async () => {
          if (await preflightBtn.isEnabled()) return 'ready';
          const alert = await page.locator('.result-error').first().innerText().catch(() => '');
          return alert ? `error-card: ${alert.replace(/\s+/g, ' ').slice(0, 200)}` : 'comparing';
        },
        { timeout: 120_000, intervals: [250], message: '等待真实比较完成（运行 Preflight 变可用）' },
      )
      .toBe('ready');

    // 差异表确实渲染出了这张表的一条**表级**差异行
    // （排除「比较成功但零差异」——那种情况同样满足门控提示，是假阳性）。
    const diffRow = page.locator('.diff-table tbody tr', { hasText: COMPARE_FIXTURE_TABLE });
    await expect(diffRow).toHaveCount(1);
    await expect(diffRow.locator('.badge.b-obj')).toHaveText('table');

    // 审查报告导出入口可用（这条路径若被 demo 结果污染，导出的就是假产物）。
    await expect(page.getByRole('button', { name: '导出审查报告' })).toBeEnabled();

    // --- 4. 真实点击运行 Preflight ---
    await preflightBtn.click();
    const verdict = page.locator('[role="status"][aria-live="polite"]');
    await verdict.waitFor({ state: 'visible', timeout: 120_000 });
    // verdict badge 的 a11y 契约（frontend/quality-guidelines.md 要求 CDP 断言两个属性）。
    await expect(verdict).toHaveAttribute('aria-live', 'polite');

    // --- 5. 真实点击导出 Preflight 报告 ---
    const [pfToast] = await Promise.all([
      waitForToast(page, '已导出 Preflight 报告'),
      page.locator('.preflight-export-btn').click(),
    ]);
    // 成功 toast 必须带真实落盘目录（quality-guidelines：never report an optimistic 已导出）。
    expect(pfToast).toContain(downloadsDir);

    // --- 6. 断言 3 个 Preflight 文件（json / 结论 md / 细节 -detail.md）---
    const pfFiles = readdirSync(downloadsDir).filter((f) => f.startsWith('sqldiff-preflight-'));
    expect(pfFiles, `downloadsDir 应恰好 3 个 preflight 文件，实际：${pfFiles.join(', ')}`).toHaveLength(3);
    const pfJsonName = pfFiles.find((f) => f.endsWith('.json'))!;
    const pfMdName = pfFiles.find((f) => f.endsWith('.md') && !f.endsWith('-detail.md'))!;
    const pfDetailName = pfFiles.find((f) => f.endsWith('-detail.md'))!;

    const pfJsonText = readFileSync(join(downloadsDir, pfJsonName), 'utf8');
    const pfMdText = readFileSync(join(downloadsDir, pfMdName), 'utf8');
    const pfDetailText = readFileSync(join(downloadsDir, pfDetailName), 'utf8');

    const report = JSON.parse(pfJsonText) as PreflightReport;
    expect(report.schemaVersion).toBe(2);
    expect(report.source).toBe('real');
    // 真实比较 → 真实采集：facts 非空，且 ddl 类 inference 存在（ADD COLUMN 已被分类）。
    expect(report.facts.length).toBeGreaterThan(0);
    const ddlInference = report.inferences.find((i) => i.category === 'ddl');
    expect(ddlInference, '应有至少一条 ddl 类 inference').toBeTruthy();
    expect(ddlInference!.statement).toContain('ADD_COLUMN');

    // AC3：写盘的文件名必须与 preflightFileNames 契约一致（3 个、各自后缀正确）。
    expect([pfJsonName, pfMdName, pfDetailName].sort()).toEqual(
      Object.values(preflightFileNames(report.checkedAt)).sort(),
    );

    // 结论 md / 细节 md 互链（B1 已在单测层锁过，这里验证「真机写盘的那两份」也成立）。
    expect(pfMdText).toContain(`./${pfDetailName}`);
    expect(pfDetailText).toContain(`./${pfMdName}`);

    // --- 7. 真实点击导出审查报告（同一次比较的产物，spec 要求 same harness run）---
    const [mfToast] = await Promise.all([
      waitForToast(page, '已导出审查报告'),
      page.getByRole('button', { name: '导出审查报告' }).click(),
    ]);
    expect(mfToast).toContain(downloadsDir);

    const mfFiles = readdirSync(downloadsDir).filter((f) => f.startsWith('sqldiff-review-'));
    expect(mfFiles, `downloadsDir 应有 2 个 manifest 文件，实际：${mfFiles.join(', ')}`).toHaveLength(2);
    const mfJsonName = mfFiles.find((f) => f.endsWith('.json'))!;
    const mfMdName = mfFiles.find((f) => f.endsWith('.md'))!;
    const mfJsonText = readFileSync(join(downloadsDir, mfJsonName), 'utf8');
    const mfMdText = readFileSync(join(downloadsDir, mfMdName), 'utf8');

    const manifest = JSON.parse(mfJsonText) as {
      schemaVersion: number;
      source: string;
      aAlias: string;
      bAlias: string;
      items: Array<{ objectType: string; objectName: string; sql: string }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.source).toBe('real');
    expect(manifest.aAlias).toBe(SOURCE_ALIAS);
    expect(manifest.bAlias).toBe(TARGET_ALIAS);
    // manifest 记的是这次真实比较的表级差异（不是空结果、不是 demo）。
    const tableItem = manifest.items.find((i) => i.objectType === 'table');
    expect(tableItem, 'manifest 应含表级 DDL 项').toBeTruthy();
    expect(tableItem!.objectName).toBe(COMPARE_FIXTURE_TABLE);
    expect(tableItem!.sql.toUpperCase()).toContain('ADD COLUMN');

    // --- 8. §11.1 保密硬边界：5 份产物全部两层断言 ---
    for (const [label, content] of [
      ['preflight json', pfJsonText],
      ['preflight 结论 md', pfMdText],
      ['preflight 细节 md', pfDetailText],
      ['manifest json', mfJsonText],
      ['manifest md', mfMdText],
    ] as const) {
      assertNoCredentialLeak(content, label, cfg.password);
    }
  });

  test('cleanup：两个 fixture 库已删除', async () => {
    if (SKIP) {
      test.skip(true, skipReason());
      return;
    }
    // afterAll 才删库，所以本用例自己再确认一次「此刻还在」不成立——
    // 改为把删除动作提前到这里执行（幂等），afterAll 的重复调用无害。
    await dropCompareFixtureDatabases(fixtureConfig());
    cleanupOwed = false;
    const remaining = await listSqldiffDatabases(env!);
    expect(
      remaining,
      `fixture 库应已清理干净，残留：${remaining.join(', ') || '(无)'}`,
    ).not.toContain(SOURCE_DB);
    expect(remaining).not.toContain(TARGET_DB);
  });
});
