// P0 审查报告 manifest：CompareResult 的确定性投影（versioned、无秘密、行值脱敏）。
//
// 纯函数、跨宿主（main / renderer 均可调用），不依赖任何 Node API。
// 核心原则：manifest 不是新的一份数据，而是当前真实比较结果的投影。
// - buildManifest：CompareResult + CompareRequest -> ReviewManifest（不重跑比较、不落盘）。
// - serializeManifest / manifestToMarkdown：在输出层对 objectType==='data' 的 sql
//   调用 redactDmlSql（数据面板仍显示真实行值，导出物脱敏）。
// - 本模块不提供任何 SQL 执行入口，也不触碰 Vault / SecretBundle。

import type {
  CompareResult,
  CoverageStatus,
  CoverageStatusKind,
  DataTableStatus,
  ManifestBuildInput,
  ReviewManifest,
  ReviewManifestItem,
} from './types';
import { REVIEW_MANIFEST_VERSION } from './types';

// ---------------------------------------------------------------------------
// CoverageStatus 映射（统一枚举 + 计数）
// ---------------------------------------------------------------------------

/** 取 kind 的优先级：越靠前越严重。 */
const KIND_PRIORITY: CoverageStatusKind[] = [
  'grant-invisible',
  'permission-denied',
  'over-threshold',
  'no-row-identity',
  'error',
  'aborted',
  'ok',
];

/**
 * 数据侧逐表状态 -> CoverageStatusKind。
 * reason 优先于 status：pk-mismatch 在 data-run 中记 status:'error'，但语义属「无行身份」
 * （AC5 分类），故映射到 no-row-identity 而非 error。
 */
function statusOfDataTable(t: DataTableStatus): CoverageStatusKind | null {
  if (t.reason === 'no-pk' || t.reason === 'pk-mismatch') return 'no-row-identity';
  if (t.reason === 'over-threshold') return 'over-threshold';
  if (t.reason === 'aborted') return 'aborted';
  if (t.reason === 'fetch-failed') return 'error';
  if (t.status === 'confirm-needed') return 'over-threshold';
  if (t.status === 'error') return 'error';
  if (t.status === 'skipped') return 'error';
  return null; // pending / running / done 不构成问题
}

/**
 * 覆盖状态统一汇总（确定性、纯函数）。
 * - counts：各来源映射后累加（每个 skipped / 失败 dataTable / 不可见对象计 1）。
 * - kind：counts 非空时取优先级最高者；全无问题返回 { kind:'ok', counts:{ ok:1 } }。
 */
export function deriveCoverageStatus(result: CompareResult): CoverageStatus {
  const counts: Partial<Record<CoverageStatusKind, number>> = {};
  const add = (kind: CoverageStatusKind, n = 1): void => {
    counts[kind] = (counts[kind] ?? 0) + n;
  };

  for (const skip of result.coverage?.skipped ?? []) {
    if (skip.reason === 'permission-denied') add('permission-denied');
    else if (skip.reason === 'aborted') add('aborted');
    else add('error'); // object-missing / unknown 统一归 error
  }
  for (const t of result.dataTables ?? []) {
    const kind = statusOfDataTable(t);
    if (kind) add(kind);
  }
  const excludedCount = result.visibility?.excluded.length ?? 0;
  if (excludedCount > 0) add('grant-invisible', excludedCount);

  const present = Object.keys(counts) as CoverageStatusKind[];
  if (present.length === 0) return { kind: 'ok', counts: { ok: 1 } };
  const kind = KIND_PRIORITY.find((k) => (counts[k] ?? 0) > 0) ?? 'ok';
  return { kind, counts };
}

// ---------------------------------------------------------------------------
// DML 脱敏器（只作用于已生成的 DML 文本，保留语句骨架）
// ---------------------------------------------------------------------------

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/**
 * 把 DML 语句中的字面值替换为脱敏占位符：
 * - 单引号字符串字面量（含日期、Buffer 转义串）→ `'***'`
 * - 数字字面量 → `0`（负号保留为运算符，`-1` 变 `-0`）
 * - `NULL` / `TRUE` / `FALSE` 保留（字母原样复制）
 * - 反引号标识符、注释、关键字、运算符原样保留
 *
 * 实现采用单遍字符扫描（而非正则两遍）：
 * - 反引号标识符（含 ```` 加倍转义）整体先复制，保证 `` `it's` `` 内的引号不被误伤；
 * - 字符串内出现反引号/注释符时按字符串整体吞掉，同样不会误判；
 * - 这是 highlightSql 占位符思路的更强形态（正则无法同时覆盖加倍反引号与串内反引号）。
 */
