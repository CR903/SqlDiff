// R1 主键解析：SHOW CREATE 全量解析 PRIMARY KEY(a,b) 联合主键。
// 修复老 `mysqldiff:218-222 getTablePK` 只取第一个反引号主键的缺陷
// （联合主键/无主键必错）。只读本函数，不碰 `mysqldiff/`。

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
