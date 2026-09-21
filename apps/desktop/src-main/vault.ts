// M2 存储 vault：节点密钥的加密存取 + 导出约定加密 + 老连接串导入。
//
// 秘密存放：
// - 首选 Electron safeStorage（OS 钥匙串背书）加密后落盘到 `<userData>/secrets/<nodeId>.json`。
//   safeStorage 只负责加密，持久化仍是本地文件（与 design.md "safeStorage + OS 钥匙串" 一致）。
// - safeStorage 不可用时回退 AES-256-GCM，主密钥存 `<userData>/.masterkey`
//  （safeStorage 可用则升级存 `.masterkey.enc`，即"主密钥存钥匙串/本地文件"）。
// - 导出 JSON 统一用 AES-GCM 约定加密（`SecretsEnc {enc:"aes-gcm", iv, data}`），
//   主密钥在本机钥匙串/本地文件，导入自动解码免重输；换机器导入会解码失败（见 importDecrypted 报错）。
//
// 本文件不直接 import 'electron'（可测试性）：main.ts 把 safeStorage 适配成
// SafeStorageLike 注入；单测用伪实现或直接走回退路径。

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExportJSON, NodeMeta, SecretBundle, SecretsEnc } from '../src-core/types';

/** Electron safeStorage 的最小结构形状（main.ts 注入真实实现，单测注入伪实现）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function safeStorageUsable(ss: SafeStorageLike | null | undefined): ss is SafeStorageLike {
  if (!ss) return false;
  try {
    return ss.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 主密钥（AES-GCM 回退路径 + 导出约定加密共用）
// ---------------------------------------------------------------------------

export const MASTER_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export function masterKeyPath(userDataDir: string): string {
  return path.join(userDataDir, '.masterkey');
}

export function encryptedMasterKeyPath(userDataDir: string): string {
  return path.join(userDataDir, '.masterkey.enc');
}

function writeFilePrivate(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 无 POSIX 权限位，忽略。
  }
}

/**
 * 读取已有主密钥，不存在则生成 32 字节随机密钥并持久化。
 * safeStorage 可用时优先读写钥匙串加密版（.masterkey.enc），否则用本地文件（.masterkey，0600）。
 */
export function loadOrCreateMasterKey(
  userDataDir: string,
  safeStorage?: SafeStorageLike | null,
): Buffer {
  fs.mkdirSync(userDataDir, { recursive: true });
  const ss = safeStorageUsable(safeStorage) ? safeStorage : null;

  const encPath = encryptedMasterKeyPath(userDataDir);
  if (ss && fs.existsSync(encPath)) {
    try {
      const keyHex = ss.decryptString(Buffer.from(fs.readFileSync(encPath, 'utf8').trim(), 'base64'));
      const key = Buffer.from(keyHex, 'hex');
      if (key.length === MASTER_KEY_BYTES) return key;
      // 长度不对则继续走生成流程覆盖。
    } catch {
      // 钥匙串不可解（如换机器/钥匙串被清）：继续用本地密钥或重建，调用方按失败处理。
    }
  }

  const rawPath = masterKeyPath(userDataDir);
  if (fs.existsSync(rawPath)) {
    const key = fs.readFileSync(rawPath);
    if (key.length === MASTER_KEY_BYTES) {
      if (ss) {
        try {
          writeFilePrivate(encPath, ss.encryptString(key.toString('hex')).toString('base64'));
        } catch {
          // 升级失败不影响使用本地密钥。
        }
      }
      return key;
    }
  }

  const key = randomBytes(MASTER_KEY_BYTES);
  if (ss) {
    writeFilePrivate(encPath, ss.encryptString(key.toString('hex')).toString('base64'));
  } else {
    writeFilePrivate(rawPath, key);
  }
  return key;
}

// ---------------------------------------------------------------------------
// AES-GCM 编解码（导出约定格式 SecretsEnc）
// ---------------------------------------------------------------------------

