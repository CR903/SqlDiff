// Q1 决策的两条路径分流回归（AC1 / AC2）：store.runCompare 的 catch 必须
//   - no-ipc（无 Electron 后端，npm run dev）→ 保留本地示例，标 source='demo'
//   - 真实比较失败（凭据/连通性/权限/后端异常）→ 绝不回填示例，清空结果进 resultError
// 无 jsdom 套件，用 vi.stubGlobal 造最小 window.sqldiff；交互呈现走 CDP 验证。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompareResult } from '../src-core/types';
import type { SqlDiffApi } from '../src-main/preload';
import { useDesktopStore } from './store';

const EMPTY_STATS = { ALL: 0, CREATE: 0, DROP: 0, CHANGE: 0, INDEX: 0, DML: { INSERT: 0, DELETE: 0, UPDATE: 0 } };

function result(over: Partial<CompareResult> = {}): CompareResult {
  return { items: [], stats: EMPTY_STATS, ...over };
}

/** 最小可用后端桩：只需要 runCompare 走到的 compare.* / history.* / nodes.* 表面。 */
function stubApi(run: () => Promise<CompareResult>): SqlDiffApi {
  return {
    compare: {
      run: vi.fn(run),
      onProgress: vi.fn(() => () => undefined),
      cancel: vi.fn(async () => undefined),
    },
    history: { list: vi.fn(async () => []) },
    nodes: { update: vi.fn(async () => undefined) },
  } as unknown as SqlDiffApi;
}

function resetStore(): void {
  useDesktopStore.setState({
    slotA: 'n-prod',
    slotB: 'n-staging',
    scopes: ['table', 'view'],
    tableFilter: '',
    includeData: false,
    dataPairs: [],
    comparing: false,
    items: [],
    dataStatus: [],
    selectedId: null,
    resultSource: null,
    coverage: null,
    visibility: null,
    resultError: null,
    lastComboText: '',
    toast: null,
  });
}

beforeEach(resetStore);
afterEach(() => {
  vi.unstubAllGlobals();
  resetStore();
});

describe('runCompare：开发/演示态（no-ipc）', () => {
  it('无后端时回填示例结果并标 demo（AC1 / AC8：npm run dev 仍可演示）', async () => {
    vi.stubGlobal('window', {}); // 无 sqldiff
    await useDesktopStore.getState().runCompare();
    const s = useDesktopStore.getState();
    expect(s.items.length).toBeGreaterThan(0);
    expect(s.resultSource).toBe('demo');
    expect(s.resultError).toBeNull();
    expect(s.coverage).toBeNull();
    expect(s.visibility).toBeNull();
    expect(s.lastComboText).toContain('本地示例数据');
    expect(s.comparing).toBe(false);
  });
});

describe('runCompare：真实比较失败（Q1 分流）', () => {
  it('后端报错时不回填示例：items 清空 + resultError 为消毒后的原因（AC2）', async () => {
    vi.stubGlobal('window', {
      sqldiff: stubApi(async () => {
        throw new Error("Error invoking remote method 'compare.run': Error: compare: A 槽节点不存在（x）");
      }),
    });
    await useDesktopStore.getState().runCompare();
    const s = useDesktopStore.getState();
    // 关键断言：没有示例差异列表。
    expect(s.items).toEqual([]);
    expect(s.dataStatus).toEqual([]);
    // 原始 Electron 前缀被剥掉，只留中文原因。
    expect(s.resultError).toBe('compare: A 槽节点不存在（x）');
    expect(s.resultError).not.toContain('Error invoking');
    expect(s.resultSource).toBeNull();
    expect(s.coverage).toBeNull();
    expect(s.visibility).toBeNull();
    expect(s.lastComboText).toContain('对比失败');
    expect(s.comparing).toBe(false);
  });

  it('失败后残留的旧结果/错误态在下一次运行时一并被替换（不复用陈旧示例）', async () => {
    useDesktopStore.setState({
      items: [{ id: 'x' } as never],
      resultSource: 'demo',
      coverage: null,
      visibility: { excluded: [], compared: 3, reliable: true },
    });
    vi.stubGlobal('window', {
      sqldiff: stubApi(async () => {
        throw new Error('compare: 连接失败');
      }),
    });
    await useDesktopStore.getState().runCompare();
    const s = useDesktopStore.getState();
    expect(s.items).toEqual([]);
    expect(s.resultSource).toBeNull();
    expect(s.resultError).toBe('compare: 连接失败');
  });
});

describe('runCompare：真实成功', () => {
  it('结果来源标 real，覆盖报告原样落库，错误态清空（AC1 / AC3）', async () => {
    const cov = { ok: { table: 2, view: 1, procedure: 0, function: 0 }, skipped: [] };
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result({ source: 'real', coverage: cov })) });
    useDesktopStore.setState({ resultError: '旧错误' });
    await useDesktopStore.getState().runCompare();
    const s = useDesktopStore.getState();
    expect(s.resultSource).toBe('real');
    expect(s.coverage).toEqual(cov);
    expect(s.resultError).toBeNull();
  });

  it('真实结果漏标 source 时按 real 兜底（缺省语义，design.md）', async () => {
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result()) });
    await useDesktopStore.getState().runCompare();
    expect(useDesktopStore.getState().resultSource).toBe('real');
  });

  it('有未检查对象时 coverage.skipped 非空 → 结果界面具备常驻计数依据（AC4 / AC5）', async () => {
    const cov = {
      ok: { table: 2, view: 0, procedure: 0, function: 0 },
      skipped: [{ name: 'secret', objectType: 'table' as const, reason: 'permission-denied' as const }],
    };
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result({ source: 'real', coverage: cov })) });
    await useDesktopStore.getState().runCompare();
    const s = useDesktopStore.getState();
    expect(s.coverage?.skipped).toHaveLength(1);
    expect(s.coverage?.skipped[0].reason).toBe('permission-denied');
    // 覆盖明细本身不含 errno / 原始 message 等敏感内容。
    expect(JSON.stringify(s.coverage)).not.toMatch(/errno|Access denied|SELECT command/i);
  });

  it('授权盲区范围报告原样落库：excluded 带对象名/类型/哪侧可见（AC3 / AC4）', async () => {
    const vis = {
      excluded: [
        { name: 'secret_tbl', objectType: 'table' as const, side: 'b-only' as const, reason: 'grant-invisible' as const },
      ],
      compared: 1,
      reliable: true,
    };
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result({ source: 'real', visibility: vis })) });
    await useDesktopStore.getState().runCompare();
    const s = useDesktopStore.getState();
    expect(s.visibility).toEqual(vis);
    expect(s.visibility?.excluded[0].side).toBe('b-only');
    // 范围报告只带判别结论与对象名，不带授权原文 / 凭据 / 连接串。
    expect(JSON.stringify(s.visibility)).not.toMatch(/GRANT|IDENTIFIED|PASSWORD|password|3306/);
  });

  it('判据不可靠时范围报告照常落库（reliable=false 驱动更强措辞，不静默）', async () => {
    const vis = { excluded: [], compared: 12, reliable: false };
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result({ source: 'real', visibility: vis })) });
    await useDesktopStore.getState().runCompare();
    expect(useDesktopStore.getState().visibility).toEqual(vis);
  });

  it('结果缺省 visibility 时置 null（老主进程/无采集路径不产生范围提示）', async () => {
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result({ source: 'real' })) });
    await useDesktopStore.getState().runCompare();
    expect(useDesktopStore.getState().visibility).toBeNull();
  });
});
