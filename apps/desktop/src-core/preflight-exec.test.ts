// 生产 Preflight v2 · 结论式渲染单测。
//
// 覆盖 parseInferenceStatement 三种典型 statement / deriveDecision 三态 /
// groupDdlByRisk 分组 / buildTableHeatmap 风险判定 / preflightToExecutiveMarkdown
// 输出结构 + 详情链接 / preflightToDetailMarkdown 完整 5 段 / 空数据不抛错。

import { describe, expect, it } from 'vitest';
import {
  buildDeveloperView,
  buildOpsView,
  buildTableHeatmap,
  deriveDecision,
  fmtRows,
  fmtSize,
  groupDdlByRisk,
  parseInferenceStatement,
  preflightFileNames,
  preflightToDetailMarkdown,
  preflightToExecutiveMarkdown,
} from './preflight';
import type {
  PreflightFact,
  PreflightInference,
  PreflightIssue,
  PreflightReport,
  PreflightUnknown,
} from './preflight-types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const NOW = '2026-01-01T00:00:00.000Z';

function fact(overrides: Partial<PreflightFact> = {}): PreflightFact {
  return {
    category: 'server',
    key: 'server.mysql_version',
    value: '8.0.36',
    source: 'select-version',
    observedAt: NOW,
    ...overrides,
  };
}

function inference(overrides: Partial<PreflightInference> = {}): PreflightInference {
  return {
    category: 'ddl',
    subject: 'diff-item:d1',
    statement: 'd1: ADD_COLUMN on orders → INSTANT/SHARED',
    confidence: 'high',
    evidence: ['server.mysql_version', 'table.orders'],
    ruleId: 'ONLINE_DDL_MATRIX',
    ...overrides,
  };
}

function unknown(overrides: Partial<PreflightUnknown> = {}): PreflightUnknown {
  return {
    category: 'ddl',
    subject: 'diff-item:d11',
    reason: 'unparsed-ddl',
    attempt: 'ALTER TABLE t ADD PARTITION ...',
    observedAt: NOW,
    ...overrides,
  };
}

function issue(overrides: Partial<PreflightIssue> = {}): PreflightIssue {
  return {
    id: 'BIG_TABLE_COPY:table.orders',
    severity: 'block',
    title: '表 orders 变更将重建表',
    detail: 'TABLE_ROWS=2000000',
    related: ['table.orders.rows'],
    recommendation: '考虑低峰发布',
    ...overrides,
  };
}

