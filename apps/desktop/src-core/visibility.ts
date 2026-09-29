// 授权盲区判定（纯函数，跨宿主共享，零 Node 依赖 —— src-core 依赖规则）。
//
// 背景：SqlDiff 把「information_schema 里看不到的对象」当成「不存在的对象」，
// 受限账号（表级授权）下会产出假 DROP TABLE。已实证 5.7.18：
//   cov_limited → SHOW TABLES FROM cov_src = open_tbl
//   cov_limited → SHOW TABLES FROM cov_tgt = open_tbl, secret_tbl
//   compareRun(cov_src 快照, cov_tgt 快照) → DROP TABLE `secret_tbl`
//
// 判据走 SHOW GRANTS FOR CURRENT_USER()（不是 information_schema.SCHEMA_PRIVILEGES /
// TABLE_PRIVILEGES —— 那两张表是 MySQL 8.0 才引入的，5.7 上直接 ERROR 1054）。
// 实测判别式（见 prd.md §5）：
//   cov_limited → 库级行 0 / 表级行 5  → 存在不可见对象
//   cov_view    → 库级行 1 / 表级行 0  → 可证明全量可见
//   cov_mixed   → 库级行 1 / 表级行 1  → 逐库判定
//
// 保守方向（不可颠倒）：判据不可靠（查询失败、形态未识别、8.0 角色授权）
// 一律 reliable:false + 空的 byDatabase，visibilityFor 随后无条件返回 'partial'。
// 误判为 full 会漏出假 DROP，代价远大于过度收窄。

import type { Visibility, VisibilityAssessment } from './types';

/** 判据不可靠时的统一结论：byDatabase 为空（无意义），下游一律按 partial 收窄。 */
const UNRELIABLE: VisibilityAssessment = { byDatabase: {}, reliable: false };

/** 全局授权（`ON *.*` 含读权限）的哨兵键；真实库名不会等于它（见 parseGrantLines 的守卫）。 */
const GLOBAL_SENTINEL = '*';

/**
 * 标准授权行：`GRANT <privs> ON <obj> TO <user>`。
 * `<obj>` 强制为 `a.b` 两段形态（各自为 `*` 或反引号标识符），这样反引号标识符里
 * 含有 " ON " 时正则会自然回溯到真正的 ON 关键字，而不是把标识符劈成两半。
 * 结果是形态收敛的：匹配不上的行（8.0 角色授权、PROXY、空行、代理实例改写的文本）
 * 一律走「未识别 → 降级」分支，不做猜测。
 */
const GRANT_RE = /^\s*GRANT\s+(.+?)\s+ON\s+(\*|`(?:[^`]|``)*`)\.(\*|`(?:[^`]|``)*`)\s+TO\s/i;

/** 去反引号：`` `db` `` → db（反引号按 SQL 规则加倍）。 */
function unquote(ident: string): string {
  return ident.startsWith('`') && ident.endsWith('`') ? ident.slice(1, -1).replace(/``/g, '`') : ident;
}

/** 授权 privilege 列表逐项归一（去掉 `OPTION` 之类的尾缀）。 */
function privList(privs: string): string[] {
  return privs
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0);
}

/**
 * 库级授权是否含「可列举 + 可 SHOW CREATE」的读权限。
 * 刻意只认 SELECT / ALL：库级 INSERT 之类不能证明全量可见，宁可收窄。
 */
function hasReadPrivilege(privs: string): boolean {
  return privList(privs).some((p) => p === 'SELECT' || p === 'ALL' || p === 'ALL PRIVILEGES');
}

/** 表级授权只需确认「存在非 USAGE 授权」这一事实即可判 partial，无须逐项解析。 */
function isNonUsage(privs: string): boolean {
  return privList(privs).some((p) => p !== 'USAGE');
}

/**
 * 解析 `SHOW GRANTS FOR CURRENT_USER()` 的行数组 → 逐库可见性判定。
 *
 * 判定表（保守方向，详见文件头）：
 * | 命中形态 | 该库结论 |
 * |---|---|
 * | `ON *.*` 含读权限 | 所有库 full（全局授权） |
 * | `ON `db`.*` 含读权限 | 该库 full |
 * | `ON `db`.`tbl`` 非 USAGE | 该库 partial（存在不可见对象） |
 * | `GRANT `role` TO`（无 ON，8.0 角色） | reliable:false，全库 partial |
 * | 其他未识别行 / 空行 / 空输出 | reliable:false，全库 partial |
 *
 * 同库同时出现库级与表级授权时取 full：库级 SELECT 是表级授权的严格超集，
 * 实测（cov_view）能全量列举并 SHOW CREATE，因此不构成盲区。
 *
 * @param lines `SHOW GRANTS` 每行文本（由 src-main/grants.ts 从 mysql 行解包）
 */
