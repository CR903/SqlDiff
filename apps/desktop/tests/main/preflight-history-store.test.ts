// preflight-history.json 存储单测（10-04-history-diff）。
//
// 覆盖：append/load 回环、同组 10 份滚动、跨组互不影响、非法条目 throw、
// get/clear、无秘密入库扫描（AC3）。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PreflightHistoryEntry } from '../../src-core/preflight-history';
import {
  appendPreflightHistory,
  clearPreflightHistory,
  getPreflightHistoryEntry,
  loadPreflightHistory,
  PREFLIGHT_HISTORY_LIMIT,
  preflightHistoryFilePath,
} from '../../src-main/store-json';
import { readFileSync } from 'node:fs';

const NOW = '2026-10-04T00:00:00.000Z';

function entry(id: string, overrides: Partial<PreflightHistoryEntry> = {}): PreflightHistoryEntry {
  return {
    id,
    at: `${id}-${NOW}`,
    bId: 'n-b',
    bAlias: 'B库',
    database: 'shop',
    schemaVersion: 2,
    appVersion: '1.2.3',
    report: {
      schemaVersion: 2,
      appVersion: '1.2.3',
      checkedAt: NOW,
      targetAlias: 'B库',
      targetDatabase: 'shop',
      source: 'real',
      facts: [],
      inferences: [],
      unknowns: [],
      issues: [],
      verdict: { level: 'pass', blocking: 0, warnings: 0, unknowns: 0 },
      summary: { decision: 'GO', message: '可发布', blocking: 0, warnings: 0, unknowns: 0 },
    },
    ...overrides,
  };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'sqldiff-preflight-hist-'));
}

describe('preflight-history store', () => {
  it('append/load 回环：新→旧排序', () => {
    const dir = freshDir();
    appendPreflightHistory(dir, entry('h1'));
    appendPreflightHistory(dir, entry('h2'));
    const list = loadPreflightHistory(dir);
    expect(list.map((e) => e.id)).toEqual(['h2', 'h1']);
    expect(preflightHistoryFilePath(dir).endsWith('preflight-history.json')).toBe(true);
  });

  it(`同组超 ${PREFLIGHT_HISTORY_LIMIT} 份滚动：只留最新 N 份`, () => {
    const dir = freshDir();
    for (let i = 0; i < PREFLIGHT_HISTORY_LIMIT + 2; i += 1) {
      appendPreflightHistory(dir, entry(`h${i}`));
    }
    const list = loadPreflightHistory(dir);
    expect(list).toHaveLength(PREFLIGHT_HISTORY_LIMIT);
    // 最新 10 份：h11 在最前，h0/h1 被淘汰。
    expect(list[0].id).toBe(`h${PREFLIGHT_HISTORY_LIMIT + 1}`);
    expect(list.map((e) => e.id)).not.toContain('h0');
    expect(list.map((e) => e.id)).not.toContain('h1');
  });

  it('跨组互不影响：一组滚动不淘汰另一组', () => {
    const dir = freshDir();
    for (let i = 0; i < PREFLIGHT_HISTORY_LIMIT + 1; i += 1) {
      appendPreflightHistory(dir, entry(`a${i}`, { bId: 'n-a', database: 'shop' }));
    }
    appendPreflightHistory(dir, entry('b0', { bId: 'n-b', database: 'shop' }));
    const list = loadPreflightHistory(dir);
    expect(list.map((e) => e.id)).toContain('b0');
    expect(list.filter((e) => e.bId === 'n-a')).toHaveLength(PREFLIGHT_HISTORY_LIMIT);
  });

  it('同 id 去重后置顶', () => {
    const dir = freshDir();
    appendPreflightHistory(dir, entry('h1'));
    appendPreflightHistory(dir, entry('h2'));
    appendPreflightHistory(dir, entry('h1'));
    expect(loadPreflightHistory(dir).map((e) => e.id)).toEqual(['h1', 'h2']);
  });

  it('非法条目 throw（缺 report.issues）', () => {
    const dir = freshDir();
    const bad = { ...entry('bad'), report: { issues: 'x' } } as unknown as PreflightHistoryEntry;
    expect(() => appendPreflightHistory(dir, bad)).toThrow();
    expect(loadPreflightHistory(dir)).toEqual([]);
  });

  it('get 按 id 取值，不存在返回 null；clear 清空', () => {
    const dir = freshDir();
    appendPreflightHistory(dir, entry('h1'));
    expect(getPreflightHistoryEntry(dir, 'h1')?.id).toBe('h1');
    expect(getPreflightHistoryEntry(dir, 'nope')).toBeNull();
    expect(getPreflightHistoryEntry(dir, '')).toBeNull();
    clearPreflightHistory(dir);
    expect(loadPreflightHistory(dir)).toEqual([]);
  });

  it('无秘密入库：文件全文不含凭据键（AC3）', () => {
    const dir = freshDir();
    appendPreflightHistory(dir, entry('h1'));
    appendPreflightHistory(dir, entry('h2', { bId: 'n-c', database: 'shop2' }));
    const raw = readFileSync(preflightHistoryFilePath(dir), 'utf8');
    for (const key of [
      '"password"',
      '"sshPassword"',
      '"privateKey"',
      '"passphrase"',
      '"vaultCiphertext"',
      '"secret"',
      'SHOW GRANTS',
    ]) {
      expect(raw).not.toContain(key);
    }
  });
});
