// M5 纯函数过滤层（core 侧，主 + 渲染双端共享，不依赖任何 Node API）：
// scopes 裁剪快照 + 结果后过滤（scopes + 表名子串）+ stats 重算。
// 从 src-main/compare-run.ts 剥离出来，避免渲染进程打包时把
// node:crypto / mysql2 / ssh2 链带进浏览器 bundle（Vite externalized 报错）。

import type { DatabaseMetadata } from '../src-main/metadata';
import { verbOf } from './classify';
import { sortDiffItems } from './compare';
import type {
  CompareResult,
  DataScope,
  DiffItem,
  ObjectType,
  ObjectTypeWithData,
  StmtAspect,
  Verb,
} from './types';

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
    INDEX: 0,
    DML: { INSERT: 0, DELETE: 0, UPDATE: 0 },
  };
  for (const it of items) {
    stats[it.changeType] += 1;
    if ((it.aspects ?? []).includes('index')) stats.INDEX += 1;
    if (it.dml) stats.DML[it.dml] += 1;
  }
  return stats;
}

/** R4 对象过滤（多选含数据行；'ALL'/空数组/选满 = 不限，组内 OR）。 */
export type ObjectTypeFilter = 'ALL' | ObjectTypeWithData[];
/** R4 切面过滤（多选；'ALL'/空数组/选满 = 不限，组内 OR）。 */
export type AspectFilter = 'ALL' | StmtAspect[];
/** R7 动词桶过滤：'ALL' 或动词数组（空数组视为 ALL，保证增量兼容）。 */
export type VerbFilter = 'ALL' | Verb[];

export interface PostFilterOptions {
  /** 对象集合（含 'data'；数据行同走集合判定，不再特殊 bypass）。 */
  objectTypes?: ObjectTypeFilter;
  /** 语句切面集合（命中任一即保留）。 */
  aspects?: AspectFilter;
  /** R7 动词桶（CREATE/DROP/ALTER/INSERT/UPDATE/DELETE）：命中任一即保留，与其他条件正交 AND。 */
  verbs?: VerbFilter;
}

/**
 * 后过滤（展示一致性兜底）：对象（scopes + 对象集合）→ 动词 → 切面 → 表名子串（大小写不敏感）。
 * 组内 OR、组间 AND；tableFilter 只作用于 table 类型（与 fetchMetadata 一致），视图/例程不受影响；
 * 数据行（objectType:'data'）不受结构 scopes 裁剪（数据开关由 hasDataScope 控制），
 * 但同走对象集合判定，仅在有 tableFilter 时按表名/SQL 子串过滤，保证“复制=所见”不丢数。
 */
export function postFilterResult(
  items: DiffItem[],
  scopes: ObjectType[],
  tableFilter?: string,
  opts: PostFilterOptions = {},
): CompareResult {
  const on = new Set<string>(scopes);
  const kw = (tableFilter ?? '').trim().toLowerCase();
  const objSet =
    opts.objectTypes === undefined || opts.objectTypes === 'ALL'
      ? null
      : new Set<string>(opts.objectTypes);
  const aspSet =
    opts.aspects === undefined || opts.aspects === 'ALL' ? null : new Set<string>(opts.aspects);
  const verbs = opts.verbs ?? 'ALL';
  const verbSet = verbs === 'ALL' ? null : new Set<Verb>(verbs);
  const filtered = items.filter((it) => {
    // 对象：数据行不受结构 scopes 裁剪，但同走对象集合判定。
    if (it.objectType !== 'data' && !on.has(it.objectType)) return false;
    if (objSet !== null && objSet.size > 0 && !objSet.has(it.objectType)) return false;
    // R7 动词：首关键字须命中已选桶（空数组视为 ALL）。
    if (verbSet !== null && verbSet.size > 0 && !verbSet.has(verbOf(it.sql))) return false;
    // 切面（多选 OR，空数组视为 ALL）。
    if (aspSet !== null && aspSet.size > 0 && !(it.aspects ?? []).some((a) => aspSet.has(a)))
      return false;
    // 关键字：仅作用于表 + 数据行。
    if (kw && (it.objectType === 'table' || it.objectType === 'data')) {
      if (!(it.objectName.toLowerCase().includes(kw) || it.sql.toLowerCase().includes(kw))) return false;
    }
    return true;
  });
  const sorted = sortDiffItems(filtered);
  return { items: sorted, stats: recountStats(sorted) };
}
