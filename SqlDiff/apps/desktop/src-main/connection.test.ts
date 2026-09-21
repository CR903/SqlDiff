// M3 单测：隧道配置生成（host/port/user/auth）+ 端口随机 + 隧道复用/关闭。
// 无需真实 DB/SSH：只覆盖纯函数与缓存逻辑；建连路径由手工冒烟覆盖。

import { describe, expect, it } from 'vitest';
import {
  __testClearTunnels,
  __testRegisterTunnel,
  buildMysqlConfig,
  buildSshConnectConfig,
  closeAll,
  closeTunnel,
  ensureTunnel,
  listTunnels,
  pickRandomPort,
  RAND_PORT_MAX,
  RAND_PORT_MIN,
  resolveMysqlEndpoint,
  type TunnelEntry,
} from './connection';
import type { NodeMeta, SecretBundle } from '../src-core/types';

function baseNode(overrides: Partial<NodeMeta> = {}): NodeMeta {
  return {
    id: 'n1',
    alias: '本地库',
    host: 'db.internal',
    port: 3306,
    user: 'root',
    database: 'shop',
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function fakeTunnel(port: number): TunnelEntry {
  return {
    client: { end: () => undefined },
    server: {
      close: (cb?: (err?: Error) => void) => {
        if (cb) cb();
        return undefined;
      },
    },
    localPort: port,
  };
}

describe('pickRandomPort', () => {
  it('落在老 Tools.randPort 区间 [32000, 35000]', () => {
    for (let i = 0; i < 200; i += 1) {
      const p = pickRandomPort();
      expect(p).toBeGreaterThanOrEqual(RAND_PORT_MIN);
      expect(p).toBeLessThanOrEqual(RAND_PORT_MAX);
      expect(Number.isInteger(p)).toBe(true);
    }
    expect(RAND_PORT_MIN).toBe(32_000);
    expect(RAND_PORT_MAX).toBe(35_000);
  });

  it('多次调用不恒为同一值（随机性）', () => {
    const got = new Set<number>();
    for (let i = 0; i < 50; i += 1) got.add(pickRandomPort());
    expect(got.size).toBeGreaterThan(1);
  });

  it('非法区间抛错', () => {
    expect(() => pickRandomPort(0, -1)).toThrow();
    expect(() => pickRandomPort(40000, 30000)).toThrow();
  });
});

describe('buildSshConnectConfig', () => {
  it('密码认证：host/port/user/password 映射正确', () => {
    const node = baseNode({
      ssh: { enabled: true, host: 'ssh.example.com', port: 2222, user: 'deploy', authType: 'password' },
    });
    const secret: SecretBundle = { sshPassword: 's3cret' };
    const cfg = buildSshConnectConfig(node, secret);
    expect(cfg.host).toBe('ssh.example.com');
    expect(cfg.port).toBe(2222);
    expect(cfg.username).toBe('deploy');
    expect(cfg.password).toBe('s3cret');
    expect(cfg.privateKey).toBeUndefined();
  });

  it('密钥认证：privateKey + passphrase 映射正确', () => {
    const node = baseNode({
      ssh: { enabled: true, host: 'ssh.example.com', port: 22, user: 'deploy', authType: 'privateKey' },
    });
    const secret: SecretBundle = { privateKey: '-----BEGIN KEY-----', passphrase: 'pp' };
    const cfg = buildSshConnectConfig(node, secret);
    expect(cfg.privateKey).toBe('-----BEGIN KEY-----');
    expect(cfg.passphrase).toBe('pp');
    expect(cfg.password).toBeUndefined();
  });

  it('缺私钥时抛 SSH_CONFIG（不静默连）', () => {
    const node = baseNode({
      ssh: { enabled: true, host: 'h', port: 22, user: 'u', authType: 'privateKey' },
    });
    expect(() => buildSshConnectConfig(node, {})).toThrowError(/私钥/);
  });

  it('缺 ssh.host/ssh.user 时抛 SSH_CONFIG', () => {
    const noHost = baseNode({ ssh: { enabled: true, host: '', port: 22, user: 'u', authType: 'password' } });
    expect(() => buildSshConnectConfig(noHost, {})).toThrowError(/ssh\.host/);
    const noUser = baseNode({ ssh: { enabled: true, host: 'h', port: 22, user: '', authType: 'password' } });
    expect(() => buildSshConnectConfig(noUser, {})).toThrowError(/ssh\.user/);
  });
});

describe('buildMysqlConfig / resolveMysqlEndpoint', () => {
  it('直连：保持节点 host/port（老 DB.js 无隧道分支）', () => {
    const node = baseNode({ host: '10.0.0.5', port: 3307 });
    const cfg = buildMysqlConfig(node, { password: 'pw' });
    expect(cfg.host).toBe('10.0.0.5');
    expect(cfg.port).toBe(3307);
    expect(cfg.user).toBe('root');
    expect(cfg.password).toBe('pw');
    expect(cfg.database).toBe('shop');
    expect(resolveMysqlEndpoint(node)).toEqual({ host: '10.0.0.5', port: 3307 });
  });

  it('经隧道：host 改写 127.0.0.1 + 本地端口（老 DB.js:37 同语义）', () => {
    const node = baseNode({ host: 'db.internal', port: 3306 });
    const cfg = buildMysqlConfig(node, { password: 'pw' }, 33441);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(33441);
    // DB 账密不变，只换 endpoint
    expect(cfg.user).toBe('root');
    expect(cfg.database).toBe('shop');
    expect(resolveMysqlEndpoint(node, 33441)).toEqual({ host: '127.0.0.1', port: 33441 });
  });
});

describe('隧道复用 Map', () => {
  it('ensureTunnel 命中缓存时不建连（返回同一 entry）', async () => {
    __testClearTunnels();
    const entry = fakeTunnel(33311);
    __testRegisterTunnel('n1', entry);
    const node = baseNode({ id: 'n1', ssh: { enabled: true, host: 'h', port: 22, user: 'u', authType: 'password' } });
    await expect(ensureTunnel(node, {})).resolves.toBe(entry);
    expect(listTunnels()).toEqual([{ nodeId: 'n1', localPort: 33311 }]);
    __testClearTunnels();
  });

  it('closeTunnel 只关指定节点（幂等）', async () => {
    __testClearTunnels();
    __testRegisterTunnel('a', fakeTunnel(33311));
    __testRegisterTunnel('b', fakeTunnel(33312));
    await closeTunnel('a');
    expect(listTunnels()).toEqual([{ nodeId: 'b', localPort: 33312 }]);
    await closeTunnel('a'); // 重复关不抛
    await closeAll();
    expect(listTunnels()).toEqual([]);
  });
});
