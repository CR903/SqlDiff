import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, safeStorage, session } from 'electron';
import type { Pool } from 'mysql2/promise';
import type {
  ConnTestResult,
  ExportJSON,
  HistoryEntry,
  NodeMeta,
  SecretBundle,
} from '../src-core/types';
import type { NodeCreateInput, NodeUpdateInput, NodesImportResult } from './preload';
import { runCompareRequest } from './compare-run';
import { format as formatSql } from 'sql-formatter';
import type { CompareRequest } from '../src-core/types';
import {
  appendHistory,
  clearHistory,
  isHistoryEntry,
  loadHistory,
  loadNodes,
  resolveUserDataDir,
  saveNodes,
} from './store-json';
import { Vault, parseLegacyConnectionString, type SafeStorageLike } from './vault';
import { closeAll, createMysqlPool, testConnection } from './connection';
import { registerWillDownload } from './download';
import { listTables } from './metadata';

// M2：vault（safeStorage + OS 钥匙串 / AES-GCM 回退）+ nodes.json / history.json 接线。
// M3：mysql2/promise + ssh2 单跳隧道池；nodes.test 走 vault 取密钥后调 testConnection，
// 另有 conn.test 直收 {node, secret}（渲染层内存密钥/表单免保存测试场景）。
// M4：compare.run 接 core diff 引擎（diffTable / diffTableField / diffProcedure 系，语义与老 mysqldiff 一致）。
// M5：compare.run 经 compare-run.ts（元数据拉取 + core 对比 + 历史落盘）；sql.format 走 sql-formatter。

let win: BrowserWindow | null = null;

interface MainContext {
  userDataDir: string;
  vault: Vault;
}

let ctx: MainContext | null = null;

function getContext(): MainContext {
  if (ctx) return ctx;
  const userDataDir = resolveUserDataDir(process.env.SQLDIFF_USER_DATA_DIR || app.getPath('userData'));
  let storage: SafeStorageLike | null = null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      storage = {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain: string) => safeStorage.encryptString(plain),
        decryptString: (enc: Buffer) => safeStorage.decryptString(enc),
      };
    }
  } catch {
    storage = null;
  }
  ctx = { userDataDir, vault: new Vault({ userDataDir, safeStorage: storage }) };
  return ctx;
}

// -- 节点输入校验/归一化 ----------------------------------------------------

function assertNonEmpty(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`nodes: 字段 ${field} 必填`);
  }
}

function normalizePort(raw: unknown, fallback: number, field: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`nodes: 字段 ${field} 须为 1-65535 的端口号`);
  }
  return n;
}

function buildNodeMeta(input: Omit<NodeCreateInput, 'secret'> & { secret?: unknown }, base?: NodeMeta): NodeMeta {
  const src = { ...(base ?? {}), ...stripSecret(input) } as Partial<NodeMeta>;
  assertNonEmpty('alias', src.alias);
  assertNonEmpty('host', src.host);
  assertNonEmpty('user', src.user);
  assertNonEmpty('database', src.database);
  const sshIn = (input as { ssh?: Record<string, unknown> }).ssh ?? {};
  const baseSsh = base?.ssh;
  const authType = sshIn.authType ?? baseSsh?.authType ?? 'password';
  if (authType !== 'password' && authType !== 'privateKey') {
    throw new Error('nodes: ssh.authType 仅支持 password/privateKey');
  }
  return {
    id: base?.id ?? randomUUID(),
    alias: (src.alias as string).trim(),
    host: (src.host as string).trim(),
    port: normalizePort(src.port, 3306, 'port'),
    user: (src.user as string).trim(),
    database: (src.database as string).trim(),
    ...(typeof src.group === 'string' && src.group ? { group: src.group } : {}),
    ...(Array.isArray(src.tags) ? { tags: src.tags.filter((t): t is string => typeof t === 'string') } : {}),
    ...(typeof src.star === 'boolean' ? { star: src.star } : {}),
    ...(typeof src.pinned === 'boolean' ? { pinned: src.pinned } : {}),
    ...(typeof src.useCount === 'number' ? { useCount: Math.max(0, Math.floor(src.useCount)) } : {}),
    ssh: {
      enabled: Boolean(sshIn.enabled ?? baseSsh?.enabled ?? false),
      host: String(sshIn.host ?? baseSsh?.host ?? ''),
      port: normalizePort(sshIn.port ?? baseSsh?.port ?? 22, 22, 'ssh.port'),
      user: String(sshIn.user ?? baseSsh?.user ?? ''),
      authType,
    },
    createdAt: base?.createdAt ?? new Date().toISOString(),
  };
}

/** 创建/更新输入里的 secret 走 vault，不进 nodes.json。 */
function stripSecret<T extends { secret?: unknown }>(input: T): Omit<T, 'secret'> {
  const { secret: _secret, ...rest } = input;
  void _secret;
  return rest;
}

