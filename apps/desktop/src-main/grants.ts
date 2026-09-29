// M3 授权盲区探针：执行 `SHOW GRANTS FOR CURRENT_USER()` 并交给 core 纯解析。
//
// 只读边界（R4 / database-guidelines.md 的只读 SQL 清单）：
// - 固定 SQL 字面量，无参数拼接；不新增任何写库路径。
// - **只读取当前用户自身的授权**（CURRENT_USER()）。本模块刻意不提供 `FOR <user>`
//   形式的入口，也不接受任何 user 参数 —— 探测他人授权既无产品需要又扩大秘密面。
// - 授权原文不外流：探针内部解包成行文本后交给 src-core/visibility.ts 纯解析，
//   只返回 VisibilityAssessment（库名 → 'full'|'partial' + reliable）。
//   授权原文不进入 CompareResult / store / 界面 / 导出物（见 database-guidelines.md）。
//
// 失败语义：查询抛错 / 形态未识别 / 8.0 角色授权 一律 reliable:false，
// 由 visibilityFor 退向 'partial' 收窄比较范围，不冒泡阻断正常比较
// （这是一次"能否证明完整"的探针，不是比较的前置条件）。

import { parseGrantLines } from '../src-core/visibility';
import type { VisibilityAssessment } from '../src-core/types';
import { rowsOf, type DbQueryable } from './metadata';

/** 唯一执行的授权语句。固定字面量：无参数、无 `FOR <user>` 变体。 */
export const SQL_SHOW_GRANTS = 'SHOW GRANTS FOR CURRENT_USER()';

/** 判据不可靠的统一结论（与 core 内部同一形状，byDatabase 为空 = 无意义）。 */
const UNRELIABLE: VisibilityAssessment = { byDatabase: {}, reliable: false };

/**
 * mysql2 对 `SHOW GRANTS` 返回的行只有一列，列名是动态的
 * （实测 5.7.18：`Grants for cov_limited@127.0.0.1`），因此不能按列名取值，
 * 逐行取第一个非空字符串单元即可。取不到字符串的行走空串 → core 判为未识别 → 降级。
 */
function grantLine(row: Record<string, unknown>): string {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * 判定当前连接账号在一批库上的可见性完整度。
 * 永不抛错：任何失败都退化为 reliable:false（下游按 partial 收窄）。
 */
export async function assessVisibility(db: DbQueryable): Promise<VisibilityAssessment> {
  try {
    const rows = rowsOf(await db.query(SQL_SHOW_GRANTS));
    if (rows.length === 0) return UNRELIABLE;
    return parseGrantLines(rows.map(grantLine));
  } catch {
    return UNRELIABLE;
  }
}