export function redactDmlSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释：-- 到行尾（含换行前内容）。
    if (ch === '-' && next === '-') {
      let j = i + 2;
      while (j < n && sql[j] !== '\n') j += 1;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    // 块注释：/* ... */。
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    // 反引号标识符：原样保留（` 加倍转义也整体吞掉）。
    if (ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }
    // 单引号字符串：整体替换为 '***'（处理 \' 转义与 '' 加倍引号）。
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += "'***'";
      i = Math.min(j + 1, n);
      continue;
    }
    // 数字字面量：替换为 0（含小数与科学计数法，如 1e+21）。
    if (isDigit(ch) || (ch === '.' && next !== undefined && isDigit(next))) {
      let j = i;
      while (j < n && (isDigit(sql[j]) || sql[j] === '.')) j += 1;
      if (j < n && (sql[j] === 'e' || sql[j] === 'E')) {
        let k = j + 1;
        if (k < n && (sql[k] === '+' || sql[k] === '-')) k += 1;
        if (k < n && isDigit(sql[k])) {
          while (k < n && isDigit(sql[k])) k += 1;
          j = k;
        }
      }
      out += '0';
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildManifest：CompareResult -> ReviewManifest（确定性投影）
// ---------------------------------------------------------------------------

function wantsData(scopes: unknown, includeData?: boolean): boolean {
  if (includeData === true) return true;
  return Array.isArray(scopes) && (scopes as unknown[]).includes('data');
}

/**
 * 从当前真实比较结果投影出审查报告。
 * - 仅允许 source !== 'demo'（demo 结果不可导出，抛 manifest: 错误）。
 * - 不复制 rollback / explain（Q4：最小交接报告）。
 * - 项目 sql 保留原文；脱敏在 serializeManifest / manifestToMarkdown 输出层做。
 */
export function buildManifest(input: ManifestBuildInput): ReviewManifest {
  const { result, request, aAlias, bAlias, appVersion } = input;
  if (result.source === 'demo') {
    throw new Error('manifest: 演示结果不可导出审查报告，请先完成一次真实比较');
  }
  const rawScopes = Array.isArray(request.scopes) ? request.scopes : (['table', 'view', 'procedure', 'function'] as const);
  const scopes = [...new Set(rawScopes)];
  const items: ReviewManifestItem[] = result.items.map((it) => ({
    id: it.id,
    objectType: it.objectType,
    objectName: it.objectName,
    changeType: it.changeType,
    ...(it.dml ? { dml: it.dml } : {}),
    aspects: it.aspects,
    risk: it.risk,
    sql: it.sql,
  }));
  return {
    schemaVersion: REVIEW_MANIFEST_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    aAlias,
    bAlias,
    scope: {
      scopes,
      includeData: wantsData(request.scopes, request.includeData),
      ...(typeof request.tableFilter === 'string' && request.tableFilter
        ? { tableFilter: request.tableFilter }
        : {}),
    },
    source: 'real',
    stats: { ...result.stats, DML: { ...result.stats.DML } },
    items,
    ...(result.dataTables && result.dataTables.length > 0 ? { dataTables: result.dataTables } : {}),
    ...(result.coverage ? { coverage: result.coverage } : {}),
    ...(result.visibility ? { visibility: result.visibility } : {}),
    coverageStatus: deriveCoverageStatus(result),
  };
}

// ---------------------------------------------------------------------------
// 序列化（确定性）：字段顺序即类型声明顺序，同输入 byte 稳定
// ---------------------------------------------------------------------------

/** 返回 items 中 data 项已脱敏的副本（DDL 原样；不修改入参）。 */
function redactedCopy(m: ReviewManifest): ReviewManifest {
  return {
    ...m,
    items: m.items.map((it) =>
      it.objectType === 'data' ? { ...it, sql: redactDmlSql(it.sql) } : it,
    ),
  };
}

/**
 * JSON 序列化：`JSON.stringify(m, null, 2) + '\n'`。
 * 输出前对 data 项调用 redactDmlSql，因此下载内容不含未经裁定的行值。
 */
export function serializeManifest(m: ReviewManifest): string {
  return JSON.stringify(redactedCopy(m), null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Markdown 生成（人工交接报告）
// ---------------------------------------------------------------------------

/** 覆盖/数据原因码的中文短文案（结构侧 + 数据侧两套词汇统一在此维护）。 */
function coverageReasonText(reason: string): string {
  if (reason === 'permission-denied') return '权限不足';
  if (reason === 'object-missing') return '对象已不存在';
  if (reason === 'aborted') return '已取消';
  if (reason === 'grant-invisible') return '授权不可见';
  if (reason === 'no-pk') return '无行身份';
  if (reason === 'pk-mismatch') return '行身份不一致';
  if (reason === 'over-threshold') return '超阈待确认';
  if (reason === 'fetch-failed') return '拉取失败';
  return '未知原因';
}

/** 数据表状态的中文短文案。 */
function dataStatusText(t: DataTableStatus): string {
  if (t.status === 'done') return '完成';
  if (t.status === 'running') return '进行中';
  if (t.status === 'skipped') return '跳过';
  if (t.status === 'confirm-needed') return '超阈待确认';
  if (t.status === 'error') return '失败';
  return t.status;
}

/**
 * Markdown 人工交接报告：
 * 头部 + 差异摘要表 + 结构 DDL 代码块（data 项已脱敏）+ 覆盖/可见性说明 + 保密声明。
 */
export function manifestToMarkdown(m: ReviewManifest): string {
  const r = redactedCopy(m);
  const lines: string[] = [];

  lines.push('# SqlDiff 审查报告');
  lines.push('');
  lines.push(`- A（来源）: ${r.aAlias}`);
  lines.push(`- B（目标）: ${r.bAlias}`);
  lines.push(`- 导出时间: ${r.exportedAt}`);
  lines.push(`- schemaVersion: ${r.schemaVersion}`);
  lines.push(`- appVersion: ${r.appVersion}`);
  lines.push(
    `- 范围: ${r.scope.scopes.join('/')}${r.scope.includeData ? ' + data' : ''}${
      r.scope.tableFilter ? `（表过滤: ${r.scope.tableFilter}）` : ''
    }`,
  );
  lines.push('');

  lines.push('## 差异摘要');
  lines.push('');
  lines.push('| 对象 | 类型 | 变更 | 风险 |');
  lines.push('| --- | --- | --- | --- |');
  if (r.items.length === 0) {
    lines.push('| （无差异） | | | |');
  } else {
    for (const it of r.items) {
      lines.push(`| ${it.objectName} | ${it.objectType} | ${it.dml ?? it.changeType} | ${it.risk} |`);
    }
  }
  lines.push('');

  lines.push('## 结构 DDL');
  lines.push('');
  if (r.items.length === 0) {
    lines.push('无差异。');
    lines.push('');
  } else {
    // 按对象分组（同对象的表语句拆条放在同一代码块，保留变更注释）。
    const groups = new Map<string, ReviewManifestItem[]>();
    for (const it of r.items) {
      const key = `${it.objectType}:${it.objectName}`;
      const arr = groups.get(key) ?? [];
      arr.push(it);
      groups.set(key, arr);
    }
    for (const items of groups.values()) {
      const first = items[0];
      lines.push(`### ${first.objectName}（${first.objectType}）`);
      lines.push('');
      lines.push('```sql');
      for (const it of items) {
        lines.push(`-- [${it.dml ?? it.changeType}] ${it.objectType} ${it.objectName}`);
        lines.push(it.sql);
      }
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## 覆盖与可见性');
  lines.push('');
  const skipped = r.coverage?.skipped ?? [];
  if (skipped.length > 0) {
    lines.push(`- 结构覆盖：${skipped.length} 个对象未取到 SHOW CREATE，已跳过且不参与差异：`);
    for (const s of skipped) {
      lines.push(`  - ${s.objectType} ${s.name}（${coverageReasonText(s.reason)}）`);
    }
  } else {
    lines.push(
      `- 结构覆盖：全部枚举对象均成功读取（ok: ${JSON.stringify(r.coverage?.ok ?? {})}）。`,
    );
  }
  const excluded = r.visibility?.excluded ?? [];
  if (excluded.length > 0) {
    lines.push(`- 授权可见性：${excluded.length} 个对象因授权仅单侧可见，未参与比较：`);
    for (const x of excluded) {
      lines.push(`  - ${x.objectType} ${x.name}（${x.side === 'a-only' ? '仅 A 侧可见' : '仅 B 侧可见'}）`);
    }
  }
  if (r.visibility && !r.visibility.reliable) {
    lines.push('- 授权可见性：判据不可靠（SHOW GRANTS 无法确认完整可见性），已按最保守范围比较。');
  }
  if (r.dataTables && r.dataTables.length > 0) {
    lines.push(`- 数据对比：${r.dataTables.length} 表。`);
    for (const t of r.dataTables) {
      // confirm-needed 的文案已含「超阈待确认」，不再重复 reason。
      const reasonSuffix =
        t.reason && t.status !== 'confirm-needed' ? `（${coverageReasonText(t.reason)}）` : '';
      lines.push(`  - ${t.a} → ${t.b}：${dataStatusText(t)}${reasonSuffix}`);
    }
  }
  lines.push(
    `- 覆盖状态：${r.coverageStatus.kind}（counts: ${JSON.stringify(r.coverageStatus.counts)}）`,
  );
  lines.push('');

  lines.push('## 保密声明');
  lines.push('');
  lines.push('本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）；数据行值已脱敏。');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 导出文件名（含时间戳，Windows 兼容：冒号与毫秒点替换为 '-'）
// ---------------------------------------------------------------------------

export function manifestFileNames(exportedAt: string): {
  jsonFileName: string;
  markdownFileName: string;
} {
  const safe = exportedAt.replace(/[:.]/g, '-');
  return {
    jsonFileName: `sqldiff-review-${safe}.json`,
    markdownFileName: `sqldiff-review-${safe}.md`,
  };
}