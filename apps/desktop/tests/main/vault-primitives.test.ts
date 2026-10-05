// 补测（10-04-test-gap-backfill R1/R2/R3）：loadOrCreateMasterKey / aesGcmEncrypt / aesGcmDecrypt / assertSafeNodeId。
// vault.test.ts 已经把 Vault 类整体走通，但四个导出原语此前零直测——其中
// assertSafeNodeId 是 secrets/<nodeId>.json 的路径拼接防线（nodeId 直接进 path.join），
// AES-GCM 原语是导出/导入与本地回退加密的共同底座，故各自独立断言（含错误路径）。
//
// 安全约束：本文件只出现假值（假主密钥、假口令占位），不涉及任何真实凭据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  assertSafeNodeId,
  encryptedMasterKeyPath,
  loadOrCreateMasterKey,
  MASTER_KEY_BYTES,
  masterKeyPath,
  type SafeStorageLike,
} from '../../src-main/vault';

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqldiff-vault-prim-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

/** 伪 safeStorage：前缀编码，模拟「钥匙串可用」通道（不依赖 Electron）。 */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`fake:${plain}`, 'utf8'),
  decryptString: (enc: Buffer) => {
    const s = enc.toString('utf8');
    if (!s.startsWith('fake:')) throw new Error('fake keychain mismatch');
    return s.slice('fake:'.length);
  },
};

const TEST_KEY = randomBytes(MASTER_KEY_BYTES);
const FAKE_SECRET = 'fake-pass-not-a-real-secret';

describe('loadOrCreateMasterKey', () => {
  it('无 safeStorage：首次生成 32 字节密钥落盘，再次读取返回同一把', () => {
    const dir = makeTmp();
    const k1 = loadOrCreateMasterKey(dir);
    expect(k1.length).toBe(MASTER_KEY_BYTES);
    expect(fs.existsSync(masterKeyPath(dir))).toBe(true);
    expect(fs.existsSync(encryptedMasterKeyPath(dir))).toBe(false);

    const k2 = loadOrCreateMasterKey(dir);
    expect(k2.equals(k1)).toBe(true);
  });

  it('safeStorage 可用：只落 .masterkey.enc（明文 .masterkey 不落盘），重启后可解回同一把', () => {
    const dir = makeTmp();
    const k1 = loadOrCreateMasterKey(dir, fakeSafeStorage);
    expect(fs.existsSync(encryptedMasterKeyPath(dir))).toBe(true);
    expect(fs.existsSync(masterKeyPath(dir))).toBe(false);
    // 钥匙串文件里只有加密后的 hex，不是明文密钥。
    const stored = Buffer.from(fs.readFileSync(encryptedMasterKeyPath(dir), 'utf8').trim(), 'base64').toString('utf8');
    expect(stored).toContain(`fake:${k1.toString('hex')}`);
    expect(fs.readFileSync(encryptedMasterKeyPath(dir), 'utf8')).not.toContain(k1.toString('hex'));

    // 模拟重启：从钥匙串解回同一把密钥。
    const k2 = loadOrCreateMasterKey(dir, fakeSafeStorage);
    expect(k2.equals(k1)).toBe(true);
  });

  it('已有 .masterkey 且 safeStorage 可用 → 升级为钥匙串副本，仍返回原密钥', () => {
    const dir = makeTmp();
    const first = loadOrCreateMasterKey(dir);
    const upgraded = loadOrCreateMasterKey(dir, fakeSafeStorage);
    expect(upgraded.equals(first)).toBe(true);
    expect(fs.existsSync(encryptedMasterKeyPath(dir))).toBe(true);
  });

  it('已有密钥长度不对 → 覆盖重建为 32 字节（不返回半截密钥）', () => {
    const dir = makeTmp();
    fs.writeFileSync(masterKeyPath(dir), Buffer.alloc(16, 7));
    const k = loadOrCreateMasterKey(dir);
    expect(k.length).toBe(MASTER_KEY_BYTES);
    expect(k.equals(Buffer.alloc(16, 7))).toBe(false);
  });

  it('safeStorage 抛错 → 降级本地文件（不因钥匙串故障而无法启动）', () => {
    const dir = makeTmp();
    const broken: SafeStorageLike = {
      isEncryptionAvailable: () => {
        throw new Error('keychain locked');
      },
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    };
    const k = loadOrCreateMasterKey(dir, broken);
    expect(k.length).toBe(MASTER_KEY_BYTES);
    expect(fs.existsSync(masterKeyPath(dir))).toBe(true);
    expect(fs.existsSync(encryptedMasterKeyPath(dir))).toBe(false);
  });
});

