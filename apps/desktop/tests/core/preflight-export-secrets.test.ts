// §11.1 保密硬边界 · 跨「序列化 + 渲染」的不变量（R1 / R2 / AC1 / AC3）。
//
// 这条契约不是「某个函数不读某个字段」，而是：
//
//   构造一份含凭据的输入 → 经过 序列化 / 结论渲染 / 细节渲染 / 写盘 → 产物里搜不到任何凭据**值**。
//
// 链条跨 4 个环节，任何单环节断言都捕获不了跨环节的泄漏（src-core/preflight.ts 与
// src-core/manifest.ts 的导出函数本身都已有直测，缺的是这条端到端不变量）。
//
// 判据两层，缺一不可：
//   - 字段名层：7 个敏感字段名 + SecretBundle + 原始 SHOW GRANTS 授权语句
//     （挡住结构化凭据字段被直接序列化）。
//   - **值层（本文件的核心，R2）**：5 个哨兵值逐个 not.toContain。
//     字段名黑名单挡不住值泄漏——凭据被拼进 SQL 字面量 / recommendation / targetAlias
//     是最现实的路径，那几个位置根本没有字段名。
//
// 目录边界：本文件**不** import `e2e/helpers/assertions.ts`——`tests/` 与 `e2e/` 各自独立
// （10-05-e2e-env-readiness 确立的边界）。e2e 侧的判据在
// `e2e/helpers/assertions.ts:assertNoSecrets`，两处各自实现、注释互相指认：
// 那边的白名单面向 DataGrip/DBeaver 的枚举值（save-password / authType），
// 这边的字段名清单面向 §11.1 的凭据契约。单边修改时请同步另一边的注释。

import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  manifestToMarkdown,
  serializeManifest,
} from '../../src-core/manifest';
import {
  buildPreflightReport,
  preflightFileNames,
  preflightToDetailMarkdown,
  preflightToExecutiveMarkdown,
  preflightToMarkdown,
  serializePreflight,
  type PreflightBuildInput,
} from '../../src-core/preflight';
import type { PreflightReport } from '../../src-core/preflight-types';
import type { DiffItem, ManifestBuildInput, SecretBundle } from '../../src-core/types';

// ---------------------------------------------------------------------------
// 哨兵凭据值
// ---------------------------------------------------------------------------

/**
 * 5 个哨兵凭据值。
 *
 * - `fake-` 前缀 = 明显假值，满足质量门禁「fixture 绝不用真实 host / 密码 / 密钥」
 *   （真密码进测试文件会同时踩红 AC10 与秘密入库红线）；
 * - 用途名 + 短随机后缀 = 一眼可辨，且不会与产物里的正常词相撞，
 *   保证「不包含」不是因为「本来就匹配不上任何东西」。
 */
const SENTINELS = {
  password: 'fake-sentinel-pw-9f3a',
  sshPassword: 'fake-sentinel-ssh-4b71',
  privateKey: 'fake-sentinel-key-2c58',
  passphrase: 'fake-sentinel-pass-6d0e',
  vaultCiphertext: 'fake-sentinel-vault-8a3f',
} as const;

const SENTINEL_VALUES: readonly string[] = Object.values(SENTINELS);

/**
 * 生产里凭据的真实载体：SecretBundle 只驻留内存 / 钥匙串，不进 nodes.json。
 *
 * 类型刻意写成 `SecretBundle & { vaultCiphertext: string }` 而不是裸对象：
 * 交叉类型要求那 4 个字段**确实存在于** SecretBundle 上——若有人给 SecretBundle
 * 删字段或改名，`tsc` 会在这一行立刻报错，而不是等到运行时的键名断言才发现。
 * `vaultCiphertext` 作为交叉里的**额外**字段，也顺带钉住了「它不属于 SecretBundle、
 * 只出现在 §11.1 的 Vault 落盘形态里」这一事实（见 types.ts:70）。
 */
const SENTINEL_SECRET: SecretBundle & { vaultCiphertext: string } = {
  password: SENTINELS.password,
  sshPassword: SENTINELS.sshPassword,
  privateKey: SENTINELS.privateKey,
  passphrase: SENTINELS.passphrase,
  // vaultCiphertext：Vault 落盘形态（见 §11.1 字段清单），同样不得外泄。
  vaultCiphertext: SENTINELS.vaultCiphertext,
};

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