export function aesGcmEncrypt(masterKey: Buffer, plainText: string): SecretsEnc {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error('vault: 主密钥长度错误，无法加密');
  }
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: 'aes-gcm',
    iv: iv.toString('base64'),
    data: Buffer.concat([ct, tag]).toString('base64'),
  };
}

export function aesGcmDecrypt(masterKey: Buffer, enc: SecretsEnc): string {
  if (!enc || enc.enc !== 'aes-gcm') {
    throw new Error(`vault: 不支持的密钥加密方式 "${String((enc as SecretsEnc | null)?.enc)}"`);
  }
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error('vault: 主密钥长度错误，无法解密');
  }
  const iv = Buffer.from(enc.iv, 'base64');
  const raw = Buffer.from(enc.data, 'base64');
  if (iv.length !== AES_GCM_IV_BYTES || raw.length < AES_GCM_TAG_BYTES) {
    throw new Error('vault: 加密段损坏（iv/data 非法）');
  }
  const ct = raw.subarray(0, raw.length - AES_GCM_TAG_BYTES);
  const tag = raw.subarray(raw.length - AES_GCM_TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('vault: 解密失败（主密钥不匹配或数据被篡改；换机器导入需原机重新导出）');
  }
}

// ---------------------------------------------------------------------------
// 节点密钥存取（per-node 加密文件）
// ---------------------------------------------------------------------------

type StoredProvider = 'safestorage' | 'aes-gcm';

interface StoredSecretFile {
  provider: StoredProvider;
  /** safestorage：safeStorage 密文 base64；aes-gcm：见 SecretsEnc.data */
  data: string;
  /** aes-gcm iv base64；safestorage 无此字段 */
  iv?: string;
}

export function assertSafeNodeId(nodeId: string): void {
  if (typeof nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId)) {
    throw new Error(`vault: 非法 nodeId "${String(nodeId)}"`);
  }
}

function secretsDir(userDataDir: string): string {
  return path.join(userDataDir, 'secrets');
}

function secretFilePath(userDataDir: string, nodeId: string): string {
  assertSafeNodeId(nodeId);
  return path.join(secretsDir(userDataDir), `${nodeId}.json`);
}

