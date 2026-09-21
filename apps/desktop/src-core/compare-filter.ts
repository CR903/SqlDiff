// M5 纯函数过滤层（core 侧，主 + 渲染双端共享，不依赖任何 Node API）：
// scopes 裁剪快照 + 结果后过滤（scopes + 表名子串）+ stats 重算。
// 从 src-main/compare-run.ts 剥离出来，避免渲染进程打包时把
// node:crypto / mysql2 / ssh2 链带进浏览器 bundle（Vite externalized 报错）。

import type { DatabaseMetadata } from '../src-main/metadata';
import { sortDiffItems } from './compare';
import type { CompareResult, DataScope, DiffItem, ObjectType } from './types';

export const ALL_SCOPES: ObjectType[] = ['table', 'view', 'procedure', 'function'];

export function normalizeScopes(scopes: unknown): ObjectType[] {
  if (!Array.isArray(scopes)) return [...ALL_SCOPES];
  const kept = (scopes as unknown[]).filter(
    (s): s is ObjectType => s === 'table' || s === 'view' || s === 'procedure' || s === 'function',
  );
  return kept.length > 0 ? [...new Set(kept)] : [...ALL_SCOPES];
}

/** 数据对比是否开启：显式开关或 scopes 携带 'data' 任一成立。 */
export function hasDataScope(scopes: unknown, includeData?: boolean): boolean {
  if (includeData === true) return true;
  return Array.isArray(scopes) && (scopes as unknown[]).includes('data' as DataScope);
}

/** 按 scopes 裁剪快照：被排除的对象类型直接清空（compareRun 侧不再产出）。 */
export function filterMetadataByScopes(meta: DatabaseMetadata, scopes: ObjectType[]): DatabaseMetadata {
  const on = new Set(scopes);
  return {
    tables: on.has('table') ? meta.tables : {},
    views: on.has('view') ? meta.views : {},
    procedures: on.has('procedure') ? meta.procedures : {},
    functions: on.has('function') ? meta.functions : {},
  };
}

export function recountStats(items: DiffItem[]): CompareResult['stats'] {
  const stats: CompareResult['stats'] = {
    ALL: items.length,
    CREATE: 0,
    DROP: 0,
    CHANGE: 0,
    DML: { INSERT: 0, DELETE: 0, UPDATE: 0 },
  };
  for (const it of items) {
    stats[it.changeType] += 1;
    if (it.dml) stats.DML[it.dml] += 1;
  }
  return stats;
}

/**
 * 后过滤（展示一致性兜底）：scopes + 表名子串（大小写不敏感）。
 * tableFilter 只作用于 table 类型（与 fetchMetadata 一致），视图/例程不受影响；
 * 数据行（objectType:'data'）不受结构 scopes 裁剪（数据开关由 hasDataScope 控制），
 * 仅在有 tableFilter 时按表名/SQL 子串过滤，保证“复制=所见”不丢数。
 */
export function postFilterResult(
  items: DiffItem[],
  scopes: ObjectType[],
  tableFilter?: string,
): CompareResult {
  const on = new Set<string>(scopes);
  const kw = (tableFilter ?? '').trim().toLowerCase();
  const filtered = items.filter((it) => {
    if (it.objectType === 'data') {
      if (kw && !(it.objectName.toLowerCase().includes(kw) || it.sql.toLowerCase().includes(kw))) {
        return false;
      }
      return true;
    }
    if (!on.has(it.objectType)) return false;
    if (kw && it.objectType === 'table') {
      if (!(it.objectName.toLowerCase().includes(kw) || it.sql.toLowerCase().includes(kw))) return false;
    }
    return true;
  });
  const sorted = sortDiffItems(filtered);
  return { items: sorted, stats: recountStats(sorted) };
}
