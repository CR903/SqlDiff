// M4 本地风险规则引擎：risk + explain + rollback（per prd.md R5，无外部 AI，离线可用）。
// 中文文案；DROP TABLE / DROP COLUMN 必带“备份”提示与“回滚占位”。

import type { RiskLevel } from './types';

export interface RiskAssessment {
  risk: RiskLevel;
  explain: string;
  rollback?: string;
}

const RE_DROP_TABLE = /\bDROP\s+TABLE\b/i;
const RE_DROP_COLUMN = /\bDROP\s+COLUMN\b/i;
const RE_DROP_PRIMARY = /\bDROP\s+PRIMARY\b/i;
const RE_DROP_ROUTINE = /\bDROP\s+(PROCEDURE|FUNCTION)\b/i;
const RE_DROP_VIEW = /\bDROP\s+VIEW\b/i;
const RE_DROP_INDEX = /\bDROP\s+INDEX\b/i;
const RE_ADD = /\bADD\s+(COLUMN|INDEX|PRIMARY\s+KEY|KEY|UNIQUE)\b/i;
const RE_CREATE_TABLE = /\bCREATE\s+TABLE\b/i;
const RE_CREATE = /\bCREATE\b/i;

/** 单条（或单对象拼接）SQL 的风险等级。 */
export function riskFor(sql: string): RiskLevel {
  return assessRisk(sql).risk;
}

/** 单条 SQL 的中文风险说明。 */
export function explainFor(sql: string): string {
  return assessRisk(sql).explain;
}

/** 单条 SQL 的回滚建议；无明确回滚时返回 undefined。 */
export function rollbackFor(sql: string, objectName?: string): string | undefined {
  return assessRisk(sql, objectName).rollback;
}

/**
 * 本地规则评估。`objectName` 仅用于回滚占位模板，不影响等级判定。
 * 等级约定：
 * - DROP TABLE / DROP COLUMN / DROP PRIMARY KEY → high（数据丢失不可逆）
 * - DROP PROCEDURE / FUNCTION / VIEW → medium（重建需原定义）
 * - DROP INDEX → low（仅影响性能，可重建）
 * - ADD COLUMN / ADD INDEX / CREATE（新建）→ low
 * - 其余 ALTER / CHANGE / CREATE OR REPLACE / DROP+CREATE 重建 → medium
 */
export function assessRisk(sql: string, objectName?: string): RiskAssessment {
  const text = sql ?? '';
  const name = objectName ?? '该对象';

  if (RE_DROP_TABLE.test(text)) {
    return {
      risk: 'high',
      explain:
        '高危：DROP TABLE 会删除整表及全部数据，执行后不可撤销。执行前请务必备份（mysqldump / 快照）。',
      rollback:
        `-- 回滚占位：DROP TABLE 无自动回滚，请先备份。\n` +
        `-- 备份示例：mysqldump -h <host> -u <user> -p <db> ${name} > ${name}.bak.sql\n` +
        `-- 恢复时从备份重建 ${name}。`,
    };
  }
  if (RE_DROP_COLUMN.test(text)) {
    return {
      risk: 'high',
      explain: '高危：DROP COLUMN 会丢失该列全部数据，执行后不可撤销。执行前请备份该表。',
      rollback:
        `-- 回滚占位：重建被删列需要原列定义，请先备份。\n` +
        `-- 示例：ALTER TABLE \`${name}\` ADD COLUMN <原列定义>; -- 请用备份中的列定义替换`,
    };
  }
  if (RE_DROP_PRIMARY.test(text)) {
    return {
      risk: 'high',
      explain: '高危：主键变更影响数据唯一性与关联完整性，大表重建耗时且可能锁表。请在低峰执行。',
      rollback: `-- 回滚占位：请保留原主键定义，异常时用 ALTER TABLE \`${name}\` 恢复原 PRIMARY KEY。`,
    };
  }
  if (RE_DROP_ROUTINE.test(text)) {
    return {
      risk: 'medium',
      explain: '中危：过程/函数重建（DROP+CREATE）会短暂不可用，请保留原 SHOW CREATE 定义以便回滚。',
      rollback: `-- 回滚占位：请保留原 SHOW CREATE 结果，异常时用原定义重建 ${name}。`,
    };
  }
  if (RE_DROP_VIEW.test(text)) {
    return {
      risk: 'medium',
      explain: '中危：删除视图不丢基表数据，但依赖该视图的查询会失败。请确认无依赖后再执行。',
      rollback: `-- 回滚占位：请保留原 SHOW CREATE VIEW 结果，异常时用原定义重建 ${name}。`,
    };
  }
  if (RE_DROP_INDEX.test(text)) {
    return {
      risk: 'low',
      explain: '低危：DROP INDEX 只影响查询性能、不丢数据，大表重建索引可能耗时。',
      rollback: `-- 回滚占位：用原索引定义 ADD INDEX 恢复 ${name}。`,
    };
  }
  if (RE_ADD.test(text) || RE_CREATE_TABLE.test(text) || RE_CREATE.test(text)) {
    if (RE_CREATE.test(text) && !RE_ADD.test(text)) {
      return {
        risk: 'low',
        explain: '低危：新建对象（CREATE）不影响现有数据，可直接执行；重复执行请加 IF NOT EXISTS。',
        rollback: `-- 回滚：如需撤销新建，可 DROP 对应对象（${name}）。`,
      };
    }
    return {
      risk: 'low',
      explain: '低危：新增列/索引不删除现有数据；新增 NOT NULL 无默认值列在大表上可能耗时。',
      rollback: `-- 回滚：如需撤销新增，可 ALTER TABLE \`${name}\` DROP COLUMN <列名> / DROP INDEX <索引名>。`,
    };
  }
  return {
    risk: 'medium',
    explain: '中危：结构变更（ALTER / CHANGE / 重建）可能锁表或影响应用，请在低峰执行并先备份。',
    rollback: `-- 回滚占位：请保留原列/原对象定义，异常时用原定义恢复 ${name}。`,
  };
}
