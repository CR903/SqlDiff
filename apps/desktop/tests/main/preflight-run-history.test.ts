// runPreflight 历史持久化单测（10-04-history-diff）。
//
// 覆盖 implement.md：只在成功 run 后 append；失败/取消不写；
// append 抛错 try/catch 隔离，不影响主流程返回值。

import { describe, expect, it, vi } from 'vitest';
import type { DiffItem } from '../../src-core/types';
import type { PreflightHistoryEntry } from '../../src-core/preflight-history';
import { runPreflight, type PreflightPoolLike } from '../../src-main/preflight-run';
import { appendPreflightHistory } from '../../src-main/store-json';

vi.mock('../../src-main/store-json', () => ({
  loadNodes: () => [
    {
      id: 'n-b',
      alias: 'B-node',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      database: 'shop',
      createdAt: '2026-10-03T00:00:00.000Z',
      ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    },
  ],
  appendPreflightHistory: vi.fn(() => []),
}));

vi.mock('../../src-main/connection', () => ({
  createMysqlPool: vi.fn(async () => {
    throw new Error('should not be called when deps.createPool is provided');
  }),
}));

const mockedAppend = appendPreflightHistory as unknown as ReturnType<typeof vi.fn>;

function fakePool(): PreflightPoolLike {
  return {
    query: async () => [],
    end: async () => undefined,
  };
}

function item(): DiffItem {
  return {
    id: 'd1',
    objectType: 'table',
    objectName: 'orders',
    changeType: 'CHANGE',
    aspects: ['column'],
    risk: 'medium',
    sql: 'ALTER TABLE `orders` ADD COLUMN `note` varchar(64)',
  };
}

describe('runPreflight 历史持久化', () => {
  it('成功 run 后 append 一次：entry 按 (bId, database) 落位且不含秘密', async () => {
    mockedAppend.mockClear();
    mockedAppend.mockImplementation(() => []);
    const result = await runPreflight(
      { bId: 'n-b', items: [item()], bAlias: 'B-node', bDatabase: 'shop' },
      { userDataDir: '/tmp/fake-history' },
      {},
      { createPool: async () => fakePool(), secretProvider: () => ({}), appVersion: 't' },
    );
    expect(result.verdictLevel).toBeDefined();
    expect(mockedAppend).toHaveBeenCalledTimes(1);
    const [dir, got] = mockedAppend.mock.calls[0] as [string, PreflightHistoryEntry];
    expect(dir).toBe('/tmp/fake-history');
    expect(got.bId).toBe('n-b');
    expect(got.database).toBe('shop');
    expect(got.bAlias).toBe('B-node');
    expect(Array.isArray(got.report.issues)).toBe(true);
    const raw = JSON.stringify(got);
    for (const key of ['"password"', '"privateKey"', '"passphrase"', '"sshPassword"']) {
      expect(raw).not.toContain(key);
    }
  });

  it('append 抛错被隔离：主流程照常返回报告', async () => {
    mockedAppend.mockClear();
    mockedAppend.mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = await runPreflight(
      { bId: 'n-b', items: [item()], bAlias: 'B-node', bDatabase: 'shop' },
      { userDataDir: '/tmp/fake-history' },
      {},
      { createPool: async () => fakePool(), secretProvider: () => ({}), appVersion: 't' },
    );
    expect(result.jsonContent).toContain('schemaVersion');
    expect(result.verdictLevel).toBeDefined();
  });

  it('aborted 取消不写历史（半份报告不污染对比）', async () => {
    mockedAppend.mockClear();
    mockedAppend.mockImplementation(() => []);
    const ctrl = new AbortController();
    ctrl.abort();
    await runPreflight(
      { bId: 'n-b', items: [item()], bAlias: 'B-node', bDatabase: 'shop' },
      { userDataDir: '/tmp/fake-history' },
      { signal: ctrl.signal },
      { createPool: async () => fakePool(), secretProvider: () => ({}), appVersion: 't' },
    );
    expect(mockedAppend).not.toHaveBeenCalled();
  });
});
