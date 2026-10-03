// 生产 Preflight v1 · 报告构建单测。
//
// 覆盖 deriveVerdict 全分支 / buildPreflightReport 字段顺序与稳定性 /
// serializePreflight byte 稳定 / preflightToMarkdown 全部区块 / preflightFileNames。

import { describe, expect, it } from 'vitest';
import type { DiffItem } from './types';
import {
  buildPreflightReport,
  deriveVerdict,
  preflightFileNames,
  preflightToMarkdown,
  serializePreflight,
  type PreflightBuildInput,
} from './preflight';
import { PREFLIGHT_REPORT_VERSION } from './preflight-types';
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
    statement: 'ADD_COLUMN @ 8.0.12 → INSTANT',
    confidence: 'high',
    evidence: ['server.mysql_version'],
    ruleId: 'INSTANT_ALGORITHM',
    ...overrides,
  };
}

function unknown(overrides: Partial<PreflightUnknown> = {}): PreflightUnknown {
  return {
    category: 'replication',
    subject: 'replication.status',
    reason: 'not-applicable',
    attempt: "SHOW REPLICA STATUS（未启用复制）",
    observedAt: NOW,
    ...overrides,
  };
}

function issue(overrides: Partial<PreflightIssue> = {}): PreflightIssue {
  return {
    id: 'BIG_TABLE_COPY:table.orders',
    severity: 'block',
    title: '表 orders 变更将重建表',
    detail: 'TABLE_ROWS=2000000 超过阈值 1000000',
    related: ['table.orders.rows'],
    recommendation: '考虑使用在线迁移工具',
    ...overrides,
  };
}

function ddlItem(sql: string, id = 'd1'): DiffItem {
  return {
    id,
    objectType: 'table',
    objectName: 't',
    changeType: 'CHANGE',
    aspects: ['column'],
    risk: 'medium',
    sql,
  };
}

function buildInput(overrides: Partial<PreflightBuildInput> = {}): PreflightBuildInput {
  return {
    report: { facts: [], inferences: [], unknowns: [] },
    items: [],
    targetAlias: 'B库',
    targetDatabase: 'app_db',
    appVersion: '0.1.0',
    ...overrides,
  };
}

function emptyReport(): PreflightReport {
  return buildPreflightReport(buildInput({ checkedAt: NOW }));
}

// ---------------------------------------------------------------------------
// deriveVerdict · 全分支
// ---------------------------------------------------------------------------

