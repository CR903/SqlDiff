// 导出落盘回归：系统另存为对话框 + 真实写盘 + 真实路径回传。
// 旧路径（渲染层 Blob + will-download 静默落 Downloads）拿不到回执，
// 这里锁住「成功必带路径、取消不写盘、坏输入不落盘」三条不变量。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSaveFilters,
  parseSaveRequest,
  saveFiles,
  type FileWriterLike,
  type SaveDialogLike,
  type SaveRequest,
} from './save-file';

function fakeWriter(): FileWriterLike & { writeFile: ReturnType<typeof vi.fn> } {
  return { writeFile: vi.fn(async () => undefined) };
}

function fakeDialog(over: {
  save?: { canceled: boolean; filePath?: string };
  open?: { canceled: boolean; filePaths: string[] };
} = {}): SaveDialogLike & { showSaveDialog: ReturnType<typeof vi.fn>; showOpenDialog: ReturnType<typeof vi.fn> } {
  return {
    showSaveDialog: vi.fn(async () => over.save ?? { canceled: false, filePath: '/chosen/out.sql' }),
    showOpenDialog: vi.fn(async () => over.open ?? { canceled: false, filePaths: ['/chosen/dir'] }),
  };
}

describe('parseSaveRequest', () => {
  it('单文件：kind=file 直通', () => {
    expect(parseSaveRequest({ kind: 'file', defaultName: 'a.sql', content: 'SELECT 1;' })).toEqual({
      kind: 'file',
      defaultName: 'a.sql',
      content: 'SELECT 1;',
    });
  });

  it('文件名只取 basename：挡掉 ../ 与绝对路径（渲染层不决定写到哪）', () => {
    const r = parseSaveRequest({ kind: 'file', defaultName: '../../etc/passwd', content: 'x' });
    expect(r).toMatchObject({ defaultName: 'passwd' });
    expect(parseSaveRequest({ kind: 'file', defaultName: '/abs/out.sql', content: 'x' })).toMatchObject({
      defaultName: 'out.sql',
    });
  });

  it('空 / 非法输入报错（不静默放行）', () => {
    expect(() => parseSaveRequest(null)).toThrow('export: 未知的导出请求类型');
    expect(() => parseSaveRequest({ kind: 'file', defaultName: '  ', content: 'x' })).toThrow(
      'export: 文件名非法',
    );
    expect(() => parseSaveRequest({ kind: 'file', defaultName: 'a.sql', content: 42 })).toThrow(
      'export: 内容非法',
    );
  });

  it('批量：重名与空列表都拒绝', () => {
    expect(() => parseSaveRequest({ kind: 'bundle', files: [] })).toThrow('export: 批量导出请至少提供一个文件');
    expect(() =>
      parseSaveRequest({
        kind: 'bundle',
        files: [
          { name: 'a.json', content: '{}' },
          { name: 'a.json', content: '{}' },
        ],
      }),
    ).toThrow('export: 批量导出存在重名文件');
  });
});

describe('buildSaveFilters', () => {
  it('按扩展名给类型过滤器 + 兜底「全部文件」', () => {
    expect(buildSaveFilters('x.sql')).toEqual([
      { name: 'SQL 文件', extensions: ['sql'] },
      { name: '全部文件', extensions: ['*'] },
    ]);
    expect(buildSaveFilters('x.md')[0]).toEqual({ name: 'Markdown 文件', extensions: ['md'] });
  });

  it('无扩展名：仅「全部文件」', () => {
    expect(buildSaveFilters('noext')).toEqual([{ name: '全部文件', extensions: ['*'] }]);
  });

  it('未知扩展名：仍按真实扩展名过滤，仅名称退化为通用文案', () => {
    expect(buildSaveFilters('x.weird')).toEqual([
      { name: 'WEIRD 文件', extensions: ['weird'] },
      { name: '全部文件', extensions: ['*'] },
    ]);
  });
});

describe('saveFiles：单文件', () => {
  it('弹另存为 → 写入用户选中的路径 → 回传该路径', async () => {
    const dialog = fakeDialog({ save: { canceled: false, filePath: '/Users/x/Desktop/my.sql' } });
    const writer = fakeWriter();
    const r = await saveFiles(
      { dialog, writer, getDefaultDir: () => '/Users/x/Downloads' },
      { kind: 'file', defaultName: 'sqldiff_1.sql', content: 'SELECT 1;', title: '导出' },
    );
    expect(r).toEqual({ status: 'saved', filePaths: ['/Users/x/Desktop/my.sql'] });
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '导出',
        defaultPath: '/Users/x/Downloads/sqldiff_1.sql',
        filters: [{ name: 'SQL 文件', extensions: ['sql'] }, { name: '全部文件', extensions: ['*'] }],
      }),
    );
    expect(writer.writeFile).toHaveBeenCalledWith('/Users/x/Desktop/my.sql', 'SELECT 1;', 'utf8');
  });

  it('用户取消：不写盘、不当错误', async () => {
    const dialog = fakeDialog({ save: { canceled: true } });
    const writer = fakeWriter();
    const r = await saveFiles(
      { dialog, writer, getDefaultDir: () => '/d' },
      { kind: 'file', defaultName: 'a.sql', content: 'x' },
    );
    expect(r).toEqual({ status: 'canceled' });
    expect(writer.writeFile).not.toHaveBeenCalled();
  });

  it('写盘失败：抛 export: 前缀错误（renderer 可直接展示）', async () => {
    const dialog = fakeDialog({ save: { canceled: false, filePath: '/d/a.sql' } });
    const writer = { writeFile: vi.fn(async () => { throw new Error('EACCES'); }) };
    await expect(
      saveFiles({ dialog, writer, getDefaultDir: () => '/d' }, { kind: 'file', defaultName: 'a.sql', content: 'x' }),
    ).rejects.toThrow('export: 写入 a.sql 失败：EACCES');
  });
});

