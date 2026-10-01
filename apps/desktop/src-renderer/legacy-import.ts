// 老 CLI 连接串导入的「解析为可编辑草稿」纯函数（跨宿主，无 Node 依赖，渲染层单测覆盖）。
//
// 设计取舍（重要）：
// 老串格式 `user:pass@host~db#port+sshuser:sshpass@sshhost#sshport` 用分隔符编码，
// 而密码是任意字符——两者本质冲突。实测（见 legacy-import.test.ts）：
//   密码含 @ ~ # :  → 因解析用 lastIndexOf 取「最后一个」，能完整还原；
//   密码含 +        → + 是 SSH 分段符且用 indexOf 取「第一个」，密码含 + 必然解析失败。
// 与其继续打补丁猜分隔符，本模块把串**解析成草稿字段**交给用户确认/纠正，
// 最终按结构化字段入库（走 nodes.create），不再让分隔符规则参与第二次切割。
// 因此：解析出错也只是「草稿没填全」，用户仍可手填后导入，不会被卡死在错误上。

/** 解析后的可编辑草稿。字段与 NodeCreateInput 对齐，用户确认后直接结构化入库。 */
export interface LegacyDraft {
  alias: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshPassword: string;
}

/** 解析提示：ok=无需纠错；warn=已尽力解析但有存疑字段；error=无法切分，只能手填。 */
export type LegacyParse =
  | { level: 'ok'; draft: LegacyDraft }
  | { level: 'warn'; draft: LegacyDraft; risks: string[] }
  | { level: 'error'; message: string };

const PORT_MIN = 1;
const PORT_MAX = 65535;

/** 端口：省略用默认；显式写了但非法时保留用户原文交给其纠正（不静默改写）。 */
function parsePortField(raw: string, fallback: number): { text: string; invalid: boolean } {
  const s = (raw ?? '').trim();
  if (!s) return { text: String(fallback), invalid: false };
  const n = Number.parseInt(s, 10);
  const invalid = !Number.isFinite(n) || n < PORT_MIN || n > PORT_MAX || !/^\d+$/.test(s);
  return { text: s, invalid };
}

function emptyDraft(): LegacyDraft {
  return {
    alias: '',
    host: '',
    port: '3306',
    user: '',
    password: '',
    database: '',
    sshEnabled: false,
    sshHost: '',
    sshPort: '22',
    sshUser: '',
    sshPassword: '',
  };
}

interface DbParts {
  user: string;
  password: string;
  host: string;
  database: string;
  port: { text: string; invalid: boolean };
}

/** 切数据库段 user:pass@host~db#port；分隔符缺失或顺序矛盾时返回 null。 */
function parseDbPart(part: string): DbParts | null {
  const i1 = part.indexOf(':');
  const i2 = part.lastIndexOf('@');
  const i3 = part.lastIndexOf('~');
  if (i1 === -1 || i2 === -1 || i3 === -1 || i1 > i2 || i2 > i3) return null;
  let i4 = part.lastIndexOf('#');
  if (i4 === -1 || i4 < i2) i4 = part.length;
  return {
    user: part.substring(0, i1),
    password: part.substring(i1 + 1, i2),
    host: part.substring(i2 + 1, i3),
    database: part.substring(i3 + 1, i4),
    port: parsePortField(part.substring(i4 + 1), 3306),
  };
}

/**
 * 把老串切成草稿字段。
 * 分隔符语义与主进程 parseLegacyConnectionString 保持一致（用 lastIndexOf 取最后，
 * 这样密码里的 @ ~ # 不会切错位），但**不做最终裁决**——结果一律交给用户确认。
 */
