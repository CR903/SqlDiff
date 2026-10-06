// store-json 契约单测（10-05-unit-test-gap-landing R2/R3/R4）：
// 本文件此前零直测 —— loadNodes / loadHistory 只在别处间接经过，守卫本身的判别面从未被表达。
//
// 三块契约：
// 1. isNodeMeta / isHistoryEntry —— 接受/拒绝的**判别矩阵**（不是快照，不是 happy path）。
//    守卫的职责是挡坏数据，只证明"一个形状能过"等于没测它的本职。
//    isHistoryEntry 另被 src-main/main.ts 直接 import 用于 IPC 入口校验，
//    所以它的矩阵同时是 IPC 边界的安全测试（用例名体现这点）。
// 2. 路径函数 —— 拼接规则 + 环境变量优先级。resolveUserDataDir 优先级写反会让
//    E2E 把节点写到错误目录，而现有任何断言都不会发现。
// 3. clearHistory —— 破坏性操作的幂等性与影响面。
//
// 无 Electron 依赖：store-json 只用 node:fs / node:path，fs 全部落在临时目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry, NodeMeta } from '../../src-core/types';
import {
  clearHistory,
  historyFilePath,
  isHistoryEntry,
  isNodeMeta,
  loadHistory,
  nodesFilePath,
  resolveUserDataDir,
} from '../../src-main/store-json';

// -- 基准对象（全字段合法） ----------------------------------------------------

/** isNodeMeta 的合法基准；每个字段都会被单独变异。 */
const VALID_NODE = {
  id: 'n1',
  alias: '本地库',
  host: 'db.internal',
  user: 'root',
  database: 'shop',
  port: 3306,
  createdAt: '2026-10-05T00:00:00.000Z',
  ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
} as const;

/** isHistoryEntry 的合法基准（5 个判别字段）。 */
const VALID_HISTORY = {
  id: 'h1',
  at: '2026-10-05T00:00:00.000Z',
  aAlias: 'A库',
  bAlias: 'B库',
  diffCount: 0,
} as const;

/** isNodeMeta 实际判别的字段（逐个变异用）。 */
const NODE_FIELDS = ['id', 'alias', 'host', 'user', 'database', 'port', 'createdAt', 'ssh'] as const;
/** isHistoryEntry 实际判别的字段（逐个变异用）。 */
const HISTORY_FIELDS = ['id', 'at', 'aAlias', 'bAlias', 'diffCount'] as const;
/** 其中要求 string 的字段：类型错变异用数字。 */
const NODE_STRING_FIELDS = ['id', 'alias', 'host', 'user', 'database', 'createdAt'] as const;
/** 其中要求 number 的字段：类型错变异必须用非数字（数字对本守卫是合法值）。 */
const HISTORY_STRING_FIELDS = ['id', 'at', 'aAlias', 'bAlias'] as const;

