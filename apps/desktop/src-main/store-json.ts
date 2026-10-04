// M2 本地 JSON 存储：nodes.json（节点元数据）+ history.json（最近对比历史，只留 20 条）。
//
// - 秘密（密码/密钥）永不进这两个文件，只走 vault.ts（safeStorage / AES-GCM）。
// - 目录由 main.ts 按 Electron `app.getPath('userData')` 传入；
//   `SQLDIFF_USER_DATA_DIR` 环境变量可覆盖（开发联调/单测隔离）。
// - 原子写（tmp + rename），读容错（缺失/损坏 → 空数组，不抛）。

import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry, NodeMeta } from '../src-core/types';
import type { PreflightHistoryEntry } from '../src-core/preflight-history';
import { historyGroupKey, isPreflightHistoryEntry } from '../src-core/preflight-history';

/** 历史只留最近 N 条（prd.md R1）。 */
export const HISTORY_LIMIT = 20;

/**
 * Preflight 历史：每组（bId + database）只留最近 N 份完整报告。
 * Compare 历史是 20 条摘要，preflight 报告体量大故取小（prd.md R3）。
 */
export const PREFLIGHT_HISTORY_LIMIT = 10;

export function resolveUserDataDir(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  const fromEnv = process?.env?.SQLDIFF_USER_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), 'user-data');
}

export function nodesFilePath(userDataDir?: string): string {
  return path.join(resolveUserDataDir(userDataDir), 'nodes.json');
}

export function historyFilePath(userDataDir?: string): string {
  return path.join(resolveUserDataDir(userDataDir), 'history.json');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isNodeMeta(v: unknown): v is NodeMeta {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.alias === 'string' &&
    typeof v.host === 'string' &&
    typeof v.user === 'string' &&
    typeof v.database === 'string' &&
    typeof v.port === 'number' &&
    typeof v.createdAt === 'string' &&
    isRecord(v.ssh)
  );
}

export function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.at === 'string' &&
    typeof v.aAlias === 'string' &&
    typeof v.bAlias === 'string' &&
    typeof v.diffCount === 'number'
  );
}

// -- nodes ---------------------------------------------------------------

/** 读取全部节点元数据；文件缺失/损坏/条目非法 → 过滤后返回（不抛）。 */
export function loadNodes(userDataDir?: string): NodeMeta[] {
  const raw = readJsonFile<unknown>(nodesFilePath(userDataDir), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isNodeMeta);
}

/** 全量保存节点元数据（调用方先改数组再调；非法条目会被过滤）。 */
export function saveNodes(userDataDir: string | undefined, nodes: NodeMeta[]): void {
  writeJsonFileAtomic(nodesFilePath(userDataDir), nodes.filter(isNodeMeta));
}

// -- history --------------------------------------------------------------

/** 读取对比历史（新 → 旧），最多 HISTORY_LIMIT 条。 */
export function loadHistory(userDataDir?: string): HistoryEntry[] {
  const raw = readJsonFile<unknown>(historyFilePath(userDataDir), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isHistoryEntry).slice(0, HISTORY_LIMIT);
}

/** 追加一条历史（同 id 去重后置顶），截断到 HISTORY_LIMIT 条并返回最新列表。 */
export function appendHistory(userDataDir: string | undefined, entry: HistoryEntry): HistoryEntry[] {
  if (!isHistoryEntry(entry)) throw new Error('store: 历史条目缺少 id/at/aAlias/bAlias/diffCount');
  const list = [entry, ...loadHistory(userDataDir).filter((h) => h.id !== entry.id)].slice(0, HISTORY_LIMIT);
  writeJsonFileAtomic(historyFilePath(userDataDir), list);
  return list;
}

/** 清空对比历史。 */
export function clearHistory(userDataDir?: string): void {
  writeJsonFileAtomic(historyFilePath(userDataDir), []);
}

// -- preflight history -------------------------------------------------------
//
// 多次 preflight 历史对比（10-04-history-diff）：每次成功 run 即存一份完整报告，
// 按 (bId, database) 分组、每组最近 PREFLIGHT_HISTORY_LIMIT 份滚动淘汰。
// - 新文件 preflight-history.json，无旧数据迁移；compare 的 history.json 不动。
// - 无秘密入库：PreflightReport 本不含 secret（facts 是版本/行数/结构计数，
//   见 preflight.md §11.1 保密边界）；守卫只做形状校验，不碰任何凭据字段。

/** preflight-history.json 路径（与 nodes.json / history.json 同目录）。 */
export function preflightHistoryFilePath(userDataDir?: string): string {
  return path.join(resolveUserDataDir(userDataDir), 'preflight-history.json');
}

/** 读取全部 preflight 历史（新 → 旧；非法条目过滤，不抛）。 */
export function loadPreflightHistory(userDataDir?: string): PreflightHistoryEntry[] {
  const raw = readJsonFile<unknown>(preflightHistoryFilePath(userDataDir), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPreflightHistoryEntry);
}

/**
 * 追加一份 preflight 报告（同 id 去重后置顶），同组超限滚动淘汰后返回最新列表。
 * 非法条目（缺 id/at/bId/database/report.issues）直接 throw，由调用方隔离。
 */
export function appendPreflightHistory(
  userDataDir: string | undefined,
  entry: PreflightHistoryEntry,
): PreflightHistoryEntry[] {
  if (!isPreflightHistoryEntry(entry)) {
    throw new Error('store: preflight 历史条目缺少 id/at/bId/database/report.issues');
  }
  const key = historyGroupKey(entry);
  const rest = loadPreflightHistory(userDataDir).filter((h) => h.id !== entry.id);
  const sameGroup = [entry, ...rest.filter((h) => historyGroupKey(h) === key)].slice(
    0,
    PREFLIGHT_HISTORY_LIMIT,
  );
  const otherGroups = rest.filter((h) => historyGroupKey(h) !== key);
  const list = [...sameGroup, ...otherGroups];
  writeJsonFileAtomic(preflightHistoryFilePath(userDataDir), list);
  return list;
}

/** 按 id 取单份 preflight 历史（UI 对比取值用；不存在返回 null）。 */
export function getPreflightHistoryEntry(
  userDataDir: string | undefined,
  id: string,
): PreflightHistoryEntry | null {
  if (typeof id !== 'string' || !id) return null;
  return loadPreflightHistory(userDataDir).find((h) => h.id === id) ?? null;
}

/** 清空 preflight 历史（删文件即清空，无迁移脚本）。 */
export function clearPreflightHistory(userDataDir?: string): void {
  writeJsonFileAtomic(preflightHistoryFilePath(userDataDir), []);
}