describe('aesGcmEncrypt / aesGcmDecrypt', () => {
  it('往返一致（中文 / 特殊字符 / 多行）', () => {
    const plain = `{"password":"${FAKE_SECRET}","note":"中文 · 引号 \\" 与换行\n第二行"}`;
    const enc = aesGcmEncrypt(TEST_KEY, plain);
    expect(enc.enc).toBe('aes-gcm');
    expect(aesGcmDecrypt(TEST_KEY, enc)).toBe(plain);
  });

  it('同一明文两次加密密文不同（iv 随机），但都能解回原文', () => {
    const a = aesGcmEncrypt(TEST_KEY, FAKE_SECRET);
    const b = aesGcmEncrypt(TEST_KEY, FAKE_SECRET);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
    expect(aesGcmDecrypt(TEST_KEY, a)).toBe(FAKE_SECRET);
    expect(aesGcmDecrypt(TEST_KEY, b)).toBe(FAKE_SECRET);
  });

  it('密文不含明文片段（iv / data 均为 base64，无原文泄漏）', () => {
    const enc = aesGcmEncrypt(TEST_KEY, FAKE_SECRET);
    expect(enc.iv).not.toContain(FAKE_SECRET);
    expect(enc.data).not.toContain(FAKE_SECRET);
    expect(Buffer.from(enc.data, 'base64').toString('utf8')).not.toContain(FAKE_SECRET);
  });

  it('错误密钥解密抛错（换机器导入场景）', () => {
    const enc = aesGcmEncrypt(TEST_KEY, FAKE_SECRET);
    const other = randomBytes(MASTER_KEY_BYTES);
    expect(() => aesGcmDecrypt(other, enc)).toThrow(/解密失败/);
  });

  it('密文被篡改抛错（GCM tag 校验）', () => {
    const enc = aesGcmEncrypt(TEST_KEY, FAKE_SECRET);
    const raw = Buffer.from(enc.data, 'base64');
    raw[0] = raw[0] ^ 0xff;
    expect(() => aesGcmDecrypt(TEST_KEY, { ...enc, data: raw.toString('base64') })).toThrow(/解密失败/);
  });

  it('非法信封：enc 非 aes-gcm / iv 长度错 / data 截断 / 密钥长度错，各自带明确报错', () => {
    const enc = aesGcmEncrypt(TEST_KEY, FAKE_SECRET);
    expect(() => aesGcmDecrypt(TEST_KEY, { ...enc, enc: 'plain' as 'aes-gcm' })).toThrow(/不支持的密钥加密方式/);
    expect(() => aesGcmDecrypt(TEST_KEY, { ...enc, iv: Buffer.alloc(8).toString('base64') })).toThrow(/加密段损坏/);
    expect(() => aesGcmDecrypt(TEST_KEY, { ...enc, data: Buffer.alloc(4).toString('base64') })).toThrow(/加密段损坏/);
    expect(() => aesGcmEncrypt(Buffer.alloc(16), FAKE_SECRET)).toThrow(/主密钥长度错误/);
    expect(() => aesGcmDecrypt(Buffer.alloc(16), enc)).toThrow(/主密钥长度错误/);
  });
});

describe('assertSafeNodeId：路径穿越与非法字符', () => {
  it('拒绝路径穿越形态（../ 上跳、嵌套分隔符、绝对路径）', () => {
    for (const bad of ['../etc/passwd', '..', 'a/b', 'a\\b', '/abs/path', 'secrets/../../x']) {
      expect(() => assertSafeNodeId(bad)).toThrow(/非法 nodeId/);
    }
  });

  it('拒绝空串 / 超长 / 非字符串（>128 字符与 undefined）', () => {
    expect(() => assertSafeNodeId('')).toThrow(/非法 nodeId/);
    expect(() => assertSafeNodeId('a'.repeat(129))).toThrow(/非法 nodeId/);
    expect(() => assertSafeNodeId(undefined as unknown as string)).toThrow(/非法 nodeId/);
    expect(() => assertSafeNodeId(123 as unknown as string)).toThrow(/非法 nodeId/);
  });

  it('拒绝路径分隔符以外的非法字符（点、空格、引号）', () => {
    for (const bad of ['a.b', 'a b', "a'b", 'a$b', 'n;rm', 'a:b']) {
      expect(() => assertSafeNodeId(bad)).toThrow(/非法 nodeId/);
    }
  });

  it('放行合法 id（字母数字 / 下划线 / 连字符，1–128 字符）', () => {
    for (const ok of ['a', 'n-prod', 'node_1', 'ABC-123_x', 'a'.repeat(128)]) {
      expect(() => assertSafeNodeId(ok)).not.toThrow();
    }
  });

  it('边界 128 字符放行 / 129 字符拒绝（长度上限精确）', () => {
    expect(() => assertSafeNodeId('x'.repeat(128))).not.toThrow();
    expect(() => assertSafeNodeId('x'.repeat(129))).toThrow(/非法 nodeId/);
  });
});