// 补测（10-04-test-gap-backfill R1/R5）：sql.ts 的浏览器侧 IO 出口
// —— saveTextFile / saveTextFiles / copyText / downloadTextFile / formatSqlSafe / exportSavedMessage。
// 这几个函数此前只有 highlightSql / buildExportText 有直测，导出落盘与复制链路完全没有断言；
// 而「导出成功必须回传真实路径」「取消不是错误」「失败不得抛未捕获异常」是产品硬约束。
//
// 不引入 jsdom：window / navigator / document / URL 全部用 vi.stubGlobal 打桩，
// 贴合实际降级链（主进程 IPC → navigator.clipboard → execCommand）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyText,
  downloadTextFile,
  exportSavedMessage,
  formatSqlSafe,
  saveTextFile,
  saveTextFiles,
} from '../../src-renderer/sql';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface AnchorStub {
  href: string;
  download: string;
  style: Record<string, string>;
  click: ReturnType<typeof vi.fn>;
}

/** 打桩 document：createElement('a') 返回可观测 anchor，createElement('textarea') 返回拷贝桩。 */
function stubDocument(opts: { execCommand?: boolean | (() => boolean) } = {}) {
  const anchor: AnchorStub = { href: '', download: '', style: {}, click: vi.fn() };
  const ta = { value: '', style: {} as Record<string, string>, select: vi.fn() };
  const body = { appendChild: vi.fn(), removeChild: vi.fn() };
  const execCommand = vi.fn(() => (typeof opts.execCommand === 'function' ? opts.execCommand() : (opts.execCommand ?? true)));
  vi.stubGlobal('document', {
    body,
    execCommand,
    createElement: vi.fn((tag: string) => (tag === 'a' ? anchor : ta)),
  });
  return { anchor, ta, body, execCommand };
}

