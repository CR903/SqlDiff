import { create } from 'zustand';
import type { ChangeType,
  ConnTestResult,
  DataTablePair,
  DataTableStatus,
  DiffItem,
  ExportJSON,
  HistoryEntry,
  NodeMeta,
  ObjectType,
  ObjectTypeWithData,
  SecretBundle,
  StmtAspect,
  Verb,
} from '../src-core/types';
import { sanitizeIpcError } from '../src-core/ipc-error';
import {
  DEFAULT_BATCH_ROWS,
  DEFAULT_INSERT_BATCH,
  DEFAULT_ROW_THRESHOLD,
  MAX_BATCH_ROWS,
  MAX_INSERT_BATCH,
  MAX_ROW_THRESHOLD,
  MIN_BATCH_ROWS,
  MIN_INSERT_BATCH,
  MIN_ROW_THRESHOLD,
  normalizeBatchRows,
  normalizeInsertBatch,
  normalizeRowThreshold,
} from '../src-core/data-options';
import type {
  DataTableLists,
  DBeaverExportResult,
  NodeCreateInput,
  SqlDiffApi,
} from '../src-main/preload';
import { runDemoCompare } from './demo';

export type LeftTab = 'all' | 'hist' | 'mine' | 'fav';
export type DiffFilter = 'ALL' | ChangeType;
export type SlotId = 'A' | 'B';
/** R4 对象多选（含数据行 'data'；'ALL'/空数组/选满 = 不限，组内 OR、组间 AND）。 */
export type ObjectTypeFilter = 'ALL' | ObjectTypeWithData[];
/** R4 切面多选（INDEX chip 等；'ALL'/空数组/选满 = 不限，组内 OR）。 */
export type AspectFilter = 'ALL' | StmtAspect[];
/** R7 动词桶过滤（CREATE/DROP/ALTER/INSERT/UPDATE/DELETE 多选；'ALL' = 不限），与对象/切面/Tab/关键字正交 AND。 */
export type VerbFilter = 'ALL' | Verb[];
/** 动词 chips 行展示的六桶（OTHER 无桶，不可点选）。 */
export const VERB_CHIPS: Verb[] = ['CREATE', 'DROP', 'ALTER', 'INSERT', 'UPDATE', 'DELETE'];
/** 对象 chips（含数据；回落 ALL 判定用）与切面全集（回落 ALL 判定用）。 */
export const OBJECT_CHIPS: ObjectTypeWithData[] = ['table', 'view', 'procedure', 'function', 'data'];
export const ASPECT_ALL: StmtAspect[] = ['column', 'primary', 'index', 'table', 'routine', 'data'];

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

