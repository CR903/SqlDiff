import { contextBridge, ipcRenderer } from 'electron';
import type {
  CompareRequest,
  CompareResult,
  ConnTestResult,
  ExportJSON,
  HistoryEntry,
  NodeMeta,
  SecretBundle,
  SshConfig,
} from '../src-core/types';

// M2：nodes CRUD / test / export / import / 老串导入 + history 接 vault。
// M3：conn.test / nodes.test 接真实 mysql2/ssh2（含延迟 ms），见 ./connection。
// M4：compare.run 接 core diff 引擎。
// M5：sql.format（sql-formatter）/ copy / export（DROP 二次确认在渲染层）。

/** 新建节点输入：meta 字段（id/createdAt 由 main 生成）+ 可选密钥（结构化表单字段，不拼串）。 */
export interface NodeCreateInput {
  alias: string;
  host: string;
  port?: number;
  user: string;
  database: string;
  group?: string;
  tags?: string[];
  star?: boolean;
  pinned?: boolean;
  useCount?: number;
  ssh?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    user?: string;
    authType?: 'password' | 'privateKey';
  };
  secret?: SecretBundle;
}

export interface NodeUpdateInput {
  id: string;
  /** ssh 允许部分更新（main 侧与 base 合并，缺省字段保留原值）。 */
  patch?: Partial<Omit<NodeMeta, 'id' | 'createdAt' | 'ssh'>> & { ssh?: Partial<SshConfig> };
  /** 传 null 表示删除该节点密钥；undefined 表示不动密钥。 */
  secret?: SecretBundle | null;
}

/** 数据表清单（表映射下拉用：同名自动 + 手动改 B）。 */
export interface DataTableLists {
  a: string[];
  b: string[];
}

export interface NodesImportResult {
  imported: number;
}

/** 主进程 -> 渲染的数据对比进度事件（compare.progress 通道）。 */
export type CompareProgressEvent =
  | { type: 'table'; table: string; status: string; detail?: string }
  | { type: 'fetch'; table: string; side: 'A' | 'B'; fetched: number; total: number };

export interface SqlDiffApi {
  nodes: {
    list: () => Promise<NodeMeta[]>;
    create: (input: NodeCreateInput) => Promise<NodeMeta>;
    update: (input: NodeUpdateInput) => Promise<NodeMeta>;
    /** 通道 'nodes.delete'（方法名避开保留字，用 remove）。 */
    remove: (id: string) => Promise<boolean>;
    /** M2 占位：存在性校验通过后返回 NOT_IMPLEMENTED，M3 接真实测试。 */
    test: (id: string) => Promise<ConnTestResult>;
    export: () => Promise<ExportJSON>;
    import: (doc: ExportJSON) => Promise<NodesImportResult>;
    /** 老 CLI 连接串一键解析导入（兼容 Tools.js:10-31）。 */
    importLegacy: (connStr: string, alias?: string) => Promise<NodeMeta>;
  };
  history: {
    list: () => Promise<HistoryEntry[]>;
    append: (entry: HistoryEntry) => Promise<HistoryEntry[]>;
    clear: () => Promise<boolean>;
  };
  /** M3：连通测试直收 {node, secret}（nodes.test 按 id 走 vault，语义相同）。 */
  conn: {
    test: (node: NodeMeta, secret?: SecretBundle) => Promise<ConnTestResult>;
  };
  compare: {
    run: (req: CompareRequest) => Promise<CompareResult>;
    /** 取消进行中的数据拉取（AbortSignal，主进程侧中断分页循环）。 */
    cancel: () => Promise<boolean>;
    /** 订阅数据对比进度（返回取消订阅函数）。 */
    onProgress: (cb: (msg: CompareProgressEvent) => void) => () => void;
  };
  data: {
    /** A/B 表清单（表映射下拉选项）。 */
    tables: (aId: string, bId: string) => Promise<DataTableLists>;
  };
  sql: {
    format: (sql: string) => Promise<string>;
    copy: (text: string) => Promise<boolean>;
  };
}

const api: SqlDiffApi = {
  nodes: {
    list: () => ipcRenderer.invoke('nodes.list') as Promise<NodeMeta[]>,
    create: (input: NodeCreateInput) => ipcRenderer.invoke('nodes.create', input) as Promise<NodeMeta>,
    update: (input: NodeUpdateInput) => ipcRenderer.invoke('nodes.update', input) as Promise<NodeMeta>,
    remove: (id: string) => ipcRenderer.invoke('nodes.delete', id) as Promise<boolean>,
    test: (id: string) => ipcRenderer.invoke('nodes.test', id) as Promise<ConnTestResult>,
    export: () => ipcRenderer.invoke('nodes.export') as Promise<ExportJSON>,
    import: (doc: ExportJSON) => ipcRenderer.invoke('nodes.import', doc) as Promise<NodesImportResult>,
    importLegacy: (connStr: string, alias?: string) =>
      ipcRenderer.invoke('nodes.import-legacy', connStr, alias) as Promise<NodeMeta>,
  },
  history: {
    list: () => ipcRenderer.invoke('history.list') as Promise<HistoryEntry[]>,
    append: (entry: HistoryEntry) => ipcRenderer.invoke('history.append', entry) as Promise<HistoryEntry[]>,
    clear: () => ipcRenderer.invoke('history.clear') as Promise<boolean>,
  },
  conn: {
    test: (node: NodeMeta, secret?: SecretBundle) =>
      ipcRenderer.invoke('conn.test', { node, secret }) as Promise<ConnTestResult>,
  },
  compare: {
    run: (req: CompareRequest) => ipcRenderer.invoke('compare.run', req) as Promise<CompareResult>,
    cancel: () => ipcRenderer.invoke('compare.cancel') as Promise<boolean>,
    onProgress: (cb: (msg: CompareProgressEvent) => void) => {
      const handler = (_event: unknown, msg: CompareProgressEvent): void => cb(msg);
      ipcRenderer.on('compare.progress', handler as (...args: unknown[]) => void);
      return () => ipcRenderer.removeListener('compare.progress', handler as (...args: unknown[]) => void);
    },
  },
  data: {
    tables: (aId: string, bId: string) =>
      ipcRenderer.invoke('data.tables', aId, bId) as Promise<DataTableLists>,
  },
  sql: {
    format: (sql: string) => ipcRenderer.invoke('sql.format', sql) as Promise<string>,
    copy: (text: string) => ipcRenderer.invoke('sql.copy', text) as Promise<boolean>,
  },
};

contextBridge.exposeInMainWorld('sqldiff', api);

declare global {
  interface Window {
    sqldiff: SqlDiffApi;
  }
}
