// 数据对比二期单测：parseTablePK 联合主键（3例）+ diffDataRows 行级比对（4例）。
import { describe, expect, it } from 'vitest';
import { addslashes, diffDataRows, escapeDataIdent, getDataPKV, sqlLiteral } from '../../src-core/data-diff';
import { parseTablePK } from '../../src-core/data-pk';

const DDL_SINGLE = [
  'CREATE TABLE `users` (',
  '  `id` int NOT NULL,',
  '  `name` varchar(64) DEFAULT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_COMPOSITE = [
  'CREATE TABLE `items` (',
  '  `a` int NOT NULL,',
  '  `b` varchar(32) NOT NULL,',
  '  `v` int DEFAULT NULL,',
  '  PRIMARY KEY (`a`,`b`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_NO_PK = [
  'CREATE TABLE `logs` (',
  '  `id` int DEFAULT NULL,',
  '  `msg` varchar(64) DEFAULT NULL',
  ') ENGINE=InnoDB',
].join('\n');

describe('parseTablePK 联合主键', () => {
  it('单主键 -> 单列', () => {
    expect(parseTablePK(DDL_SINGLE)).toEqual(['id']);
  });
  it('联合主键 -> 全量有序', () => {
    expect(parseTablePK(DDL_COMPOSITE)).toEqual(['a', 'b']);
  });
  it('无主键 -> null（空串/null 同理）', () => {
    expect(parseTablePK(DDL_NO_PK)).toBeNull();
    expect(parseTablePK('')).toBeNull();
    expect(parseTablePK(null)).toBeNull();
  });
});

describe('diffDataRows 行级比对', () => {
  it('insert：仅 A 有 -> 多 VALUES 分批（insertBatch=2，3 行拆 2 条）', () => {
    const rowsA = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ];
    const r = diffDataRows(rowsA, [], ['id'], 'users', 2);
    expect(r.inserts).toHaveLength(2);
    expect(r.inserts[0]).toContain('INSERT INTO `users` VALUES');
    expect(r.inserts[0]).toContain("(1,'a'),(2,'b')");
    expect(r.inserts[1]).toContain("(3,'c')");
    expect(r.deletes).toEqual([]);
    expect(r.updates).toEqual([]);
  });

  it('delete：仅 B 有 -> 按主键逐行 DELETE', () => {
    const r = diffDataRows([], [{ id: 7, name: 'g' }], ['id'], 'users');
    expect(r.inserts).toEqual([]);
    expect(r.updates).toEqual([]);
    expect(r.deletes).toHaveLength(1);
    expect(r.deletes[0]).toBe('DELETE FROM `users` WHERE `id`=7;\n');
  });

  it('update：同键异值 -> 只列变更列；同行跳过；联合主键拼 key', () => {
    const rowsA = [
      { a: 1, b: 'x', v: 10 },
      { a: 1, b: 'y', v: 20 },
    ];
    const rowsB = [
      { a: 1, b: 'x', v: 11 },
      { a: 1, b: 'y', v: 20 },
    ];
    // 联合主键 (1,'x') vs (1,'y') 必须区分。
    expect(getDataPKV({ a: 1, b: 'x' }, ['a', 'b'])).not.toBe(getDataPKV({ a: 1, b: 'y' }, ['a', 'b']));
    const r = diffDataRows(rowsA, rowsB, ['a', 'b'], 'items');
    expect(r.inserts).toEqual([]);
    expect(r.deletes).toEqual([]);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]).toContain('UPDATE `items` SET `v`=10 WHERE');
    expect(r.updates[0].split(' WHERE ')[0]).not.toContain('`a`=');
    expect(r.updates[0]).toContain("`b`='x'");
  });

  it('转义：引号/反斜杠走 addslashes，NULL 生成关键字', () => {
    expect(addslashes("o'clock\\")).toBe("o\\'clock\\\\");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    const r = diffDataRows(
      [{ id: 1, name: "o'clock", nick: null }],
      [],
      ['id'],
      'users',
    );
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0]).toContain("o\\'clock");
    expect(r.inserts[0]).toContain('NULL');
  });
});

