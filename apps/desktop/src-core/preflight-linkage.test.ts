// SQL 生成联动单测：deriveSuggestedEdits 命中/未命中/归一化 +
// applySuggestedEdit 改写/幂等/ miss + executive 新增节。

import { describe, expect, it } from 'vitest';
import {
  applySuggestedEdit,
  buildDeveloperView,
  deriveSuggestedEdits,
  diffItemIdOfSuggestion,
  normalizeDdl,
  preflightToExecutiveMarkdown,
} from './preflight';
import type {
  PreflightFact,
  PreflightInference,
  PreflightIssue,
  PreflightReport,
} from './preflight-types';

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
    subject: 'diff-item:d01',
    statement: 'd01: ADD_COLUMN on orders → INSTANT/SHARED',
    confidence: 'high',
    evidence: ['diff-item:d01.sql', 'server.mysql_version'],
    ruleId: 'ONLINE_DDL_MATRIX',
    ...overrides,
  };
}

function issue(overrides: Partial<PreflightIssue> = {}): PreflightIssue {
  return {
    id: 'LARGE_TABLE_INSTANT_ADD:diff-item:d01',
    severity: 'warn',
    title: '表 orders 的大表 ADD_COLUMN 可用 INSTANT 加速',
    detail: 'MySQL 8.0.36 支持 INSTANT',
    related: ['table.orders.rows', 'server.mysql_version', 'diff-item:d01'],
    recommendation: '该 DDL 可用 `ALGORITHM=INSTANT` 加速，避免长锁与重建。',
    ...overrides,
  };
}