/** §11.1 点名的敏感字段名（含 SecretBundle 类型名）。 */
const SECRET_FIELD_NAMES = [
  'password',
  'sshPassword',
  'privateKey',
  'passphrase',
  'vaultCiphertext',
  'userPassword',
  'SecretBundle',
] as const;

/**
 * 「原始 SHOW GRANTS 文本」的判据。
 *
 * 注意这里刻意**不**用裸 `SHOW GRANTS` 子串：报告里出现查询名是合法的
 * （`preflight-collect.ts` 在授权查询失败时把 `attempt` 记成
 * `SHOW GRANTS FOR CURRENT_USER()`，那是要试过什么，不是授权内容）。
 * §11.1 禁的是**授权语句本体**，所以这里匹配 privilege 语句的形态。
 * `\bGRANT\s+` 不会命中 `SHOW GRANTS FOR ...`（GRANT 后面跟的是 S 不是空白）。
 */
const GRANT_TEXT_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'GRANT <privilege>', re: /\bGRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|REFERENCES|FILE|PROCESS|RELOAD|SHUTDOWN|SUPER|REPLICATION|REPLICATION\s+CLIENT|REPLICATION\s+SLAVE)\b/i },
  { label: 'IDENTIFIED BY/WITH', re: /\bIDENTIFIED\s+(?:BY|WITH)\b/i },
  { label: 'ON *.*', re: /\bON\s+\*\.\*/i },
  { label: "授权目标 'user'@'host'", re: /\bTO\s+'[^']*'\s*@\s*'[^']*'/i },
];

/**
 * Markdown 产物里的固定保密声明（preflight.md / manifest-export.md 都要求这段文案）。
 *
 * 它**刻意**提到「passphrase / 私钥 / Vault 密文」这些词——那是保密承诺本身，不是泄漏。
 * 所以判字段名黑名单前先摘掉这两句固定文案，其余内容一律裸判。
 * JSON 产物不含这段文案，因此 JSON 直接裸判（见 assertArtifactClean 的 strip 参数）。
 */
const CONFIDENTIALITY_NOTES = [
  '本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）与未经裁定的行值。',
  '本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）；数据行值已脱敏。',
];

function stripConfidentialityNotes(content: string): string {
  return CONFIDENTIALITY_NOTES.reduce((acc, note) => acc.split(note).join(''), content);
}

/**
 * 对单个导出产物跑全部无秘密判据，一次性汇总违规项再断言。
 *
 * 汇总而非逐条 expect：一次失败就能看到**全部**泄漏点（哪个产物 / 字段名 / 哪个哨兵值），
 * 逐条断言只会报出第一个。
 */
function assertArtifactClean(
  content: string,
  label: string,
  opts?: { stripConfidentialityNote?: boolean },
): void {
  const wantsStrip = opts?.stripConfidentialityNote === true;
  const target = wantsStrip ? stripConfidentialityNotes(content) : content;
  const violations: string[] = [];
  // 非空转自证：要求摘除时就必须真的摘掉了东西。
  //
  // 本文件（与 e2e/specs/export-ui.spec.ts 各存一份）的 CONFIDENTIALITY_NOTES 是产品
  // src-core 里那两句固定文案的**副本**。产品改了文案而副本没跟上时，strip 命不中 →
  // 那句里的 `passphrase` 会被当成真实泄漏，报出一句完全误导的
  // 「导出物 X 泄漏：敏感字段名 passphrase」。这里先把「文案漂移」报成它自己的错误，
  // 失败信息直指真正的原因与修法。
  if (wantsStrip && target === content) {
    violations.push(
      '保密声明文案与产品不一致（stripConfidentialityNotes 未命中）——'
      + '请把 src-core/preflight.ts 与 src-core/manifest.ts 里的保密声明文案同步到 CONFIDENTIALITY_NOTES',
    );
  }
  const lower = target.toLowerCase();
  for (const name of SECRET_FIELD_NAMES) {
    if (lower.includes(name.toLowerCase())) violations.push(`敏感字段名 ${name}`);
  }
  for (const p of GRANT_TEXT_PATTERNS) {
    if (p.re.test(target)) violations.push(`授权文本「${p.label}」`);
  }
  for (const value of SENTINEL_VALUES) {
    if (target.includes(value)) violations.push(`凭据值 ${value}`);
  }
  expect(violations, `导出物 ${label} 泄漏：\n  - ${violations.join('\n  - ')}`).toEqual([]);
}

