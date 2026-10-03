// 生产 Preflight v1 · DDL 分类器与 Online DDL 矩阵（纯函数，零运行时依赖）。
//
// 分类器：把 DDL 文本按关键字优先级归入 DdlOp（不做完整 SQL AST；复杂语句可能误分类）。
// 矩阵：内置 17 种 Op 的静态表 + MySQL 版本前缀比较；未收录或版本 < 5.6 返回 null。
//
// 边界：本文件是纯函数层，不触碰 SQL 执行、不引入 Node 依赖。

export type DdlOp =
  | 'ADD_COLUMN'
  | 'DROP_COLUMN'
  | 'MODIFY_COLUMN'
  | 'CHANGE_COLUMN'
  | 'ADD_INDEX'
  | 'ADD_UNIQUE_INDEX'
  | 'ADD_PRIMARY_KEY'
  | 'DROP_INDEX'
  | 'CONVERT_TO_CHAR_SET'
  | 'CHANGE_ENGINE'
  | 'CREATE_TABLE'
  | 'DROP_TABLE'
  | 'RENAME_TABLE'
  | 'CREATE_INDEX'
  | 'DROP_INDEX_STANDALONE'
  | 'OTHER';

export type DdlConfidence = 'high' | 'medium' | 'low';

/**
 * 单条 DDL 的分类结果。
 *
 * - `tableName` / `columnName` / `indexName`：从 DDL 提取的标识符（已剥离反引号，
 *   含 ``dbl`` 转义还原），捕获不到时返回 `null`。
 * - `statement`：原始 SQL（已 trim），供调用方写入 Inference 备注。
 * - `confidence`：`high` = 关键字形态明确；`medium` = 语义有歧义（例：CREATE INDEX
 *   无法从 SQL 判定是否为 UNIQUE）；`low` = OTHER 兜底。
 */
export interface DdlClassification {
  op: DdlOp;
  tableName: string | null;
  columnName: string | null;
  indexName: string | null;
  statement: string;
  confidence: DdlConfidence;
}

// ---------------------------------------------------------------------------
// 标识符提取（反引号包裹可剥离；未捕获返回 null）
// ---------------------------------------------------------------------------

/** 剥离反引号并把 ``dbl`` 转义还原为单反引号；对裸标识符原样返回。 */
function stripBackticks(s: string): string {
  if (s.length >= 2 && s[0] === '`' && s.endsWith('`')) {
    return s.slice(1, -1).replace(/``/g, '`');
  }
  return s;
}

// ---------------------------------------------------------------------------
// 表名提取
// ---------------------------------------------------------------------------

function extractTable(sql: string): string | null {
  // ALTER TABLE [IF EXISTS] <name>
  const r1 = new RegExp(
    '^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(`([^`]*)`|[A-Za-z_$][\\w$]*)',
    'i',
  );
  const m1 = sql.match(r1);
  if (m1) return stripBackticks(m1[1]);
  // CREATE TABLE [IF NOT EXISTS] <name>
  const r2 = new RegExp(
    '^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(`([^`]*)`|[A-Za-z_$][\\w$]*)',
    'i',
  );
  const m2 = sql.match(r2);
  if (m2) return stripBackticks(m2[1]);
  // DROP TABLE [IF EXISTS] <name>
  const r3 = new RegExp(
    '^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(`([^`]*)`|[A-Za-z_$][\\w$]*)',
    'i',
  );
  const m3 = sql.match(r3);
  if (m3) return stripBackticks(m3[1]);
  return null;
}

/** 从 `ON <tbl>` 子句提取表名（CREATE INDEX / DROP INDEX 独立语句）。 */
function extractTableFromOnClause(sql: string): string | null {
  const re = /\bON\s+(`([^`]*)`|[A-Za-z_$][\w$]*)/i;
  const m = sql.match(re);
  if (!m) return null;
  return stripBackticks(m[1]);
}

// ---------------------------------------------------------------------------
// 列名提取
// ---------------------------------------------------------------------------

/** 从 ADD / DROP / MODIFY COLUMN <name> 提取列名。 */
function extractFirstColumn(sql: string, verb: 'ADD' | 'DROP' | 'MODIFY'): string | null {
  const re = new RegExp(
    '\\b' + verb + '\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:COLUMN\\s+)?' +
      '(`([^`]*)`|[A-Za-z_$][\\w$]*)',
    'i',
  );
  const m = sql.match(re);
  if (!m) return null;
  return stripBackticks(m[1]);
}