function report(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    schemaVersion: 2,
    appVersion: '0.1.0',
    checkedAt: NOW,
    targetAlias: 'B库',
    targetDatabase: 'app_db',
    source: 'real',
    facts: [fact()],
    inferences: [],
    unknowns: [],
    issues: [],
    verdict: { level: 'pass', blocking: 0, warnings: 0, unknowns: 0 },
    summary: { decision: 'GO', message: '可发布。', blocking: 0, warnings: 0, unknowns: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeDdl
// ---------------------------------------------------------------------------

describe('normalizeDdl', () => {
  it('大小写/空白/反引号/末尾分号不敏感', () => {
    expect(normalizeDdl('  ALTER   TABLE  `orders`  ADD COLUMN a INT; ')).toBe(
      'alter table orders add column a int',
    );
  });

  it('空串归一化为空串', () => {
    expect(normalizeDdl('')).toBe('');
    expect(normalizeDdl('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// diffItemIdOfSuggestion
// ---------------------------------------------------------------------------

describe('diffItemIdOfSuggestion', () => {
  it('从 issueId 反解 diffItemId', () => {
    expect(diffItemIdOfSuggestion('LARGE_TABLE_INSTANT_ADD:diff-item:d01')).toBe('d01');
  });

  it('非本规则前缀返回 null', () => {
    expect(diffItemIdOfSuggestion('BIG_TABLE_COPY:table.orders')).toBeNull();
    expect(diffItemIdOfSuggestion('LARGE_TABLE_INSTANT_ADD:table.orders')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveSuggestedEdits
// ---------------------------------------------------------------------------

describe('deriveSuggestedEdits', () => {
  it('命中：LARGE_TABLE_INSTANT_ADD + ADD_COLUMN/INSTANT 推断 → 1 条建议', () => {
    const r = report({
      inferences: [inference()],
      issues: [issue()],
    });
    const edits = deriveSuggestedEdits(r);
    expect(edits).toHaveLength(1);
    expect(edits[0].issueId).toBe('LARGE_TABLE_INSTANT_ADD:diff-item:d01');
    expect(edits[0].tableName).toBe('orders');
    expect(edits[0].find).toBe('alter table orders');
    expect(edits[0].replace).toBe('ALGORITHM=INSTANT');
    // 建议文案带版本前提 + 乐观推断提示
    expect(edits[0].reason).toContain('≥8.0.12');
    expect(edits[0].reason).toContain('DEFAULT');
  });

  it('未命中：非本规则 issue 不给建议、不猜', () => {
    const r = report({
      inferences: [inference({ subject: 'diff-item:d02', statement: 'd02: MODIFY_COLUMN on t → INPLACE/SHARED (rebuild)' })],
      issues: [issue({ id: 'BIG_TABLE_COPY:table.orders', severity: 'block' })],
    });
    expect(deriveSuggestedEdits(r)).toEqual([]);
  });

  it('未命中：有 issue 但无对应 inference → 跳过', () => {
    const r = report({ inferences: [], issues: [issue()] });
    expect(deriveSuggestedEdits(r)).toEqual([]);
  });

  it('未命中：inference 非 ADD_COLUMN / 非 INSTANT → 跳过（与规则同源复核）', () => {
    const r = report({
      inferences: [inference({ subject: 'diff-item:d02', statement: 'd02: MODIFY_COLUMN on t → INPLACE/SHARED (rebuild)' })],
      issues: [issue({ id: 'LARGE_TABLE_INSTANT_ADD:diff-item:d02' })],
    });
    expect(deriveSuggestedEdits(r)).toEqual([]);
  });

  it('归一化：inference 表名大小写不影响 find（find 恒为小写锚点）', () => {
    const r = report({
      inferences: [inference({ statement: 'd01: ADD_COLUMN on Orders → INSTANT/SHARED' })],
      issues: [issue()],
    });
    const edits = deriveSuggestedEdits(r);
    expect(edits).toHaveLength(1);
    expect(edits[0].find).toBe('alter table orders');
  });

  it('空报告返回空数组，不抛错', () => {
    expect(deriveSuggestedEdits(report())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applySuggestedEdit
// ---------------------------------------------------------------------------

describe('applySuggestedEdit', () => {
  it('命中：原文追加 `, ALGORITHM=INSTANT`（保留原文大小写）', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const [edit] = deriveSuggestedEdits(r);
    const out = applySuggestedEdit('ALTER TABLE orders ADD COLUMN age INT', edit);
    expect(out).toBe('ALTER TABLE orders ADD COLUMN age INT, ALGORITHM=INSTANT');
  });

  it('归一化命中：反引号/多空白/小写原文仍可匹配', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const [edit] = deriveSuggestedEdits(r);
    const out = applySuggestedEdit('  alter   table  `orders`  add  column age int; ', edit);
    expect(out).not.toBeNull();
    expect(out!).toContain('ALGORITHM=INSTANT');
  });

  it('未命中：表名不一致 → null（不硬套）', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const [edit] = deriveSuggestedEdits(r);
    expect(applySuggestedEdit('ALTER TABLE users ADD COLUMN age INT', edit)).toBeNull();
  });

  it('幂等：已含 ALGORITHM 子句 → null（不重复追加）', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const [edit] = deriveSuggestedEdits(r);
    expect(
      applySuggestedEdit('ALTER TABLE orders ADD COLUMN age INT, ALGORITHM=INSTANT', edit),
    ).toBeNull();
    expect(
      applySuggestedEdit('ALTER TABLE orders ADD COLUMN age INT ALGORITHM = INPLACE', edit),
    ).toBeNull();
  });

  it('空 SQL → null', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const [edit] = deriveSuggestedEdits(r);
    expect(applySuggestedEdit('', edit)).toBeNull();
    expect(applySuggestedEdit('   ', edit)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executive 新增节
// ---------------------------------------------------------------------------

describe('executive 可应用的加速建议节', () => {
  it('有建议时表格列出规则 id / 表 / 子句 / 依据', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const md = preflightToExecutiveMarkdown(r);
    expect(md).toContain('### 可应用的加速建议');
    expect(md).toContain('LARGE_TABLE_INSTANT_ADD:diff-item:d01');
    expect(md).toContain('ALGORITHM=INSTANT');
    expect(md).toContain('≥8.0.12');
  });

  it('无建议时优雅降级（占位文案，不抛错）', () => {
    const md = preflightToExecutiveMarkdown(report());
    expect(md).toContain('### 可应用的加速建议');
    expect(md).toContain('暂无可应用的加速建议');
  });

  it('新节位于建议动作之后、DDL 分组之前（只做加法，不重排）', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const md = preflightToExecutiveMarkdown(r);
    const a = md.indexOf('### 建议动作');
    const b = md.indexOf('### 可应用的加速建议');
    const c = md.indexOf('### DDL 分组');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('buildDeveloperView 不受影响（新函数不改既有派生）', () => {
    const r = report({ inferences: [inference()], issues: [issue()] });
    const dev = buildDeveloperView(r);
    expect(dev.classifiedCount).toBe(1);
  });
});