/** 递归收集对象图里的全部键名（用于「schema 不得长出凭据字段」的断言）。 */
function collectKeys(value: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectKeys(v, `${path}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(`${path}.${k}`);
      collectKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 夹具：一个「上游把整份节点 + 凭据一起递进来」的最坏情况输入
// ---------------------------------------------------------------------------

const NOW = '2026-10-05T12:00:00.000Z';

/**
 * 含哨兵凭据的节点（NodeMeta + secret）。ssh.authType='password' 是刻意留的：
 * 若实现改成对象展开（而非白名单逐字段挑选），它连同 5 个哨兵值一起进产物，本文件变红。
 */
function pollutedNode(): Record<string, unknown> {
  return {
    id: 'fake-node-b',
    alias: 'fake-B库',
    host: 'fake-db.invalid',
    port: 3306,
    user: 'fake-user',
    database: 'fake_shop',
    ssh: {
      enabled: true,
      host: 'fake-jump.invalid',
      port: 22,
      user: 'fake-user',
      authType: 'password',
    },
    createdAt: NOW,
    secret: SENTINEL_SECRET,
  };
}

function ddlItem(sql: string, id = 'd01'): DiffItem {
  return { id, objectType: 'table', objectName: 'orders', changeType: 'CHANGE', aspects: ['column'], risk: 'medium', sql };
}

/** 报告夹具：facts 覆盖 6 类 category，inferences 是可被 STATEMENT_RE 解析的形态。 */
function pollutedPreflightInput(): PreflightBuildInput {
  const base: PreflightBuildInput = {
    report: {
      facts: [
        { category: 'server', key: 'server.mysql_version', value: '8.0.46', source: 'select-version', observedAt: NOW },
        { category: 'server', key: 'server.read_only', value: 0, source: 'select-version', observedAt: NOW },
        { category: 'variables', key: 'variables.max_connections', value: 151, source: 'select-sysvars', observedAt: NOW },
        { category: 'table', key: 'table.orders.rows', value: 2_000_000, source: 'information-schema.tables', observedAt: NOW },
        { category: 'table', key: 'table.orders.data_length', value: 96_000_000, source: 'information-schema.tables', observedAt: NOW },
        { category: 'table', key: 'table.orders.index_length', value: 1_024_000, source: 'information-schema.tables', observedAt: NOW },
        { category: 'table', key: 'table.orders.primary_indexes', value: ['PRIMARY'], source: 'information-schema.statistics', observedAt: NOW },
        { category: 'index', key: 'index.orders.primary', value: ['id'], source: 'information-schema.statistics', observedAt: NOW },
        { category: 'ddl', key: 'ddl.count', value: 2, source: 'information-schema.tables', observedAt: NOW },
        { category: 'replication', key: 'replication.gtid_mode', value: 'ON', source: 'select-sysvars', observedAt: NOW },
        { category: 'replication', key: 'replication.seconds_behind_master', value: 0, source: 'show-replica-status', observedAt: NOW },
        // permissions 只承载结构化判定（§11.1：不带 privilege 语句 / 用户主机名）。
        { category: 'permissions', key: 'permissions.visibility', value: 'full', source: 'show-grants-for-current-user', observedAt: NOW },
        { category: 'permissions', key: 'permissions.reliable', value: true, source: 'show-grants-for-current-user', observedAt: NOW },
      ],
      inferences: [
        {
          category: 'ddl',
          subject: 'diff-item:d01',
          statement: 'd01: ADD_COLUMN on orders → INSTANT/SHARED',
          confidence: 'high',
          evidence: ['diff-item:d01.sql', 'server.mysql_version', 'table.orders'],
          ruleId: 'ONLINE_DDL_MATRIX',
        },
        {
          category: 'ddl',
          subject: 'diff-item:d02',
          statement: 'd02: ADD_INDEX on orders → INPLACE/SHARED',
          confidence: 'high',
          evidence: ['diff-item:d02.sql', 'server.mysql_version'],
          ruleId: 'ONLINE_DDL_MATRIX',
        },
      ],
      unknowns: [
        { category: 'ddl', subject: 'diff-item:d03', reason: 'unparsed-ddl', attempt: 'TRUNCATE TABLE `orders`', observedAt: NOW },
        { category: 'permissions', subject: 'permissions.reliable', reason: 'permission-denied', attempt: 'SHOW GRANTS FOR CURRENT_USER()', observedAt: NOW },
        { category: 'replication', subject: 'replication.status', reason: 'not-applicable', attempt: 'SHOW REPLICA STATUS（未启用复制）', observedAt: NOW },
      ],
    },
    items: [
      ddlItem('ALTER TABLE `orders` ADD COLUMN `note` VARCHAR(64) NULL;', 'd01'),
      ddlItem('ALTER TABLE `orders` ADD INDEX `idx_note` (`note`);', 'd02'),
      ddlItem('TRUNCATE TABLE `orders`', 'd03'),
    ],
    targetAlias: 'fake-B库',
    targetDatabase: 'fake_shop',
    appVersion: '0.1.0',
    checkedAt: NOW,
  };
  // 最坏情况：上游把整份节点 + 凭据 + 连接串一起递进来。契约要求输出仍是白名单投影。
  return {
    ...base,
    node: pollutedNode(),
    secret: SENTINEL_SECRET,
    connection: { host: 'fake-db.invalid', port: 3306, user: 'fake-user', password: SENTINELS.password },
  } as unknown as PreflightBuildInput;
}

function buildPollutedReport(): PreflightReport {
  return buildPreflightReport(pollutedPreflightInput());
}

/** JSON 产物的 label。用于区分「含保密声明的 Markdown」与「裸判的 JSON」。 */
const JSON_LABEL = 'serializePreflight (json)';

/** Preflight 的四种产物：写盘用的 3 种 + v1 兼容渲染（被 detail 文件内嵌，故一并覆盖）。 */
function preflightProducts(m: PreflightReport): Record<string, string> {
  return {
    [JSON_LABEL]: serializePreflight(m),
    'preflightToExecutiveMarkdown (结论 md)': preflightToExecutiveMarkdown(m),
    'preflightToDetailMarkdown (细节 md)': preflightToDetailMarkdown(m),
    'preflightToMarkdown (v1 兼容，detail 内嵌)': preflightToMarkdown(m),
  };
}

// ---------------------------------------------------------------------------
// Preflight 导出物无秘密
// ---------------------------------------------------------------------------

describe('§11.1 保密边界 · Preflight 四种导出物', () => {
  it('四种产物非空（确保后续断言不是打在空串上的永真）', () => {
    const products = preflightProducts(buildPollutedReport());
    for (const [label, content] of Object.entries(products)) {
      expect(content.length, `${label} 不应为空`).toBeGreaterThan(200);
    }
    // JSON 产物结构完整（不是空对象被序列化出来的 '{}'）。
    const parsed = JSON.parse(products['serializePreflight (json)']) as PreflightReport;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.source).toBe('real');
    expect(parsed.facts.length).toBeGreaterThan(0);
    expect(parsed.inferences.length).toBe(2);
  });

  it('四种产物都不含敏感字段名 / 授权语句 / 5 个哨兵凭据值', () => {
    const products = preflightProducts(buildPollutedReport());
    for (const [label, content] of Object.entries(products)) {
      // JSON 不含保密声明文案 → 裸判；Markdown 含那句固定承诺 → 摘掉后再判。
      //
      // 判据是「产物类型」而非 label 后缀：v1 的 label 结尾是「(v1 兼容，detail 内嵌)」
      // 而不是「md)」，用 endsWith 会漏掉它 → 保密声明里那个「passphrase」被当成泄漏。
      assertArtifactClean(content, label, { stripConfidentialityNote: label !== JSON_LABEL });
    }
  });

  it('报告对象图的键名里没有凭据字段（挡住「字段有值才进 JSON」这类盲区）', () => {
    // JSON.stringify 会丢掉 undefined 值，所以「值层」断言看不到一个值为 undefined 的
    // 新增凭据字段。键名层断言把这条路也堵上。
    const keys = collectKeys(buildPollutedReport());
    const offenders = keys.filter((k) =>
      SECRET_FIELD_NAMES.some((name) => k.toLowerCase().endsWith(`.${name.toLowerCase()}`)),
    );
    expect(offenders, `PreflightReport 键名含凭据字段：${offenders.join(', ')}`).toEqual([]);
  });

  it('保密声明本身存在（断言不是靠「产品里什么都没有」蒙混过关）', () => {
    const m = buildPollutedReport();
    expect(preflightToExecutiveMarkdown(m)).toContain('## 保密声明');
    expect(preflightToDetailMarkdown(m)).toContain('## 保密声明');
  });
});

// ---------------------------------------------------------------------------
// Manifest 导出物无秘密
// ---------------------------------------------------------------------------

/** data 项的 DML：字面值里塞 5 个哨兵值 + 数字，脱敏后必须变成 '***' / 0。 */
function pollutedDataItems(): DiffItem[] {
  return [
    {
      id: 'data:orders:0',
      objectType: 'data',
      objectName: 'orders',
      changeType: 'CREATE',
      dml: 'INSERT',
      aspects: ['data'],
      risk: 'medium',
      sql:
        `INSERT INTO \`orders\` (\`id\`, \`email\`, \`token\`, \`amount\`, \`note\`, \`created\`) VALUES `
        + `(1001, '${SENTINELS.password}', '${SENTINELS.sshPassword}', 4200.55, `
        + `'${SENTINELS.privateKey}', '${SENTINELS.passphrase}', '2026-10-05 09:00:00');`,
    },
    {
      id: 'data:orders:1',
      objectType: 'data',
      objectName: 'orders',
      changeType: 'DROP',
      dml: 'DELETE',
      aspects: ['data'],
      risk: 'medium',
      sql:
        `DELETE FROM \`orders\` WHERE \`id\` = 1002 AND \`vault\` = '${SENTINELS.vaultCiphertext}' AND \`amount\` = 88.8;`,
    },
  ];
}

