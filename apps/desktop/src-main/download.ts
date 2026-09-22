// P0 导出落盘：主进程 will-download 静默落盘到系统 Downloads 目录（保持无弹窗体验）。
// 纯接口模块（不直引 electron，单测用假 session/item 断言）；main.ts 在 app ready 内注册一次。

import path from 'node:path';

/** Electron DownloadItem 最小形状（单测用假对象断言）。 */
export interface DownloadItemLike {
  getFilename(): string;
  setSavePath(savePath: string): void;
}

/** Electron session 最小形状（仅 will-download 订阅）。 */
export interface DownloadSessionLike {
  on(event: 'will-download', listener: (e: unknown, item: DownloadItemLike) => void): void;
}

/** 落盘路径 = 系统 Downloads 目录 + 原文件名透传（空文件名回落默认 sqldiff_*.sql）。 */
export function buildDownloadSavePath(downloadsDir: string, filename: string): string {
  const safe = filename && filename.trim() ? filename : `sqldiff_${Date.now()}.sql`;
  return path.join(downloadsDir, safe);
}

/** will-download 处理：静默指定落盘路径（不弹另存对话框，此前无 handler 时默认行为不落盘）。 */
export function handleWillDownload(
  event: unknown,
  item: DownloadItemLike,
  getDownloadsDir: () => string,
): void {
  void event;
  item.setSavePath(buildDownloadSavePath(getDownloadsDir(), item.getFilename()));
}

/** app ready 内注册一次（此前无 handler，回滚时 revert 本模块 + main.ts 调用即可）。 */
export function registerWillDownload(
  session: DownloadSessionLike,
  getDownloadsDir: () => string,
): void {
  session.on('will-download', (e, item) => handleWillDownload(e, item, getDownloadsDir));
}