export function parseGrantLines(lines: readonly string[]): VisibilityAssessment {
  if (!Array.isArray(lines) || lines.length === 0) return UNRELIABLE;
  const byDatabase: Record<string, Visibility> = {};
  let globalFull = false;
  for (const raw of lines) {
    if (typeof raw !== 'string') return UNRELIABLE;
    const m = GRANT_RE.exec(raw);
    // 8.0 角色授权（`GRANT `r`@`%` TO `u`@`%``，无 ON，表级授权不展开）与任何未识别
    // 形态都降级「未证明」：角色会改写输出形态，猜测即误判。
    if (!m) return UNRELIABLE;
    const privs = m[1].trim();
    const objA = m[2];
    const objB = m[3];
    if (objA === '*' && objB === '*') {
      if (hasReadPrivilege(privs)) globalFull = true;
      continue; // USAGE ON *.* 是空账号基线，不构成任何授权。
    }
    // `*`.`tbl` 不是 MySQL 合法授权形态，保守处理。
    if (objA === '*') return UNRELIABLE;
    const db = unquote(objA);
    if (!db) return UNRELIABLE;
    // 反引号标识符允许库名就叫 `*`，写进来会与全局哨兵撞车：
    // visibilityFor 随后会把**其他**任何库误判为 full。保守跳过 → 该库按 partial 处理。
    if (db === GLOBAL_SENTINEL) continue;
    if (objB === '*') {
      if (hasReadPrivilege(privs)) byDatabase[db] = 'full';
      continue; // 库级但无读权限（USAGE / 仅 INSERT 等）→ 保持未列出，默认 partial。
    }
    if (isNonUsage(privs)) byDatabase[db] = byDatabase[db] === 'full' ? 'full' : 'partial';
  }
  if (globalFull) return { byDatabase: { [GLOBAL_SENTINEL]: 'full' }, reliable: true };
  return { byDatabase, reliable: true };
}

/**
 * 取某库在本次判定下的可见性。
 * - `reliable: false` → 无条件 'partial'（判据失败/未识别/角色授权，一律收窄）。
 * - 库名**精确**命中 → 该库结论；全局授权记在哨兵键 `'*'` 上，命中即 full。
 * - 其余一律 'partial'（默认保守：授权只覆盖部分对象时本就看不见其余对象）。
 *
 * **刻意不做大小写不敏感回落。** 早期实现按「MySQL 不可能同时存在仅大小写不同的两个库」
 * 放宽到大小写不敏感匹配，但该前提只对 `lower_case_table_names != 0` 成立；
 * Linux 默认的 `lower_case_table_names = 0`（含 5.7.18 fixture 所在的容器）下
 * `Foo` 与 `foo` 就是两个不同的库。此时 `GRANT ... ON \`Foo\`.*` 会被误配到节点配置里的
 * `foo`，凭空造出一个 `full` → 不收窄 → 若该连接确实读不到 `foo` 的任何对象（典型成因：
 * 节点对话框里库名大小写敲错），整个 A 侧 schema 都会变成静默的假 `DROP TABLE`。
 * 代价对比：保守收窄的最坏结果是单侧对象被列为「无法比较」（界面常驻明示，可改配置消除）；
 * 误判为 full 的最坏结果是未经核实的破坏性 DDL。因此保留精确匹配。
 * （`lower_case_table_names != 0` 的 Windows/macOS 若大小写不一致也会走收窄分支；
 * 两侧对象集相同时交集等于原集，`excluded` 为空、界面不出现任何提示，故无实际损失。）
 */
export function visibilityFor(assessment: VisibilityAssessment, database: string): Visibility {
  if (!assessment || !assessment.reliable) return 'partial';
  const table = assessment.byDatabase ?? {};
  if (Object.prototype.hasOwnProperty.call(table, database)) return table[database];
  if (Object.prototype.hasOwnProperty.call(table, GLOBAL_SENTINEL)) return 'full';
  return 'partial';
}