/** 数据逐表状态 -> 中文（进度条文本用）。 */
function tableStatusText(status: string): string {
  if (status === 'running') return '对比中';
  if (status === 'done') return '完成';
  if (status === 'skipped') return '跳过（无可用行身份）';
  if (status === 'error') return '失败';
  if (status === 'confirm-needed') return '超阈待确认';
  return status;
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
  /** 数据对比开关（范围勾选“数据”，与结构四项并列）。 */
  includeData: boolean;
  /** 数据表映射（同名自动 + 手动改 B 下拉；空则服务端按同名交集跑）。 */
  dataPairs: DataTablePair[];
  /** A/B 表清单（映射下拉选项，载入后填充）。 */
  dataLists: DataTableLists;
  dataListsLoading: boolean;
  /** 逐表状态行（待比/进行中/完成/跳过/失败/待确认）。 */
  dataStatus: DataTableStatus[];
  /** 超阈大表已二次确认（重跑时透传 dataOptions.confirmOverThreshold）。 */
  confirmDataThreshold: boolean;
  /** 数据对比可调参数（R2：分页批量 / 行阈值 / INSERT 分批，非法越界回落默认+toast）。 */
  dataBatchRows: number;
  dataThreshold: number;
  dataInsertBatch: number;
  /** 差异 focus：当前 Tab + 对象/切面多选过滤 + 选中行 */
  diffFilter: DiffFilter;
  objectTypeFilter: ObjectTypeFilter;
  /** R4 切面多选（INDEX chip 等），跨对比保留（派生过滤自动生效）。 */
  aspectFilter: AspectFilter;
  /** R7 动词桶（多选 chips，空/'ALL' = 不限；与对象/切面/Tab 正交 AND，单表统一约束）。 */
  verbFilter: VerbFilter;
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
  setAspectFilter: (f: AspectFilter) => void;
  setVerbFilter: (f: VerbFilter) => void;
  /** 对象 chip 开关：点选增删单个对象（含数据）；清空或选满五类时回落 'ALL'。 */
  toggleObjectType: (o: ObjectTypeWithData) => void;
  /** 切面 chip 开关：点选增删单个切面；清空或选满全集时回落 'ALL'。 */
  toggleAspect: (a: StmtAspect) => void;
  /** 动词 chip 开关：点选增删单个动词；清空或选满六桶时回落 'ALL'。 */
  toggleVerb: (v: Verb) => void;
  toggleIncludeData: () => void;
  setDataPairs: (pairs: DataTablePair[]) => void;
  setDataPairB: (index: number, b: string) => void;
  removeDataPair: (index: number) => void;
  addDataPair: (a: string, b: string) => void;
  setConfirmDataThreshold: (v: boolean) => void;
  /** 数据可调参数 setters（接受输入框字符串；非法/越界回落默认并 toast）。 */
  setDataBatchRows: (v: unknown) => void;
  setDataThreshold: (v: unknown) => void;
  setDataInsertBatch: (v: unknown) => void;
  refreshDataTables: () => Promise<void>;
  selectDiff: (id: string | null) => void;
  setToast: (msg: string | null) => void;
  toggleStar: (id: string) => void;
  refreshNodes: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  runCompare: () => Promise<void>;
  cancelCompare: () => Promise<void>;
  /** 新增 / 编辑节点（secret 为空表示不改动密钥；新建时可留空）。无主进程时抛错。 */
  saveNode: (input: NodeCreateInput, editingId?: string | null) => Promise<NodeMeta>;
  removeNode: (id: string) => Promise<void>;
  testNode: (id: string) => Promise<ConnTestResult>;
  /** 表单免保存测试：直收 {node, secret} 走 conn.test，不写 vault。 */
  testDraft: (node: NodeMeta, secret?: SecretBundle) => Promise<ConnTestResult>;
  exportDoc: () => Promise<ExportJSON>;
  exportDbeaver: (ids: string[]) => Promise<DBeaverExportResult>;
  importDoc: (doc: ExportJSON) => Promise<number>;
  importLegacy: (connStr: string, alias?: string) => Promise<NodeMeta>;
}