function pollutedManifestInput(): ManifestBuildInput {
  const base: ManifestBuildInput = {
    result: {
      items: [
        ddlItem('ALTER TABLE `orders` ADD COLUMN `note` VARCHAR(64) NULL;', 'd01'),
        ...pollutedDataItems(),
      ],
      stats: { ALL: 3, CREATE: 1, DROP: 1, CHANGE: 1, INDEX: 0, DML: { INSERT: 1, DELETE: 1, UPDATE: 0 } },
      dataTables: [{ a: 'orders', b: 'orders', status: 'done' }],
      coverage: {
        ok: { table: 1, view: 1, procedure: 1, function: 1 },
        skipped: [{ name: 'secret_view', objectType: 'view', reason: 'permission-denied' }],
      },
      visibility: {
        reliable: true,
        compared: 4,
        excluded: [{ name: 'sp_secret', objectType: 'procedure', side: 'b-only', reason: 'grant-invisible' }],
      },
    },
    request: { aId: 'fake-node-a', bId: 'fake-node-b', scopes: ['table', 'view', 'data'], includeData: true },
    aAlias: 'fake-A库',
    bAlias: 'fake-B库',
    appVersion: '0.1.0',
  };
  return {
    ...base,
    result: { ...base.result, node: pollutedNode(), secret: SENTINEL_SECRET },
    request: { ...base.request, secret: SENTINEL_SECRET },
  } as unknown as ManifestBuildInput;
}

