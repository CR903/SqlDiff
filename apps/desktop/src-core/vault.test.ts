import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  loadHistory,
  loadNodes,
  saveNodes,
} from '../src-main/store-json';
import {
  connStringImporter,
  parseLegacyConnectionString,
  Vault,
  type SafeStorageLike,
} from '../src-main/vault';
import type { HistoryEntry, NodeMeta, SecretBundle } from './types';

// M2 单测：加密往返 + 导出导入往返 + 老串解析 + 历史截断。
// 说明：特殊字符密码走结构化 SecretBundle 表单字段（不拼连接串），
// 老串解析器仅做迁移兼容（含 Tools.js 已知分隔符限制，见 vault.ts 注释）。

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqldiff-m2-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeMeta(id: string, alias = `node-${id}`): NodeMeta {
  return {
    id,
    alias,
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: 'shop',
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: new Date().toISOString(),
  };
}

/** 伪 safeStorage：前缀编码，模拟"钥匙串可用"通道（不依赖 Electron）。 */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`fake:${plain}`, 'utf8'),
  decryptString: (enc: Buffer) => {
    const s = enc.toString('utf8');
    if (!s.startsWith('fake:')) throw new Error('fake keychain mismatch');
    return s.slice('fake:'.length);
  },
};

const SPECIAL_SECRET: SecretBundle = {
  // 特殊字符密码：结构化保存，不拼串。
  password: `p@ss:w~o#r+d&%x!'`,
  sshPassword: 'ssh:p@ss#1',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----',
  passphrase: 'pp:~~##',
};

describe('vault 加密往返（AES-GCM 回退）', () => {
  it('save/get 往返一致，落盘无明文', () => {
    const dir = makeTmp();
    const vault = new Vault({ userDataDir: dir });
    expect(vault.provider).toBe('aes-gcm');
    vault.saveNodeSecret('n1', SPECIAL_SECRET);
    expect(vault.getNodeSecret('n1')).toEqual(SPECIAL_SECRET);

    const stored = fs.readFileSync(path.join(dir, 'secrets', 'n1.json'), 'utf8');
    expect(stored).not.toContain(SPECIAL_SECRET.password as string);

    vault.deleteNodeSecret('n1');
    expect(vault.getNodeSecret('n1')).toBeNull();
  });

  it('未知节点返回 null，非法 nodeId 抛错', () => {
    const vault = new Vault({ userDataDir: makeTmp() });
    expect(vault.getNodeSecret('nope')).toBeNull();
    expect(() => vault.saveNodeSecret('../evil', {})).toThrow(/非法 nodeId/);
  });
});

describe('vault 加密往返（safeStorage 通道）', () => {
  it('save/get 往返一致', () => {
    const vault = new Vault({ userDataDir: makeTmp(), safeStorage: fakeSafeStorage });
    expect(vault.provider).toBe('safestorage');
    vault.saveNodeSecret('n1', SPECIAL_SECRET);
    expect(vault.getNodeSecret('n1')).toEqual(SPECIAL_SECRET);
  });
});