describe('isNodeMeta 判别矩阵', () => {
  it('全字段合法的基准对象被接受', () => {
    expect(isNodeMeta({ ...VALID_NODE })).toBe(true);
    expect(isNodeMeta(VALID_NODE)).toBe(true);
  });

  // 每个字段三态：删除 / 类型错 / 值为空。删一个字段就足以让守卫拒绝。
  it.each(NODE_FIELDS)('缺 %s 字段 → 拒绝', (field) => {
    const broken: Record<string, unknown> = { ...VALID_NODE };
    delete broken[field];
    expect(isNodeMeta(broken)).toBe(false);
  });

  it.each(NODE_STRING_FIELDS)('%s 类型错（数字）→ 拒绝', (field) => {
    expect(isNodeMeta({ ...VALID_NODE, [field]: 42 })).toBe(false);
  });

  it('port 类型错（字符串）→ 拒绝', () => {
    expect(isNodeMeta({ ...VALID_NODE, port: '3306' })).toBe(false);
  });

  it.each(NODE_FIELDS)('%s 值为 null → 拒绝', (field) => {
    expect(isNodeMeta({ ...VALID_NODE, [field]: null })).toBe(false);
  });

  // id 是唯一带 length > 0 约束的字段，最容易漏测
  it('id 为空串 → 拒绝（length > 0 边界）', () => {
    expect(isNodeMeta({ ...VALID_NODE, id: '' })).toBe(false);
  });

  it('id 为单字符 → 接受（length > 0 的另一侧）', () => {
    expect(isNodeMeta({ ...VALID_NODE, id: 'x' })).toBe(true);
  });

  it('port 为数字字符串 → 拒绝（不做宽松转换）', () => {
    expect(isNodeMeta({ ...VALID_NODE, port: '3306' })).toBe(false);
  });

  // 口径说明（10-06-guard-tighten-comment-fix D1）：读侧与写侧对齐 1–65535 整数——
  // main.ts:buildNodeMeta → normalizePort 在写入面已保证合法，读侧收紧只影响手改坏的
  // nodes.json（以前能加载、连库时才报结构化错误，现在读侧直接过滤）。下游不再依赖
  // mysql2 的报错做兜底。
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 65536, 70000, 1.5])(
    'port 为 %s → 拒绝（须为 1–65535 整数）',
    (port) => {
      expect(isNodeMeta({ ...VALID_NODE, port })).toBe(false);
    },
  );

  it.each([1, 22, 3306, 65535])('port 为 %s → 接受（边界内整数）', (port) => {
    expect(isNodeMeta({ ...VALID_NODE, port })).toBe(true);
  });

  it('ssh 为空对象 {} → 接受（isRecord 只看形状，不看字段）', () => {
    expect(isNodeMeta({ ...VALID_NODE, ssh: {} })).toBe(true);
  });

  it('ssh 为数组 → 拒绝（isRecord 显式排除数组）', () => {
    expect(isNodeMeta({ ...VALID_NODE, ssh: [] })).toBe(false);
    expect(isNodeMeta({ ...VALID_NODE, ssh: ['enabled'] })).toBe(false);
  });

  it('ssh 为字符串 / 数字 → 拒绝（非 record）', () => {
    expect(isNodeMeta({ ...VALID_NODE, ssh: 'enabled' })).toBe(false);
    expect(isNodeMeta({ ...VALID_NODE, ssh: 1 })).toBe(false);
  });

  it.each<unknown>([
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['对象数组', [{ ...VALID_NODE }]],
    ['字符串', 'n1'],
    ['数字', 42],
    ['布尔', true],
  ])('非对象输入 %s → 拒绝', (_label, value) => {
    expect(isNodeMeta(value)).toBe(false);
  });

  it('嵌套错误：ssh 合法但顶层字段被伪造为数组 → 拒绝', () => {
    expect(isNodeMeta({ ...VALID_NODE, ssh: [], alias: ['a'] })).toBe(false);
  });

  it('不影响守卫的额外字段被忽略（守卫不是白名单）', () => {
    const node: NodeMeta = {
      ...VALID_NODE,
      alias: String(VALID_NODE.alias),
      ssh: { ...VALID_NODE.ssh },
      star: true,
      pinned: false,
      useCount: 3,
      group: '默认',
      tags: ['prod'],
    };
    expect(isNodeMeta(node)).toBe(true);
  });
});

