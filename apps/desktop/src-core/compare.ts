// M4 组装层：DatabaseMetadata(A/B 快照) -> DiffItem[] + stats + 排序。
// 表走 diffTable（多 ALTER 拼为单条目），视图/过程/函数走 diffProcedure。
// changeType 经 classify 判定，risk/explain/rollback 经本地规则引擎填充。
// 导出排序 DROP(0) -> CREATE(1) -> CHANGE(2)，同级按对象类型+对象名稳定排序。

import type { DatabaseMetadata } from '../src-main/metadata';
import type { ChangeType, CompareResult, DiffItem, ObjectType } from './types';
import { classify } from './classify';
import { diffProcedure, diffTable, type RoutineKind } from './diff';
import { assessRisk } from './risk';

export interface CompareRunOptions {
  /** 透传给 changeProcedure 的目标库用户名（DEFINER 归一用）；不传则保留来源 DEFINER。 */
  targetUser?: string;
}

const CHANGE_ORDER: Record<ChangeType, number> = { DROP: 0, CREATE: 1, CHANGE: 2 };
const OBJECT_ORDER: Record<ObjectType, number> = {
  table: 0,
  view: 1,
  procedure: 2,
  function: 3,
};

function makeItem(
  objectType: ObjectType,
  objectName: string,
  sql: string,
): DiffItem {
  const changeType = classify(sql);
  const assessed = assessRisk(sql, objectName);
  return {
    id: `${objectType}:${objectName}`,
    objectType,
    objectName,
    changeType,
    risk: assessed.risk,
    sql,
    rollback: assessed.rollback,
    explain: assessed.explain,
  };
}

/** 是否“缺失”（map 无此键）；值为 null 表示 SHOW CREATE 失败，按约定跳过。 */
function pick(
  map: Record<string, string | null>,
  name: string,
): { missing: boolean; value: string | null | undefined } {
  if (!Object.prototype.hasOwnProperty.call(map, name)) return { missing: true, value: undefined };
  return { missing: false, value: map[name] };
}

function unionSorted(a: Record<string, string | null>, b: Record<string, string | null>): string[] {
  const set = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...set].sort((x, y) => x.localeCompare(y));
}

/** 排序：DROP -> CREATE -> CHANGE；同级按对象类型 -> 对象名。 */
export function sortDiffItems(items: DiffItem[]): DiffItem[] {
  return [...items].sort((x, y) => {
    const c = CHANGE_ORDER[x.changeType] - CHANGE_ORDER[y.changeType];
    if (c !== 0) return c;
    const o = OBJECT_ORDER[x.objectType] - OBJECT_ORDER[y.objectType];
    if (o !== 0) return o;
    return x.objectName.localeCompare(y.objectName);
  });
}

function emptyStats(): CompareResult['stats'] {
  return { ALL: 0, CREATE: 0, DROP: 0, CHANGE: 0 };
}

/**
 * 对比两个元数据快照（A=来源/期望，B=目标/待升级，与老 mysqldiff db1/db2 同向：
 * 生成的是“把 B 升级到 A”的 SQL）。
 */
export function compareRun(
  a: DatabaseMetadata,
  b: DatabaseMetadata,
  opts: CompareRunOptions = {},
): CompareResult {
  const items: DiffItem[] = [];

  for (const name of unionSorted(a.tables, b.tables)) {
    const pa = pick(a.tables, name);
    const pb = pick(b.tables, name);
    if (!pa.missing && pa.value == null) continue;
    if (!pb.missing && pb.value == null) continue;
    const sql = diffTable(name, pa.missing ? '' : (pa.value as string), pb.missing ? '' : (pb.value as string));
    if (sql) items.push(makeItem('table', name, sql));
  }

  const routineGroups: Array<{ mapA: Record<string, string | null>; mapB: Record<string, string | null>; kind: RoutineKind; objectType: ObjectType }> = [
    { mapA: a.views, mapB: b.views, kind: 'VIEW', objectType: 'view' },
    { mapA: a.procedures, mapB: b.procedures, kind: 'PROCEDURE', objectType: 'procedure' },
    { mapA: a.functions, mapB: b.functions, kind: 'FUNCTION', objectType: 'function' },
  ];
  for (const g of routineGroups) {
    for (const name of unionSorted(g.mapA, g.mapB)) {
      const pa = pick(g.mapA, name);
      const pb = pick(g.mapB, name);
      if (!pa.missing && pa.value == null) continue;
      if (!pb.missing && pb.value == null) continue;
      const sql = diffProcedure(
        name,
        pa.missing ? '' : (pa.value as string),
        pb.missing ? '' : (pb.value as string),
        g.kind,
        opts.targetUser,
      );
      if (sql) items.push(makeItem(g.objectType, name, sql));
    }
  }

  const sorted = sortDiffItems(items);
  const stats = emptyStats();
  stats.ALL = sorted.length;
  for (const it of sorted) stats[it.changeType] += 1;
  return { items: sorted, stats };
}

/** 别名：与 IPC compare.run 语义同名，方便 main/UI 调用。 */
export const compareDatabases = compareRun;

/** 导出 .sql 文本：头注释（A/B/时间）+ DROP→CREATE→CHANGE 顺序（items 应已排序，本函数再排一次保底）。 */
export function toExportSql(
  items: DiffItem[],
  opts: { aName?: string; bName?: string; at?: string } = {},
): string {
  const sorted = sortDiffItems(items);
  const head = [
    `-- SqlDiff 导出`,
    `-- A(来源): ${opts.aName ?? 'db1'}`,
    `-- B(目标): ${opts.bName ?? 'db2'}`,
    `-- 时间: ${opts.at ?? new Date().toISOString()}`,
    `-- 条数: ${sorted.length}`,
    '',
  ].join('\n');
  if (sorted.length === 0) return `${head}-- 无差异\n`;
  return head + sorted.map((it) => `-- [${it.changeType}] ${it.objectType} ${it.objectName}\n${it.sql}`).join('\n');
}
