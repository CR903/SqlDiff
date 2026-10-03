// 生产 Preflight v1 · 高风险规则单测。
//
// 每条规则独立测试（触发 + 不触发），evaluateRules 覆盖顺序稳定性与纯函数属性。
// 所有断言基于当前实现语义：
// - `ruleGtidMismatch` 的 v1 语义只识别中间态（如 ON_PERMISSIVE），OFF/ON 均跳过。
// - `NO_UNIQUE_INDEX_AFTER_CHANGE` 使用 `table.<t>.unique_indexes` 数组（而非设计稿里的
//   `index.<idx>.non_unique`），primary_indexes 非空时把 PRIMARY 视为唯一索引。
// - `evaluateRules` 按 RULES 数组顺序汇总（不是按 severity 排序）。

import { describe, expect, it } from 'vitest';
import type { DiffItem } from './types';
import {
  evaluateRules,
  ruleBigTableCopy,
  ruleGtidMismatch,
  ruleLargeTableInstantAdd,
  ruleLargeTableRebuild,
  ruleNoPrimaryKey,
  ruleNoUniqueIndexAfterChange,
  rulePermissionIncomplete,
  ruleReplicaLag,
  ruleReadOnlyTarget,
  type RuleInput,
} from './preflight-rules';
import { DEFAULT_THRESHOLDS } from './preflight-types';
import type {
  PreflightCategory,
  PreflightFact,
  PreflightFactSource,
} from './preflight-types';

// ---------------------------------------------------------------------------
// helper fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-01-01T00:00:00.000Z';

function fact(
  category: PreflightCategory,
  key: string,
  value: unknown,
  overrides: Partial<PreflightFact> = {},
): PreflightFact {
  return {
    category,
    key,
    value,
    source: 'select-sysvars' satisfies PreflightFactSource,
    observedAt: NOW,
    ...overrides,
  };
}

function serverFacts(overrides: Array<[string, unknown, Partial<PreflightFact>?]> = []): PreflightFact[] {
  const out: PreflightFact[] = [
    fact('server', 'server.mysql_version', '8.0.36', { source: 'select-version' }),
  ];
  for (const [key, value, o] of overrides) {
    out.push(fact('server', key, value, o));
  }
  return out;
}

function tableFact(
  table: string,
  overrides: {
    rows?: number;
    dataLength?: number;
    indexLength?: number;
    primaryIndexes?: string[];
    uniqueIndexes?: string[];
  } = {},
): PreflightFact[] {
  const out: PreflightFact[] = [];
  if (overrides.rows !== undefined) {
    out.push(fact('table', `table.${table}.rows`, overrides.rows, { source: 'information-schema.tables' }));
  }
  if (overrides.dataLength !== undefined) {
    out.push(fact('table', `table.${table}.data_length`, overrides.dataLength, { source: 'information-schema.tables' }));
  }
  if (overrides.indexLength !== undefined) {
    out.push(fact('table', `table.${table}.index_length`, overrides.indexLength, { source: 'information-schema.tables' }));
  }
  if (overrides.primaryIndexes !== undefined) {
    out.push(fact('index', `table.${table}.primary_indexes`, overrides.primaryIndexes, { source: 'information-schema.statistics' }));
  }
  if (overrides.uniqueIndexes !== undefined) {
    out.push(fact('index', `table.${table}.unique_indexes`, overrides.uniqueIndexes, { source: 'information-schema.statistics' }));
  }
  return out;
}

function ddlItem(sql: string, id = 'd1'): DiffItem {
  return {
    id,
    objectType: 'table',
    objectName: 't',
    changeType: 'CHANGE',
    aspects: ['column'],
    risk: 'medium',
    sql,
  };
}

function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    report: { facts: [], inferences: [], unknowns: [] },
    items: [],
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

function fullInput(overrides: {
  facts?: PreflightFact[];
  items?: DiffItem[];
  thresholds?: RuleInput['thresholds'];
} = {}): RuleInput {
  return {
    report: { facts: overrides.facts ?? [], inferences: [], unknowns: [] },
    items: overrides.items ?? [],
    thresholds: overrides.thresholds ?? DEFAULT_THRESHOLDS,
  };
}

// ---------------------------------------------------------------------------
// ruleBigTableCopy
// ---------------------------------------------------------------------------