describe('isHistoryEntry 判别矩阵（IPC 入口校验面）', () => {
  it('全字段合法的基准对象被接受', () => {
    expect(isHistoryEntry({ ...VALID_HISTORY })).toBe(true);
  });

  it('diffCount 为 0（falsy 但合法）→ 接受', () => {
    expect(isHistoryEntry({ ...VALID_HISTORY, diffCount: 0 })).toBe(true);
  });

  it.each(HISTORY_FIELDS)('缺 %s 字段 → 拒绝', (field) => {
    const broken: Record<string, unknown> = { ...VALID_HISTORY };
    delete broken[field];
    expect(isHistoryEntry(broken)).toBe(false);
  });

  it.each(HISTORY_STRING_FIELDS)('%s 类型错（数字）→ 拒绝', (field) => {
    expect(isHistoryEntry({ ...VALID_HISTORY, [field]: 7 })).toBe(false);
  });

  it('diffCount 类型错（字符串）→ 拒绝', () => {
    expect(isHistoryEntry({ ...VALID_HISTORY, diffCount: '3' })).toBe(false);
  });

  it.each(HISTORY_FIELDS)('%s 值为 null → 拒绝', (field) => {
    expect(isHistoryEntry({ ...VALID_HISTORY, [field]: null })).toBe(false);
  });

  // diffCount 须为有限数（10-06-guard-tighten-comment-fix D2）：NaN / Infinity 无统计意义，
  // 上游只保证 typeof number，读侧用 isFinite 挡掉非有限值。
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'diffCount 为 %s → 拒绝（须为有限数）',
    (diffCount) => {
      expect(isHistoryEntry({ ...VALID_HISTORY, diffCount })).toBe(false);
    },
  );

  // id 空串此前被接受，但 appendHistory 按 id 去重置顶——空串会把所有空 id 条目折叠成一条。
  // 与 isNodeMeta.id 的 length > 0 对齐（10-06-guard-tighten-comment-fix R2）。
  it('id 为空串 → 拒绝（length > 0 边界；空串会破坏 appendHistory 去重）', () => {
    expect(isHistoryEntry({ ...VALID_HISTORY, id: '' })).toBe(false);
  });

  it.each<unknown>([
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['对象数组', [{ ...VALID_HISTORY }]],
    ['字符串', 'h1'],
    ['数字', 42],
    ['布尔', false],
  ])('非对象输入 %s → 拒绝', (_label, value) => {
    expect(isHistoryEntry(value)).toBe(false);
  });

  it('不影响守卫的可选字段 aId / bId 被忽略', () => {
    const entry: HistoryEntry = { ...VALID_HISTORY, aId: 'na', bId: 'nb' };
    expect(isHistoryEntry(entry)).toBe(true);
  });

  it('守卫确实被 loadHistory 用于过滤（集成面）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqldiff-store-hist-'));
    try {
      fs.writeFileSync(
        historyFilePath(dir),
        JSON.stringify([{ ...VALID_HISTORY }, { id: 'bad' }, null, { ...VALID_HISTORY, id: 'h2' }]),
        'utf8',
      );
      expect(loadHistory(dir).map((h) => h.id)).toEqual(['h1', 'h2']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -- 路径函数 ------------------------------------------------------------------

const ORIG_ENV = process.env.SQLDIFF_USER_DATA_DIR;

describe('resolveUserDataDir 优先级', () => {
  beforeEach(() => {
    delete process.env.SQLDIFF_USER_DATA_DIR;
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.SQLDIFF_USER_DATA_DIR;
    else process.env.SQLDIFF_USER_DATA_DIR = ORIG_ENV;
    vi.unstubAllEnvs();
  });

  it('显式参数优先于环境变量', () => {
    vi.stubEnv('SQLDIFF_USER_DATA_DIR', '/from-env');
    expect(resolveUserDataDir('/from-arg')).toBe('/from-arg');
  });

  it('显式参数为空白串 → 落到环境变量（不把空白当路径）', () => {
    vi.stubEnv('SQLDIFF_USER_DATA_DIR', '/from-env');
    expect(resolveUserDataDir('   ')).toBe('/from-env');
    expect(resolveUserDataDir('')).toBe('/from-env');
  });

  it('不传参 + 环境变量存在 → 用环境变量', () => {
    vi.stubEnv('SQLDIFF_USER_DATA_DIR', '/from-env');
    expect(resolveUserDataDir()).toBe('/from-env');
  });

  it('环境变量为空白 → 落到 cwd/user-data（不把空白当路径）', () => {
    vi.stubEnv('SQLDIFF_USER_DATA_DIR', '  \t ');
    expect(resolveUserDataDir()).toBe(path.join(process.cwd(), 'user-data'));
  });

  it('两者都缺省 → 回落 cwd/user-data', () => {
    expect(resolveUserDataDir()).toBe(path.join(process.cwd(), 'user-data'));
  });
});

describe('nodesFilePath / historyFilePath 拼接规则', () => {
  beforeEach(() => {
    delete process.env.SQLDIFF_USER_DATA_DIR;
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.SQLDIFF_USER_DATA_DIR;
    else process.env.SQLDIFF_USER_DATA_DIR = ORIG_ENV;
    vi.unstubAllEnvs();
  });

  it('显式传参 → <dir>/nodes.json 与 <dir>/history.json', () => {
    const dir = path.join(os.tmpdir(), 'ud-a');
    expect(nodesFilePath(dir)).toBe(path.join(dir, 'nodes.json'));
    expect(historyFilePath(dir)).toBe(path.join(dir, 'history.json'));
  });

  it('不传参 → 读 SQLDIFF_USER_DATA_DIR（这正是需要直测的路径）', () => {
    vi.stubEnv('SQLDIFF_USER_DATA_DIR', path.join(os.tmpdir(), 'ud-env'));
    expect(nodesFilePath()).toBe(path.join(os.tmpdir(), 'ud-env', 'nodes.json'));
    expect(historyFilePath()).toBe(path.join(os.tmpdir(), 'ud-env', 'history.json'));
  });

  it('两个路径文件同名不同后缀，不互相覆盖', () => {
    const dir = path.join(os.tmpdir(), 'ud-b');
    expect(nodesFilePath(dir)).not.toBe(historyFilePath(dir));
    expect(path.basename(nodesFilePath(dir))).toBe('nodes.json');
    expect(path.basename(historyFilePath(dir))).toBe('history.json');
  });

  it('尾部斜杠不产生重复分隔符（path.join 语义）', () => {
    const dir = `${path.join(os.tmpdir(), 'ud-c')}${path.sep}`;
    expect(nodesFilePath(dir)).toBe(path.join(path.join(os.tmpdir(), 'ud-c'), 'nodes.json'));
  });
});

// -- clearHistory --------------------------------------------------------------

describe('clearHistory', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqldiff-store-clear-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('清空已有历史：读回为空数组', () => {
    fs.writeFileSync(
      historyFilePath(dir),
      JSON.stringify([VALID_HISTORY, { ...VALID_HISTORY, id: 'h2' }]),
      'utf8',
    );
    expect(loadHistory(dir)).toHaveLength(2);
    clearHistory(dir);
    expect(loadHistory(dir)).toEqual([]);
  });

  it('契约说明：写空数组而非删文件（实现即此语义，测试锁定它）', () => {
    fs.writeFileSync(historyFilePath(dir), JSON.stringify([VALID_HISTORY]), 'utf8');
    clearHistory(dir);
    expect(fs.existsSync(historyFilePath(dir))).toBe(true);
    expect(JSON.parse(fs.readFileSync(historyFilePath(dir), 'utf8'))).toEqual([]);
  });

  it('文件不存在时不抛（幂等），并把空历史落盘', () => {
    expect(fs.existsSync(historyFilePath(dir))).toBe(false);
    expect(() => clearHistory(dir)).not.toThrow();
    expect(loadHistory(dir)).toEqual([]);
    expect(() => clearHistory(dir)).not.toThrow();
  });

  it('目录不存在时自动建目录，不抛', () => {
    const missing = path.join(dir, 'deep', 'nested');
    expect(() => clearHistory(missing)).not.toThrow();
    expect(loadHistory(missing)).toEqual([]);
  });

  it('只清历史，不动 nodes.json（影响面）', () => {
    fs.writeFileSync(nodesFilePath(dir), JSON.stringify([VALID_NODE]), 'utf8');
    fs.writeFileSync(historyFilePath(dir), JSON.stringify([VALID_HISTORY]), 'utf8');
    clearHistory(dir);
    expect(loadHistory(dir)).toEqual([]);
    expect(fs.existsSync(nodesFilePath(dir))).toBe(true);
    expect(JSON.parse(fs.readFileSync(nodesFilePath(dir), 'utf8'))).toEqual([VALID_NODE]);
  });

  it('损坏的历史文件被清成空数组（不因解析失败而抛）', () => {
    fs.writeFileSync(historyFilePath(dir), '{ not json', 'utf8');
    expect(loadHistory(dir)).toEqual([]);
    expect(() => clearHistory(dir)).not.toThrow();
    expect(loadHistory(dir)).toEqual([]);
  });
});