function applySecret(vault: Vault, id: string, secret: SecretBundle | null | undefined): void {
  if (secret === undefined) return;
  if (secret === null) {
    vault.deleteNodeSecret(id);
    return;
  }
  vault.saveNodeSecret(id, secret);
}

// -- IPC --------------------------------------------------------------------

function registerNodesIpc(): void {
  ipcMain.handle('nodes.list', () => loadNodes(getContext().userDataDir));

  ipcMain.handle('nodes.create', (_event, input: NodeCreateInput) => {
    const { userDataDir, vault } = getContext();
    if (!input || typeof input !== 'object') throw new Error('nodes: 创建参数非法');
    const meta = buildNodeMeta(input);
    const nodes = loadNodes(userDataDir);
    nodes.push(meta);
    saveNodes(userDataDir, nodes);
    try {
      applySecret(vault, meta.id, input.secret);
    } catch (err) {
      // meta 已落盘，密钥失败则回滚节点，避免"无密裸节点"残留。
      saveNodes(
        userDataDir,
        loadNodes(userDataDir).filter((n) => n.id !== meta.id),
      );
      throw err;
    }
    return meta;
  });

  ipcMain.handle('nodes.update', (_event, input: NodeUpdateInput) => {
    const { userDataDir, vault } = getContext();
    if (!input || typeof input.id !== 'string') throw new Error('nodes: 更新缺少 id');
    const nodes = loadNodes(userDataDir);
    const idx = nodes.findIndex((n) => n.id === input.id);
    if (idx === -1) throw new Error(`nodes: 未找到节点 ${input.id}`);
    const merged: Omit<NodeCreateInput, 'secret'> & { secret?: SecretBundle | null } = {
      ...nodes[idx],
      ...(input.patch ?? {}),
      secret: input.secret,
    };
    const updated = buildNodeMeta(merged, nodes[idx]);
    nodes[idx] = updated;
    saveNodes(userDataDir, nodes);
    applySecret(vault, updated.id, input.secret);
    return updated;
  });

  ipcMain.handle('nodes.delete', (_event, id: string) => {
    const { userDataDir, vault } = getContext();
    if (typeof id !== 'string' || !id) throw new Error('nodes: 删除缺少 id');
    const nodes = loadNodes(userDataDir);
    const kept = nodes.filter((n) => n.id !== id);
    if (kept.length === nodes.length) return false;
    saveNodes(userDataDir, kept);
    vault.deleteNodeSecret(id);
    return true;
  });

  // M3：真实连通测试（mysql2 直连或经 ssh2 单跳隧道，返回延迟 ms）。
  ipcMain.handle('nodes.test', async (_event, id: string): Promise<ConnTestResult> => {
    const { userDataDir, vault } = getContext();
    if (typeof id !== 'string' || !id) throw new Error('nodes: 测试缺少 id');
    const node = loadNodes(userDataDir).find((n) => n.id === id);
    if (!node) throw new Error(`nodes: 未找到节点 ${id}`);
    return testConnection(node, vault.getNodeSecret(id) ?? {});
  });

  // M3：直收 {node, secret} 的连通测试（渲染层持有内存密钥时用，免走 vault 落盘）。
  ipcMain.handle(
    'conn.test',
    async (_event, payload: { node: NodeMeta; secret?: SecretBundle }): Promise<ConnTestResult> => {
      const node = payload?.node;
      if (!node || typeof node.id !== 'string') throw new Error('conn: 测试缺少合法 node');
      return testConnection(node, payload.secret ?? {});
    },
  );

  ipcMain.handle('nodes.export', (): ExportJSON => {
    const { userDataDir, vault } = getContext();
    const nodes = loadNodes(userDataDir);
    return vault.exportEncrypted(
      nodes.map((meta) => ({ meta, secret: vault.getNodeSecret(meta.id) ?? {} })),
    );
  });

  ipcMain.handle('nodes.import', (_event, doc: ExportJSON): NodesImportResult => {
    const { userDataDir, vault } = getContext();
    const pairs = vault.importDecrypted(doc);
    const nodes = loadNodes(userDataDir);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const { meta, secret } of pairs) {
      byId.set(meta.id, meta);
      vault.saveNodeSecret(meta.id, secret);
    }
    saveNodes(userDataDir, [...byId.values()]);
    return { imported: pairs.length };
  });

  // R7：老 CLI 连接串一键解析导入（密码含特殊字符请走表单，此处仅迁移）。
  ipcMain.handle('nodes.import-legacy', (_event, connStr: string, alias?: string) => {
    const { userDataDir, vault } = getContext();
    const { meta, secret } = parseLegacyConnectionString(connStr, alias);
    const nodes = loadNodes(userDataDir);
    nodes.push(meta);
    saveNodes(userDataDir, nodes);
    try {
      vault.saveNodeSecret(meta.id, secret);
    } catch (err) {
      saveNodes(
        userDataDir,
        loadNodes(userDataDir).filter((n) => n.id !== meta.id),
      );
      throw err;
    }
    return meta;
  });
}

