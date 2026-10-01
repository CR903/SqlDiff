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

/**
 * 可切换过滤的切面计数键（全量 `StmtAspect`，而非某一子集）。
 * 早前一版只数 index/primary/column（全局切面 chip 时代），现改为 Tab 内子标签，
 * 需要 table/routine/data 同样参与计数——它们正是 DROP·表 / CHANGE·例程 / CHANGE·数据 的来源。
 */
export type AspectCountKey = StmtAspect;

/** 各切面计数键的零值基座，避免每次调用重建对象字面量。 */
const ZERO_ASPECT_COUNTS: Record<AspectCountKey, number> = {
  table: 0,
  column: 0,
  primary: 0,
  index: 0,
  routine: 0,
  data: 0,
};

/**
 * 各切面的条目数，供 UI 打 chip / 子标签。
 * 计数基数由调用方给定——**必须是不含切面自身过滤的列表**（通常是 byTab），
 * 否则数字无法回答「我点了这个子标签会得到几条」。
 */
export function countAspects(
  items: readonly DiffItem[],
): Record<AspectCountKey, number> {
  const counts: Record<AspectCountKey, number> = { ...ZERO_ASPECT_COUNTS };
  for (const it of items) {
    for (const a of it.aspects ?? []) {
      if (a in counts) counts[a as AspectCountKey] += 1;
    }
  }
  return counts;
}

/**
 * Tab → 该 Tab 内可用的切面子标签（有序）。
 *
 * 来源是实测的 (changeType × aspect) 矩阵，不是拍脑袋的枚举：
 * `aspects` 恒为单元素数组（`compare.ts:42`，并由 `diff.test.ts:268`
 * 的 `toHaveLength(1)` 断言守住），故 (Tab, 切面) 构成无歧义分区，
 * 子标签不会漏项也不会重叠。
 *
 *   DROP   → { table, column, primary, index, routine }
 *   CHANGE → { column, primary, index, routine, data }
 *
 * `ALL` / `CREATE` 刻意缺席：CREATE 的切面只有 table/routine，细分收益低；
 * `ALL` 若提供全量子标签会与具体 Tab 的子标签语义重复。缺席即「该 Tab 不分子标签」。
 */
export const ASPECT_SCOPES: Record<'DROP' | 'CHANGE', { value: StmtAspect; label: string }[]> = {
  DROP: [
    { value: 'table', label: '表' },
    { value: 'column', label: '列' },
    { value: 'primary', label: '主键' },
    { value: 'index', label: '索引' },
    { value: 'routine', label: '例程' },
  ],
  CHANGE: [
    { value: 'column', label: '列' },
    { value: 'primary', label: '主键' },
    { value: 'index', label: '索引' },
    { value: 'routine', label: '例程' },
    { value: 'data', label: '数据' },
  ],
};

/** 取某 Tab 的子标签集；该 Tab 不分子标签时返回 null（ALL / CREATE）。 */
export function aspectScopeFor(tab: string): { value: StmtAspect; label: string }[] | null {
  return ASPECT_SCOPES[tab as 'DROP' | 'CHANGE'] ?? null;
}

/**
 * 把切面选择裁剪到目标 Tab 的可用集（切换 Tab 时调用）。
 *
 * 存在的原因是一个具体的 UX 失败模式：在 `DROP` 下选了「表」再切到 `CHANGE`，
 * 而 CHANGE 没有 `table` 切面——若不裁剪，结果列表会变成空的，
 * 且界面上没有任何可见原因提示为何为空（静默空列表）。
 *
 * 语义：裁剪后仍有剩余则保留（例如 DROP 同时选了「表+索引」，CHANGE 两者皆可用）；
 * 裁剪后为空则回落 `ALL`。`ALL` 原样返回。
 */
export function pruneAspectFilter(sel: AspectFilter, tab: string): AspectFilter {
  const allowed = aspectScopeFor(tab);
  if (allowed === null) return 'ALL';
  if (sel === 'ALL') return 'ALL';
  const allowedSet = new Set(allowed.map((a) => a.value));
  const kept = sel.filter((a) => allowedSet.has(a));
  return kept.length === 0 ? 'ALL' : kept;
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