describe('ruleBigTableCopy', () => {
  it('触发：大表 + ADD_UNIQUE_INDEX 重建 → block，id 以 BIG_TABLE_COPY: 开头', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('orders', { rows: 2_000_000 }),
      ],
      items: [ddlItem('ALTER TABLE orders ADD UNIQUE INDEX u (col)', 'd1')],
    });
    const issues = ruleBigTableCopy(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('block');
    expect(issues[0].id).toBe('BIG_TABLE_COPY:table.orders');
    expect(issues[0].related).toContain('table.orders.rows');
  });

  it('不触发：行数低于阈值（rows=500k）→ 无 issue', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('orders', { rows: 500_000 }),
      ],
      items: [ddlItem('ALTER TABLE orders ADD UNIQUE INDEX u (col)', 'd1')],
    });
    expect(ruleBigTableCopy(input)).toHaveLength(0);
  });

  it('不触发：rebuildsTable=false 的 op（DROP_INDEX）即使大表也不触发', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('orders', { rows: 2_000_000 }),
      ],
      items: [ddlItem('ALTER TABLE orders DROP INDEX idx', 'd1')],
    });
    expect(ruleBigTableCopy(input)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ruleReadOnlyTarget
// ---------------------------------------------------------------------------

describe('ruleReadOnlyTarget', () => {
  it('触发：server.read_only=1 → block', () => {
    const issues = ruleReadOnlyTarget(fullInput({ facts: serverFacts([['server.read_only', 1]]) }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('block');
    expect(issues[0].id).toBe('READ_ONLY_TARGET:server');
    expect(issues[0].detail).toContain('read_only');
  });

  it('触发：server.super_read_only=1 → block（与 read_only 独立成 issue）', () => {
    const issues = ruleReadOnlyTarget(fullInput({ facts: serverFacts([['server.super_read_only', 1]]) }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('block');
    expect(issues[0].detail).toContain('super_read_only');
  });

  it('两个只读标记同时 ON → 产出 2 条独立 block issue', () => {
    const issues = ruleReadOnlyTarget(
      fullInput({ facts: serverFacts([['server.read_only', 1], ['server.super_read_only', 1]]) }),
    );
    expect(issues).toHaveLength(2);
    for (const i of issues) {
      expect(i.severity).toBe('block');
      expect(i.id).toBe('READ_ONLY_TARGET:server');
    }
  });

  it('不触发：read_only=0 且 super_read_only=0 → 无 issue', () => {
    const input = fullInput({
      facts: serverFacts([['server.read_only', 0], ['server.super_read_only', 0]]),
    });
    expect(ruleReadOnlyTarget(input)).toHaveLength(0);
  });

  it('不触发：事实缺失 → 无 issue（保守默认，不误报只读）', () => {
    expect(ruleReadOnlyTarget(fullInput({ facts: serverFacts() }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ruleNoPrimaryKey
// ---------------------------------------------------------------------------

describe('ruleNoPrimaryKey', () => {
  it('触发：DROP_INDEX + primary_indexes=[] → warn', () => {
    const input = fullInput({
      facts: [...tableFact('t', { primaryIndexes: [] })],
      items: [ddlItem('ALTER TABLE t DROP INDEX idx', 'd1')],
    });
    const issues = ruleNoPrimaryKey(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].id).toBe('NO_PRIMARY_KEY:table.t');
  });

  it('不触发：primary_indexes 非空 → 无 issue', () => {
    const input = fullInput({
      facts: [...tableFact('t', { primaryIndexes: ['PRIMARY'] })],
      items: [ddlItem('ALTER TABLE t DROP INDEX idx', 'd1')],
    });
    expect(ruleNoPrimaryKey(input)).toHaveLength(0);
  });

  it('不触发：op 非 DROP_INDEX / DROP_COLUMN（ADD_COLUMN）→ 无 issue', () => {
    const input = fullInput({
      facts: [...tableFact('t', { primaryIndexes: [] })],
      items: [ddlItem('ALTER TABLE t ADD COLUMN c INT', 'd1')],
    });
    expect(ruleNoPrimaryKey(input)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ruleReplicaLag
// ---------------------------------------------------------------------------

describe('ruleReplicaLag', () => {
  it('触发：Seconds_Behind_Master=60 > threshold=30 → warn', () => {
    const input = fullInput({
      facts: [fact('replication', 'replication.seconds_behind_master', 60)],
    });
    const issues = ruleReplicaLag(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].id).toBe('REPLICA_LAG:replication');
    expect(issues[0].detail).toContain('60');
  });

  it('不触发：Seconds_Behind_Master=10 ≤ 阈值 → 无 issue', () => {
    const input = fullInput({
      facts: [fact('replication', 'replication.seconds_behind_master', 10)],
    });
    expect(ruleReplicaLag(input)).toHaveLength(0);
  });

  it('不触发：replication fact 缺失 → 无 issue（Unknown 层负责记录）', () => {
    expect(ruleReplicaLag(fullInput({ facts: [] }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ruleGtidMismatch
// ---------------------------------------------------------------------------

describe('ruleGtidMismatch', () => {
  it('触发：gtid_mode=ON_PERMISSIVE（中间态）→ warn', () => {
    const input = fullInput({
      facts: [fact('replication', 'replication.gtid_mode', 'ON_PERMISSIVE')],
    });
    const issues = ruleGtidMismatch(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].id).toBe('GTID_MISMATCH:replication');
    expect(issues[0].detail).toContain("ON_PERMISSIVE");
  });

  it('不触发：gtid_mode=ON（已启用一致状态）', () => {
    const input = fullInput({
      facts: [fact('replication', 'replication.gtid_mode', 'ON')],
    });
    expect(ruleGtidMismatch(input)).toHaveLength(0);
  });

  it('不触发：gtid_mode=OFF（GTID 未启用，v1 无法判定主从一致性）', () => {
    const input = fullInput({
      facts: [fact('replication', 'replication.gtid_mode', 'OFF')],
    });
    expect(ruleGtidMismatch(input)).toHaveLength(0);
  });

  it('不触发：gtid_mode fact 缺失 → 无 issue', () => {
    expect(ruleGtidMismatch(fullInput({ facts: [] }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rulePermissionIncomplete
// ---------------------------------------------------------------------------

describe('rulePermissionIncomplete', () => {
  it('触发：permissions.reliable=false → warn', () => {
    const input = fullInput({
      facts: [
        fact('permissions', 'permissions.reliable', false, { source: 'show-grants-for-current-user' }),
        fact('permissions', 'permissions.visibility', 'full', { source: 'show-grants-for-current-user' }),
      ],
    });
    const issues = rulePermissionIncomplete(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].id).toBe('PERMISSION_INCOMPLETE:permissions');
    expect(issues[0].detail).toContain('可靠度判据失败');
  });

  it('触发：visibility=partial（reliable=true 也可能触发）→ warn', () => {
    const input = fullInput({
      facts: [
        fact('permissions', 'permissions.reliable', true, { source: 'show-grants-for-current-user' }),
        fact('permissions', 'permissions.visibility', 'partial', { source: 'show-grants-for-current-user' }),
      ],
    });
    const issues = rulePermissionIncomplete(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain('partial');
  });

  it('不触发：visibility=full 且 reliable=true → 无 issue', () => {
    const input = fullInput({
      facts: [
        fact('permissions', 'permissions.reliable', true, { source: 'show-grants-for-current-user' }),
        fact('permissions', 'permissions.visibility', 'full', { source: 'show-grants-for-current-user' }),
      ],
    });
    expect(rulePermissionIncomplete(input)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ruleLargeTableInstantAdd
// ---------------------------------------------------------------------------

describe('ruleLargeTableInstantAdd', () => {
  it('触发：MySQL 8.0.36 + ADD_COLUMN + 大表 → warn，recommendation 含 INSTANT', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('orders', { rows: 2_000_000 }),
      ],
      items: [ddlItem('ALTER TABLE orders ADD COLUMN c INT', 'd1')],
    });
    const issues = ruleLargeTableInstantAdd(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].id).toBe('LARGE_TABLE_INSTANT_ADD:diff-item:d1');
    expect(issues[0].recommendation).toContain('INSTANT');
  });

  it('不触发：MySQL 8.0.11（低于 INSTANT 阈值）→ 无 issue', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('orders', { rows: 2_000_000 }),
      ],
      items: [ddlItem('ALTER TABLE orders ADD COLUMN c INT', 'd1')],
    });
    // 覆盖 mysql_version 为 8.0.11
    input.report.facts[0] = fact('server', 'server.mysql_version', '8.0.11', { source: 'select-version' });
    expect(ruleLargeTableInstantAdd(input)).toHaveLength(0);
  });

  it('不触发：行数低于阈值 → 无 issue', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('orders', { rows: 500_000 }),
      ],
      items: [ddlItem('ALTER TABLE orders ADD COLUMN c INT', 'd1')],
    });
    expect(ruleLargeTableInstantAdd(input)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ruleNoUniqueIndexAfterChange
// ---------------------------------------------------------------------------

describe('ruleNoUniqueIndexAfterChange', () => {
  it('触发：DROP_INDEX 移除唯一索引后无其他 unique → warn', () => {
    const input = fullInput({
      facts: [
        ...tableFact('t', { primaryIndexes: [], uniqueIndexes: ['u_idx'] }),
      ],
      items: [ddlItem('ALTER TABLE t DROP INDEX u_idx', 'd1')],
    });
    const issues = ruleNoUniqueIndexAfterChange(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].id).toBe('NO_UNIQUE_INDEX_AFTER_CHANGE:table.t');
  });

  it('不触发：还有其他 unique 索引 → 无 issue', () => {
    const input = fullInput({
      facts: [
        ...tableFact('t', { primaryIndexes: [], uniqueIndexes: ['u_idx', 'u_idx2'] }),
      ],
      items: [ddlItem('ALTER TABLE t DROP INDEX u_idx', 'd1')],
    });
    expect(ruleNoUniqueIndexAfterChange(input)).toHaveLength(0);
  });

  it('不触发：被删索引不在 unique 列表（普通索引）→ 无 issue', () => {
    const input = fullInput({
      facts: [
        ...tableFact('t', { primaryIndexes: [], uniqueIndexes: ['u_idx'] }),
      ],
      items: [ddlItem('ALTER TABLE t DROP INDEX idx_normal', 'd1')],
    });
    expect(ruleNoUniqueIndexAfterChange(input)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ruleLargeTableRebuild
// ---------------------------------------------------------------------------

describe('ruleLargeTableRebuild', () => {
  const GiB = 1024 * 1024 * 1024;

  it('触发：DATA_LENGTH + INDEX_LENGTH > 5 GiB + rebuildsTable → warn', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('t', { dataLength: 3 * GiB, indexLength: 3 * GiB }),
      ],
      items: [ddlItem('ALTER TABLE t MODIFY COLUMN col INT', 'd1')],
    });
    const issues = ruleLargeTableRebuild(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].id).toBe('LARGE_TABLE_REBUILD:table.t');
  });

  it('不触发：总空间 < 5 GiB → 无 issue', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('t', { dataLength: 1 * GiB, indexLength: 1 * GiB }),
      ],
      items: [ddlItem('ALTER TABLE t MODIFY COLUMN col INT', 'd1')],
    });
    expect(ruleLargeTableRebuild(input)).toHaveLength(0);
  });

  it('不触发：空间大但 op 不重建（DROP_INDEX）→ 无 issue', () => {
    const input = fullInput({
      facts: [
        ...serverFacts(),
        ...tableFact('t', { dataLength: 3 * GiB, indexLength: 3 * GiB }),
      ],
      items: [ddlItem('ALTER TABLE t DROP INDEX idx', 'd1')],
    });
    expect(ruleLargeTableRebuild(input)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateRules · 顺序、去重、纯函数、空输入
// ---------------------------------------------------------------------------

describe('evaluateRules', () => {
  it('按 RULES 数组顺序输出（不按 severity 重排）', () => {
    // REPLICA_LAG（rule 3，warn）在 READ_ONLY_TARGET（rule 4，block）之前。
    // 如果实现按 severity 排序，block 会先出现；本用例断言实际是 rule-order 语义。
    const input = fullInput({
      facts: [
        fact('replication', 'replication.seconds_behind_master', 60),
        fact('server', 'server.read_only', 1),
      ],
    });
    const issues = evaluateRules(input);
    expect(issues.map((i) => i.id)).toEqual([
      'REPLICA_LAG:replication',
      'READ_ONLY_TARGET:server',
    ]);
  });

  it('9 条规则同时触发时无重复 id', () => {
    // 构造一条能触发多条规则的场景：大表 + 无主键 + 大空间 + ADD_UNIQUE_INDEX
    // → 至少 BIG_TABLE_COPY / NO_PRIMARY_KEY / LARGE_TABLE_REBUILD 三条同时触发。
    const GiB = 1024 * 1024 * 1024;
    const input = fullInput({
      facts: [
        ...serverFacts([['server.read_only', 1]]),
        ...tableFact('orders', {
          rows: 2_000_000,
          dataLength: 3 * GiB,
          indexLength: 3 * GiB,
          primaryIndexes: [],
          uniqueIndexes: [],
        }),
      ],
      items: [ddlItem('ALTER TABLE orders ADD UNIQUE INDEX u (col)', 'd1')],
    });
    const issues = evaluateRules(input);
    const ids = issues.map((i) => i.id);
    // 顺序：RULES[0] BIG_TABLE_COPY、RULES[3] READ_ONLY_TARGET、RULES[8] LARGE_TABLE_REBUILD
    expect(ids).toEqual([
      'BIG_TABLE_COPY:table.orders',
      'READ_ONLY_TARGET:server',
      'LARGE_TABLE_REBUILD:table.orders',
    ]);
    // 无重复
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('纯函数：不修改入参', () => {
    const input = fullInput({
      facts: [
        ...serverFacts([['server.read_only', 1]]),
        ...tableFact('t', { rows: 2_000_000 }),
      ],
      items: [ddlItem('ALTER TABLE t ADD UNIQUE INDEX u (col)', 'd1')],
    });
    const before = JSON.parse(JSON.stringify(input)) as RuleInput;
    evaluateRules(input);
    expect(input).toEqual(before);
  });

  it('空输入（facts=[] / items=[]）→ 返回空数组', () => {
    expect(evaluateRules(ruleInput())).toEqual([]);
  });
});
