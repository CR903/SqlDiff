// 授权解析单测（纯函数，无需连接）：
// 行文本全部取自隔离 MySQL 5.7.18 fixture 的真实 SHOW GRANTS FOR CURRENT_USER() 输出
// （账号名已脱敏为别名；凭据不落盘、不入本文件）。
//
// 覆盖 AC1：库级→full / 表级→partial / 混合→逐库 / 角色·无法解析→未证明。

import { describe, expect, it } from 'vitest';
import { parseGrantLines, visibilityFor } from './visibility';

// 真实输出逐行摘录（'cov_x'@'127.0.0.1' 固定为 fixture 主机）。
const USAGE = "GRANT USAGE ON *.* TO 'cov_x'@'127.0.0.1'";
// cov_limited：6 行 = 1 库级 0 / 5 表级 → 可证明存在不可见对象
const LIMITED = [
  USAGE,
  'GRANT SELECT ON `cov_tgt`.`open_tbl` TO \'cov_x\'@\'127.0.0.1\'',
  'GRANT SELECT ON `cov_src`.`open_tbl` TO \'cov_x\'@\'127.0.0.1\'',
  'GRANT SELECT ON `cov_tgt`.`secret_tbl` TO \'cov_x\'@\'127.0.0.1\'',
  'GRANT SELECT ON `cov_tgt`.`open_view` TO \'cov_x\'@\'127.0.0.1\'',
  'GRANT SELECT ON `cov_src`.`open_view` TO \'cov_x\'@\'127.0.0.1\'',
];
// cov_view：库级授权 → 可证明全量可见
const VIEW = [USAGE, "GRANT SELECT ON `cov_src`.* TO 'cov_x'@'127.0.0.1'"];
// cov_mixed：库级(cov_src) + 表级(cov_tgt) → 逐库判定
const MIXED = [
  USAGE,
  "GRANT SELECT ON `cov_src`.* TO 'cov_x'@'127.0.0.1'",
  'GRANT SELECT ON `cov_tgt`.`open_tbl` TO \'cov_x\'@\'127.0.0.1\'',
];

describe('parseGrantLines：AC1 判别式', () => {
  it('库级授权 → 该库 full（实测 cov_view）', () => {
    const r = parseGrantLines(VIEW);
    expect(r.reliable).toBe(true);
    expect(visibilityFor(r, 'cov_src')).toBe('full');
  });

  it('表级授权 → 该库 partial（实测 cov_limited：5 条表级、0 条库级）', () => {
    const r = parseGrantLines(LIMITED);
    expect(r.reliable).toBe(true);
    expect(visibilityFor(r, 'cov_src')).toBe('partial');
    expect(visibilityFor(r, 'cov_tgt')).toBe('partial');
  });

  it('混合授权 → 逐库判定（实测 cov_mixed：cov_src 库级 / cov_tgt 表级）', () => {
    const r = parseGrantLines(MIXED);
    expect(r.reliable).toBe(true);
    expect(visibilityFor(r, 'cov_src')).toBe('full');
    expect(visibilityFor(r, 'cov_tgt')).toBe('partial');
  });

  it('USAGE ON *.* 只是空账号基线，不构成任何授权', () => {
    const r = parseGrantLines([USAGE]);
    expect(r.reliable).toBe(true);
    expect(r.byDatabase).toEqual({});
    expect(visibilityFor(r, 'anything')).toBe('partial');
  });

  it('全局非 USAGE 且含读权限 → 所有库 full', () => {
    const r = parseGrantLines([USAGE, "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1'"]);
    expect(r.reliable).toBe(true);
    expect(visibilityFor(r, 'cov_src')).toBe('full');
    expect(visibilityFor(r, 'never_mentioned_db')).toBe('full');
  });

  it('同库既有库级又有表级授权 → 取 full（库级是表级的严格超集）', () => {
    const r = parseGrantLines([
      'GRANT SELECT ON `shop`.* TO \'u\'@\'%\'',
      'GRANT SELECT ON `shop`.`t1` TO \'u\'@\'%\'',
    ]);
    expect(visibilityFor(r, 'shop')).toBe('full');
  });

  it('库级但无读权限（仅 INSERT）不算 full，保持保守 partial', () => {
    const r = parseGrantLines(["GRANT INSERT ON `shop`.* TO 'u'@'%'"]);
    expect(r.reliable).toBe(true);
    expect(visibilityFor(r, 'shop')).toBe('partial');
  });

  it('授权里没出现的库 → partial（默认保守：只授了部分对象）', () => {
    const r = parseGrantLines(["GRANT SELECT ON `shop`.* TO 'u'@'%'"]);
    expect(visibilityFor(r, 'warehouse')).toBe('partial');
  });

  it('库名大小写不一致时不做回落 → partial（lower_case_table_names=0 下 Foo 与 foo 是两个库）', () => {
    // Linux 默认 lower_case_table_names=0，库名大小写敏感：``GRANT ON `Foo`.*`` 不能证明
    // 对 `foo` 有权限。若按大小写不敏感回落判成 full，该连接读不到 foo 任何对象时
    // 整个 A 侧 schema 都会变成静默的假 DROP TABLE —— 误判为 full 的代价不可接受。
    const r = parseGrantLines(["GRANT SELECT ON `cov_src`.* TO 'u'@'%'"]);
    expect(visibilityFor(r, 'COV_SRC')).toBe('partial');
    // 精确命中大小写时仍是 full（实测 fixture 走的正是这条路径）。
    expect(visibilityFor(r, 'cov_src')).toBe('full');
  });

  it('库名恰好叫 `*`（反引号标识符允许）时不占用全局哨兵，避免其他库被误判 full', () => {
    const r = parseGrantLines(["GRANT SELECT ON `*`.* TO 'u'@'%'"]);
    expect(r.reliable).toBe(true);
    expect(r.byDatabase).toEqual({}); // 保守跳过，不写入哨兵位
    expect(visibilityFor(r, 'shop')).toBe('partial');
  });

  it('真正的全局授权仍记在哨兵位并对所有库判 full', () => {
    const r = parseGrantLines([USAGE, "GRANT SELECT ON *.* TO 'u'@'%'"]);
    expect(visibilityFor(r, 'shop')).toBe('full');
    expect(visibilityFor(r, 'warehouse')).toBe('full');
  });
});

