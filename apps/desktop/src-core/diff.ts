// M4 diff 移植：纯 TS 复刻 `mysqldiff/mysqldiff:223-351` 语义。
// 只读老代码，不改 `mysqldiff/`。正则与分支与老逻辑逐行一致，
// 含 AUTO_INCREMENT/CHECKSUM 等忽略项（filterTable）与 COMMENT 忽略（filterField）。
//
// 老函数对照：
// - filterTable      <- mysqldiff:342-351
// - filterField      <- mysqldiff:336-341
// - diffTableField   <- mysqldiff:267-335
// - diffTable        <- mysqldiff:257-266
// - filterProcedure  <- mysqldiff:250-256
// - changeProcedure  <- mysqldiff:238-249
// - diffProcedure    <- mysqldiff:223-237
//
// 纯函数：不连 DB。changeProcedure 的 DEFINER 归一需要目标库用户名时
// 由调用方经 `targetUser` 传入（老代码取 `db2.getUser()`）；不传则原样返回。

export type RoutineKind = 'PROCEDURE' | 'FUNCTION' | 'VIEW';

/** 输入归一：SHOW CREATE 文本；null/undefined/非字符串一律视为空（缺失）。 */
function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 老 filterField:336-341 — 忽略列 COMMENT（两种写法），其余逐字比对。 */
export function filterField(field: string | null | undefined): string {
  if (!field) return '';
  let out = field;
  out = out.replace(/ COMMENT '.*'/g, '');
  out = out.replace(/ COMMENT='.*'/g, '');
  return out.trim();
}

/** 老 filterTable:342-351 — 忽略 AUTO_INCREMENT 等表选项 + COMMENT。 */
export function filterTable(table: string | null | undefined): string {
  if (!table) return '';
  let out = table;
  out = out.replace(/AUTO_INCREMENT=.* /g, '');
  out = out.replace(/ CHECKSUM=1/g, '');
  out = out.replace(/ DELAY_KEY_WRITE=1/g, '');
  out = out.replace(/ ROW_FORMAT=DYNAMIC/g, '');
  out = out.replace(/ DEFAULT/g, '');
  out = filterField(out);
  return out.trim();
}

/** 老 diffTable:257-266。返回 null 表示无差异。 */
export function diffTable(
  name: string,
  table1: string | null | undefined,
  table2: string | null | undefined,
): string | null {
  // 与老 diffTable:257-266 同语义：按过滤后文本判空（t1/t2），返回时用原文。
  const raw1 = asText(table1);
  const raw2 = asText(table2);
  const t1 = filterTable(raw1);
  const t2 = filterTable(raw2);
  if (t1 === t2) return null;

  if (t1 !== '' && t2 === '') return `${raw1};\n`;
  if (t1 === '' && t2 !== '') return `DROP TABLE \`${name}\`;\n`;

  return diffTableField(name, raw1, raw2);
}

/**
 * R2 表语句拆分：按 `/;\s*\n/` 切为单语句（尾补 `;` + `\n`，过滤空块）。
 * 仅表条目调用：CREATE TABLE 内无分号，拆分安全；
 * 视图/过程/函数含 DELIMITER 不走本函数，保持原子。
 */
export function splitStatements(tableSql: string): string[] {
  const text = tableSql ?? '';
  if (!text.trim()) return [];
  return text
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    // 切分消耗了 `;`（`;\n` 结尾）；末块无换行时 `;` 仍在，需先去重再补回，避免 `;;`。
    .map((s) => `${s.endsWith(';') ? s : `${s};`}\n`);
}