function isSecretBundle(v: unknown): v is SecretBundle {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface VaultOptions {
  userDataDir: string;
  /** Electron safeStorage 适配（main.ts 注入）；缺失/不可用时走 AES-GCM 文件回退。 */
  safeStorage?: SafeStorageLike | null;
}

export class Vault {
  private readonly dir: string;
  private readonly safeStorage: SafeStorageLike | null;

  constructor(opts: VaultOptions) {
    if (!opts || typeof opts.userDataDir !== 'string' || opts.userDataDir.length === 0) {
      throw new Error('vault: userDataDir 必填');
    }
    this.dir = opts.userDataDir;
    this.safeStorage = safeStorageUsable(opts.safeStorage) ? (opts.safeStorage as SafeStorageLike) : null;
  }

  /** 当前生效的加密通道（third-party 可见，用于自检/备份提示）。 */
  get provider(): StoredProvider {
    return this.safeStorage ? 'safestorage' : 'aes-gcm';
  }

  private masterKey(): Buffer {
    return loadOrCreateMasterKey(this.dir, this.safeStorage);
  }

  saveNodeSecret(nodeId: string, secret: SecretBundle): void {
    if (!isSecretBundle(secret)) throw new Error('vault: secret 必须为对象');
    const plain = JSON.stringify(secret);
    let stored: StoredSecretFile;
    if (this.safeStorage) {
      stored = {
        provider: 'safestorage',
        data: this.safeStorage.encryptString(plain).toString('base64'),
      };
    } else {
      const enc = aesGcmEncrypt(this.masterKey(), plain);
      stored = { provider: 'aes-gcm', iv: enc.iv, data: enc.data };
    }
    writeFilePrivate(secretFilePath(this.dir, nodeId), JSON.stringify(stored));
  }

  getNodeSecret(nodeId: string): SecretBundle | null {
    const file = secretFilePath(this.dir, nodeId);
    if (!fs.existsSync(file)) return null;
    let stored: StoredSecretFile;
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredSecretFile;
    } catch {
      throw new Error(`vault: 节点 ${nodeId} 的密钥文件损坏`);
    }
    let plain: string;
    if (stored.provider === 'safestorage') {
      if (!this.safeStorage) {
        throw new Error(
          `vault: 节点 ${nodeId} 的密钥由钥匙串加密，当前环境钥匙串不可用（换机器/钥匙串被清请用导出文件恢复）`,
        );
      }
      try {
        plain = this.safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
      } catch {
        throw new Error(`vault: 节点 ${nodeId} 的密钥解密失败（钥匙串不匹配）`);
      }
    } else if (stored.provider === 'aes-gcm') {
      plain = aesGcmDecrypt(this.masterKey(), {
        enc: 'aes-gcm',
        iv: stored.iv ?? '',
        data: stored.data,
      });
    } else {
      throw new Error(`vault: 节点 ${nodeId} 的密钥加密方式未知 "${String(stored.provider)}"`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plain);
    } catch {
      throw new Error(`vault: 节点 ${nodeId} 的密钥内容损坏`);
    }
    if (!isSecretBundle(parsed)) throw new Error(`vault: 节点 ${nodeId} 的密钥内容损坏`);
    return parsed;
  }

  deleteNodeSecret(nodeId: string): void {
    try {
      fs.rmSync(secretFilePath(this.dir, nodeId), { force: true });
    } catch {
      // 删除幂等：失败即视为不存在。
    }
  }

  // -- 导出 / 导入（约定加密，密码永不明文） -------------------------------

  exportEncrypted(entries: Array<{ meta: NodeMeta; secret: SecretBundle }>): ExportJSON {
    if (!Array.isArray(entries)) throw new Error('vault: 导出条目必须为数组');
    const key = this.masterKey();
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      nodes: entries.map(({ meta, secret }) => {
        if (!meta || typeof meta.id !== 'string') throw new Error('vault: 导出条目缺少合法 meta.id');
        return {
          meta,
          secretsEnc: aesGcmEncrypt(key, JSON.stringify(secret ?? {})),
        };
      }),
    };
  }

  importDecrypted(doc: ExportJSON): Array<{ meta: NodeMeta; secret: SecretBundle }> {
    if (!doc || typeof doc !== 'object') throw new Error('vault: 导入文件不是合法 JSON 对象');
    if ((doc as ExportJSON).version !== 1) {
      throw new Error(`vault: 不支持的导出版本 "${String((doc as { version?: unknown }).version)}"（仅支持 v1）`);
    }
    if (!Array.isArray((doc as ExportJSON).nodes)) throw new Error('vault: 导入文件缺少 nodes 数组');
    const key = this.masterKey();
    return (doc as ExportJSON).nodes.map((entry, i) => {
      const meta = (entry as { meta?: unknown }).meta;
      const secretsEnc = (entry as { secretsEnc?: unknown }).secretsEnc;
      if (!meta || typeof (meta as NodeMeta).id !== 'string' || !(meta as NodeMeta).host) {
        throw new Error(`vault: 导入文件第 ${i + 1} 个节点元数据非法`);
      }
      const plain = aesGcmDecrypt(key, secretsEnc as SecretsEnc);
      let secret: unknown;
      try {
        secret = JSON.parse(plain);
      } catch {
        throw new Error(`vault: 导入文件第 ${i + 1} 个节点密钥损坏`);
      }
      if (!isSecretBundle(secret)) throw new Error(`vault: 导入文件第 ${i + 1} 个节点密钥损坏`);
      return { meta: meta as NodeMeta, secret };
    });
  }
}

// ---------------------------------------------------------------------------
// 老 CLI 连接串导入（兼容 mysqldiff/Tools.js dbConfig + mysqldiff/DB.js SSH 解析）
// ---------------------------------------------------------------------------

export interface LegacyConnectionStringResult {
  meta: NodeMeta;
  secret: SecretBundle;
}