// ---------------------------------------------------------------------------
// escapeDataIdent —— 标识符注入防线（10-05-unit-test-gap-landing R1 / AC2 / AC7）
//
// 实现：`\`${String(name).replace(/`/g, '``')}\``。注释明写「表名/列名进 SQL 前必经此函数」，
// 失效即静默 SQL 注入 —— 同文件其余 4 个导出早有直测，唯独漏它。
//
// 断言写法是硬要求：**不写字符串等值**（不写 `expect(escapeDataIdent('a')).toBe('`a`')`）。
// 理由是断言对象不同：等值锁的是「输出长什么样」，而这里锁的是「输出安全」——
//   1. 包裹结构完好 —— 去掉首尾分隔符后，body 内不出现落单的分隔符（不可提前闭合包裹）；
//   2. 可逆还原 —— 成对转义符还原后恰好等于**原始输入**（转义无损，不吞字符、不多余字符）。
// 两者都与「必须输出这个具体字符串」无关，实现换写法时不必改断言。
//
// 关于分隔符：helper 确实锁了反引号，这是**刻意**的，不是遗漏。反引号是本产品唯一的
// 合法标识符引号——`"` 只有在 ANSI_QUOTES 模式下才引号化标识符，而那是默认关闭的模式；
// 非 ANSI_QUOTES 下 `"a"` 是字符串字面量而非标识符。所以放宽成「反引号或双引号都算过」
// 会放进一个真实错误的实现（用 `"` 包裹且不转义反引号，在默认模式下会把注入载荷当字符串
// 之外的另一种语义解析）。契约要锁的是「在 MySQL 默认模式下不可逃逸」，反引号是这个前提
// 的一部分，不属于实现细节。
// ---------------------------------------------------------------------------

/** 反引号（MySQL 标识符引号）计数。 */
function countBackticks(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === '`') n += 1;
  return n;
}

/**
 * 解包标识符：结构被破坏（可逃逸出包裹）返回 null。
 * 判定：首尾各一个分隔符，body 内分隔符必须成对出现，否则存在可提前闭合包裹的位置。
 */
function unwrapIdent(quoted: string): string | null {
  if (countBackticks(quoted) < 2) return null;
  if (!quoted.startsWith('`') || !quoted.endsWith('`')) return null;
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '`') continue;
    if (body[i + 1] !== '`') return null;
    i += 1;
  }
  return body;
}

/** 反引号成对还原（MySQL 语义：`` 还原为 `）。 */
function unescapeBackticks(body: string): string {
  return body.replace(/``/g, '`');
}

describe('escapeDataIdent 注入防线', () => {
  it('普通标识符：包裹完整且可逆还原', () => {
    const out = escapeDataIdent('users');
    expect(unwrapIdent(out)).not.toBeNull();
    expect(unescapeBackticks(unwrapIdent(out) as string)).toBe('users');
  });

  it('单反引号加倍，标识符仍不可逃逸出包裹（核心防线）', () => {
    const out = escapeDataIdent('a`b');
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe('a`b');
    // 加倍：输入 1 个 -> 输出 body 内 2 个（成对，无落单）
    expect(countBackticks(body as string)).toBe(2);
  });

  it('连续多个反引号：全部加倍且仍成对', () => {
    const out = escapeDataIdent('a``b');
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe('a``b');
    expect(countBackticks(body as string)).toBe(4);
  });

  it('仅由反引号组成的标识符：加倍后可逆（最刁钻的注入载荷）', () => {
    const out = escapeDataIdent('``');
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe('``');
    expect(countBackticks(body as string)).toBe(4);
  });

  it('注入载荷（含闭合包裹尝试）无法逃逸：还原后逐字等于原输入', () => {
    // 若转义失效，`users`; DROP TABLE x; -- ` 就能闭合包裹并追加语句
    const payload = 'x`, `id` int; DROP TABLE `users';
    const out = escapeDataIdent(payload);
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe(payload);
  });

  it('空字符串：仍是合法包裹的空标识符', () => {
    const out = escapeDataIdent('');
    expect(unwrapIdent(out)).not.toBeNull();
    expect(unescapeBackticks(unwrapIdent(out) as string)).toBe('');
  });

  it('含换行的标识符：不破坏包裹结构，转义无损', () => {
    const out = escapeDataIdent('a\nb');
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe('a\nb');
  });

  it('含 NUL 的标识符：不破坏包裹结构，转义无损', () => {
    const out = escapeDataIdent('a\u0000b');
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe('a\u0000b');
  });

  it('含换行 + 反引号组合：结构与可逆性同时成立', () => {
    const out = escapeDataIdent('a`\nb`');
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe('a`\nb`');
  });

  it('非字符串输入走 String() 语义，不抛且仍被包裹', () => {
    for (const v of [42, null, undefined, true, { a: 1 }, ['x'], Symbol('s')]) {
      const out = escapeDataIdent(v as unknown as string);
      expect(unwrapIdent(out)).not.toBeNull();
      expect(unescapeBackticks(unwrapIdent(out) as string)).toBe(String(v));
    }
  });

  it('非字符串且自身含反引号形态的对象：toString 里的反引号同样被加倍', () => {
    const out = escapeDataIdent({ toString: () => 'a`b' } as unknown as string);
    const body = unwrapIdent(out);
    expect(body).not.toBeNull();
    expect(unescapeBackticks(body as string)).toBe('a`b');
  });

  it('输出总反引号数 = 输入反引号数 × 2 + 2（成对转义的量化契约）', () => {
    for (const raw of ['users', 'a`b', 'a``b', '``', '', 'a`\nb`']) {
      const out = escapeDataIdent(raw);
      expect(countBackticks(out)).toBe(countBackticks(raw) * 2 + 2);
    }
  });
});