describe('parseGrantLines：保守降级（AC1 后半）', () => {
  it('8.0 角色授权（无 ON）→ reliable:false，全部按 partial', () => {
    const r = parseGrantLines([USAGE, "GRANT `role_a`@`%` TO 'u'@'%'"]);
    expect(r.reliable).toBe(false);
    expect(r.byDatabase).toEqual({});
    expect(visibilityFor(r, 'cov_src')).toBe('partial');
  });

  it('角色授权与库级授权共存也降级（角色的表级授权不展开，不能猜）', () => {
    const r = parseGrantLines([...VIEW, "GRANT `role_a`@`%` TO 'u'@'%'"]);
    expect(r.reliable).toBe(false);
    expect(visibilityFor(r, 'cov_src')).toBe('partial');
  });

  it('空输出 / 空行 / 非字符串 → reliable:false', () => {
    expect(parseGrantLines([]).reliable).toBe(false);
    expect(parseGrantLines([USAGE, '']).reliable).toBe(false);
    expect(parseGrantLines([USAGE, '   ']).reliable).toBe(false);
    expect(parseGrantLines([42 as unknown as string]).reliable).toBe(false);
  });

  it('未识别的授权形态（PROXY / 托管实例改写文本）→ reliable:false', () => {
    expect(parseGrantLines(["GRANT PROXY ON ''@'' TO 'u'@'h'"]).reliable).toBe(false);
    expect(parseGrantLines(['GRANT SELECT ON mydb.mytbl TO u@h']).reliable).toBe(false);
    expect(parseGrantLines(['SOME VENDOR-SPECIFIC OUTPUT']).reliable).toBe(false);
  });

  it('非法的 `*`.`tbl` 形态 → reliable:false（不猜测）', () => {
    expect(parseGrantLines(['GRANT SELECT ON *.`t1` TO \'u\'@\'%\'']).reliable).toBe(false);
  });

  it('不可靠判定下 byDatabase 无论写了什么都强制 partial（漏判为 full 的代价最高）', () => {
    const r = { byDatabase: { shop: 'full' as const }, reliable: false };
    expect(visibilityFor(r, 'shop')).toBe('partial');
  });
});

describe('标识符解析边界', () => {
  it('反引号标识符内含 " ON " 时仍能取到正确的库名（正则回溯到真 ON 关键字）', () => {
    const r = parseGrantLines(["GRANT SELECT ON `odd ON db`.* TO 'u'@'%'"]);
    expect(r.reliable).toBe(true);
    expect(visibilityFor(r, 'odd ON db')).toBe('full');
  });

  it('反引号加倍转义的库名解回原样', () => {
    const r = parseGrantLines(['GRANT SELECT ON `we``ird`.* TO \'u\'@\'%\'']);
    expect(visibilityFor(r, 'we`ird')).toBe('full');
  });

  it('WITH GRANT OPTION 后缀不影响识别', () => {
    const r = parseGrantLines(["GRANT SELECT ON `shop`.* TO 'u'@'%' WITH GRANT OPTION"]);
    expect(visibilityFor(r, 'shop')).toBe('full');
  });

  it('多权限逗号列表：含 SELECT 才算库级可读', () => {
    const r = parseGrantLines(["GRANT SELECT, INSERT, UPDATE ON `shop`.* TO 'u'@'%'"]);
    expect(visibilityFor(r, 'shop')).toBe('full');
  });
});
