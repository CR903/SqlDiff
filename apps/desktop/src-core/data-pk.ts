// R1 主键解析：SHOW CREATE 全量解析 PRIMARY KEY(a,b) 联合主键。
// 修复老 `mysqldiff:218-222 getTablePK` 只取第一个反引号主键的缺陷
// （联合主键/无主键必错）。只读本函数，不碰 `mysqldiff/`。
//
// 小增强 R1（UNIQUE 等价行身份，Q1=仅 NOT NULL）：
// - parseUniqueKeys 解析 UNIQUE KEY / UNIQUE INDEX 定义（含列级内联 UNIQUE），
//   逐列判定 NOT NULL（列定义行含 NOT NULL 为非空；PRIMARY KEY 列的隐式非空不计入，
//   必须显式 NOT NULL 才算资格）；
// - qualifyIdentity 优先 PK，其次首个全列非空 UNIQUE，否则 none（reason 点名可空列/无唯一键）。

/**
 * 从 SHOW CREATE TABLE 文本解析主键列（ ordered ）。
 * - 单主键 `PRIMARY KEY (`id`)` -> ['id']
 * - 联合主键 `PRIMARY KEY (`a`,`b`)` -> ['a', 'b']（含空格/换行变体）
 * - 无 PRIMARY KEY 子句或括号内无反引号列 -> null（调用方记 skipped:'no-pk'）
 */
export function parseTablePK(ddl: string | null | undefined): string[] | null {
  if (typeof ddl !== 'string' || ddl.length === 0) return null;
  const m = ddl.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
  if (!m) return null;
  const cols: string[] = [];
  const body = m[1];
  const re = /`([^`]+)`/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(body)) !== null) {
    const col = hit[1].trim();
    if (col && !cols.includes(col)) cols.push(col);
  }
  return cols.length > 0 ? cols : null;
}

/** 单个 UNIQUE 键定义（nullable 与 cols 等长：true=可空，无资格做行身份）。 */
export interface UniqueKeyDef {
  /** 键名（列级内联 UNIQUE 无名，为 null）。 */
  name: string | null;
  cols: string[];
  nullable: boolean[];
}

/** 行身份判定结果：pk 优先，其次全非空 UNIQUE，否则 none（reason 给出来由）。 */
export type TableIdentity =
  | { kind: 'pk'; cols: string[] }
  | { kind: 'unique'; cols: string[]; name: string | null }
  | { kind: 'none'; reason: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去引号字面量（COMMENT/ENUM 内含 UNIQUE 等关键字时不误判）。 */
function stripQuoted(s: string): string {
  return s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * 列是否显式 NOT NULL（列定义行含 NOT NULL；PRIMARY KEY 隐式非空不计入）。
 * 未知列（DDL 中找不到列定义）按可空处理（保守：无资格）。
 */
export function isColumnNotNull(ddl: string, col: string): boolean {
  const re = new RegExp(`^[ \\t]*\`${escapeRegExp(col)}\`[^\\n]*`, 'gim');
  let m: RegExpExecArray | null;
  while ((m = re.exec(ddl)) !== null) {
    // 行首反引号列必为列定义（键定义行首为 PRIMARY/UNIQUE/KEY/CONSTRAINT 等关键字）。
    return /\bNOT\s+NULL\b/i.test(stripQuoted(m[0]));
  }
  return false;
}

/**
 * 从 SHOW CREATE TABLE 文本解析全部 UNIQUE 键（按 DDL 出现顺序）。
 * - 表级 `UNIQUE KEY `uk` (`a`,`b`)` / `UNIQUE INDEX ...` / 匿名 `UNIQUE (`a`)`（含换行变体）；
 * - 列级内联 `` `email` varchar(64) NOT NULL UNIQUE ``（含 `UNIQUE KEY` 后缀变体）。
 * 括号内无反引号列的空定义跳过；同名同列去重。
 */
export function parseUniqueKeys(ddl: string | null | undefined): UniqueKeyDef[] {
  if (typeof ddl !== 'string' || ddl.length === 0) return [];
  const clean = stripQuoted(ddl);
  type Raw = { index: number; name: string | null; cols: string[] };
  const raws: Raw[] = [];

  const tableRe = /UNIQUE\s+(?:KEY|INDEX)?\s*(?:`([^`]*)`\s*)?\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(clean)) !== null) {
    const name = m[1] !== undefined ? m[1] : null;
    const cols: string[] = [];
    const body = m[2];
    const colRe = /`([^`]+)`/g;
    let hit: RegExpExecArray | null;
    while ((hit = colRe.exec(body)) !== null) {
      const col = hit[1].trim();
      if (col && !cols.includes(col)) cols.push(col);
    }
    if (cols.length > 0) raws.push({ index: m.index, name, cols });
  }

  // 列级内联：行首反引号列定义且行内含 UNIQUE 关键字（COMMENT 已去引号，不误判）。
  const lines = clean.split('\n');
  let offset = 0;
  for (const line of lines) {
    const lm = line.match(/^[ \t]*`([^`]+)`(.*)$/);
    if (lm && /\bUNIQUE\b/i.test(lm[2])) {
      const col = lm[1].trim();
      if (col) raws.push({ index: offset, name: null, cols: [col] });
    }
    offset += line.length + 1;
  }

  raws.sort((x, y) => x.index - y.index);
  const out: UniqueKeyDef[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    const key = `${r.name ?? ''}\0${r.cols.join('\0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.name, cols: r.cols, nullable: r.cols.map((c) => !isColumnNotNull(ddl, c)) });
  }
  return out;
}

/**
 * 行身份资格判定（Q1：仅 NOT NULL）。
 * - 有 PK -> {kind:'pk'}（PK 列无需 NOT NULL 显式标记）；
 * - 无 PK 但有首个全列非空 UNIQUE -> {kind:'unique'}；
 * - 否则 {kind:'none'}：有 UNIQUE 但含可空列时 reason 点名（哪键、哪列可空），
 *   无任何唯一键时 reason 说明无 PRIMARY KEY 且无 UNIQUE 键。
 */
export function qualifyIdentity(ddl: string | null | undefined): TableIdentity {
  const pk = parseTablePK(ddl);
  if (pk) return { kind: 'pk', cols: pk };
  const uniques = parseUniqueKeys(ddl);
  for (const u of uniques) {
    if (u.nullable.every((n) => !n)) return { kind: 'unique', cols: u.cols, name: u.name };
  }
  if (uniques.length === 0) {
    return { kind: 'none', reason: '无 PRIMARY KEY 且无 UNIQUE 键' };
  }
  const details = uniques.map((u) => {
    const nullCols = u.cols.filter((_, i) => u.nullable[i]);
    const label = `UNIQUE${u.name ? ` ${u.name}` : ''}(${u.cols.join(',')})`;
    return `${label}含可空列：${nullCols.join('、')}`;
  });
  return { kind: 'none', reason: details.join('；') };
}