/** 从 CHANGE [COLUMN] <old> <new> ... 提取 [old, new]。 */
function extractChangeColumns(sql: string): [string | null, string | null] {
  // CHANGE COLUMN `old` `new` ...
  const reQ = new RegExp('\\bCHANGE\\s+COLUMN\\s+(`([^`]*)`)\\s+(`([^`]*)`)', 'i');
  const mQ = sql.match(reQ);
  if (mQ) return [stripBackticks(mQ[1]), stripBackticks(mQ[3])];
  // CHANGE COLUMN old new ...
  const reC = new RegExp('\\bCHANGE\\s+COLUMN\\s+([A-Za-z_$][\\w$]*)\\s+([A-Za-z_$][\\w$]*)', 'i');
  const mC = sql.match(reC);
  if (mC) return [mC[1], mC[2]];
  // CHANGE `old` `new` ...
  const reQBare = new RegExp('\\bCHANGE\\s+(`([^`]*)`)\\s+(`([^`]*)`)', 'i');
  const mQBare = sql.match(reQBare);
  if (mQBare) return [stripBackticks(mQBare[1]), stripBackticks(mQBare[3])];
  // CHANGE old new ...
  const reBare = new RegExp('\\bCHANGE\\s+([A-Za-z_$][\\w$]*)\\s+([A-Za-z_$][\\w$]*)', 'i');
  const mBare = sql.match(reBare);
  if (mBare) return [mBare[1], mBare[2]];
  return [null, null];
}

