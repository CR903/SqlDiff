// P0 回归：will-download 静默落盘（假 session/item 断言 setSavePath + 文件名透传）。
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDownloadSavePath,
  handleWillDownload,
  registerWillDownload,
  type DownloadItemLike,
} from './download';

function fakeItem(filename: string): DownloadItemLike & { setSavePath: ReturnType<typeof vi.fn> } {
  return { getFilename: () => filename, setSavePath: vi.fn() };
}

describe('buildDownloadSavePath', () => {
  it('Downloads 目录 + 原文件名透传', () => {
    expect(buildDownloadSavePath('/Users/x/Downloads', 'sqldiff_123.sql')).toBe(
      path.join('/Users/x/Downloads', 'sqldiff_123.sql'),
    );
  });

  it('空文件名回落默认 sqldiff_*.sql', () => {
    const p = buildDownloadSavePath('/d', '');
    expect(p.startsWith(path.join('/d', 'sqldiff_'))).toBe(true);
    expect(p.endsWith('.sql')).toBe(true);
  });
});

describe('handleWillDownload', () => {
  it('setSavePath 被调且文件名透传', () => {
    const item = fakeItem('sqldiff_1.sql');
    handleWillDownload({}, item, () => '/d');
    expect(item.setSavePath).toHaveBeenCalledTimes(1);
    expect(item.setSavePath).toHaveBeenCalledWith(path.join('/d', 'sqldiff_1.sql'));
  });
});

describe('registerWillDownload', () => {
  it('订阅 will-download，触发后静默落盘', () => {
    const listeners = new Map<string, (e: unknown, item: DownloadItemLike) => void>();
    const session = {
      on: vi.fn((event: 'will-download', cb: (e: unknown, item: DownloadItemLike) => void) => {
        listeners.set(event, cb);
      }),
    };
    registerWillDownload(session, () => '/dl');
    expect(session.on).toHaveBeenCalledWith('will-download', expect.any(Function));
    const item = fakeItem('a.sql');
    listeners.get('will-download')?.({}, item);
    expect(item.setSavePath).toHaveBeenCalledWith(path.join('/dl', 'a.sql'));
  });
});
