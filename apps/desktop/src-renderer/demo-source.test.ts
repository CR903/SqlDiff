// 来源与覆盖/范围展示的纯逻辑回归：只有渲染侧可单测的部分。
// 说明：store.runCompare 的分流依赖 window.sqldiff 与 localStorage（无 jsdom 套件），
// 故此处覆盖 demo 标注（AC1）与"全部成功时静默"的判定条件（AC10），交互部分走 CDP。

import { describe, expect, it } from 'vitest';
import type { CompareResult, CompareVisibility } from '../src-core/types';
import { runDemoCompare } from './demo';

/** 与 App.tsx 同口径：是否存在需要常驻提示的覆盖缺口。 */
function hasCoverageNotice(c: CompareResult): boolean {
  return (c.coverage?.skipped.length ?? 0) > 0;
}

/**
 * 与 App.tsx 同口径（visShow）：范围提示只在「有对象被排除」或「判据不可靠」时出现。
 * excluded 为空且判据可靠 → 界面完全安静（AC4 / AC5：库级授权账号不打扰）。
 */
function hasVisibilityNotice(v: CompareVisibility | null | undefined): boolean {
  if (v == null) return false;
  return v.excluded.length > 0 || !v.reliable;
}

describe('runDemoCompare 来源标注', () => {
  it('标 source=demo 且无 coverage / visibility（AC1）', () => {
    const r = runDemoCompare(['table', 'view', 'procedure', 'function']);
    expect(r.source).toBe('demo');
    expect(r.coverage).toBeUndefined();
    expect(r.visibility).toBeUndefined();
    expect(hasCoverageNotice(r)).toBe(false);
    expect(hasVisibilityNotice(r.visibility)).toBe(false);
  });

  it('带 tableFilter 时来源标注不变', () => {
    const r = runDemoCompare(['table'], 'user');
    expect(r.source).toBe('demo');
  });

  it('scopes 为空时回落到四类全开，仍标 demo', () => {
    const r = runDemoCompare([]);
    expect(r.source).toBe('demo');
    expect(r.stats.ALL).toBeGreaterThan(0);
  });

  it('覆盖为空（未采集）时不产生提示位（AC10）', () => {
    expect(hasCoverageNotice({ items: [], stats: { ALL: 0, CREATE: 0, DROP: 0, CHANGE: 0, INDEX: 0, DML: { INSERT: 0, DELETE: 0, UPDATE: 0 } }, source: 'real' })).toBe(false);
    expect(
      hasCoverageNotice({
        items: [],
        stats: { ALL: 0, CREATE: 0, DROP: 0, CHANGE: 0, INDEX: 0, DML: { INSERT: 0, DELETE: 0, UPDATE: 0 } },
        source: 'real',
        coverage: { ok: { table: 12, view: 0, procedure: 0, function: 0 }, skipped: [] },
      }),
    ).toBe(false);
    expect(
      hasCoverageNotice({
        items: [],
        stats: { ALL: 0, CREATE: 0, DROP: 0, CHANGE: 0, INDEX: 0, DML: { INSERT: 0, DELETE: 0, UPDATE: 0 } },
        source: 'real',
        coverage: {
          ok: { table: 12, view: 0, procedure: 0, function: 0 },
          skipped: [{ name: 'orders', objectType: 'table', reason: 'permission-denied' }],
        },
      }),
    ).toBe(true);
  });

  it('范围提示条件：excluded 非空或判据不可靠才提示，其余一律安静（AC4 / AC5）', () => {
    const clean: CompareVisibility = { excluded: [], compared: 12, reliable: true };
    const narrowed: CompareVisibility = {
      excluded: [{ name: 'secret_tbl', objectType: 'table', side: 'b-only', reason: 'grant-invisible' }],
      compared: 11,
      reliable: true,
    };
    const unverifiable: CompareVisibility = { excluded: [], compared: 12, reliable: false };
    expect(hasVisibilityNotice(null)).toBe(false);
    expect(hasVisibilityNotice(undefined)).toBe(false);
    expect(hasVisibilityNotice(clean)).toBe(false);
    expect(hasVisibilityNotice(narrowed)).toBe(true);
    // 判据不可靠时即便没有对象被排除也不能沉默：不能暗示"范围已完整"。
    expect(hasVisibilityNotice(unverifiable)).toBe(true);
  });
});
