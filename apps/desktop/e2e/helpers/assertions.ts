/**
 * E2E 断言工具：XML/JSON 解析 + 无秘密检查 + 结构断言。
 */

// -- 秘密字段黑名单 ----------------------------------------------------------

const SECRET_PATTERNS = [
  'password',
  'sshPassword',
  'privateKey',
  'passphrase',
  'userPassword',
  'keyValue',
  'keyPath',
  'vaultCiphertext',
  'BEGIN OPENSSH PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
  'BEGIN EC PRIVATE KEY',
];

/** 断言内容不含任何秘密字段名或密钥头。
 * 注意：save-password（值 false）、authType: PASSWORD/PUBLIC_KEY 是合法的控制字段/枚举值，不算秘密泄漏。 */
export function assertNoSecrets(content: string): void {
  // 先移除合法的控制字段和枚举值，避免误报。
  const sanitized = content
    .replace(/"save-password"\s*:\s*false/g, '"save-pw-disabled"')
    .replace(/"authType"\s*:\s*"PASSWORD"/g, '"authType": "PW_AUTH"')
    .replace(/"authType"\s*:\s*"PUBLIC_KEY"/g, '"authType": "PK_AUTH"')
    .replace(/authType="PASSWORD"/g, 'authType="PW_AUTH"')
    .replace(/authType="PUBLIC_KEY"/g, 'authType="PK_AUTH"');
  const lower = sanitized.toLowerCase();
  for (const pattern of SECRET_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      throw new Error(`秘密字段泄漏：${pattern}`);
    }
  }
}

// -- JSON 断言（DBeaver） -----------------------------------------------------

export interface DBeaverConnection {
  provider: string;
  driver: string;
  name: string;
  'save-password': boolean;
  configuration: {
    host: string;
    port: string;
    database: string;
    configurationType: string;
    'auth-model': string;
    'auth-properties': { userName: string };
    handlers?: {
      ssh_tunnel: {
        type: string;
        enabled: boolean;
        'save-password': boolean;
        properties: {
          host: string;
          port: number;
          user: string;
          authType: string;
        };
      };
    };
  };
}

export interface DBeaverDataSources {
  folders: Record<string, unknown>;
  connections: Record<string, DBeaverConnection>;
  'connection-types': Record<string, unknown>;
}

export function parseDBeaverJson(json: string): DBeaverDataSources {
  return JSON.parse(json) as DBeaverDataSources;
}

// -- XML 断言（DataGrip） -----------------------------------------------------

/** 断言 XML 是 well-formed 的最小子集。 */
export function assertWellFormedXml(xml: string): void {
  // XML 声明
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    throw new Error('XML 缺少正确的声明头');
  }
  // 根节点
  if (!xml.includes('<project version="4">')) {
    throw new Error('XML 缺少 <project version="4">');
  }
  // 引号配对
  const doubleQuotes = (xml.match(/"/g) ?? []).length;
  if (doubleQuotes % 2 !== 0) {
    throw new Error(`XML 引号不配对：${doubleQuotes} 个双引号`);
  }
  // 闭合标签
  const opens = (xml.match(/<data-source[\s>]/g) ?? []).length;
  const closes = (xml.match(/<\/data-source>/g) ?? []).length;
  if (opens !== closes) {
    throw new Error(`XML <data-source> 标签不配对：${opens} 开 / ${closes} 闭`);
  }
}

/** 从 dataSources.xml 提取 data-source 条目。 */
export function extractDataSources(xml: string): Array<{ name: string; uuid: string }> {
  const re = /<data-source\s+name="([^"]*)"\s+source="LOCAL"\s+uuid="([^"]*)"/g;
  const out: Array<{ name: string; uuid: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ name: m[1], uuid: m[2] });
  return out;
}

/** 从 dataSources.local.xml 提取 data-source 条目。 */
export function extractLocalDataSources(xml: string): Array<{ name: string; uuid: string; hasSsh: boolean }> {
  const re = /<data-source\s+name="([^"]*)"\s+uuid="([^"]*)">([\s\S]*?)<\/data-source>/g;
  const out: Array<{ name: string; uuid: string; hasSsh: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ name: m[1], uuid: m[2], hasSsh: m[3].includes('<ssh-properties>') });
  }
  return out;
}

/** 从 sshConfigs.xml 提取 sshConfig 条目。 */
export function extractSshConfigs(xml: string): Array<{ id: string; authType: string; host: string; port: number; username: string }> {
  const re = /<sshConfig\s+authType="([^"]*)"\s+host="([^"]*)"\s+id="([^"]*)"\s+port="(\d+)"\s+username="([^"]*)"/g;
  const out: Array<{ id: string; authType: string; host: string; port: number; username: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ authType: m[1], host: m[2], id: m[3], port: parseInt(m[4], 10), username: m[5] });
  }
  return out;
}

/** 从 dataSources.local.xml 提取 ssh-config-id 引用。 */
export function extractSshConfigIds(xml: string): string[] {
  const re = /<ssh-config-id>([^<]*)<\/ssh-config-id>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}