function stubUrl() {
  const createObjectURL = vi.fn(() => 'blob:sqldiff-test');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

describe('formatSqlSafe', () => {
  it('正常路径：关键字大写并换行排版', () => {
    const out = formatSqlSafe('select a,b from t where a=1;');
    // 契约是「格式化确实发生」：关键字大写、子句各自成行、运算符补空格。
    // 不断言逐字节排版结果——那是 sql-formatter 的内部宽度/缩进策略，
    // 依赖它在 ^15 范围内的补丁升级不应让本仓库测试变红。
    expect(out).not.toBe('select a,b from t where a=1;');
    expect(out).toContain('a = 1');
    expect(out.split('\n').map((line) => line.trim())).toEqual(
      expect.arrayContaining(['SELECT', 'a,', 'b', 'FROM', 't', 'WHERE', 'a = 1;']),
    );
  });

  it('空串 / 纯空白原样返回（不排版、不抛错）', () => {
    expect(formatSqlSafe('')).toBe('');
    expect(formatSqlSafe('   \n\t ')).toBe('   \n\t ');
  });

  it('null / undefined 归一为空串（不把 undefined 串进 UI）', () => {
    expect(formatSqlSafe(undefined as unknown as string)).toBe('');
    expect(formatSqlSafe(null as unknown as string)).toBe('');
  });

  it('DELIMITER 例程块与未闭合引号等怪输入不抛未捕获异常', () => {
    const odd = [
      'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;',
      "SELECT 'unclosed",
      '',
    ];
    for (const s of odd) {
      expect(() => formatSqlSafe(s)).not.toThrow();
      expect(typeof formatSqlSafe(s)).toBe('string');
    }
  });
});

describe('exportSavedMessage', () => {
  it('带真实落盘路径 → 拼在文案后（用户最需要知道位置）', () => {
    expect(exportSavedMessage('已导出', '/Users/test/out.sql')).toBe('已导出：/Users/test/out.sql');
  });

  it('路径为空 → 只返回前缀，不产生「已导出：」这种空尾巴', () => {
    expect(exportSavedMessage('已导出', '')).toBe('已导出');
    expect(exportSavedMessage('已导出报告', '')).toBe('已导出报告');
  });
});

describe('downloadTextFile', () => {
  it('创建 anchor、设置 download 并点击，随后移除节点', () => {
    // 用 fake timers 并在断言后推进：downloadTextFile 内部 setTimeout(1000) 释放 objectURL，
    // 若留真实定时器，它会在 afterEach unstubAllGlobals 之后才触发，
    // 打到下一个用例的 URL 桩上（跨用例污染），advance 到 0ms 只为确保回调已执行。
    vi.useFakeTimers();
    const { createObjectURL, revokeObjectURL } = stubUrl();
    const { anchor, body } = stubDocument();
    downloadTextFile('out.sql', 'SELECT 1', 'text/sql;charset=utf-8');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchor.href).toBe('blob:sqldiff-test');
    expect(anchor.download).toBe('out.sql');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(body.appendChild).toHaveBeenCalledWith(anchor);
    expect(body.removeChild).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
  });

  it('延迟 1s 后释放 objectURL（用 fake timers 断言，不真等）', () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubUrl();
    stubDocument();
    downloadTextFile('out.md', '# t', 'text/markdown;charset=utf-8');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sqldiff-test');
  });

  it('anchor 点击抛错时仍释放 objectURL，且异常向上传播（不被静默吞掉）', () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubUrl();
    const { anchor } = stubDocument();
    anchor.click.mockImplementation(() => {
      throw new Error('click blocked');
    });
    expect(() => downloadTextFile('out.json', '{}', 'application/json')).toThrow(/click blocked/);
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe('saveTextFile', () => {
  it('主进程保存成功 → status=saved 且带真实路径（不是乐观「已导出」）', async () => {
    const fileSave = vi.fn(async () => ({ status: 'saved' as const, filePaths: ['/Users/test/out.sql'] }));
    vi.stubGlobal('window', { sqldiff: { file: { save: fileSave } } });
    expect(await saveTextFile('out.sql', 'SELECT 1', '另存为')).toEqual({
      status: 'saved',
      filePath: '/Users/test/out.sql',
    });
    expect(fileSave).toHaveBeenCalledWith({
      kind: 'file',
      defaultName: 'out.sql',
      content: 'SELECT 1',
      title: '另存为',
    });
  });

  it('用户取消 → status=canceled（是正常结局，不是错误）', async () => {
    vi.stubGlobal('window', { sqldiff: { file: { save: vi.fn(async () => ({ status: 'canceled' as const })) } } });
    expect(await saveTextFile('out.sql', 'SELECT 1', '另存为')).toEqual({ status: 'canceled' });
  });

  it('saved 但未回传路径 → filePath 为空串（不编造路径）', async () => {
    vi.stubGlobal('window', {
      sqldiff: { file: { save: vi.fn(async () => ({ status: 'saved' as const, filePaths: [] })) } },
    });
    expect(await saveTextFile('out.sql', 'x', '另存为')).toEqual({ status: 'saved', filePath: '' });
  });

  it('无主进程（window.sqldiff 缺失）→ 回落 Blob 下载并标 fallback', async () => {
    const { createObjectURL } = stubUrl();
    const { anchor } = stubDocument();
    vi.stubGlobal('window', {});
    expect(await saveTextFile('out.json', '{}', '另存为')).toEqual({ status: 'fallback' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe('out.json');
  });

  it('主进程抛错（对话框失败）→ 异常向上传播，不静默假成功', async () => {
    vi.stubGlobal('window', {
      sqldiff: {
        file: {
          save: vi.fn(async () => {
            throw new Error('dialog failed');
          }),
        },
      },
    });
    await expect(saveTextFile('out.sql', 'x', '另存为')).rejects.toThrow(/dialog failed/);
  });
});

describe('saveTextFiles', () => {
  it('主进程 bundle 保存 → 原样透传全部真实路径', async () => {
    const fileSave = vi.fn(async () => ({
      status: 'saved' as const,
      filePaths: ['/Users/test/r.json', '/Users/test/r.md'],
    }));
    vi.stubGlobal('window', { sqldiff: { file: { save: fileSave } } });
    const files = [
      { name: 'r.json', content: '{}' },
      { name: 'r.md', content: '#' },
    ];
    expect(await saveTextFiles(files, '导出报告')).toEqual({
      status: 'saved',
      filePaths: ['/Users/test/r.json', '/Users/test/r.md'],
    });
    expect(fileSave).toHaveBeenCalledWith({ kind: 'bundle', files, title: '导出报告' });
  });

  it('无主进程 → 每个文件各下载一次并标 fallback（不弹 N 次对话框）', async () => {
    const { createObjectURL } = stubUrl();
    stubDocument();
    vi.stubGlobal('window', {});
    const out = await saveTextFiles(
      [
        { name: 'r.json', content: '{}' },
        { name: 'r.md', content: '#' },
      ],
      '导出报告',
    );
    expect(out).toEqual({ status: 'fallback' });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('取消 → canceled（不是失败）', async () => {
    vi.stubGlobal('window', {
      sqldiff: { file: { save: vi.fn(async () => ({ status: 'canceled' as const })) } },
    });
    expect(await saveTextFiles([{ name: 'r.md', content: '#' }], '导出报告')).toEqual({
      status: 'canceled',
    });
  });
});

describe('copyText：三级降级链', () => {
  it('主进程 sql.copy 成功 → true，且不再走浏览器剪贴板', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('window', { sqldiff: { sql: { copy: vi.fn(async () => true) } } });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('SELECT 1')).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('主进程返回 false / 抛错 → 降级 navigator.clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    vi.stubGlobal('window', { sqldiff: { sql: { copy: vi.fn(async () => false) } } });
    expect(await copyText('a')).toBe(true);

    vi.stubGlobal('window', {
      sqldiff: {
        sql: {
          copy: vi.fn(async () => {
            throw new Error('clipboard unavailable');
          }),
        },
      },
    });
    expect(await copyText('b')).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('navigator 拒绝 → 降级 textarea + execCommand（并把临时节点摘掉）', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    const { ta, body, execCommand } = stubDocument({ execCommand: true });
    expect(await copyText('SELECT 1')).toBe(true);
    expect(ta.value).toBe('SELECT 1');
    expect(ta.select).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(body.appendChild).toHaveBeenCalledWith(ta);
    expect(body.removeChild).toHaveBeenCalledWith(ta);
  });

  it('全链路失败（无 navigator / 无 document）→ 返回 false 而非抛未捕获异常', async () => {
    // 无 window：ipc() 内部 try/catch 吞掉 ReferenceError。
    expect(await copyText('SELECT 1')).toBe(false);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    expect(await copyText('SELECT 1')).toBe(false);
  });

  it('execCommand 返回 false → 复制失败返回 false（不谎报成功）', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    stubDocument({ execCommand: false });
    expect(await copyText('SELECT 1')).toBe(false);
  });
});