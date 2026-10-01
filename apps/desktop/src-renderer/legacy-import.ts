// 老 CLI 连接串导入的「说明 + 解析预览」纯函数（跨宿主，无 Node 依赖，渲染层单测覆盖）。
//
// 为什么要它：老串格式 `user:pass@host~db#port+sshuser:sshpass@sshhost#sshport` 极难凭记忆拼对，
// 而真正的解析在主进程（parseLegacyConnectionString，含与老实现逐字兼容的分隔符语义）。
// 本模块不重复实现解析，只按同样的分隔符规则给出**预览与风险提示**，让用户在提交前
// 看清「会被解析成什么」；最终解析仍以主进程为唯一事实来源。

/** 预览结果：ok=可直接提交；warn=可提交但有已知限制；error=必然解析失败，不该提交。 */
export type LegacyPreview =
  | { level: 'ok'; summary: string; lines: string[] }
  | { level: 'warn'; summary: string; lines: string[]; risk: string }
  | { level: 'error'; summary: string; lines: string[] };

export interface LegacyParsedParts {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  ssh: { user: string; password: string; host: string; port: number } | null;
  /** 显式写了端口但不合法，已回落默认——预览据此给警告（省略端口不算警告）。 */
  portInvalid: boolean;
  /** SSH 段同理。 */
  sshPortInvalid: boolean;
}

const PORT_MIN = 1;
const PORT_MAX = 65535;

/** 与主进程 parsePort 同语义：非法/越界回落缺省值（3306 / 22）。 */
function previewPort(raw: string, fallback: number): { port: number; invalid: boolean } {
  if (!raw) return { port: fallback, invalid: false };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < PORT_MIN || n > PORT_MAX) return { port: fallback, invalid: true };
  return { port: n, invalid: false };
}

/**
 * 按主进程同样的分隔符规则切分老串。
 * 注意 `lastIndexOf` 语义：密码含 `@`/`~`/`#` 时会切错位（与老实现一致的已知限制），
 * 这里如实反映，不做美化。
 */
export function splitLegacyString(
  src: string,
): LegacyParsedParts | { error: string } {
  const plusIdx = src.indexOf('+');
  const dbPart = plusIdx === -1 ? src : src.slice(0, plusIdx);
  const sshPart = plusIdx === -1 ? '' : src.slice(plusIdx + 1);

  const i1 = dbPart.indexOf(':');
  const i2 = dbPart.lastIndexOf('@');
  const i3 = dbPart.lastIndexOf('~');
  if (i1 === -1 || i2 === -1 || i3 === -1) {
    return { error: '缺少分隔符：必须有 用户名:密码@主机~库名 的结构' };
  }
  let i4 = dbPart.lastIndexOf('#');
  if (i4 === -1 || i4 < i2) i4 = dbPart.length;

  const user = dbPart.substring(0, i1);
  const password = dbPart.substring(i1 + 1, i2);
  const host = dbPart.substring(i2 + 1, i3);
  const database = dbPart.substring(i3 + 1, i4);
  if (!user || !host || !database) {
    return { error: '用户名 / 主机 / 库名 任一为空' };
  }
  const p = previewPort(dbPart.substring(i4 + 1), 3306);

  let ssh: LegacyParsedParts['ssh'] = null;
  let sshPortInvalid = false;
  if (sshPart) {
    const s1 = sshPart.indexOf(':');
    const s2 = sshPart.lastIndexOf('@');
    if (s1 === -1 || s2 === -1) return { error: 'SSH 段格式错误：应为 ssh用户名:ssh密码@ssh主机#ssh端口' };
    let s3 = sshPart.lastIndexOf('#');
    if (s3 === -1 || s3 < s2) s3 = sshPart.length;
    const sshUser = sshPart.substring(0, s1);
    const sshPassword = sshPart.substring(s1 + 1, s2);
    const sshHost = sshPart.substring(s2 + 1, s3);
    if (!sshUser || !sshHost) return { error: 'SSH 段的用户名 / 主机为空' };
    const sp = previewPort(sshPart.substring(s3 + 1), 22);
    sshPortInvalid = sp.invalid;
    ssh = { user: sshUser, password: sshPassword, host: sshHost, port: sp.port };
  }

  return { user, password, host, port: p.port, database, ssh, portInvalid: p.invalid, sshPortInvalid };
}

/** 解析预览：把连接串翻译成人话，并标出已知限制。空串返回 null（尚未输入）。 */
export function previewLegacyString(input: string): LegacyPreview | null {
  const src = (input ?? '').trim();
  if (!src) return null;

  const parsed = splitLegacyString(src);
  if ('error' in parsed) {
    return { level: 'error', summary: '无法识别这个连接串', lines: [parsed.error] };
  }

  const lines = [
    `主机 ${parsed.host} · 端口 ${parsed.port} · 库名 ${parsed.database}`,
    `用户名 ${parsed.user}${parsed.password ? ' · 密码已填写' : ' · 密码为空'}`,
    parsed.ssh
      ? `走 SSH 跳板：${parsed.ssh.host}:${parsed.ssh.port}（用户 ${parsed.ssh.user}）`
      : '不走 SSH 跳板（直连）',
  ];

  // 已知限制：user 段不允许含 `:`；密码含 @ ~ # 会切错位。
  const risks: string[] = [];
  if (parsed.password.includes('@') || parsed.password.includes('~') || parsed.password.includes('#')) {
    risks.push('密码里含 @ ~ # 符号，可能被切到错误位置——请核对上面的主机/库名是否正确');
  }
  if (parsed.ssh && (parsed.ssh.password.includes('@') || parsed.ssh.password.includes('#'))) {
    risks.push('SSH 密码里含 @ 或 # 符号，可能切错位');
  }
  // 只在「显式写了端口且不合法」时警告；省略端口走默认值是正常写法，不能误报。
  if (parsed.portInvalid) {
    risks.push(`端口号不合法，已按默认 ${parsed.port} 处理`);
  }
  if (parsed.sshPortInvalid) {
    risks.push(`SSH 端口号不合法，已按默认 ${parsed.ssh?.port} 处理`);
  }

  if (risks.length > 0) {
    return {
      level: 'warn',
      summary: `将导入为 ${parsed.user}@${parsed.host}/${parsed.database}`,
      lines,
      risk: risks.join('；'),
    };
  }
  return { level: 'ok', summary: `将导入为 ${parsed.user}@${parsed.host}/${parsed.database}`, lines };
}

/** 填入示例按钮用的示例串（不含真实凭据）。 */
export const LEGACY_EXAMPLE = 'appuser:secret@10.0.0.8~shop#3306+jump:sshsecret@10.0.0.2#22';