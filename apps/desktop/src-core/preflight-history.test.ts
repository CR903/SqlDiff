// 多次 preflight 历史对比 · diff 纯函数单测（10-04-history-diff）。
//
// 覆盖 implement.md 要求的四种：新增 / 消失 / 等级变化 / verdict 翻转，
// 另加：无变化空 diff、v1 旧报告回填、分组键、条目守卫。

import { describe, expect, it } from 'vitest';
import {
  diffPreflight,
  historyGroupKey,
  isPreflightHistoryEntry,
  sameHistoryGroup,
  type DiffableReport,
  type PreflightHistoryEntry,
} from './preflight-history';
import type { PreflightIssue } from './preflight-types';

const NOW = '2026-10-04T00:00:00.000Z';

function issue(overrides: Partial<PreflightIssue> = {}): PreflightIssue {
  return {
    id: 'BIG_TABLE_COPY:table.orders',
    severity: 'block',
    title: '表 orders 变更将重建表',
    detail: 'TABLE_ROWS=2000000 超过阈值 1000000',
    related: ['table.orders.rows'],
    recommendation: '低峰时段发布',
    ...overrides,
  };
}

function report(overrides: Partial<DiffableReport> = {}): DiffableReport {
  return { issues: [], inferences: [], unknowns: [], ...overrides };
}

function entry(overrides: Partial<PreflightHistoryEntry> = {}): PreflightHistoryEntry {
  return {
    id: 'h1',
    at: NOW,
    bId: 'n-b',
    bAlias: 'B库',
    database: 'shop',
    schemaVersion: 2,
    appVersion: '1.2.3',
    report: {
      schemaVersion: 2,
      appVersion: '1.2.3',
      checkedAt: NOW,
      targetAlias: 'B库',
      targetDatabase: 'shop',
      source: 'real',
      facts: [],
      inferences: [],
      unknowns: [],
      issues: [],
      verdict: { level: 'pass', blocking: 0, warnings: 0, unknowns: 0 },
      summary: { decision: 'GO', message: '可发布', blocking: 0, warnings: 0, unknowns: 0 },
    },
    ...overrides,
  };
}

describe('diffPreflight', () => {
  it('新增：to 多出的 issue 进 addedIssues', () => {
    const added = issue({ id: 'REPLICA_LAG:replication', severity: 'warn', title: '复制延迟' });
    const d = diffPreflight(
      report(),
      report({
        issues: [added],
        verdict: { level: 'warn', blocking: 0, warnings: 1, unknowns: 0 },
      }),
    );
    expect(d.addedIssues.map((i) => i.id)).toEqual(['REPLICA_LAG:replication']);
    expect(d.removedIssues).toEqual([]);
    expect(d.severityChanged).toEqual([]);
    expect(d.verdictChanged).toBe(true);
  });

  it('消失：from 独有的 issue 进 removedIssues', () => {
    const gone = issue({ id: 'NO_PRIMARY_KEY:table.t', severity: 'warn', title: '无主键' });
    const d = diffPreflight(
      report({
        issues: [gone],
        verdict: { level: 'warn', blocking: 0, warnings: 1, unknowns: 0 },
      }),
      report(),
    );
    expect(d.removedIssues.map((i) => i.id)).toEqual(['NO_PRIMARY_KEY:table.t']);
    expect(d.addedIssues).toEqual([]);
    expect(d.severityChanged).toEqual([]);
    expect(d.verdictChanged).toBe(true);
  });

  it('等级变化：同 id 不同 severity 进 severityChanged，不计新增/消失', () => {
    const a = issue({ id: 'X:t', severity: 'block' });
    const b = issue({ id: 'X:t', severity: 'warn' });
    const d = diffPreflight(report({ issues: [a] }), report({ issues: [b] }));
    expect(d.severityChanged).toEqual([{ id: 'X:t', from: 'block', to: 'warn' }]);
    expect(d.addedIssues).toEqual([]);
    expect(d.removedIssues).toEqual([]);
  });

  it('verdict 翻转：GO → BLOCK 且快照前后正确', () => {
    const blk = issue();
    const d = diffPreflight(
      report(),
      report({
        issues: [blk],
        verdict: { level: 'block', blocking: 1, warnings: 0, unknowns: 0 },
      }),
    );
    expect(d.verdictChanged).toBe(true);
    expect(d.from.decision).toBe('GO');
    expect(d.to.decision).toBe('BLOCK');
    expect(d.to.blocking).toBe(1);
  });

  it('无变化：同样 issues → 空 diff 且 verdictChanged=false', () => {
    const w = issue({ id: 'REPLICA_LAG:replication', severity: 'warn' });
    const d = diffPreflight(report({ issues: [w] }), report({ issues: [{ ...w }] }));
    expect(d.verdictChanged).toBe(false);
    expect(d.addedIssues).toEqual([]);
    expect(d.removedIssues).toEqual([]);
    expect(d.severityChanged).toEqual([]);
  });

  it('v1 旧报告（缺 summary）：经 getSummary 回填后可参与对比', () => {
    const v1a = { issues: [], inferences: [], unknowns: [] };
    const v1b = {
      issues: [issue()],
      inferences: [],
      unknowns: [],
      verdict: { level: 'block' as const, blocking: 1, warnings: 0, unknowns: 0 },
    };
    const d = diffPreflight(v1a, v1b);
    expect(d.from.decision).toBe('GO');
    expect(d.to.decision).toBe('BLOCK');
    expect(d.addedIssues).toHaveLength(1);
  });
});

describe('historyGroupKey / sameHistoryGroup', () => {
  it('同 (bId, database) 同组，任一不同即跨组', () => {
    const a = { bId: 'n-b', database: 'shop' };
    expect(historyGroupKey(a)).toBe('n-b\nshop');
    expect(sameHistoryGroup(a, { bId: 'n-b', database: 'shop' })).toBe(true);
    expect(sameHistoryGroup(a, { bId: 'n-c', database: 'shop' })).toBe(false);
    expect(sameHistoryGroup(a, { bId: 'n-b', database: 'shop2' })).toBe(false);
  });
});

describe('isPreflightHistoryEntry', () => {
  it('合法条目通过', () => {
    expect(isPreflightHistoryEntry(entry())).toBe(true);
  });

  it('缺 id / bId / database / report.issues 即非法', () => {
    expect(isPreflightHistoryEntry({ ...entry(), id: '' })).toBe(false);
    expect(isPreflightHistoryEntry({ ...entry(), bId: '' })).toBe(false);
    expect(isPreflightHistoryEntry({ ...entry(), database: '' })).toBe(false);
    expect(isPreflightHistoryEntry({ ...entry(), report: { issues: 'x' } })).toBe(false);
    expect(isPreflightHistoryEntry(null)).toBe(false);
    expect(isPreflightHistoryEntry([])).toBe(false);
  });

  it('缺 verdict / verdict 形状坏即非法（UI 直接读 verdict.level）', () => {
    const noVerdict = entry();
    (noVerdict.report as unknown as Record<string, unknown>).verdict = undefined;
    expect(isPreflightHistoryEntry(noVerdict)).toBe(false);
    const badLevel = entry();
    (badLevel.report as unknown as Record<string, unknown>).verdict = {
      level: 'GO',
      blocking: 0,
      warnings: 0,
      unknowns: 0,
    };
    expect(isPreflightHistoryEntry(badLevel)).toBe(false);
  });
});
