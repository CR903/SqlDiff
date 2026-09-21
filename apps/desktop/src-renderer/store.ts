import { create } from 'zustand';
import type {
  ChangeType,
  ConnTestResult,
  DiffItem,
  ExportJSON,
  HistoryEntry,
  NodeMeta,
  ObjectType,
  SecretBundle,
} from '../src-core/types';
import type { NodeCreateInput, SqlDiffApi } from '../src-main/preload';
import { runDemoCompare } from './demo';

export type LeftTab = 'hist' | 'mine' | 'fav';
export type DiffFilter = 'ALL' | ChangeType;
export type SlotId = 'A' | 'B';
export type ObjectTypeFilter = ObjectType | 'ALL';

const LAST_COMBO_KEY = 'sqldiff.lastCombo';

function meta(
  id: string,
  alias: string,
  host: string,
  database: string,
  extra: Partial<NodeMeta> = {},
): NodeMeta {
  return {
    id,
    alias,
    host,
    port: 3306,
    user: 'root',
    database,
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

// 无后端（Vite 直开）时的种子，仅用于展示三栏结构；有 IPC 时会被 nodes.list 覆盖。
const seedNodes: NodeMeta[] = [
  meta('n-prod', 'prod-主库', '10.0.1.12', 'shop', {
    group: '生产',
    tags: ['prod'],
    star: true,
    useCount: 42,
  }),
  meta('n-staging', 'staging-验证库', '10.0.2.8', 'shop', {
    group: '预发',
    tags: ['staging'],
    useCount: 27,
  }),
  meta('n-dev', '本地-dev', '127.0.0.1', 'shop_dev', {
    group: '本地',
    star: true,
    useCount: 15,
  }),
];

function getIpc(): SqlDiffApi | null {
  try {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { sqldiff?: SqlDiffApi };
    return w.sqldiff ?? null;
  } catch {
    return null;
  }
}

function readLastCombo(): { aId: string | null; bId: string | null } {
  try {
    const raw = localStorage.getItem(LAST_COMBO_KEY);
    if (!raw) return { aId: null, bId: null };
    const parsed = JSON.parse(raw) as { aId?: unknown; bId?: unknown };
    return {
      aId: typeof parsed.aId === 'string' ? parsed.aId : null,
      bId: typeof parsed.bId === 'string' ? parsed.bId : null,
    };
  } catch {
    return { aId: null, bId: null };
  }
}

function writeLastCombo(aId: string | null, bId: string | null): void {
  try {
    localStorage.setItem(LAST_COMBO_KEY, JSON.stringify({ aId, bId }));
  } catch {
    // 离线存储失败不阻塞。
  }
}

interface DesktopState {
  /** 节点库 */
  nodes: NodeMeta[];
  nodesLoading: boolean;
  /** 对比历史（新→旧，最多 20 条） */
  history: HistoryEntry[];
  leftTab: LeftTab;
  nodeKeyword: string;
  /** 对比槽 A/B（存节点 id） */
  slotA: string | null;
  slotB: string | null;
  scopes: ObjectType[];
  tableFilter: string;
  /** 差异 focus：当前 Tab + 对象类型二级过滤 + 选中行 */
  diffFilter: DiffFilter;
  objectTypeFilter: ObjectTypeFilter;
  items: DiffItem[];
  selectedId: string | null;
  /** 对比进度 */
  comparing: boolean;
  progress: string;
  progressPct: number;
  /** 上次组合描述（记忆上次组合） */
  lastComboText: string;
  /** toast 轻提示 */
  toast: string | null;
  setLeftTab: (t: LeftTab) => void;
  setNodeKeyword: (kw: string) => void;
  assignNode: (id: string) => void;
  setSlot: (which: SlotId, id: string | null) => void;
  swapSlots: () => void;
  clearSlots: () => void;
  toggleScope: (s: ObjectType) => void;
  setTableFilter: (v: string) => void;
  setDiffFilter: (f: DiffFilter) => void;
  setObjectTypeFilter: (f: ObjectTypeFilter) => void;
  selectDiff: (id: string | null) => void;
  setToast: (msg: string | null) => void;
  toggleStar: (id: string) => void;
  refreshNodes: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  runCompare: () => Promise<void>;
  /** 新增 / 编辑节点（secret 为空表示不改动密钥；新建时可留空）。无主进程时抛错。 */
  saveNode: (input: NodeCreateInput, editingId?: string | null) => Promise<NodeMeta>;
  removeNode: (id: string) => Promise<void>;
  testNode: (id: string) => Promise<ConnTestResult>;
  /** 表单免保存测试：直收 {node, secret} 走 conn.test，不写 vault。 */
  testDraft: (node: NodeMeta, secret?: SecretBundle) => Promise<ConnTestResult>;
  exportDoc: () => Promise<ExportJSON>;
  importDoc: (doc: ExportJSON) => Promise<number>;
  importLegacy: (connStr: string, alias?: string) => Promise<NodeMeta>;
}

export const useDesktopStore = create<DesktopState>()((set, get) => ({
  nodes: seedNodes,
  nodesLoading: false,
  history: [],
  leftTab: 'hist',
  nodeKeyword: '',
  slotA: null,
  slotB: null,
  scopes: ['table', 'view', 'procedure', 'function'],
  tableFilter: '',
  diffFilter: 'ALL',
  objectTypeFilter: 'ALL',
  items: [],
  selectedId: null,
  comparing: false,
  progress: '',
  progressPct: 0,
  lastComboText: '',
  toast: null,
  setLeftTab: (t) => set({ leftTab: t }),
  setNodeKeyword: (kw) => set({ nodeKeyword: kw }),
  assignNode: (id) =>
    set((s) => {
      const next = !s.slotA
        ? { slotA: id }
        : !s.slotB
          ? { slotB: id }
          : s.slotA === id
            ? {}
            : { slotB: id };
      const aId = next.slotA !== undefined ? next.slotA : s.slotA;
      const bId = next.slotB !== undefined ? next.slotB : s.slotB;
      writeLastCombo(aId ?? null, bId ?? null);
      return next;
    }),
  setSlot: (which, id) =>
    set((s) => {
      const next = which === 'A' ? { slotA: id } : { slotB: id };
      writeLastCombo(which === 'A' ? id : s.slotA, which === 'B' ? id : s.slotB);
      return next;
    }),
  swapSlots: () =>
    set((s) => {
      writeLastCombo(s.slotB, s.slotA);
      return { slotA: s.slotB, slotB: s.slotA };
    }),
  clearSlots: () => {
    writeLastCombo(null, null);
    set({ slotA: null, slotB: null });
  },
  toggleScope: (scope) =>
    set((s) => ({
      scopes: s.scopes.includes(scope) ? s.scopes.filter((x) => x !== scope) : [...s.scopes, scope],
    })),
  setTableFilter: (v) => set({ tableFilter: v }),
  setDiffFilter: (f) => set({ diffFilter: f, selectedId: null }),
  setObjectTypeFilter: (f) => set({ objectTypeFilter: f, selectedId: null }),
  selectDiff: (id) => set({ selectedId: id }),
  setToast: (msg) => set({ toast: msg }),
  toggleStar: (id) => {
    const cur = get().nodes.find((n) => n.id === id);
    if (!cur) return;
    const star = !cur.star;
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, star } : n)) }));
    const api = getIpc();
    if (api) {
      void api.nodes
        .update({ id, patch: { star } })
        .catch(() => undefined);
    }
  },

  refreshNodes: async () => {
    const api = getIpc();
    if (!api) return;
    set({ nodesLoading: true });
    try {
      const nodes = await api.nodes.list();
      if (Array.isArray(nodes) && nodes.length > 0) {
        set({ nodes });
        // 记忆上次组合：IPC 节点到位后恢复 A/B。
        const { slotA, slotB } = get();
        if (!slotA && !slotB) {
          const last = readLastCombo();
          const ids = new Set(nodes.map((n) => n.id));
          set({
            slotA: last.aId && ids.has(last.aId) ? last.aId : null,
            slotB: last.bId && ids.has(last.bId) ? last.bId : null,
          });
        }
      }
    } catch {
      // 后端不可用时保留种子节点，保证离线可用。
    } finally {
      set({ nodesLoading: false });
    }
  },

  refreshHistory: async () => {
    const api = getIpc();
    if (!api) return;
    try {
      const history = await api.history.list();
      if (Array.isArray(history)) set({ history });
    } catch {
      // 忽略，保持空历史。
    }
  },

  saveNode: async (input, editingId) => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以管理节点');
    if (editingId) {
      const { secret, ...rest } = input;
      const updated = await api.nodes.update({
        id: editingId,
        patch: { ...rest },
        secret,
      });
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === editingId ? updated : n)) }));
      return updated;
    }
    const created = await api.nodes.create(input);
    set((s) => ({ nodes: [...s.nodes, created] }));
    return created;
  },

  removeNode: async (id) => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以管理节点');
    await api.nodes.remove(id);
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      slotA: s.slotA === id ? null : s.slotA,
      slotB: s.slotB === id ? null : s.slotB,
    }));
  },

  testNode: async (id) => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以测试连接');
    return api.nodes.test(id);
  },

  testDraft: async (node, secret) => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以测试连接');
    return api.conn.test(node, secret ?? {});
  },

  exportDoc: async () => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以导出节点');
    return api.nodes.export();
  },

  importDoc: async (doc) => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以导入节点');
    const r = await api.nodes.import(doc);
    await get().refreshNodes();
    return r.imported;
  },

  importLegacy: async (connStr, alias) => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以导入连接串');
    const meta = await api.nodes.importLegacy(connStr, alias);
    set((s) => ({ nodes: [...s.nodes, meta] }));
    return meta;
  },

  runCompare: async () => {
    const s = get();
    if (s.comparing) return;
    if (!s.slotA || !s.slotB) {
      set({ toast: '请先在 A / B 槽各放入一个节点（拖拽或下拉选择）' });
      return;
    }
    if (s.scopes.length === 0) {
      set({ toast: '请至少勾选一个对比范围（表 / 视图 / 过程 / 函数）' });
      return;
    }
    const api = getIpc();
    const { slotA, slotB, scopes, tableFilter } = s;
    const nodes = s.nodes;
    const aliasOf = (id: string | null): string =>
      nodes.find((n) => n.id === id)?.alias ?? (id ?? '未选');
    set({ comparing: true, progressPct: 8, progress: '连接 A / B …' });
    const tick = (pct: number, text: string): void => {
      set({ progressPct: pct, progress: text });
    };
    try {
      if (api) {
        tick(30, '拉取元数据（information_schema + SHOW CREATE）…');
        const result = await api.compare.run({
          aId: slotA,
          bId: slotB,
          scopes,
          tableFilter,
        });
        tick(85, '分类 + 风险评估…');
        set({
          items: result.items,
          selectedId: null,
          diffFilter: 'ALL',
          lastComboText: `${aliasOf(slotA)} → ${aliasOf(slotB)} · ${scopes.join('/')} · ${new Date().toLocaleTimeString()} · ${result.stats.ALL} 条差异`,
          toast: `对比完成：发现 ${result.stats.ALL} 条差异`,
        });
        // 成功后刷新历史 + 本地使用频次（常用 Tab 排序依据），频次顺手持久化到主进程。
        set((prev) => ({
          nodes: prev.nodes.map((n) =>
            n.id === slotA || n.id === slotB ? { ...n, useCount: (n.useCount ?? 0) + 1 } : n,
          ),
        }));
        for (const id of [slotA, slotB]) {
          const n = get().nodes.find((x) => x.id === id);
          if (n && api) {
            void api.nodes
              .update({ id, patch: { useCount: n.useCount ?? 1 } })
              .catch(() => undefined);
          }
        }
        void get()
          .refreshHistory()
          .catch(() => undefined);
      } else {
        throw new Error('no-ipc');
      }
    } catch (err) {
      // 无后端 / 种子节点不在 vault / 连接失败时：本地示例降级，保证三栏可交互演示。
      const demo = runDemoCompare(scopes, tableFilter);
      const isNoIpc = err instanceof Error && err.message === 'no-ipc';
      const reason =
        err instanceof Error && err.message !== 'no-ipc' ? `（${err.message}）` : '';
      set({
        items: demo.items,
        selectedId: null,
        diffFilter: 'ALL',
        lastComboText: `${aliasOf(slotA)} → ${aliasOf(slotB)} · 本地示例数据${reason}`,
        toast: isNoIpc
          ? `已用本地示例数据演示（${demo.stats.ALL} 条）`
          : `后端对比失败，已用本地示例数据演示${reason}`,
      });
    } finally {
      tick(100, '');
      set({ comparing: false, progressPct: 0, progress: '' });
    }
  },
}));
