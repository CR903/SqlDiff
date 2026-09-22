// P1a IPC 错误文案消毒（纯函数，主 + 渲染双端共享，不依赖任何 Node API）：
// Electron 渲染侧 invoke 失败抛 `Error invoking remote method 'xxx'(: Error:) + 后端 message`，
// 对比条 / 组合栏 / toast 只应展示中文 message（后端报错本身友好）。

const RE_IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(Error:\s*)?/;

/**
 * 剥 `Error invoking remote method '…'(: Error:)?` 前缀，取中文 message。
 * 非 Error 输入（字符串 / null / 数字等）同样处理：字符串直消毒，其余 String() 化。
 */
export function sanitizeIpcError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
  const cleaned = raw.replace(RE_IPC_PREFIX, '').trim();
  return cleaned || raw.trim() || '未知错误';
}
