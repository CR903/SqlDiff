// store.runCompare 的「执行范围」语义（10-05 修复 R2/R3）：
//   - 门禁：结构与数据都没勾时拒绝运行；只勾数据是合法态，必须放行（R2）；
//   - lastComboText 如实反映实际执行范围——结构为空时不得输出误导性的 `· /data`（R3）。
// 这段文案会写进历史并展示在左下角，用户据此判断「这次到底比了什么」。
// 无 jsdom 套件，用 vi.stubGlobal 造最小 window.sqldiff。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompareResult, DataTableStatus } from '../../src-core/types';
import type { SqlDiffApi } from '../../src-main/preload';
import { useDesktopStore } from '../../src-renderer/store';

const EMPTY_STATS = { ALL: 0, CREATE: 0, DROP: 0, CHANGE: 0, INDEX: 0, DML: { INSERT: 0, DELETE: 0, UPDATE: 0 } };

function result(over: Partial<CompareResult> = {}): CompareResult {
  return { items: [], stats: EMPTY_STATS, source: 'real', ...over };
}

function doneTable(a: string): DataTableStatus {
  return { a, b: a, status: 'done', insertCount: 1, deleteCount: 0, updateCount: 0 };
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
    stats: null,
    lastCompareRequest: null,
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

describe('runCompare 门禁：至少勾选一个对比范围（R2）', () => {
  it('结构与数据都没勾 → 拒绝运行，不打后端，toast 给出可操作提示', async () => {
    const api = stubApi(async () => result());
    vi.stubGlobal('window', { sqldiff: api });
    useDesktopStore.setState({ scopes: [], includeData: false });

    await useDesktopStore.getState().runCompare();

    expect(api.compare.run).not.toHaveBeenCalled();
    expect(useDesktopStore.getState().toast).toContain('至少勾选一个对比范围');
    expect(useDesktopStore.getState().comparing).toBe(false);
  });

  it('只勾数据（结构全不勾）→ 合法态，放行', async () => {
    const api = stubApi(async () => result());
    vi.stubGlobal('window', { sqldiff: api });
    useDesktopStore.setState({ scopes: [], includeData: true });

    await useDesktopStore.getState().runCompare();

    expect(api.compare.run).toHaveBeenCalledTimes(1);
    // 发出的请求即 store 归一前的原始意图：结构为空 + data。
    const sent = vi.mocked(api.compare.run).mock.calls[0][0];
    expect(sent.scopes).toEqual(['data']);
    expect(sent.includeData).toBe(true);
  });
});

describe('lastComboText 如实反映执行范围（R3）', () => {
  it('只勾数据 → 显示为 `data`，不出现前导斜杠 `· /data`', async () => {
    vi.stubGlobal('window', {
      sqldiff: stubApi(async () => result({ dataTables: [doneTable('users')] })),
    });
    useDesktopStore.setState({ scopes: [], includeData: true });

    await useDesktopStore.getState().runCompare();

    const text = useDesktopStore.getState().lastComboText;
    expect(text).toContain(' · data · ');
    expect(text).not.toContain('· /data');
    expect(text).not.toContain('/data');
  });

  it('结构 + 数据 → `table/view/data`，分隔符与既有格式一致', async () => {
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result()) });
    useDesktopStore.setState({ scopes: ['table', 'view'], includeData: true });

    await useDesktopStore.getState().runCompare();

    expect(useDesktopStore.getState().lastComboText).toContain(' · table/view/data · ');
  });

  it('仅结构、无数据 → `table/view`，末尾无悬空斜杠', async () => {
    vi.stubGlobal('window', { sqldiff: stubApi(async () => result()) });
    useDesktopStore.setState({ scopes: ['table', 'view'], includeData: false });

    await useDesktopStore.getState().runCompare();

    const text = useDesktopStore.getState().lastComboText;
    expect(text).toContain(' · table/view · ');
    expect(text).not.toContain('view/');
  });
});