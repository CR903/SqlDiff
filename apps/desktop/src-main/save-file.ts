// 导出落盘：主进程弹系统「另存为」对话框，由用户自选目录/文件名，写盘成功后回传真实路径。
// 纯接口模块（不直引 electron / node:fs，单测注入假 dialog/writer）；main.ts 在 registerIpc 内注册一次。
//
// 为什么不再用「渲染层 Blob + will-download 静默落 Downloads」：那条路径写完文件后
// 渲染层拿不到任何回执，只能报一句乐观的「已导出」，用户既不知道落在哪、也无法改位置。
// 这里是唯一落盘通道：路径由用户决定，成功/取消都是可回传的真实结果。

import path from 'node:path';

/** 一次导出里的单个文件（name 只取 basename，不接受目录分隔符）。 */
export interface SaveFileEntry {
  name: string;
  content: string;
}

/** 导出请求：单文件走「另存为」，多文件（报告 JSON+MD）走「选目录」，避免连弹两次框。 */
export type SaveRequest =
  | { kind: 'file'; defaultName: string; content: string; title?: string }
  | { kind: 'bundle'; files: SaveFileEntry[]; title?: string };

/** 导出结果：saved 携带真实落盘绝对路径（按请求顺序）；canceled 为用户在对话框中取消。 */
export type SaveResult = { status: 'saved'; filePaths: string[] } | { status: 'canceled' };

export interface SaveDialogFilters {
  name: string;
  extensions: string[];
}

export interface SaveDialogLike {
  showSaveDialog(options: {
    title?: string;
    defaultPath?: string;
    filters?: SaveDialogFilters[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    /** 本模块只用选目录能力，保留联合类型以对齐 Electron 的 OpenDialogProperties。 */
    properties?: ('openDirectory' | 'createDirectory')[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface FileWriterLike {
  writeFile(filePath: string, data: string, encoding: 'utf8'): Promise<void>;
}

export interface SaveDeps {
  dialog: SaveDialogLike;
  writer: FileWriterLike;
  /** 对话框默认目录（系统 Downloads）。 */
  getDefaultDir: () => string;
}

const EXTENSION_LABELS: Record<string, string> = {
  sql: 'SQL 文件',
  json: 'JSON 文件',
  md: 'Markdown 文件',
  txt: '文本文件',
};

/** 文件名归一：只保留 basename，挡掉 ../ 与绝对路径（渲染层不该决定写到哪）。 */
function safeEntryName(raw: string, field: string): string {
  const base = path.basename(String(raw ?? '').trim());
  if (!base || base === '.' || base === '..') {
    // field 为空串（单文件）时不留多余空格。
    throw new Error(field ? `export: ${field} 文件名非法` : 'export: 文件名非法');
  }
  return base;
}

function assertContent(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new Error(field ? `export: ${field} 内容非法` : 'export: 内容非法');
  }
  return raw;
}

/** 运行时校验渲染层传来的 SaveRequest（不可信边界，与 nodes/dbeaver 同规格）。 */
export function parseSaveRequest(raw: unknown): SaveRequest {
  const p = (raw ?? {}) as { kind?: unknown; defaultName?: unknown; content?: unknown; files?: unknown; title?: unknown };
  const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : undefined;

  if (p.kind === 'bundle') {
    if (!Array.isArray(p.files) || p.files.length === 0) {
      throw new Error('export: 批量导出请至少提供一个文件');
    }
    const files = p.files.map((f, i) => {
      const e = (f ?? {}) as { name?: unknown; content?: unknown };
      return {
        name: safeEntryName(String(e.name ?? ''), `第 ${i + 1} 个`),
        content: assertContent(e.content, `第 ${i + 1} 个`),
      };
    });
    if (new Set(files.map((f) => f.name)).size !== files.length) {
      throw new Error('export: 批量导出存在重名文件');
    }
    return title ? { kind: 'bundle', files, title } : { kind: 'bundle', files };
  }

  if (p.kind !== 'file') {
    throw new Error('export: 未知的导出请求类型');
  }
  const file = {
    defaultName: safeEntryName(String(p.defaultName ?? ''), ''),
    content: assertContent(p.content, ''),
  };
  return title ? { kind: 'file', ...file, title } : { kind: 'file', ...file };
}

/** 按扩展名给对话框配过滤器（未知扩展名退化为「全部文件」）。 */
export function buildSaveFilters(name: string): SaveDialogFilters[] {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  const filters: SaveDialogFilters[] = ext
    ? [{ name: EXTENSION_LABELS[ext] ?? `${ext.toUpperCase()} 文件`, extensions: [ext] }]
    : [];
  filters.push({ name: '全部文件', extensions: ['*'] });
  return filters;
}

async function writeAll(
  writer: FileWriterLike,
  targets: { filePath: string; content: string }[],
): Promise<string[]> {
  const filePaths: string[] = [];
  for (const t of targets) {
    try {
      await writer.writeFile(t.filePath, t.content, 'utf8');
    } catch (e) {
      throw new Error(`export: 写入 ${path.basename(t.filePath)} 失败：${String((e as Error)?.message ?? e)}`);
    }
    filePaths.push(t.filePath);
  }
  return filePaths;
}

/**
 * 落盘主流程：
 * - 单文件 → showSaveDialog（默认名 + 类型过滤器），用户可改目录与文件名；
 * - 多文件 → showOpenDialog 选一个目录，一次写完，避免连弹 N 次对话框。
 * 取消一律返回 canceled（不是错误，也不写盘）。
 */
export async function saveFiles(deps: SaveDeps, request: SaveRequest): Promise<SaveResult> {
  if (request.kind === 'bundle') {
    const picked = await deps.dialog.showOpenDialog({
      title: request.title ?? '选择导出目录',
      defaultPath: deps.getDefaultDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return { status: 'canceled' };
    return { status: 'saved', filePaths: await writeAll(deps.writer, request.files.map((f) => ({ filePath: path.join(dir, f.name), content: f.content }))) };
  }

  const picked = await deps.dialog.showSaveDialog({
    title: request.title ?? '导出文件',
    defaultPath: path.join(deps.getDefaultDir(), request.defaultName),
    filters: buildSaveFilters(request.defaultName),
  });
  if (picked.canceled || !picked.filePath) return { status: 'canceled' };
  return { status: 'saved', filePaths: await writeAll(deps.writer, [{ filePath: picked.filePath, content: request.content }]) };
}