describe('deriveVerdict', () => {
  it('无 issues / unknowns → pass，全部计数为 0', () => {
    expect(deriveVerdict([], [])).toEqual({
      level: 'pass',
      blocking: 0,
      warnings: 0,
      unknowns: 0,
    });
  });

  it('有 block issue → level=block', () => {
    const issues = [issue({ severity: 'block' })];
    expect(deriveVerdict(issues, []).level).toBe('block');
  });

  it('只有 warn issue → level=warn', () => {
    const issues = [issue({ severity: 'warn' })];
    expect(deriveVerdict(issues, [])).toEqual({
      level: 'warn',
      blocking: 0,
      warnings: 1,
      unknowns: 0,
    });
  });

  it('只有 unknown（无 issues）→ level=unknown', () => {
    const unknowns = [unknown()];
    expect(deriveVerdict([], unknowns)).toEqual({
      level: 'unknown',
      blocking: 0,
      warnings: 0,
      unknowns: 1,
    });
  });

  it('混合：block + warn + unknown → level 取最高优先级 block', () => {
    const issues = [
      issue({ severity: 'block' }),
      issue({ id: 'X', severity: 'warn' }),
    ];
    const unknowns = [unknown()];
    expect(deriveVerdict(issues, unknowns).level).toBe('block');
  });

  it('混合 warn + unknown（无 block）→ level 取 warn', () => {
    const issues = [issue({ severity: 'warn' })];
    const unknowns = [unknown()];
    expect(deriveVerdict(issues, unknowns).level).toBe('warn');
  });

  it('计数：3 block + 2 warn + 5 unknown → 对应计数准确', () => {
    const issues = [
      issue({ id: 'A', severity: 'block' }),
      issue({ id: 'B', severity: 'block' }),
      issue({ id: 'C', severity: 'block' }),
      issue({ id: 'D', severity: 'warn' }),
      issue({ id: 'E', severity: 'warn' }),
    ];
    const unknowns = [unknown(), unknown(), unknown(), unknown(), unknown()];
    expect(deriveVerdict(issues, unknowns)).toEqual({
      level: 'block',
      blocking: 3,
      warnings: 2,
      unknowns: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// buildPreflightReport · 字段顺序 + checkedAt + source
// ---------------------------------------------------------------------------

describe('buildPreflightReport', () => {
  const EXPECTED_KEYS = [
    'schemaVersion',
    'appVersion',
    'checkedAt',
    'targetAlias',
    'targetDatabase',
    'source',
    'facts',
    'inferences',
    'unknowns',
    'issues',
    'verdict',
  ] as const;

  it('字段顺序严格等于 PreflightReport 类型声明顺序', () => {
    const r = emptyReport();
    expect(Object.keys(r)).toEqual([...EXPECTED_KEYS]);
  });

  it('schemaVersion 恒等于 PREFLIGHT_REPORT_VERSION', () => {
    expect(emptyReport().schemaVersion).toBe(PREFLIGHT_REPORT_VERSION);
  });

  it('source 恒为 "real"（Preflight 无 demo 分支）', () => {
    expect(emptyReport().source).toBe('real');
  });

  it('checkedAt 从 input 传入时使用传入值（byte 稳定）', () => {
    const r = buildPreflightReport(buildInput({ checkedAt: NOW }));
    expect(r.checkedAt).toBe(NOW);
  });

  it('checkedAt 未传入时使用当前时间（ISO 字符串）', () => {
    const r = buildPreflightReport(buildInput());
    // ISO 字符串格式（UTC，含 T 与 Z）
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('传入 facts / inferences / unknowns / items 被原样携带；evaluateRules 产出 issues', () => {
    const r = buildPreflightReport(
      buildInput({
        checkedAt: NOW,
        report: {
          facts: [fact()],
          inferences: [inference()],
          unknowns: [unknown()],
        },
        items: [ddlItem('ALTER TABLE orders ADD UNIQUE INDEX u (col)')],
      }),
    );
    expect(r.facts).toEqual([fact()]);
    expect(r.inferences).toEqual([inference()]);
    expect(r.unknowns).toEqual([unknown()]);
    // items 中一条 ADD UNIQUE INDEX 在 8.0.36 上 → lookupOnlineDdl rebuildsTable=true，
    // 但没有 table.orders.rows fact → ruleBigTableCopy 不触发；因此 issues 可能为空。
    // 本用例只验证 items 不进入报告顶层字段（issues 由规则计算得出）。
    expect(r.issues).toBeDefined();
    expect(Array.isArray(r.issues)).toBe(true);
  });

  it('阈值覆盖：传入 thresholds 生效', () => {
    // 大表规则阈值调到 999999：ADD UNIQUE INDEX 大表也不再触发（因为 rows=2_000_000 < 999999 且
    // ruleBigTableCopy 需要 rows > thresholds.bigTableRows）
    const r = buildPreflightReport(
      buildInput({
        checkedAt: NOW,
        report: {
          facts: [
            fact(),
            fact({ category: 'table', key: 'table.orders.rows', value: 2_000_000 }),
          ],
          inferences: [],
          unknowns: [],
        },
        items: [ddlItem('ALTER TABLE orders ADD UNIQUE INDEX u (col)')],
        thresholds: { bigTableRows: 999_999, replicaLagSeconds: 30 },
      }),
    );
    // ruleBigTableCopy 需要 rows > threshold，此处 rows=2_000_000 > 999_999 → 触发
    // 但同时无 data_length / index_length → ruleLargeTableRebuild 不触发
    const ids = r.issues.map((i) => i.id);
    expect(ids).toContain('BIG_TABLE_COPY:table.orders');
  });
});

// ---------------------------------------------------------------------------
// serializePreflight · byte 稳定 + 合法 JSON + roundtrip
// ---------------------------------------------------------------------------

describe('serializePreflight', () => {
  function sampleReport(): PreflightReport {
    return buildPreflightReport(
      buildInput({
        checkedAt: NOW,
        report: {
          facts: [fact(), fact({ category: 'table', key: 'table.orders.rows', value: 2_000_000 })],
          inferences: [inference()],
          unknowns: [unknown()],
        },
        items: [ddlItem('ALTER TABLE orders ADD UNIQUE INDEX u (col)')],
      }),
    );
  }

  it('输出以换行结尾', () => {
    expect(serializePreflight(sampleReport())).toMatch(/\n$/);
  });

  it('同输入 byte 稳定（确定性序列化）', () => {
    const r = sampleReport();
    expect(serializePreflight(r)).toBe(serializePreflight(r));
  });

  it('合法 JSON，可解析回原对象（AC3 等价语义）', () => {
    const r = sampleReport();
    const text = serializePreflight(r);
    const parsed = JSON.parse(text) as PreflightReport;
    expect(parsed).toEqual(r);
    expect(parsed.schemaVersion).toBe(PREFLIGHT_REPORT_VERSION);
    expect(parsed.source).toBe('real');
  });

  it('字段顺序在序列化文本中保持 PreflightReport 声明顺序', () => {
    const text = serializePreflight(emptyReport());
    // 逐字段查找首次出现位置，验证升序（对象键即类型声明顺序）
    let lastIdx = -1;
    for (const k of [
      'schemaVersion',
      'appVersion',
      'checkedAt',
      'targetAlias',
      'targetDatabase',
      'source',
      'facts',
      'inferences',
      'unknowns',
      'issues',
      'verdict',
    ]) {
      const idx = text.indexOf(`"${k}"`);
      expect(idx, `字段 ${k} 应出现在文本中`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

// ---------------------------------------------------------------------------
// preflightToMarkdown · 头部 + 5 个二级区块 + 保密声明
// ---------------------------------------------------------------------------

describe('preflightToMarkdown', () => {
  function richReport(): PreflightReport {
    return buildPreflightReport(
      buildInput({
        checkedAt: NOW,
        report: {
          facts: [
            fact({ category: 'server', key: 'server.mysql_version', value: '8.0.36' }),
            fact({ category: 'table', key: 'table.orders.rows', value: 2_000_000 }),
            fact({ category: 'replication', key: 'replication.seconds_behind_master', value: 60 }),
          ],
          inferences: [
            inference({ evidence: ['server.mysql_version', 'table.orders.rows'] }),
          ],
          unknowns: [
            unknown({ attempt: 'SHOW REPLICA STATUS 未返回行' }),
          ],
        },
        items: [ddlItem('ALTER TABLE orders ADD UNIQUE INDEX u (col)')],
      }),
    );
  }

  it('含一级标题与检查元信息', () => {
    const md = preflightToMarkdown(emptyReport());
    expect(md).toContain('# Preflight Report');
    expect(md).toContain(`schemaVersion: ${PREFLIGHT_REPORT_VERSION}`);
    expect(md).toContain('appVersion: 0.1.0');
    expect(md).toContain('目标别名: B库');
    expect(md).toContain('目标数据库: app_db');
    expect(md).toContain('来源: real');
  });

  it('含五个二级区块：Facts / Inferences / Unknowns / Issues / Verdict', () => {
    const md = preflightToMarkdown(richReport());
    expect(md).toContain('## Facts');
    expect(md).toContain('## Inferences');
    expect(md).toContain('## Unknowns');
    expect(md).toContain('## Issues');
    expect(md).toContain('## Verdict');
  });

  it('Fact 表按 category 分组，每个 category 一个三级子标题', () => {
    const md = preflightToMarkdown(richReport());
    expect(md).toContain('### Facts · server');
    expect(md).toContain('### Facts · table');
    expect(md).toContain('### Facts · replication');
  });

  it('Inference 表包含 evidence 列，引用 Fact.key', () => {
    const md = preflightToMarkdown(richReport());
    // 表头包含 Evidence 列
    expect(md).toContain('Evidence');
    // evidence 用分号拼接
    expect(md).toContain('server.mysql_version; table.orders.rows');
  });

  it('Unknown 表包含 reason 列', () => {
    const md = preflightToMarkdown(richReport());
    expect(md).toContain('Reason');
    expect(md).toContain('not-applicable');
  });

  it('Issue 表 block 优先于 warn 排序', () => {
    const r: PreflightReport = {
      ...emptyReport(),
      issues: [
        issue({ id: 'WARN_A', severity: 'warn', title: 'warn-a' }),
        issue({ id: 'BLOCK_A', severity: 'block', title: 'block-a' }),
        issue({ id: 'WARN_B', severity: 'warn', title: 'warn-b' }),
      ],
      verdict: { level: 'block', blocking: 1, warnings: 2, unknowns: 0 },
    };
    const md = preflightToMarkdown(r);
    const blockIdx = md.indexOf('BLOCK_A');
    const warnAIdx = md.indexOf('WARN_A');
    const warnBIdx = md.indexOf('WARN_B');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(warnAIdx).toBeGreaterThan(-1);
    expect(warnBIdx).toBeGreaterThan(-1);
    // block 在两个 warn 之前
    expect(blockIdx).toBeLessThan(warnAIdx);
    expect(blockIdx).toBeLessThan(warnBIdx);
  });

  it('保密声明包含"不含连接凭据"文本', () => {
    const md = preflightToMarkdown(emptyReport());
    expect(md).toContain('保密声明');
    expect(md).toContain('不含连接凭据');
  });

  it('空报告不崩溃，各区块输出占位而非表格', () => {
    const md = preflightToMarkdown(emptyReport());
    expect(md).toContain('_（无事实）_');
    expect(md).toContain('_（无推断）_');
    expect(md).toContain('_（无未知）_');
    expect(md).toContain('_（无高危规则触发）_');
    expect(md).toContain('## Verdict');
    expect(md).toContain('- Level: **pass**');
  });

  it('Markdown 单元格中的竖线被转义', () => {
    const r: PreflightReport = {
      ...emptyReport(),
      facts: [
        fact({ key: 'server.sql_mode', value: 'ONLY_FULL_GROUP_BY|STRICT_TRANS_TABLES' }),
      ],
    };
    const md = preflightToMarkdown(r);
    expect(md).toContain('ONLY_FULL_GROUP_BY\\|STRICT_TRANS_TABLES');
  });
});

// ---------------------------------------------------------------------------
// preflightFileNames
// ---------------------------------------------------------------------------

describe('preflightFileNames', () => {
  it('传入 ISO 时间戳返回 { jsonFileName, markdownFileName }', () => {
    const { jsonFileName, markdownFileName } = preflightFileNames(NOW);
    expect(jsonFileName).toBe('sqldiff-preflight-2026-01-01T00-00-00-000Z.json');
    expect(markdownFileName).toBe('sqldiff-preflight-2026-01-01T00-00-00-000Z.md');
  });

  it('冒号与点被替换为短横线（对齐 manifest 的 filename 策略）', () => {
    const { jsonFileName } = preflightFileNames('2026-09-30T10:30:00.123Z');
    expect(jsonFileName).toBe('sqldiff-preflight-2026-09-30T10-30-00-123Z.json');
    // 不残留冒号与点（除结尾的 .json）
    expect(jsonFileName.replace(/\.json$/, '')).not.toMatch(/[:.]/);
  });

  it('两个文件名的时间戳部分一致，仅扩展名不同', () => {
    const { jsonFileName, markdownFileName } = preflightFileNames(NOW);
    const strip = (s: string) => s.replace(/\.(json|md)$/, '');
    expect(strip(jsonFileName)).toBe(strip(markdownFileName));
    expect(jsonFileName.endsWith('.json')).toBe(true);
    expect(markdownFileName.endsWith('.md')).toBe(true);
  });
});