export const useDesktopStore = create<DesktopState>()((set, get) => ({
  nodes: seedNodes,
  nodesLoading: false,
  history: [],
  leftTab: 'all',
  nodeKeyword: '',
  slotA: null,
  slotB: null,
  scopes: ['table', 'view', 'procedure', 'function'],
  tableFilter: '',
  includeData: false,
  dataPairs: [],
  dataLists: { a: [], b: [] },
  dataListsLoading: false,
  dataStatus: [],
  confirmDataThreshold: false,
  dataBatchRows: DEFAULT_BATCH_ROWS,
  dataThreshold: DEFAULT_ROW_THRESHOLD,
  dataInsertBatch: DEFAULT_INSERT_BATCH,
  diffFilter: 'ALL',
  objectTypeFilter: 'ALL',
  aspectFilter: 'ALL',
  verbFilter: 'ALL',
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
  setAspectFilter: (f) => set({ aspectFilter: f, selectedId: null }),
  setVerbFilter: (f) => set({ verbFilter: f, selectedId: null }),
  toggleObjectType: (o) =>
    set((s) => {
      const cur = s.objectTypeFilter === 'ALL' ? [] : s.objectTypeFilter;
      const next = cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o];
      // 清空（不限）或选满五类（= 不限）都回落 'ALL'，保证开关可逆可见。
      const objectTypeFilter: ObjectTypeFilter =
        next.length === 0 || next.length >= OBJECT_CHIPS.length ? 'ALL' : next;
      return { objectTypeFilter, selectedId: null };
    }),
  toggleAspect: (a) =>
    set((s) => {
      const cur = s.aspectFilter === 'ALL' ? [] : s.aspectFilter;
      const next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a];
      // 清空（不限）或选满全集（= 不限）都回落 'ALL'，保证开关可逆可见。
      const aspectFilter: AspectFilter =
        next.length === 0 || next.length >= ASPECT_ALL.length ? 'ALL' : next;
      return { aspectFilter, selectedId: null };
    }),
  toggleVerb: (v) =>
    set((s) => {
      const cur = s.verbFilter === 'ALL' ? [] : s.verbFilter;
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      // 清空（不限）或选满六桶（= 不限）都回落 'ALL'，保证开关可逆可见。
      const verbFilter: VerbFilter = next.length === 0 || next.length >= VERB_CHIPS.length ? 'ALL' : next;
      return { verbFilter, selectedId: null };
    }),
  toggleIncludeData: () => set((s) => ({ includeData: !s.includeData })),
  setDataPairs: (pairs) => set({ dataPairs: pairs }),
  setDataPairB: (index, b) =>
    set((s) => ({ dataPairs: s.dataPairs.map((p, i) => (i === index ? { ...p, b } : p)) })),
  removeDataPair: (index) => set((s) => ({ dataPairs: s.dataPairs.filter((_, i) => i !== index) })),
  addDataPair: (a, b) => {
    if (!a || !b) return;
    set((s) =>
      s.dataPairs.some((p) => p.a === a && p.b === b) ? {} : { dataPairs: [...s.dataPairs, { a, b }] },
    );
  },
  setConfirmDataThreshold: (v) => set({ confirmDataThreshold: v }),
  setDataBatchRows: (v) => {
    const r = normalizeBatchRows(v);
    set({
      dataBatchRows: r.value,
      ...(r.adjusted
        ? { toast: `分页批量非法/越界，已回落默认 ${DEFAULT_BATCH_ROWS}（范围 ${MIN_BATCH_ROWS}-${MAX_BATCH_ROWS}）` }
        : {}),
    });
  },
  setDataThreshold: (v) => {
    const r = normalizeRowThreshold(v);
    set({
      dataThreshold: r.value,
      ...(r.adjusted
        ? { toast: `行阈值非法/越界，已回落默认 ${DEFAULT_ROW_THRESHOLD}（范围 ${MIN_ROW_THRESHOLD}-${MAX_ROW_THRESHOLD}，超阈仍需二次确认）` }
        : {}),
    });
  },
  setDataInsertBatch: (v) => {
    const r = normalizeInsertBatch(v);
    set({
      dataInsertBatch: r.value,
      ...(r.adjusted
        ? { toast: `INSERT 分批非法/越界，已回落默认 ${DEFAULT_INSERT_BATCH}（范围 ${MIN_INSERT_BATCH}-${MAX_INSERT_BATCH}）` }
        : {}),
    });
  },
  refreshDataTables: async () => {
    const s = get();
    const api = getIpc();
    if (!api) {
      set({ toast: '当前为预览模式（无主进程），请在 Electron 中运行以载入表清单' });
      return;
    }
    if (!s.slotA || !s.slotB) {
      set({ toast: '请先在 A / B 槽各放入一个节点' });
      return;
    }
    set({ dataListsLoading: true });
    try {
      const lists = await api.data.tables(s.slotA, s.slotB);
      const inB = new Set(lists.b);
      const auto = lists.a.filter((t) => inB.has(t)).map((t) => ({ a: t, b: t }));
      set({
        dataLists: lists,
        dataPairs: auto,
        toast: `已载入表清单：A ${lists.a.length} / B ${lists.b.length}，同名配对 ${auto.length} 对`,
      });
    } catch (err) {
      // P1a：IPC 错误剥前缀展示（conn 测试等同规则）。
      set({ toast: sanitizeIpcError(err) });
    } finally {
      set({ dataListsLoading: false });
    }
  },
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

  exportDbeaver: async (ids) => {
    const api = getIpc();
    if (!api) throw new Error('当前为预览模式（无主进程），请在 Electron 中运行以导出 DBeaver 配置');
    try {
      return await api.nodes.exportDbeaver(ids);
    } catch (err) {
      throw new Error(sanitizeIpcError(err));
    }
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
    if (s.scopes.length === 0 && !s.includeData) {
      set({ toast: '请至少勾选一个对比范围（表 / 视图 / 过程 / 函数 / 数据）' });
      return;
    }
    const api = getIpc();
    const { slotA, slotB, scopes, tableFilter, includeData, dataPairs, confirmDataThreshold } = s;
    const { dataBatchRows, dataThreshold, dataInsertBatch } = s;
    const nodes = s.nodes;
    const aliasOf = (id: string | null): string =>
      nodes.find((n) => n.id === id)?.alias ?? (id ?? '未选');
    set({ comparing: true, progressPct: 8, progress: '连接 A / B …' });
    const tick = (pct: number, text: string): void => {
      set({ progressPct: pct, progress: text });
    };
    // 数据进度订阅（主进程 compare.progress 事件；demo/无后端时为空）。
    const unsub = api
      ? api.compare.onProgress((msg) => {
          if (msg.type === 'fetch') {
            const pct =
              msg.total > 0 ? 30 + Math.min(60, Math.round((msg.fetched / msg.total) * 60)) : 50;
            tick(pct, `数据 ${msg.table} 拉取 ${msg.side}: ${msg.fetched}/${msg.total}`);
          } else {
            tick(50, `数据 ${msg.table}：${tableStatusText(msg.status)}${msg.detail ? `（${msg.detail}）` : ''}`);
          }
        })
      : null;
    try {
      if (api) {
        tick(30, '拉取元数据（information_schema + SHOW CREATE）…');
        const result = await api.compare.run({
          aId: slotA,
          bId: slotB,
          scopes: includeData ? [...scopes, 'data'] : scopes,
          tableFilter,
          includeData,
          ...(dataPairs.length > 0 ? { dataTables: dataPairs } : {}),
          ...(includeData
            ? {
                dataOptions: {
                  batchRows: dataBatchRows,
                  insertBatch: dataInsertBatch,
                  threshold: dataThreshold,
                  ...(confirmDataThreshold ? { confirmOverThreshold: true } : {}),
                },
              }
            : {}),
        });
        tick(85, '分类 + 风险评估…');
        const dataNote =
          result.dataTables && result.dataTables.length > 0
            ? ` · 数据 ${result.dataTables.length} 表（I${result.stats.DML.INSERT}/D${result.stats.DML.DELETE}/U${result.stats.DML.UPDATE}）`
            : '';
        const needConfirm = (result.dataTables ?? []).some((t) => t.status === 'confirm-needed');
        set({
          items: result.items,
          dataStatus: result.dataTables ?? [],
          selectedId: null,
          diffFilter: 'ALL',
          verbFilter: 'ALL',
          confirmDataThreshold: false,
          lastComboText: `${aliasOf(slotA)} → ${aliasOf(slotB)} · ${scopes.join('/')}${includeData ? '/data' : ''} · ${new Date().toLocaleTimeString()} · ${result.stats.ALL} 条差异${dataNote}`,
          toast: needConfirm
            ? '对比完成：部分大表超阈待确认，请二次确认后重跑'
            : `对比完成：发现 ${result.stats.ALL} 条差异${dataNote}`,
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
      // P1a：对比兜底 reason/toast 只展示消毒后的中文 message（无 `Error invoking` 前缀）。
      const demo = runDemoCompare(scopes, tableFilter);
      const clean = sanitizeIpcError(err);
      const isNoIpc = clean === 'no-ipc';
      const reason = !isNoIpc && clean ? `（${clean}）` : '';
      set({
        items: demo.items,
        dataStatus: [],
        selectedId: null,
        diffFilter: 'ALL',
        verbFilter: 'ALL',
        confirmDataThreshold: false,
        lastComboText: `${aliasOf(slotA)} → ${aliasOf(slotB)} · 本地示例数据${reason}`,
        toast: isNoIpc
          ? `已用本地示例数据演示（${demo.stats.ALL} 条，数据对比需 Electron 后端）`
          : `后端对比失败，已用本地示例数据演示${reason}`,
      });
    } finally {
      try {
        unsub?.();
      } catch {
        // 忽略取消订阅异常。
      }
      tick(100, '');
      set({ comparing: false, progressPct: 0, progress: '' });
    }
  },

  cancelCompare: async () => {
    const api = getIpc();
    if (!api) return;
    try {
      await api.compare.cancel();
      set({ toast: '已发送取消请求，正在中断数据拉取…' });
    } catch {
      // 忽略。
    }
  },
}));