interface LegacyDbPart {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

interface LegacySshPart {
  host: string;
  port: number;
  user: string;
  password: string;
}

function parsePort(raw: string, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback;
}

/** 逐字兼容 Tools.js dbConfig 的分隔符语义：user:pass@host~db#port。 */
function parseLegacyDbPart(config: string): LegacyDbPart {
  const index1 = config.indexOf(':');
  const index2 = config.lastIndexOf('@');
  const index3 = config.lastIndexOf('~');
  let index4 = config.lastIndexOf('#');
  if (index1 === -1 || index2 === -1 || index3 === -1) {
    throw new Error('vault: 数据库连接串格式错误（期望 user:pass@host~db#port）');
  }
  if (index4 === -1 || index4 < index2) index4 = config.length;
  const user = config.substring(0, index1);
  const password = config.substring(index1 + 1, index2);
  const host = config.substring(index2 + 1, index3);
  const database = config.substring(index3 + 1, index4);
  if (!user || !host || !database) {
    throw new Error('vault: 数据库连接串缺少 user/host/database');
  }
  return { host, port: parsePort(config.substring(index4 + 1), 3306), user, password, database };
}

/**
 * 兼容 DB.js initSSHConfig 的分隔符语义：sshuser:sshpass@sshhost#sshport。
 * 与老实现有一处刻意偏离：老实现取 host 时未剔除 `#port` 后缀
 * （`substring(index2+1)` 会把 `#sshport` 带进 host），此处按正确语义截断，
 * 老 host 形如 `sshhost#22` 的请手动修正。
 */
function parseLegacySshPart(config: string): LegacySshPart | null {
  if (!config) return null;
  const index1 = config.indexOf(':');
  const index2 = config.lastIndexOf('@');
  let index3 = config.lastIndexOf('#');
  if (index1 === -1 || index2 === -1) {
    throw new Error('vault: SSH 连接串格式错误（期望 sshuser:sshpass@sshhost#sshport）');
  }
  if (index3 === -1 || index3 < index2) index3 = config.length;
  const user = config.substring(0, index1);
  const password = config.substring(index1 + 1, index2);
  const host = config.substring(index2 + 1, index3);
  if (!user || !host) throw new Error('vault: SSH 连接串缺少 user/host');
  return { host, port: parsePort(config.substring(index3 + 1), 22), user, password };
}

/**
 * 老 CLI 连接串 → { meta, secret }。
 * 完整格式：`user:pass@host~db#port+sshuser:sshpass@sshhost#sshport`（`+` 后 SSH 段可选）。
 * 已知限制（与老实现一致）：user 段不允许含 `:`；password 若含 `@`/`~`/`#` 可能切错位——
 * 特殊字符密码请走节点表单字段创建（结构化保存，不再拼串），本函数仅做老串迁移。
 */
export function parseLegacyConnectionString(oldStr: string, alias?: string): LegacyConnectionStringResult {
  if (typeof oldStr !== 'string' || oldStr.length === 0) {
    throw new Error('vault: 连接串为空');
  }
  const src = oldStr.trim();
  const plusIdx = src.indexOf('+');
  const dbPart = plusIdx === -1 ? src : src.slice(0, plusIdx);
  const sshPart = plusIdx === -1 ? '' : src.slice(plusIdx + 1);
  const db = parseLegacyDbPart(dbPart);
  const ssh = parseLegacySshPart(sshPart);
  return {
    meta: {
      id: randomUUID(),
      alias: alias?.trim() || `${db.user}@${db.host}/${db.database}`,
      host: db.host,
      port: db.port,
      user: db.user,
      database: db.database,
      ssh: ssh
        ? { enabled: true, host: ssh.host, port: ssh.port, user: ssh.user, authType: 'password' }
        : { enabled: false, host: '', port: 22, user: '', authType: 'password' },
      createdAt: new Date().toISOString(),
    },
    secret: ssh ? { password: db.password, sshPassword: ssh.password } : { password: db.password },
  };
}

/** connStringImporter：dispatch 命名别名，与 parseLegacyConnectionString 同义。 */
export const connStringImporter = parseLegacyConnectionString;