/** Manifest JSON 产物的 label（判据是「产物类型」而非 label 后缀，理由见 preflightProducts）。 */
const MANIFEST_JSON_LABEL = 'serializeManifest (json)';

function manifestProducts(): Record<string, string> {
  const m = buildManifest(pollutedManifestInput());
  return {
    [MANIFEST_JSON_LABEL]: serializeManifest(m),
    'manifestToMarkdown (md)': manifestToMarkdown(m),
  };
}

describe('§11.1 保密边界 · Manifest 导出物', () => {
  it('两种产物非空且结构完整', () => {
    const products = manifestProducts();
    expect(products['serializeManifest (json)'].length).toBeGreaterThan(200);
    const parsed = JSON.parse(products['serializeManifest (json)']) as {
      schemaVersion: number;
      source: string;
      items: unknown[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.source).toBe('real');
    expect(parsed.items.length).toBe(3);
  });

  it('两种产物都不含敏感字段名 / 授权语句 / 5 个哨兵凭据值', () => {
    for (const [label, content] of Object.entries(manifestProducts())) {
      assertArtifactClean(content, label, { stripConfidentialityNote: label !== MANIFEST_JSON_LABEL });
    }
  });

  it('data 项 DML 的字面值被脱敏（哨兵值 → \'***\'，数字 → 0）—— 值层断言的核心非空转证明', () => {
    // 这一条是 R2 的核心：如果 redactDmlSql 失效 / 被摘掉，哨兵值会直接出现在产物里，本条变红。
    const json = manifestProducts()['serializeManifest (json)'];
    expect(json).toContain("'***'");
    expect(json).not.toContain('4200.55');
    expect(json).not.toContain('88.8');
    // 脱敏只动字面值，不动语句骨架与标识符（契约而非依赖内部格式）。
    expect(json).toContain('INSERT INTO `orders`');
    expect(json).toContain('DELETE FROM `orders`');
  });

  it('DDL（table）项按契约原文保留 —— 这就是值层断言只对 data 项成立的原因', () => {
    // manifest-export.md §3：脱敏只作用于 objectType==='data' 的 DML，DDL 原样保留。
    // 因此「凭据值绝不出现在导出物」的可达面是 data 字面值 + 凭据字段，
    // 不是 DDL 自由文本——后者由「DDL 不携带连接信息」这一上游前提保证。
    // 显式钉住这条边界，避免下一个维护者往 DDL 文本里塞哨兵值后困惑于「为什么红了」。
    const m = buildManifest(pollutedManifestInput());
    expect(manifestToMarkdown(m)).toContain('ADD COLUMN `note`');
    expect(serializeManifest(m)).toContain('ADD COLUMN `note`');
  });

  it('manifest 对象图的键名里没有凭据字段', () => {
    const keys = collectKeys(buildManifest(pollutedManifestInput()));
    const offenders = keys.filter((k) =>
      SECRET_FIELD_NAMES.some((name) => k.toLowerCase().endsWith(`.${name.toLowerCase()}`)),
    );
    expect(offenders, `ReviewManifest 键名含凭据字段：${offenders.join(', ')}`).toEqual([]);
  });

  it('manifest.stats 的键集合被钉死（唯一的对象展开面不许长出凭据字段）', () => {
    // buildManifest 里 `stats: { ...result.stats, DML: { ... } }` 是全模块唯一的对象展开：
    // 给 result.stats 多挂一个键，它会原样进产物。所以这里把键集合钉死，而不是给 stats 注入哨兵
    // （那会造出一个生产上不存在的输入，并让本文件永久变红）。
    //
    // 顶层键就是输入的顶层键。`INSERT` / `DELETE` / `UPDATE` 住在 **DML 内层**，不是顶层——
    // 把它们平铺进期望集合会让本用例恒红，且掩盖真正的展开面变化。
    const m = buildManifest(pollutedManifestInput());
    expect(Object.keys(m.stats).sort()).toEqual(['ALL', 'CHANGE', 'CREATE', 'DML', 'DROP', 'INDEX']);

    // DML 内层被显式展开，键必须原样保留（不能被清空或改名）。
    expect(Object.keys(m.stats.DML as object).sort()).toEqual(['DELETE', 'INSERT', 'UPDATE']);
  });

  it('stats 展开面不多不少：产物 stats 的顶层键集合恒等于输入', () => {
    // 与上面「钉死键集合」互补：上面锁具体集合，这里锁「不多不少」这个性质本身。
    const input = pollutedManifestInput();
    const m = buildManifest(input);
    expect(Object.keys(m.stats).sort()).toEqual(Object.keys(input.result.stats).sort());
  });
});

// ---------------------------------------------------------------------------
// preflightFileNames · 3 文件名契约（AC3 / R3）
// ---------------------------------------------------------------------------

describe('preflightFileNames · 3 文件名契约', () => {
  it('返回恰好 3 个键（防回退成 2 份而 spec 与测试都没察觉）', () => {
    const names = preflightFileNames(NOW);
    expect(Object.keys(names).sort()).toEqual([
      'detailMarkdownFileName',
      'jsonFileName',
      'markdownFileName',
    ]);
  });

  it('三个文件名各自正确：.json / 结论 .md / 细节 -detail.md', () => {
    const safe = '2026-10-05T12-00-00-000Z';
    expect(preflightFileNames(NOW)).toEqual({
      jsonFileName: `sqldiff-preflight-${safe}.json`,
      markdownFileName: `sqldiff-preflight-${safe}.md`,
      detailMarkdownFileName: `sqldiff-preflight-${safe}-detail.md`,
    });
  });

  it('checkedAt 的 : 与 . 全部替换为 -（Windows 文件名兼容）', () => {
    const names = preflightFileNames('2026-10-05T12:34:56.789Z');
    // 判据只针对**时间戳部分**（safe 前缀）：扩展名 `.json` / `.md` 本来就带点，
    // 对整个文件名断言 not.toContain('.') 会必然失败——那是错断言，不是契约。
    for (const [key, name] of Object.entries(names)) {
      const prefix = name.replace(/\.json$|\.md$/, '');
      expect(prefix, `${key} 的时间戳部分不该有冒号`).not.toContain(':');
      expect(prefix, `${key} 的时间戳部分不该有点`).not.toContain('.');
      expect(prefix, `${key} 应含替换后的时间戳`).toContain('2026-10-05T12-34-56-789Z');
    }
  });

  it('三个文件名共享同一 safe 前缀且互不相同（写盘时不会互相覆盖）', () => {
    const names = preflightFileNames(NOW);
    const values = Object.values(names);
    expect(new Set(values).size).toBe(3);
    for (const name of values) {
      expect(name.startsWith('sqldiff-preflight-2026-10-05T12-00-00-000Z')).toBe(true);
    }
  });

  it('三个文件名与产物内容一一对应：结论 md 链向细节 md、细节 md 链回结论 md', () => {
    // 与 handleExportPreflight（App.tsx）一次 saveTextFiles 写 3 份的行为对齐：
    // 两个渲染器都靠 preflightFileNames 生成互链，文件名对不上就是断链。
    const m = buildPollutedReport();
    const names = preflightFileNames(m.checkedAt);
    expect(preflightToExecutiveMarkdown(m)).toContain(`./${names.detailMarkdownFileName}`);
    expect(preflightToDetailMarkdown(m)).toContain(`./${names.markdownFileName}`);
  });
});

// ---------------------------------------------------------------------------
// SecretBundle 类型层的边界（防止有人把 secret 挂进共享类型）
// ---------------------------------------------------------------------------

describe('凭据类型边界', () => {
  it('字段名黑名单覆盖全部哨兵字段（加哨兵必须同时加黑名单）', () => {
    // 真实类型事实（types.ts:70）：`SecretBundle` 只有 **4** 个凭据字段
    // —— password / sshPassword / privateKey / passphrase。
    // `vaultCiphertext` 是 §11.1 点名的 Vault 落盘形态，**不是** SecretBundle 的字段，
    // 所以本文件的哨兵集合（5 个）比 SecretBundle（4 个）多一个；两者的并集才是
    // 「可能承载凭据的字段名全集」。
    //
    // 这里钉的是那个并集与黑名单的关系：若有人新增第 6 个凭据字段却忘了加进
    // SECRET_FIELD_NAMES，字段名层断言会对它**静默失明**（值层还能兜住，但字段名层退化）。
    //
    // 注意这里刻意**不**用 `Object.keys({} as SecretBundle).length === 0` 那类写法：
    // 那是空对象字面量的键数恒为 0，与 SecretBundle 的字段数无关——是永真断言，
    // 却披着「钉住字段清单」的外衣。
    const sentinelKeys = Object.keys(SENTINEL_SECRET);
    const uncovered = sentinelKeys.filter(
      (k) => !(SECRET_FIELD_NAMES as readonly string[]).includes(k),
    );
    expect(uncovered, `哨兵字段未进黑名单：${uncovered.join(', ')}`).toEqual([]);
  });
});