describe('saveFiles：批量（报告 JSON+MD）', () => {
  it('一次「选目录」写完全部文件，回传全部路径', async () => {
    const dialog = fakeDialog({ open: { canceled: false, filePaths: ['/Users/x/reports'] } });
    const writer = fakeWriter();
    const files = [
      { name: 'sqldiff-review.json', content: '{"a":1}' },
      { name: 'sqldiff-review.md', content: '# 报告' },
    ];
    const r = await saveFiles({ dialog, writer, getDefaultDir: () => '/d' }, { kind: 'bundle', files, title: '导出报告' });
    expect(r).toEqual({
      status: 'saved',
      filePaths: ['/Users/x/reports/sqldiff-review.json', '/Users/x/reports/sqldiff-review.md'],
    });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      title: '导出报告',
      defaultPath: '/d',
      properties: ['openDirectory', 'createDirectory'],
    });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(writer.writeFile).toHaveBeenCalledTimes(2);
  });

  it('取消选目录：不写盘', async () => {
    const dialog = fakeDialog({ open: { canceled: true, filePaths: [] } });
    const writer = fakeWriter();
    const r = await saveFiles(
      { dialog, writer, getDefaultDir: () => '/d' },
      { kind: 'bundle', files: [{ name: 'a.json', content: '{}' }] },
    );
    expect(r).toEqual({ status: 'canceled' });
    expect(writer.writeFile).not.toHaveBeenCalled();
  });
});

describe('saveFiles：标题缺省', () => {
  it('未给 title 时用通用默认文案', async () => {
    const dialog = fakeDialog();
    await saveFiles(
      { dialog, writer: fakeWriter(), getDefaultDir: () => '/d' },
      { kind: 'file', defaultName: 'a.sql', content: 'x' } as SaveRequest,
    );
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '导出文件' }));
  });
});

// 真 fs 往返：假 writer 只证明「调了 writeFile」，这里证明文件真的落在回传的那个路径上。
describe('saveFiles：真实磁盘往返', () => {
  const tmpDirs: string[] = [];

  function makeTmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqldiff-save-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('单文件：回传路径存在，内容与请求一致（含中文）', async () => {
    const dir = makeTmp();
    const target = path.join(dir, 'chosen.sql');
    const content = '-- SqlDiff 导出\nCREATE TABLE `用户` (`名` VARCHAR(10));\n';
    const r = await saveFiles(
      {
        dialog: fakeDialog({ save: { canceled: false, filePath: target } }),
        writer: fs.promises,
        getDefaultDir: () => dir,
      },
      { kind: 'file', defaultName: 'default.sql', content, title: '导出' },
    );
    expect(r).toEqual({ status: 'saved', filePaths: [target] });
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
  });

  it('批量：两个文件都落在所选目录', async () => {
    const dir = makeTmp();
    const r = await saveFiles(
      {
        dialog: fakeDialog({ open: { canceled: false, filePaths: [dir] } }),
        writer: fs.promises,
        getDefaultDir: () => dir,
      },
      {
        kind: 'bundle',
        files: [
          { name: 'r.json', content: '{"schemaVersion":1}' },
          { name: 'r.md', content: '# 报告' },
        ],
      },
    );
    expect(r.status).toBe('saved');
    expect(fs.readFileSync(path.join(dir, 'r.json'), 'utf8')).toBe('{"schemaVersion":1}');
    expect(fs.readFileSync(path.join(dir, 'r.md'), 'utf8')).toBe('# 报告');
  });

  it('取消：目录里不产生任何文件', async () => {
    const dir = makeTmp();
    const r = await saveFiles(
      {
        dialog: fakeDialog({ save: { canceled: true } }),
        writer: fs.promises,
        getDefaultDir: () => dir,
      },
      { kind: 'file', defaultName: 'nope.sql', content: 'x' },
    );
    expect(r).toEqual({ status: 'canceled' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('写盘失败：目标目录不存在时报 export: 前缀错误，不静默吞掉', async () => {
    const dir = makeTmp();
    await expect(
      saveFiles(
        {
          dialog: fakeDialog({ save: { canceled: false, filePath: path.join(dir, 'missing', 'a.sql') } }),
          writer: fs.promises,
          getDefaultDir: () => dir,
        },
        { kind: 'file', defaultName: 'a.sql', content: 'x' },
      ),
    ).rejects.toThrow('export: 写入 a.sql 失败');
  });
});