export function parseLegacyToDraft(input: string): LegacyParse {
  const src = (input ?? '').trim();
  if (!src) return { level: 'error', message: '请先粘贴连接串' };

  // 先按「有 SSH 段」切；切不开就退回「整串当数据库段」——密码含 + 时正是这条路，
  // 否则用户连手填的机会都没有（实测 u:p+ss@host~db 会被截成 u:p 而无法解析）。
  const plusIdx = src.indexOf('+');
  let dbPart = plusIdx === -1 ? src : src.slice(0, plusIdx);
  let sshPart = plusIdx === -1 ? '' : src.slice(plusIdx + 1);
  // 只有「按 SSH 段切失败、改用整串才成功」时才判定 + 可疑；
  // 数据库段本来就能正常切分时，+ 就是合法的 SSH 分隔符，不该报警告。
  let plusSuspect = false;

  let parsed = parseDbPart(dbPart);
  if (!parsed && plusIdx !== -1) {
    parsed = parseDbPart(src);
    if (parsed) {
      plusSuspect = true;
      dbPart = src;
      sshPart = '';
    }
  }
  if (!parsed) {
    return {
      level: 'error',
      message: '无法切分连接串，需要 用户名:密码@主机~库名 的结构。请对照上面的格式手动填写字段。',
    };
  }

  const split = { sshPart, plusSuspect };

  const risks: string[] = [];
  const draft = emptyDraft();
  if (split.plusSuspect) {
    risks.push('串里有 “+”，已按「整个串都是数据库段」解析。若你确实要走 SSH 跳板，请手动填写下方跳板字段');
  }

  draft.user = parsed.user;
  draft.password = parsed.password;
  draft.host = parsed.host;
  draft.database = parsed.database;
  draft.port = parsed.port.text;
  if (parsed.port.invalid) risks.push(`端口 “${parsed.port.text}” 不是合法端口号，请修改（留空则用 3306）`);

  if (sshPart && !split.plusSuspect) {
    const s1 = sshPart.indexOf(':');
    const s2 = sshPart.lastIndexOf('@');
    if (s1 === -1 || s2 === -1 || s1 > s2) {
      risks.push('SSH 段无法切分（需要 ssh用户名:ssh密码@ssh主机），跳板信息请手动填写，或取消勾选 SSH');
    } else {
      let s3 = sshPart.lastIndexOf('#');
      if (s3 === -1 || s3 < s2) s3 = sshPart.length;
      draft.sshEnabled = true;
      draft.sshUser = sshPart.substring(0, s1);
      draft.sshPassword = sshPart.substring(s1 + 1, s2);
      draft.sshHost = sshPart.substring(s2 + 1, s3);
      const sp = parsePortField(sshPart.substring(s3 + 1), 22);
      draft.sshPort = sp.text;
      if (sp.invalid) risks.push(`SSH 端口 “${sp.text}” 不是合法端口号，请修改（留空则用 22）`);
    }
  }

  draft.alias = draft.user && draft.host ? `${draft.user}@${draft.host}/${draft.database}` : '';
  return risks.length > 0 ? { level: 'warn', draft, risks } : { level: 'ok', draft };
}

/** 草稿 → 结构化入库载荷（与 NodeCreateInput 对齐；空密码不写入 secret）。 */
export function draftToNodeInput(draft: LegacyDraft): {
  alias: string;
  host: string;
  port?: number;
  user: string;
  database: string;
  ssh: { enabled: boolean; host: string; port: number; user: string; authType: 'password' };
  secret: { password?: string; sshPassword?: string };
} {
  const numPort = draft.port.trim() === '' ? undefined : Number.parseInt(draft.port.trim(), 10);
  const numSshPort = draft.sshPort.trim() === '' ? undefined : Number.parseInt(draft.sshPort.trim(), 10);
  const secret: { password?: string; sshPassword?: string } = {};
  if (draft.password) secret.password = draft.password;
  if (draft.sshEnabled && draft.sshPassword) secret.sshPassword = draft.sshPassword;
  return {
    alias: draft.alias.trim() || `${draft.user.trim()}@${draft.host.trim()}/${draft.database.trim()}`,
    host: draft.host.trim(),
    ...(numPort !== undefined && Number.isFinite(numPort) ? { port: numPort } : {}),
    user: draft.user.trim(),
    database: draft.database.trim(),
    ssh: {
      enabled: draft.sshEnabled,
      host: draft.sshEnabled ? draft.sshHost.trim() : '',
      port: numSshPort !== undefined && Number.isFinite(numSshPort) ? numSshPort : 22,
      user: draft.sshEnabled ? draft.sshUser.trim() : '',
      authType: 'password',
    },
    secret,
  };
}

/** 草稿必填项校验（结构化入库前的最后一道闸）。 */
export function validateDraft(draft: LegacyDraft): string[] {
  const errs: string[] = [];
  if (!draft.host.trim()) errs.push('主机不能为空');
  if (!draft.user.trim()) errs.push('用户名不能为空');
  if (!draft.database.trim()) errs.push('库名不能为空');
  const p = Number.parseInt(draft.port.trim() || '3306', 10);
  if (!Number.isFinite(p) || p < PORT_MIN || p > PORT_MAX) errs.push('端口需为 1-65535 的整数');
  if (draft.sshEnabled) {
    if (!draft.sshHost.trim()) errs.push('勾选了 SSH 跳板，但跳板主机为空');
    if (!draft.sshUser.trim()) errs.push('勾选了 SSH 跳板，但 SSH 用户名为空');
    const sp = Number.parseInt(draft.sshPort.trim() || '22', 10);
    if (!Number.isFinite(sp) || sp < PORT_MIN || sp > PORT_MAX) errs.push('SSH 端口需为 1-65535 的整数');
  }
  return errs;
}

/** 填入示例按钮用的示例串（不含真实凭据）。 */
export const LEGACY_EXAMPLE = 'appuser:secret@10.0.0.8~shop#3306+jump:sshsecret@10.0.0.2#22';