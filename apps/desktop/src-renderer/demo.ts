// M5 本地示例降级：无后端（Vite 直开 / IPC 不可用 / 种子节点不在 vault）时，
// 用内置 DatabaseMetadata 快照经 compareRun 生成演示差异，保证三栏可交互。
// 快照覆盖 CREATE / DROP / CHANGE 与表/视图/过程/函数四类型（含高危 DROP TABLE）。

import type { DatabaseMetadata } from '../src-main/metadata';
import { compareRun, type CompareRunOptions } from '../src-core/compare';
import { postFilterResult } from '../src-core/compare-filter';
import type { CompareResult, ObjectType } from '../src-core/types';

const T_USERS_A = [
  'CREATE TABLE `users` (',
  '  `id` bigint NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  `age` int DEFAULT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const T_USERS_B = [
  'CREATE TABLE `users` (',
  '  `id` bigint NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  "  `age` tinyint NULL DEFAULT '0',",
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const T_ORDERS = [
  'CREATE TABLE `orders` (',
  '  `id` bigint NOT NULL AUTO_INCREMENT,',
  '  `total` decimal(10,2) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const T_NEW_TABLE = [
  'CREATE TABLE `users_new` (',
  '  `id` bigint NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const T_OLD_LOG = [
  'CREATE TABLE `old_log` (',
  '  `id` bigint NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

/** 演示快照：A=来源（期望），B=目标（待升级），生成“把 B 升级到 A”的 SQL。 */
export function buildDemoMetadata(): { a: DatabaseMetadata; b: DatabaseMetadata } {
  const a: DatabaseMetadata = {
    tables: { users: T_USERS_A, orders: T_ORDERS, users_new: T_NEW_TABLE },
    views: {
      v_order: 'CREATE DEFINER=`root`@`%` VIEW `v_order` AS SELECT `id`, `total` FROM `orders`',
    },
    procedures: {
      calc_new: 'CREATE DEFINER=`root`@`%` PROCEDURE `calc_new`() BEGIN SELECT 1; END',
      shared_proc: 'CREATE DEFINER=`root`@`%` PROCEDURE `shared_proc`() BEGIN SELECT 2; END',
    },
    functions: {
      fn_total:
        'CREATE DEFINER=`root`@`%` FUNCTION `fn_total`(`oid` BIGINT) RETURNS DECIMAL(10,2) DETERMINISTIC RETURN (SELECT SUM(`price`) FROM `items` WHERE `order_id` = `oid`)',
    },
  };
  const b: DatabaseMetadata = {
    tables: { users: T_USERS_B, orders: T_ORDERS, old_log: T_OLD_LOG },
    views: {
      v_old: 'CREATE DEFINER=`root`@`%` VIEW `v_old` AS SELECT 1 AS `a`',
    },
    procedures: {
      calc: 'CREATE DEFINER=`root`@`%` PROCEDURE `calc`() BEGIN SELECT 1; END',
      shared_proc: 'CREATE DEFINER=`root`@`%` PROCEDURE `shared_proc`() BEGIN SELECT 1; END',
    },
    functions: {
      fn_total:
        'CREATE DEFINER=`root`@`%` FUNCTION `fn_total`(`oid` BIGINT) RETURNS DECIMAL(10,2) DETERMINISTIC RETURN (SELECT SUM(`price`) FROM `items` WHERE `order_id` = `oid` AND `status` = 1)',
    },
  };
  return { a, b };
}

/** 本地演示对比（与 compare.run 返回同形，已按 scopes/tableFilter 过滤）。 */
export function runDemoCompare(
  scopes: ObjectType[],
  tableFilter = '',
  opts: CompareRunOptions = {},
): CompareResult {
  const { a, b } = buildDemoMetadata();
  const on = new Set(scopes.length > 0 ? scopes : (['table', 'view', 'procedure', 'function'] as ObjectType[]));
  const keep = (m: Record<string, string | null>, kind: ObjectType): Record<string, string | null> =>
    on.has(kind) ? m : {};
  const fa: DatabaseMetadata = {
    tables: keep(a.tables, 'table'),
    views: keep(a.views, 'view'),
    procedures: keep(a.procedures, 'procedure'),
    functions: keep(a.functions, 'function'),
  };
  const fb: DatabaseMetadata = {
    tables: keep(b.tables, 'table'),
    views: keep(b.views, 'view'),
    procedures: keep(b.procedures, 'procedure'),
    functions: keep(b.functions, 'function'),
  };
  const kw = tableFilter.trim().toLowerCase();
  if (kw) {
    const hit = (name: string): boolean => name.toLowerCase().includes(kw);
    fa.tables = Object.fromEntries(Object.entries(fa.tables).filter(([k]) => hit(k)));
    fb.tables = Object.fromEntries(Object.entries(fb.tables).filter(([k]) => hit(k)));
  }
  const base = compareRun(fa, fb, opts);
  return postFilterResult(base.items, [...on], '');
}