/** 从 ADD [UNIQUE] [INDEX|KEY] <idx> (<col>) 提取列名。 */
function extractFirstColumnFromIndexOp(sql: string): string | null {
  const re =
    /\bADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+`([^`]*)`\s*\(\s*`([^`]*)`/i;
  const m1 = sql.match(re);
  if (m1) return stripBackticks(m1[2]);
  const re2 = /\bADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+[A-Za-z_$][\w$]*\s*\(\s*[A-Za-z_$][\w$]*/i;
  const m2 = sql.match(re2);
  if (m2) return m2[0].match(/\(\s*([A-Za-z_$][\w$]*)/)?.[1] ?? null;
  return null;
}

/** 从 CREATE / ADD / DROP [UNIQUE] [INDEX|KEY] <name> 提取索引名。 */
function extractIndexName(sql: string, verb: 'ADD' | 'DROP' | 'CREATE'): string | null {
  if (verb === 'CREATE') {
    const re = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]*)`/i;
    const m1 = sql.match(re);
    if (m1) return stripBackticks(m1[1]);
    const re2 = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_$][\w$]*/i;
    const m2 = sql.match(re2);
    if (m2) return m2[0].match(/[A-Za-z_$][\w$]*$/)?.[0] ?? null;
    return null;
  }
  const re = new RegExp(
    `\\b${verb}\\s+(?:UNIQUE\\s+)?(?:INDEX|KEY)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?` +
      '(`([^`]*)`|[A-Za-z_$][\\w$]*)',
    'i',
  );
  const m = sql.match(re);
  if (!m) return null;
  return stripBackticks(m[1]);
}

/** 从 RENAME TABLE ... TO <newName> 提取新表名。 */
function extractNewTableName(sql: string): string | null {
  const re = /\bTO\s+(`([^`]*)`|[A-Za-z_$][\w$]*)/i;
  const m = sql.match(re);
  if (!m) return null;
  return stripBackticks(m[1]);
}

// ---------------------------------------------------------------------------
// 模式表（关键字匹配，全部大小写不敏感）
// ---------------------------------------------------------------------------

interface DdlPattern {
  op: DdlOp;
  re: RegExp;
}

/**
 * 按优先级顺序匹配（首个命中即返回）：
 *
 * 1. 完整语句操作：DROP TABLE / CREATE TABLE / RENAME TABLE / CREATE INDEX /
 *    DROP INDEX —— 语句起始关键字即定类型。
 * 2. ALTER TABLE 索引类：ADD PRIMARY KEY > ADD UNIQUE INDEX > ADD INDEX > DROP INDEX
 *    —— 先判 PRIMARY / UNIQUE 避免被 `KEY` 兜底吞掉。
 * 3. ALTER TABLE 列类：DROP COLUMN > CHANGE COLUMN > MODIFY COLUMN > ADD COLUMN
 *    —— `COLUMN` 是显式关键字，不与 `ADD KEY` 冲突。
 * 4. ALTER TABLE 表级属性：CONVERT TO CHARACTER SET > ENGINE =
 */
const PATTERNS: readonly DdlPattern[] = [
  { op: 'DROP_TABLE', re: /^DROP\s+TABLE\b/i },
  { op: 'CREATE_TABLE', re: /^CREATE\s+TABLE\b/i },
  { op: 'RENAME_TABLE', re: /^RENAME\s+TABLE\b/i },
  { op: 'CREATE_INDEX', re: /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i },
  { op: 'DROP_INDEX_STANDALONE', re: /^DROP\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\b/i },

  { op: 'ADD_PRIMARY_KEY', re: /ALTER\s+TABLE\b.*\bADD\s+PRIMARY\s+KEY\b/i },
  { op: 'ADD_UNIQUE_INDEX', re: /ALTER\s+TABLE\b.*\bADD\s+UNIQUE\s+(?:INDEX|KEY)\b/i },
  { op: 'ADD_INDEX', re: /ALTER\s+TABLE\b.*\bADD\s+(?:FULLTEXT|SPATIAL|INDEX|KEY)\b/i },
  { op: 'DROP_INDEX', re: /ALTER\s+TABLE\b.*\bDROP\s+(?:INDEX|KEY)\b/i },

  { op: 'DROP_COLUMN', re: /ALTER\s+TABLE\b.*\bDROP\s+COLUMN\b/i },
  { op: 'CHANGE_COLUMN', re: /ALTER\s+TABLE\b.*\bCHANGE\s+(?:COLUMN\b|\S+\s+\S+)/i },
  { op: 'MODIFY_COLUMN', re: /ALTER\s+TABLE\b.*\bMODIFY\s+(?:COLUMN\s+|\S+)/i },
  { op: 'ADD_COLUMN', re: /ALTER\s+TABLE\b.*\bADD\s+(?!PARTITION\b|CONSTRAINT\b|FOREIGN\b|FULLTEXT\b|SPATIAL\b|INDEX\b|KEY\b|PRIMARY\b|UNIQUE\b)(?:COLUMN\s+|\S+)/i },

  { op: 'CONVERT_TO_CHAR_SET', re: /ALTER\s+TABLE\b.*\bCONVERT\s+TO\s+CHARACTER\s+SET\b/i },
  { op: 'CHANGE_ENGINE', re: /ALTER\s+TABLE\b.*\bENGINE\s*=/i },
];

// ---------------------------------------------------------------------------
// 分类器入口
// ---------------------------------------------------------------------------

/**
 * 从 DDL 文本分类出 DdlOp。纯函数。
 *
 * - 大小写不敏感；反引号包裹的标识符可剥离（含 ``dbl`` 转义）。
 * - 复合 ALTER（`ALTER TABLE t ADD COLUMN a, ADD COLUMN b`）按优先级取首条匹配，
 *   由调用方在 Inference 备注里注明「多条 ALTER 子句，取首个操作类别」。
 * - 无法识别 → `op: 'OTHER'`，`confidence: 'low'`。
 */
export function classifyDdl(sql: string): DdlClassification {
  const trimmed = sql.trim();
  if (!trimmed) {
    return {
      op: 'OTHER',
      tableName: null,
      columnName: null,
      indexName: null,
      statement: '',
      confidence: 'low',
    };
  }
  for (const { op, re } of PATTERNS) {
    if (re.test(trimmed)) {
      return {
        op,
        tableName: pickTableName(op, trimmed),
        columnName: pickColumnName(op, trimmed),
        indexName: pickIndexName(op, trimmed),
        statement: trimmed,
        confidence: confidenceOf(op),
      };
    }
  }
  return {
    op: 'OTHER',
    tableName: null,
    columnName: null,
    indexName: null,
    statement: trimmed,
    confidence: 'low',
  };
}

function pickTableName(op: DdlOp, sql: string): string | null {
  switch (op) {
    case 'DROP_TABLE':
    case 'CREATE_TABLE':
    case 'ADD_INDEX':
    case 'ADD_UNIQUE_INDEX':
    case 'ADD_PRIMARY_KEY':
    case 'DROP_INDEX':
    case 'DROP_COLUMN':
    case 'MODIFY_COLUMN':
    case 'CHANGE_COLUMN':
    case 'ADD_COLUMN':
    case 'CONVERT_TO_CHAR_SET':
    case 'CHANGE_ENGINE':
      return extractTable(sql);
    case 'RENAME_TABLE':
      return extractNewTableName(sql);
    case 'CREATE_INDEX':
    case 'DROP_INDEX_STANDALONE':
      return extractTableFromOnClause(sql);
    case 'OTHER':
      return null;
  }
}

function pickColumnName(op: DdlOp, sql: string): string | null {
  switch (op) {
    case 'ADD_COLUMN':
      return extractFirstColumn(sql, 'ADD');
    case 'DROP_COLUMN':
      return extractFirstColumn(sql, 'DROP');
    case 'MODIFY_COLUMN':
      return extractFirstColumn(sql, 'MODIFY');
    case 'CHANGE_COLUMN':
      return extractChangeColumns(sql)[0];
    case 'ADD_INDEX':
    case 'ADD_UNIQUE_INDEX':
      return extractFirstColumnFromIndexOp(sql);
    case 'OTHER':
      return null;
    default:
      return null;
  }
}

function pickIndexName(op: DdlOp, sql: string): string | null {
  switch (op) {
    case 'ADD_INDEX':
    case 'ADD_UNIQUE_INDEX':
      return extractIndexName(sql, 'ADD');
    case 'DROP_INDEX':
    case 'DROP_INDEX_STANDALONE':
      return extractIndexName(sql, 'DROP');
    case 'CREATE_INDEX':
      return extractIndexName(sql, 'CREATE');
    case 'OTHER':
      return null;
    default:
      return null;
  }
}

function confidenceOf(op: DdlOp): DdlConfidence {
  // CREATE INDEX 无法从 SQL 判定是否为 UNIQUE（取决于列是否为唯一），故 medium；
  // OTHER 兜底，故 low；其余关键字明确，故 high。
  if (op === 'CREATE_INDEX') return 'medium';
  if (op === 'OTHER') return 'low';
  return 'high';
}

// ---------------------------------------------------------------------------
// 版本前缀比较
// ---------------------------------------------------------------------------

/**
 * 版本前缀比较：'8.0.36' >= '8.0.12'。
 *
 * - 支持 `X.Y.Z` 与 `X.Y.Z.N`（MariaDB-style 四段）前缀比较；缺位按 0 补齐。
 * - 只取首段纯数字（MySQL 8.0.36-0ubuntu 之类后缀被忽略）。
 * - 非法字符串返回 false（上层记 unsupported-version）。
 */
export function versionAtLeast(actual: string, required: string): boolean {
  const a = parseVersion(actual);
  const r = parseVersion(required);
  if (!a || !r) return false;
  const len = Math.max(a.length, r.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const rv = r[i] ?? 0;
    if (av > rv) return true;
    if (av < rv) return false;
  }
  return true; // 完全相等
}

function parseVersion(s: string): number[] | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // 只取首段纯数字（去掉 build tag / 发行版后缀）
  const m = trimmed.match(/^(\d+(?:\.\d+)*)/);
  if (!m) return null;
  return m[1].split('.').map((n) => Number.parseInt(n, 10));
}

// ---------------------------------------------------------------------------
// Online DDL 矩阵
// ---------------------------------------------------------------------------

export interface OnlineDdlInfo {
  algorithm: 'INSTANT' | 'INPLACE' | 'COPY';
  lockMode: 'NONE' | 'SHARED' | 'EXCLUSIVE' | 'EXCLUSIVE-BRIEF';
  rebuildsTable: boolean;
  /** 版本下限（形如 '8.0.12'）；低于此版本该算法不可用。 */
  availableFrom: string | null;
  notes: string;
}

/** MySQL 5.6 是 InnoDB 支持 INPLACE ALTER 的最低版本；低于此返回 null。 */
const MIN_VERSION = '5.6';

/**
 * 查矩阵：按 DdlOp + MySQL 版本返回 OnlineDdlInfo。
 *
 * **v1 只做「可用 INSTANT」的乐观推断**：
 * - `ADD_COLUMN` 在 MySQL ≥ 8.0.12 且列被追加到末尾、无默认值时 MySQL 才使用 INSTANT；
 *   本函数无 `default` 参数，无法读取 DDL 里的 DEFAULT 子句，因此对版本 ≥ 8.0.12
 *   一律返回 INSTANT（乐观推断），实际默认值检测留待 v2。规则层负责把「大表 +
 *   ADD_COLUMN + INSTANT」映射为 `LARGE_TABLE_INSTANT_ADD` 提示（见 preflight-rules.ts）。
 * - `DROP_COLUMN` 在 MySQL ≥ 8.0.29 返回 INSTANT，无条件（MySQL 8.0.29 起原生支持）。
 *
 * 版本分支：
 * - MySQL < 5.6 → 返回 null（上层记 `unsupported-version`）；
 * - 矩阵未收录 → 返回 null（上层记 `unparsed-ddl`）。
 */
export function lookupOnlineDdl(op: DdlOp, mysqlVersion: string): OnlineDdlInfo | null {
  if (!mysqlVersion || !versionAtLeast(mysqlVersion, MIN_VERSION)) return null;

  switch (op) {
    case 'ADD_COLUMN':
      if (versionAtLeast(mysqlVersion, '8.0.12')) {
        return {
          algorithm: 'INSTANT',
          lockMode: 'SHARED',
          rebuildsTable: false,
          availableFrom: '8.0.12',
          notes: 'INSTANT 追加列（v1 乐观推断：未校验 DEFAULT 子句；实际默认值检测推迟到 v2）',
        };
      }
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: 'MySQL 8.0.12 前一律 INPLACE + 重建表',
      };

    case 'DROP_COLUMN':
      if (versionAtLeast(mysqlVersion, '8.0.29')) {
        return {
          algorithm: 'INSTANT',
          lockMode: 'NONE',
          rebuildsTable: false,
          availableFrom: '8.0.29',
          notes: 'MySQL 8.0.29 起 DROP COLUMN 原生 INSTANT',
        };
      }
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: 'MySQL 8.0.29 前 DROP COLUMN 需重建表',
      };

    case 'ADD_INDEX':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: false,
        availableFrom: '5.6',
        notes: '非 UNIQUE、非 PRIMARY KEY 索引；不重建表',
      };
    case 'ADD_UNIQUE_INDEX':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: 'UNIQUE INDEX 需重建表',
      };
    case 'ADD_PRIMARY_KEY':
      return {
        algorithm: 'INPLACE',
        lockMode: 'EXCLUSIVE',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: 'PRIMARY KEY 需重建表 + 排他锁',
      };
    case 'DROP_INDEX':
    case 'DROP_INDEX_STANDALONE':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: false,
        availableFrom: '5.6',
        notes: 'DROP INDEX / DROP KEY',
      };

    case 'MODIFY_COLUMN':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: 'MODIFY COLUMN 一律重建表',
      };
    case 'CHANGE_COLUMN':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: 'CHANGE COLUMN 一律重建表',
      };

    case 'CONVERT_TO_CHAR_SET':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: '字符集扩张（如 utf8mb4）需重建表且空间可能翻倍',
      };
    case 'CHANGE_ENGINE':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: true,
        availableFrom: '5.6',
        notes: '引擎变更需重建表',
      };

    case 'CREATE_TABLE':
      return {
        algorithm: 'INPLACE',
        lockMode: 'EXCLUSIVE-BRIEF',
        rebuildsTable: false,
        availableFrom: '5.6',
        notes: '新建表',
      };
    case 'DROP_TABLE':
      return {
        algorithm: 'INPLACE',
        lockMode: 'EXCLUSIVE-BRIEF',
        rebuildsTable: false,
        availableFrom: '5.6',
        notes: '删除表',
      };
    case 'RENAME_TABLE':
      return {
        algorithm: 'INPLACE',
        lockMode: 'EXCLUSIVE-BRIEF',
        rebuildsTable: false,
        availableFrom: '5.6',
        notes: '重命名表',
      };
    case 'CREATE_INDEX':
      return {
        algorithm: 'INPLACE',
        lockMode: 'SHARED',
        rebuildsTable: false,
        availableFrom: '5.6',
        notes: 'CREATE INDEX；若目标列为唯一索引则实际需重建表',
      };

    case 'OTHER':
    default:
      return null;
  }
}