/** 老 diffTableField:267-335 — 逐行解析列/主键/索引，生成 ALTER 语句串。 */
export function diffTableField(name: string, table1: string, table2: string): string {
  const t1 = table1.split('\n');
  const t2 = table2.split('\n');
  if (t1.length < 3 || t2.length < 3) return '';

  const col: string[] = [];
  const col1: Record<string, string> = {};
  const col2: Record<string, string> = {};
  const key: string[] = [];
  const key1: Record<string, number> = {};
  const key2: Record<string, number> = {};
  let pk1 = '';
  let pk2 = '';

  for (let i = 1, len = t1.length - 1; i < len; i++) {
    let row = t1[i].trim();
    const l = row.length - 1;
    if (row.lastIndexOf(',') === l) row = row.substring(0, l);
    const field = row.indexOf('`') === 0 ? row.split(' ')[0] : false;
    const pkey = row.indexOf('PRIMARY KEY ') === 0 ? row.substring(12) : false;
    const ikey = row.indexOf('KEY `') === 0 ? row.substring(4) : false;
    if (field) {
      col1[field] = row;
      if (col.indexOf(field) === -1) col.push(field);
    }
    if (pkey) pk1 = pkey as string;
    if (ikey) {
      key1[ikey as string] = 1;
      if (key.indexOf(ikey as string) === -1) key.push(ikey as string);
    }
  }

  for (let i = 1, len = t2.length - 1; i < len; i++) {
    let row = t2[i].trim();
    const l = row.length - 1;
    if (row.lastIndexOf(',') === l) row = row.substring(0, l);
    const field = row.indexOf('`') === 0 ? row.split(' ')[0] : false;
    const pkey = row.indexOf('PRIMARY KEY ') === 0 ? row.substring(12) : false;
    const ikey = row.indexOf('KEY `') === 0 ? row.substring(4) : false;
    if (field) {
      col2[field] = row;
      if (col.indexOf(field) === -1) col.push(field);
    }
    if (pkey) pk2 = pkey as string;
    if (ikey) {
      key2[ikey as string] = 1;
      if (key.indexOf(ikey as string) === -1) key.push(ikey as string);
    }
  }

  let sql = '';
  for (let i = 0, len = col.length; i < len; i++) {
    const c = col[i];
    const c1 = col1[c];
    const c2 = col2[c];
    const c3 = filterField(c1);
    const c4 = filterField(c2);
    if (c3 === c4) continue;

    if (c3 !== '' && c4 === '') {
      sql += `ALTER TABLE \`${name}\` ADD COLUMN ${c1};\n`;
      continue;
    }
    if (c3 === '' && c4 !== '') {
      sql += `ALTER TABLE \`${name}\` DROP COLUMN ${c};\n`;
      continue;
    }
    sql += `ALTER TABLE \`${name}\` CHANGE COLUMN ${c} ${c1};\n`;
  }

  if (pk1 !== '' && pk2 === '') sql += `ALTER TABLE \`${name}\` ADD PRIMARY KEY ${pk1};\n`;
  if (pk1 === '' && pk2 !== '') sql += 'ALTER TABLE `' + name + '` DROP PRIMARY KEY;\n';
  if (pk1 !== '' && pk2 !== '' && pk1 !== pk2)
    sql += `ALTER TABLE \`${name}\` DROP PRIMARY KEY,ADD PRIMARY KEY ${pk1};\n`;

  for (let i = 0, len = key.length; i < len; i++) {
    const k = key[i];
    const k1 = key1[k];
    const k2 = key2[k];
    if (k1 === k2) continue;

    if (k1 && !k2) {
      sql += `ALTER TABLE \`${name}\` ADD INDEX ${k};\n`;
      continue;
    }
    if (!k1 && k2) {
      const kname = k.split(' ')[0];
      sql += `ALTER TABLE \`${name}\` DROP INDEX ${kname};\n`;
      continue;
    }
  }

  return sql;
}

/** 老 filterProcedure:250-256 — DEFINER 归一后比对。 */
export function filterProcedure(proc: string | null | undefined): string {
  if (!proc) return '';
  let out = proc;
  out = out.replace(/ DEFINER=.* FUNCTION/g, ' FUNCTION');
  out = out.replace(/ DEFINER=.* PROCEDURE/g, ' PROCEDURE');
  out = out.replace(/ DEFINER=.* VIEW/g, ' VIEW');
  return out.trim();
}

/**
 * 老 changeProcedure:238-249。
 * - proc2 为空（目标库缺失，需新建）：老代码把来源 DEFINER 用户换成 db2 用户；
 *   纯函数版经 `targetUser` 传入，不传则原样返回来源语句。
 * - 双方都有：把来源语句的 DEFINER 段换成目标库的 DEFINER 段（保留目标 DEFINER，避免误报）。
 * - 目标语句无 DEFINER 段时老代码会抛错；纯函数版降级为原样返回（更稳，不改有 DEFINER 时的语义）。
 */
export function changeProcedure(
  proc1: string,
  proc2: string | null | undefined,
  ex: RoutineKind,
  targetUser?: string,
): string {
  if (!proc2) {
    if (!targetUser) return proc1;
    return proc1.replace(/ DEFINER=`.*`@/g, ` DEFINER=\`${targetUser}\`@`);
  }
  const single = new RegExp(` DEFINER=.* ${ex}`, 'i');
  const m = proc2.match(single);
  if (!m) return proc1;
  const definer = m[0];
  const global = new RegExp(` DEFINER=.* ${ex}`, 'g');
  return proc1.replace(global, definer);
}

/**
 * 老 diffProcedure:223-237。返回 null 表示无差异。
 * - 仅来源有：DELIMITER 包裹的 CREATE（经 changeProcedure 做 DEFINER 归一）。
 * - 仅目标有：DROP 例程/视图。
 * - 双方有：VIEW 走 `CREATE OR REPLACE`；过程/函数走 DROP + CREATE（DELIMITER 包裹）。
 */
export function diffProcedure(
  name: string,
  proc1: string | null | undefined,
  proc2: string | null | undefined,
  ex: RoutineKind,
  targetUser?: string,
): string | null {
  const p1 = filterProcedure(asText(proc1));
  const p2 = filterProcedure(asText(proc2));
  if (p1 === p2) return null;

  const raw1 = asText(proc1);
  const raw2 = asText(proc2);

  if (p1 !== '' && p2 === '')
    return `DELIMITER ;;\n${changeProcedure(raw1, raw2, ex, targetUser)} ;;\nDELIMITER ;\n`;
  if (p1 === '' && p2 !== '') return `DROP ${ex} \`${name}\`;\n`;

  if (ex === 'VIEW') {
    let proc = changeProcedure(raw1, raw2, ex, targetUser);
    proc = proc.replace('CREATE', 'CREATE OR REPLACE');
    return `${proc};\n`;
  }
  return `DROP ${ex} \`${name}\`;\nDELIMITER ;;\n${changeProcedure(raw1, raw2, ex, targetUser)} ;;\nDELIMITER ;\n`;
}