function registerHistoryIpc(): void {
  ipcMain.handle('history.list', () => loadHistory(getContext().userDataDir));

  ipcMain.handle('history.append', (_event, entry: HistoryEntry) => {
    const { userDataDir } = getContext();
    const normalized: HistoryEntry = {
      ...entry,
      id: typeof entry?.id === 'string' && entry.id ? entry.id : randomUUID(),
      at: typeof entry?.at === 'string' && entry.at ? entry.at : new Date().toISOString(),
    };
    if (!isHistoryEntry(normalized)) throw new Error('history: 条目缺少 aAlias/bAlias/diffCount');
    return appendHistory(userDataDir, normalized);
  });

  ipcMain.handle('history.clear', () => {
    clearHistory(getContext().userDataDir);
    return true;
  });
}

function registerIpc(): void {
  registerNodesIpc();
  registerHistoryIpc();
  // 数据对比取消：进行中的 compare.run 分页循环经 AbortSignal 中断。
  let dataAbort: AbortController | null = null;
  ipcMain.handle('compare.cancel', () => {
    if (dataAbort) {
      dataAbort.abort();
      return true;
    }
    return false;
  });
  // 数据表映射下拉：A/B 表清单（只读 SHOW 全表名，不拉 DDL）。
  ipcMain.handle('data.tables', async (_event, aId: string, bId: string) => {
    const { userDataDir, vault } = getContext();
    if (typeof aId !== 'string' || !aId || typeof bId !== 'string' || !bId) {
      throw new Error('data: 缺少 A / B 节点 id');
    }
    const nodes = loadNodes(userDataDir);
    const nodeA = nodes.find((n) => n.id === aId);
    const nodeB = nodes.find((n) => n.id === bId);
    if (!nodeA || !nodeB) throw new Error('data: A / B 节点不存在，请重新选择');
    let poolA: Pool | null = null;
    let poolB: Pool | null = null;
    try {
      [poolA, poolB] = await Promise.all([
        createMysqlPool(nodeA, vault.getNodeSecret(aId) ?? {}),
        createMysqlPool(nodeB, vault.getNodeSecret(bId) ?? {}),
      ]);
      const [a, b] = await Promise.all([
        listTables(poolA as unknown as Parameters<typeof listTables>[0], nodeA.database),
        listTables(poolB as unknown as Parameters<typeof listTables>[0], nodeB.database),
      ]);
      return { a, b };
    } finally {
      await Promise.allSettled([poolA?.end(), poolB?.end()]);
    }
  });
  // M5：compare.run 经 compare-run.ts（元数据拉取 + core 对比 + 历史落盘；scope 含 data 时追加数据对比）。
  ipcMain.handle('compare.run', (event, req: CompareRequest) => {
    const ctrl = new AbortController();
    dataAbort = ctrl;
    const sender = event.sender;
    const post = (msg: unknown): void => {
      try {
        sender.send('compare.progress', msg);
      } catch {
        // 窗口已关时忽略。
      }
    };
    return runCompareRequest(
      req,
      getContext(),
      {
        signal: ctrl.signal,
        onTable: (table, status, detail) => post({ type: 'table', table, status, detail }),
        onFetchProgress: (table, side, fetched, total) =>
          post({ type: 'fetch', table, side, fetched, total }),
      },
    ).finally(() => {
      if (dataAbort === ctrl) dataAbort = null;
    });
  });
  // M5：sql.format 经 sql-formatter（mysql 方言，关键字大写）；失败回落原文。
  ipcMain.handle('sql.format', (event, sql: string) => {
    void event;
    const text = typeof sql === 'string' ? sql : String(sql ?? '');
    if (!text.trim()) return text;
    try {
      return formatSql(text, { language: 'mysql', keywordCase: 'upper' });
    } catch {
      return text;
    }
  });
  ipcMain.handle('sql.copy', (_event, text: string) => {
    try {
      clipboard.writeText(String(text ?? ''));
      return true;
    } catch {
      return false;
    }
  });
}

// -- 窗口 --------------------------------------------------------------------

function rendererEntry(): string {
  return path.join(__dirname, '../../dist-renderer/index.html');
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0b0f14',
    title: 'SqlDiff 桌面版',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(rendererEntry());
  }

  win.on('closed', () => {
    win = null;
  });
}

void app.whenReady().then(() => {
  registerIpc();
  // P0 导出必落盘：静默落盘到系统 Downloads（保持无弹窗体验，此前无 handler 默认行为不落盘）。
  registerWillDownload(session.defaultSession, () => app.getPath('downloads'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// M3：退出前关闭全部 SSH 隧道（复用池不断开会悬挂; closeAll 内部幂等）。
app.on('before-quit', () => {
  void closeAll().catch(() => undefined);
});