function buildReport(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    schemaVersion: 1,
    appVersion: '0.1.0',
    checkedAt: NOW,
    targetAlias: 'B库',
    targetDatabase: 'app_db',
    source: 'real',
    facts: [],
    inferences: [],
    unknowns: [],
    issues: [],
    verdict: { level: 'pass', blocking: 0, warnings: 0, unknowns: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseInferenceStatement
// ---------------------------------------------------------------------------

describe('parseInferenceStatement', () => {
  it('解析 INSTANT/SHARED（ADD_COLUMN 追加列，无 rebuild）', () => {
    const stmt = parseInferenceStatement('d01: ADD_COLUMN on users_big → INSTANT/SHARED');
    expect(stmt).toEqual({
      op: 'ADD_COLUMN',
      tableName: 'users_big',
      algorithm: 'INSTANT',
      lockMode: 'SHARED',
      rebuilds: false,
    });
  });

  it('解析 INPLACE/EXCLUSIVE（ADD_PRIMARY_KEY 排他锁 + rebuild）', () => {
    const stmt = parseInferenceStatement('d06: ADD_PRIMARY_KEY on t → INPLACE/EXCLUSIVE (rebuild)');
    expect(stmt).toEqual({
      op: 'ADD_PRIMARY_KEY',
      tableName: 't',
      algorithm: 'INPLACE',
      lockMode: 'EXCLUSIVE',
      rebuilds: true,
    });
  });

  it('解析 INPLACE/SHARED + (rebuild) 后缀（MODIFY_COLUMN 重建表）', () => {
    const stmt = parseInferenceStatement('d08: MODIFY_COLUMN on slow_log → INPLACE/SHARED (rebuild)');
    expect(stmt).toEqual({
      op: 'MODIFY_COLUMN',
      tableName: 'slow_log',
      algorithm: 'INPLACE',
      lockMode: 'SHARED',
      rebuilds: true,
    });
  });

  it('tableName 为占位符 ? 时返回 null', () => {
    const stmt = parseInferenceStatement('d01: ADD_COLUMN on ? → INSTANT/SHARED');
    expect(stmt.tableName).toBeNull();
  });

  it('无法解析时返回全空结构', () => {
    const stmt = parseInferenceStatement('任意文本');
    expect(stmt).toEqual({
      op: '',
      tableName: null,
      algorithm: null,
      lockMode: null,
      rebuilds: false,
    });
  });

  it('EXCLUSIVE-BRIEF 锁模式被识别（CREATE_TABLE）', () => {
    const stmt = parseInferenceStatement('d02: CREATE_TABLE on users → INPLACE/EXCLUSIVE-BRIEF');
    expect(stmt.lockMode).toBe('EXCLUSIVE-BRIEF');
    expect(stmt.algorithm).toBe('INPLACE');
    expect(stmt.rebuilds).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fmtRows / fmtSize
// ---------------------------------------------------------------------------

describe('fmtRows', () => {
  it('null 与 NaN 返回 "?"', () => {
    expect(fmtRows(null)).toBe('?');
    expect(fmtRows(NaN)).toBe('?');
  });

  it('1 百万 → "1.0 M"', () => {
    expect(fmtRows(1_000_000)).toBe('1.0 M');
  });

  it('1234567 → "1.2 M"', () => {
    expect(fmtRows(1_234_567)).toBe('1.2 M');
  });

  it('891 000 → "891 K"', () => {
    expect(fmtRows(891_000)).toBe('891 K');
  });

  it('小数值原样输出', () => {
    expect(fmtRows(0)).toBe('0');
    expect(fmtRows(500)).toBe('500');
  });
});

describe('fmtSize', () => {
  it('null 返回 "?"', () => {
    expect(fmtSize(null)).toBe('?');
  });

  it('1 GiB → "1.0 GiB"', () => {
    expect(fmtSize(1024 * 1024 * 1024)).toBe('1.0 GiB');
  });

  it('46 MiB → "46.7 MiB"', () => {
    expect(fmtSize(48_949_094)).toBe('46.7 MiB');
  });

  it('16 KiB → "16 KiB"', () => {
    expect(fmtSize(16 * 1024)).toBe('16 KiB');
  });

  it('小值原样输出', () => {
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(500)).toBe('500 B');
  });
});

// ---------------------------------------------------------------------------
// deriveDecision
// ---------------------------------------------------------------------------

describe('deriveDecision', () => {
  it('BLOCK：有 severity=block 的 issue → level=BLOCK', () => {
    const r = buildReport({
      issues: [issue({ severity: 'block' })],
      verdict: { level: 'block', blocking: 1, warnings: 0, unknowns: 0 },
    });
    const d = deriveDecision(r);
    expect(d.level).toBe('BLOCK');
    expect(d.message).toContain('不能发布');
  });

  it('DEGRADED：有 INPLACE/EXCLUSIVE inference 且无 block → level=DEGRADED', () => {
    const r = buildReport({
      inferences: [inference({
        subject: 'diff-item:d06',
        statement: 'd06: ADD_PRIMARY_KEY on t → INPLACE/EXCLUSIVE (rebuild)',
      })],
    });
    const d = deriveDecision(r);
    expect(d.level).toBe('DEGRADED');
    expect(d.message).toContain('可发布但需排期');
  });

  it('DEGRADED：有 REPLICA_LAG issue → level=DEGRADED', () => {
    const r = buildReport({
      issues: [issue({ id: 'REPLICA_LAG:replication', severity: 'warn', title: '复制延迟偏高' })],
    });
    const d = deriveDecision(r);
    expect(d.level).toBe('DEGRADED');
  });

  it('GO：全 INSTANT 且无 block → level=GO', () => {
    const r = buildReport({
      inferences: [inference({
        statement: 'd01: ADD_COLUMN on t → INSTANT/SHARED',
      })],
    });
    const d = deriveDecision(r);
    expect(d.level).toBe('GO');
    expect(d.message).toContain('可发布');
  });

  it('BLOCK 优先于 DEGRADED（同时有 block issue 与 EXCLUSIVE inference）', () => {
    const r = buildReport({
      inferences: [inference({
        statement: 'd06: ADD_PRIMARY_KEY on t → INPLACE/EXCLUSIVE (rebuild)',
      })],
      issues: [issue({ severity: 'block' })],
    });
    expect(deriveDecision(r).level).toBe('BLOCK');
  });

  it('空报告 → level=GO', () => {
    expect(deriveDecision(buildReport()).level).toBe('GO');
  });
});

// ---------------------------------------------------------------------------
// groupDdlByRisk
// ---------------------------------------------------------------------------

describe('groupDdlByRisk', () => {
  it('三档分组：INSTANT / EXCLUSIVE / INPLACE SHARED', () => {
    const infs = [
      inference({ statement: 'd01: ADD_COLUMN on t → INSTANT/SHARED' }),
      inference({ subject: 'diff-item:d06', statement: 'd06: ADD_PRIMARY_KEY on t → INPLACE/EXCLUSIVE (rebuild)' }),
      inference({ subject: 'diff-item:d07', statement: 'd07: MODIFY_COLUMN on t → INPLACE/SHARED (rebuild)' }),
      inference({ subject: 'diff-item:d03', statement: 'd03: ADD_INDEX on t → INPLACE/SHARED' }),
    ];
    const g = groupDdlByRisk(infs);
    expect(g.instant.length).toBe(1);
    expect(g.instant[0].stmt.op).toBe('ADD_COLUMN');
    expect(g.exclusive.length).toBe(1);
    expect(g.exclusive[0].stmt.op).toBe('ADD_PRIMARY_KEY');
    expect(g.exclusive[0].stmt.rebuilds).toBe(true);
    expect(g.inplaceShared.length).toBe(2);
  });

  it('空输入返回三个空数组', () => {
    const g = groupDdlByRisk([]);
    expect(g.exclusive).toEqual([]);
    expect(g.inplaceShared).toEqual([]);
    expect(g.instant).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildTableHeatmap
// ---------------------------------------------------------------------------

describe('buildTableHeatmap', () => {
  it('无 PK 表 → block；有 PK 且大表 → warn；其他 → safe', () => {
    const facts = [
      fact({ category: 'table', key: 'table.orders.rows', value: 2_000_000 }),
      fact({ category: 'table', key: 'table.orders.primary_indexes', value: ['PRIMARY'] }),
      fact({ category: 'table', key: 'table.orders.data_length', value: 50_000_000 }),
      fact({ category: 'table', key: 'table.orders.index_length', value: 10_000_000 }),
      fact({ category: 'table', key: 'table.no_pk.rows', value: 100 }),
      fact({ category: 'table', key: 'table.no_pk.primary_indexes', value: [] }),
      fact({ category: 'table', key: 'table.tiny.rows', value: 10 }),
      fact({ category: 'table', key: 'table.tiny.primary_indexes', value: ['PRIMARY'] }),
    ];
    const infs = [inference({ statement: 'd01: ADD_COLUMN on orders → INSTANT/SHARED' })];
    const rows = buildTableHeatmap(facts, infs);
    // 按 rows 降序：orders (2M) → no_pk (100) → tiny (10)
    expect(rows.map((r) => r.name)).toEqual(['orders', 'no_pk', 'tiny']);
    expect(rows[0].risk).toBe('warn');       // 有 PK 但大表
    expect(rows[0].hasPk).toBe(true);
    expect(rows[0].rows).toBe(2_000_000);
    expect(rows[0].size).toBe(60_000_000);
    expect(rows[0].ddlCount).toBe(1);
    expect(rows[1].risk).toBe('block');      // 无 PK
    expect(rows[1].hasPk).toBe(false);
    expect(rows[2].risk).toBe('safe');       // 有 PK 且小
  });

  it('空 facts 返回空数组', () => {
    expect(buildTableHeatmap([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDeveloperView / buildOpsView
// ---------------------------------------------------------------------------

describe('buildDeveloperView', () => {
  it('totalDdl = inferences + unparsed unknowns；opDistribution 计数正确', () => {
    const r = buildReport({
      inferences: [
        inference({ statement: 'd01: ADD_COLUMN on t → INSTANT/SHARED' }),
        inference({ subject: 'diff-item:d02', statement: 'd02: DROP_COLUMN on t → INPLACE/SHARED (rebuild)' }),
      ],
      unknowns: [unknown({ subject: 'diff-item:d11' })],
    });
    const dev = buildDeveloperView(r);
    expect(dev.totalDdl).toBe(3);
    expect(dev.classifiedCount).toBe(2);
    expect(dev.classifiedPct).toBe(67);
    expect(dev.opDistribution).toEqual({ ADD_COLUMN: 1, DROP_COLUMN: 1 });
    expect(dev.unparsed.length).toBe(1);
    expect(dev.tableIssues).toEqual([]);
  });

  it('空报告不抛错，classifiedPct=100（默认全可识别）', () => {
    const dev = buildDeveloperView(buildReport());
    expect(dev.totalDdl).toBe(0);
    expect(dev.classifiedCount).toBe(0);
    expect(dev.classifiedPct).toBe(100);
    expect(dev.opDistribution).toEqual({});
  });
});

describe('buildOpsView', () => {
  it('envStatus 至少含 4 项：read_only / replica_lag / gtid_mode / permissions', () => {
    const r = buildReport({
      facts: [
        fact({ key: 'server.mysql_version', value: '8.0.36' }),
        fact({ key: 'server.read_only', value: 0 }),
        fact({ category: 'replication', key: 'replication.seconds_behind_master', value: 45 }),
        fact({ category: 'replication', key: 'replication.gtid_mode', value: 'ON' }),
        fact({ category: 'permissions', key: 'permissions.visibility', value: 'full' }),
        fact({ category: 'permissions', key: 'permissions.reliable', value: true }),
      ],
    });
    const ops = buildOpsView(r);
    const keys = ops.envStatus.map((e) => e.key);
    expect(keys).toContain('server.mysql_version');
    expect(keys).toContain('server.read_only');
    expect(keys).toContain('replication.seconds_behind_master');
    expect(keys).toContain('replication.gtid_mode');
    expect(keys).toContain('permissions.visibility');
    // 状态判定
    const readOnly = ops.envStatus.find((e) => e.key === 'server.read_only');
    expect(readOnly?.status).toBe('ok');
    const lag = ops.envStatus.find((e) => e.key === 'replication.seconds_behind_master');
    expect(lag?.status).toBe('warn');
    expect(lag?.value).toBe('45s');
    const vis = ops.envStatus.find((e) => e.key === 'permissions.visibility');
    expect(vis?.status).toBe('ok');
  });

  it('read_only=1 → block 状态', () => {
    const r = buildReport({
      facts: [fact({ key: 'server.read_only', value: 1 })],
    });
    const ops = buildOpsView(r);
    const ro = ops.envStatus.find((e) => e.key === 'server.read_only');
    expect(ro?.status).toBe('block');
    expect(ro?.value).toBe('ON');
  });
});

// ---------------------------------------------------------------------------
// preflightToExecutiveMarkdown
// ---------------------------------------------------------------------------

describe('preflightToExecutiveMarkdown', () => {
  it('含一级标题 + 决策段 + 双视角段 + 详情链接 + 保密声明', () => {
    const r = buildReport({
      inferences: [inference({ statement: 'd01: ADD_COLUMN on t → INSTANT/SHARED' })],
      facts: [fact({ key: 'server.mysql_version', value: '8.0.36' })],
    });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('# Preflight Executive Summary');
    expect(md).toContain('## 决策 ·');
    expect(md).toContain('## 开发视角');
    expect(md).toContain('## 运维视角');
    expect(md).toContain('## 详情');
    expect(md).toContain('## 保密声明');
    expect(md).toContain('-detail.md');
    expect(md).toContain('完整原始数据');
  });

  it('决策 = BLOCK 时含 🔴 图标与不能发布文案', () => {
    const r = buildReport({
      issues: [issue({ severity: 'block' })],
      verdict: { level: 'block', blocking: 1, warnings: 0, unknowns: 0 },
    });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('🔴 BLOCK');
    expect(md).toContain('不能发布');
  });

  it('决策 = GO 时含 🟢 图标与可发布文案', () => {
    const r = buildReport({});
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('🟢 GO');
    expect(md).toContain('可发布');
  });

  it('开发视角含分类统计 + 分布', () => {
    const r = buildReport({
      inferences: [
        inference({ statement: 'd01: ADD_COLUMN on t → INSTANT/SHARED' }),
        inference({ subject: 'diff-item:d02', statement: 'd02: DROP_COLUMN on t → INPLACE/SHARED (rebuild)' }),
      ],
    });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('共 2 条 DDL');
    expect(md).toContain('ADD_COLUMN:1, DROP_COLUMN:1');
  });

  it('Unparsed DDL 表列出 subject 与 reason', () => {
    const r = buildReport({
      unknowns: [unknown({ subject: 'diff-item:d11', attempt: 'ALTER TABLE t ADD PARTITION ...' })],
    });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('Unparsed DDL（1 条）');
    expect(md).toContain('diff-item:d11');
    expect(md).toContain('unparsed-ddl');
  });

  it('无 unparsed 时显示"全部可识别"', () => {
    const r = buildReport({ inferences: [inference()] });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('全部可识别');
  });

  it('运维视角含 DDL 分组 + 表风险热图 + 环境状态表', () => {
    const r = buildReport({
      facts: [
        fact({ category: 'table', key: 'table.orders.rows', value: 1_500_000 }),
        fact({ category: 'table', key: 'table.orders.primary_indexes', value: ['PRIMARY'] }),
        fact({ category: 'table', key: 'table.orders.data_length', value: 100 }),
        fact({ category: 'table', key: 'table.orders.index_length', value: 50 }),
        fact({ key: 'server.read_only', value: 0 }),
      ],
      inferences: [
        inference({ subject: 'diff-item:d06', statement: 'd06: ADD_PRIMARY_KEY on orders → INPLACE/EXCLUSIVE (rebuild)' }),
        inference({ subject: 'diff-item:d01', statement: 'd01: ADD_COLUMN on orders → INSTANT/SHARED' }),
      ],
    });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('DDL 分组');
    expect(md).toContain('🔴 EXCLUSIVE');
    expect(md).toContain('🟡 INPLACE');
    expect(md).toContain('🟢 INSTANT');
    expect(md).toContain('表风险热图');
    expect(md).toContain('orders');
    expect(md).toContain('环境状态');
  });

  it('底部含 detail 文件相对链接', () => {
    const r = buildReport({});
    const md = preflightToExecutiveMarkdown(r);
    const expected = preflightFileNames(NOW).detailMarkdownFileName;
    expect(md).toContain(`./${expected}`);
  });

  it('空报告不抛错，各段显示占位而非表格', () => {
    const md = preflightToExecutiveMarkdown(buildReport());
    expect(md).toContain('共 0 条 DDL');
    expect(md).toContain('全部可识别');
    expect(md).toContain('无。');
  });

  it('LARGE_TABLE_INSTANT_ADD 建议动作包含 INSTANT 加速提示', () => {
    const r = buildReport({
      issues: [issue({
        id: 'LARGE_TABLE_INSTANT_ADD:diff-item:d01',
        severity: 'warn',
        title: '大表 ADD_COLUMN 可用 INSTANT 加速',
      })],
    });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('ALGORITHM=INSTANT 加速');
  });
});

// ---------------------------------------------------------------------------
// preflightToDetailMarkdown
// ---------------------------------------------------------------------------

describe('preflightToDetailMarkdown', () => {
  it('含 Detail Report 一级标题 + 返回链接', () => {
    const r = buildReport({
      facts: [fact()],
      inferences: [inference()],
      unknowns: [unknown()],
      issues: [issue()],
    });
    const md = preflightToDetailMarkdown(r);
    expect(md).toContain('# Preflight Detail Report');
    expect(md).toContain('← [返回结论]');
    const expected = preflightFileNames(NOW).markdownFileName;
    expect(md).toContain(`./${expected}`);
  });

  it('保留完整 5 段结构（Facts / Inferences / Unknowns / Issues / Verdict）', () => {
    const r = buildReport({
      facts: [fact()],
      inferences: [inference()],
      unknowns: [unknown()],
      issues: [issue()],
    });
    const md = preflightToDetailMarkdown(r);
    expect(md).toContain('## Facts');
    expect(md).toContain('## Inferences');
    expect(md).toContain('## Unknowns');
    expect(md).toContain('## Issues');
    expect(md).toContain('## Verdict');
    expect(md).toContain('### Facts · server');
    expect(md).toContain('Evidence');
    expect(md).toContain('Reason');
  });

  it('不再出现旧的一级标题 "# Preflight Report"', () => {
    const r = buildReport({});
    const md = preflightToDetailMarkdown(r);
    expect(md).not.toMatch(/^# Preflight Report/m);
  });

  it('空报告不抛错，各段输出占位', () => {
    const md = preflightToDetailMarkdown(buildReport());
    expect(md).toContain('_（无事实）_');
    expect(md).toContain('_（无推断）_');
    expect(md).toContain('_（无未知）_');
    expect(md).toContain('_（无高危规则触发）_');
  });

  it('保密声明保留', () => {
    const md = preflightToDetailMarkdown(buildReport());
    expect(md).toContain('保密声明');
    expect(md).toContain('不含连接凭据');
  });
});

// ---------------------------------------------------------------------------
// preflightFileNames（v2 扩展）
// ---------------------------------------------------------------------------

describe('preflightFileNames', () => {
  it('返回三个文件名：json + markdown + detail markdown', () => {
    const names = preflightFileNames(NOW);
    expect(names.jsonFileName).toBe('sqldiff-preflight-2026-01-01T00-00-00-000Z.json');
    expect(names.markdownFileName).toBe('sqldiff-preflight-2026-01-01T00-00-00-000Z.md');
    expect(names.detailMarkdownFileName).toBe('sqldiff-preflight-2026-01-01T00-00-00-000Z-detail.md');
  });

  it('三个文件名时间戳前缀一致', () => {
    const names = preflightFileNames(NOW);
    const ts = '2026-01-01T00-00-00-000Z';
    expect(names.jsonFileName).toContain(ts);
    expect(names.markdownFileName).toContain(ts);
    expect(names.detailMarkdownFileName).toContain(ts);
  });
});