describe('vault 导出导入往返', () => {
  it('导出 version=1 + aes-gcm 段无明文，导入恢复免重输', () => {
    const dir = makeTmp();
    const vault = new Vault({ userDataDir: dir });
    const entries = [
      { meta: makeMeta('n1', 'prod-主库'), secret: SPECIAL_SECRET },
      { meta: makeMeta('n2', '本地-dev'), secret: { password: 'devpw' } },
    ];
    const doc = vault.exportEncrypted(entries);

    expect(doc.version).toBe(1);
    expect(doc.nodes).toHaveLength(2);
    for (const n of doc.nodes) {
      expect(n.secretsEnc.enc).toBe('aes-gcm');
      expect(typeof n.secretsEnc.iv).toBe('string');
      expect(typeof n.secretsEnc.data).toBe('string');
    }
    // 模拟"导出文件落盘再读回"：走一遍 JSON 序列化。
    const wire = JSON.stringify(doc);
    expect(wire).not.toContain(SPECIAL_SECRET.password as string);
    const revived = JSON.parse(wire) as typeof doc;

    const restored = new Vault({ userDataDir: dir }).importDecrypted(revived);
    expect(restored).toHaveLength(2);
    expect(restored[0]?.meta.alias).toBe('prod-主库');
    expect(restored[0]?.secret).toEqual(SPECIAL_SECRET);
    expect(restored[1]?.secret).toEqual({ password: 'devpw' });
  });

  it('换目录（主密钥不同）导入失败且可诊断', () => {
    const vault = new Vault({ userDataDir: makeTmp() });
    const doc = vault.exportEncrypted([{ meta: makeMeta('n1'), secret: { password: 'x' } }]);
    expect(() => new Vault({ userDataDir: makeTmp() }).importDecrypted(doc)).toThrow(/解密失败/);
  });

  it('非法版本/形状抛错', () => {
    const vault = new Vault({ userDataDir: makeTmp() });
    expect(() => vault.importDecrypted({ version: 2, nodes: [] } as never)).toThrow(/不支持的导出版本/);
    expect(() => vault.importDecrypted({ version: 1 } as never)).toThrow(/缺少 nodes 数组/);
  });
});

describe('老连接串解析（兼容 Tools.js:10-31）', () => {
  it('基本格式 user:pass@host~db#port', () => {
    const { meta, secret } = parseLegacyConnectionString('root:secret@127.0.0.1~shop#3306');
    expect(meta.host).toBe('127.0.0.1');
    expect(meta.port).toBe(3306);
    expect(meta.user).toBe('root');
    expect(meta.database).toBe('shop');
    expect(meta.ssh.enabled).toBe(false);
    expect(secret).toEqual({ password: 'secret' });
    expect(meta.alias).toContain('root');
  });

  it('SSH 段解析 + 默认端口（db 3306 / ssh 22）', () => {
    const { meta, secret } = parseLegacyConnectionString('root:pw@dbhost~shopdb+admin:sshpass@10.0.0.1');
    expect(meta.port).toBe(3306);
    expect(meta.ssh).toMatchObject({ enabled: true, host: '10.0.0.1', port: 22, user: 'admin' });
    expect(secret).toEqual({ password: 'pw', sshPassword: 'sshpass' });

    const withSshPort = parseLegacyConnectionString('root:pw@dbhost~shopdb#3307+admin:sp@10.0.0.1#2222');
    expect(withSshPort.meta.port).toBe(3307);
    expect(withSshPort.meta.ssh.port).toBe(2222);
  });

  it('密码含 : # $ 等特殊字符可还原', () => {
    const { secret } = parseLegacyConnectionString('root:p:a#s$s!@127.0.0.1~shop');
    expect(secret.password).toBe('p:a#s$s!');
  });

  it('connStringImporter 为同义别名，非法串抛错', () => {
    expect(connStringImporter).toBe(parseLegacyConnectionString);
    expect(() => parseLegacyConnectionString('')).toThrow(/为空/);
    expect(() => parseLegacyConnectionString('rootonly')).toThrow(/格式错误/);
    expect(() => parseLegacyConnectionString('a:b')).toThrow(/格式错误/);
    expect(() => parseLegacyConnectionString('root:pw@host~db+badssh')).toThrow(/SSH/);
  });
});

describe('store-json nodes/history', () => {
  it('nodes 读写往返，缺失文件返回空数组', () => {
    const dir = makeTmp();
    expect(loadNodes(dir)).toEqual([]);
    saveNodes(dir, [makeMeta('n1'), makeMeta('n2')]);
    expect(loadNodes(dir).map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('历史只留 20 条，新条置顶', () => {
    const dir = makeTmp();
    for (let i = 1; i <= 25; i++) {
      const entry: HistoryEntry = {
        id: `h${i}`,
        at: new Date(Date.UTC(2026, 8, 21, 0, 0, i)).toISOString(),
        aAlias: 'A库',
        bAlias: 'B库',
        diffCount: i,
      };
      appendHistory(dir, entry);
    }
    const list = loadHistory(dir);
    expect(list).toHaveLength(20);
    expect(list[0]?.id).toBe('h25');
    expect(list[19]?.id).toBe('h6');
  });
});
