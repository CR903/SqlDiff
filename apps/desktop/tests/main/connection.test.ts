// M3 单测：隧道配置生成（host/port/user/auth）+ 端口随机 + 隧道复用/关闭。
// 无需真实 DB/SSH：只覆盖纯函数与缓存逻辑；建连路径由手工冒烟覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'mysql2/promise';
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
  testConnection,
  type TunnelEntry,
} from '../../src-main/connection';
import type { NodeMeta, SecretBundle } from '../../src-core/types';

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

// ---------------------------------------------------------------------------
// testConnection —— 连接冒烟（10-05-unit-test-gap-landing R5）
//
// 契约：永不 throw，失败以 {ok:false, code, message} 返回（UI 直接展示）。
// 覆盖成功 + 失败路径，并锁住「ConnectionError 的 code 原样透传」——
// 这是 UI 区分「密码错」与「网络不通」的依据，吞掉就退化成一句无信息的报错。
//
// mock 纪律：mysql2/promise 的 createConnection 被模块级 mock 替换，
// 绝不真实 TCP 连接（会慢、不稳定，且可能真去连 .env.e2e 里的机器）。
// ---------------------------------------------------------------------------

vi.mock('mysql2/promise', () => ({
  createConnection: vi.fn(),
  createPool: vi.fn(),
}));

// ssh2 一并 mock：ensureTunnel 会真去拨号，不 mock 会拖慢测试并真的连出去。
// Client 构造后 connect() 立刻 emit 'error'，模拟握手失败。
vi.mock('ssh2', () => ({
  Client: class {
    private readonly handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    once(event: string, cb: (arg?: unknown) => void): this {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    connect(): this {
      queueMicrotask(() => {
        for (const cb of this.handlers.error ?? []) cb(new Error('mock ssh handshake refused'));
      });
      return this;
    }
    end(): void {
      /* 忽略 */
    }
  },
}));

/** 构造一个行为可控的假连接对象。 */
function fakeConn(opts: { query?: () => Promise<unknown>; end?: () => Promise<unknown> } = {}): {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(opts.query ?? (() => Promise.resolve([[{ 1: 1 }]]))),
    end: vi.fn(opts.end ?? (() => Promise.resolve(undefined))),
  };
}

describe('testConnection', () => {
  beforeEach(() => {
    __testClearTunnels();
    vi.mocked(createConnection).mockReset();
  });

  afterEach(() => {
    __testClearTunnels();
  });

  it('直连成功 → ok:true，带 ms，不含 code', async () => {
    const conn = fakeConn();
    vi.mocked(createConnection).mockResolvedValue(conn as never);
    const r = await testConnection(baseNode({ host: '10.0.0.5' }), { password: 'pw' });
    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.code).toBeUndefined();
  });

  it('直连成功时执行的是 SELECT 1，且连接被关闭（无连接泄漏）', async () => {
    const conn = fakeConn();
    vi.mocked(createConnection).mockResolvedValue(conn as never);
    await testConnection(baseNode({ host: '10.0.0.5' }), {});
    expect(conn.query).toHaveBeenCalledWith('SELECT 1');
    expect(conn.end).toHaveBeenCalledTimes(1);
  });

  it('连接失败 → ok:false，code=MYSQL_CONNECT，不 throw', async () => {
    vi.mocked(createConnection).mockRejectedValue(new Error('ECONNREFUSED') as never);
    const r = await testConnection(baseNode({ host: '10.0.0.5' }), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('MYSQL_CONNECT');
    expect(r.message).toContain('ECONNREFUSED');
    expect(typeof r.ms).toBe('number');
  });

  it('查询失败 → code 仍为 MYSQL_CONNECT，且连接被关闭', async () => {
    const conn = fakeConn({ query: () => Promise.reject(new Error('ER_ACCESS_DENIED')) });
    vi.mocked(createConnection).mockResolvedValue(conn as never);
    const r = await testConnection(baseNode({ host: '10.0.0.5' }), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('MYSQL_CONNECT');
    expect(r.message).toContain('ER_ACCESS_DENIED');
    expect(conn.end).toHaveBeenCalledTimes(1);
  });

  it('conn.end 抛错不掩盖原始失败结果（cleanup 不吞 verdict）', async () => {
    const conn = fakeConn({
      query: () => Promise.reject(new Error('ER_ACCESS_DENIED')),
      end: () => Promise.reject(new Error('close boom')),
    });
    vi.mocked(createConnection).mockResolvedValue(conn as never);
    const r = await testConnection(baseNode({ host: '10.0.0.5' }), {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ER_ACCESS_DENIED');
    expect(r.message).not.toContain('close boom');
  });

  it('createConnection 抛非 Error 值 → 仍被 Error 化并归 MYSQL_CONNECT', async () => {
    vi.mocked(createConnection).mockImplementation((): never => {
      // 故意抛非 Error 值，验证 testConnection 把任意抛出值归一为结构化结果
      throw 'plain string failure';
    });
    const r = await testConnection(baseNode({ host: '10.0.0.5' }), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('MYSQL_CONNECT');
    expect(r.message).toContain('plain string failure');
  });

  it('ssh 配置非法（enabled 但缺 ssh.host）→ SSH_CONFIG，且不建连', async () => {
    const node = baseNode({
      ssh: { enabled: true, host: '', port: 22, user: 'u', authType: 'password' },
    });
    const r = await testConnection(node, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SSH_CONFIG');
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('节点缺 host → BAD_NODE，且不建连（validateNode 前置）', async () => {
    const r = await testConnection(baseNode({ host: '' }), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BAD_NODE');
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('节点缺 user / database → BAD_NODE，不建连', async () => {
    expect((await testConnection(baseNode({ user: '' }), {})).code).toBe('BAD_NODE');
    expect((await testConnection(baseNode({ database: '' }), {})).code).toBe('BAD_NODE');
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('SSH 握手失败 → ok:false，code=SSH_CONNECT，不 throw', async () => {
    const node = baseNode({
      ssh: { enabled: true, host: 'ssh.invalid', port: 22, user: 'u', authType: 'password' },
    });
    const r = await testConnection(node, {}).catch((e: unknown) => e);
    expect(r).toBeTypeOf('object');
    expect(r).not.toBeNull();
    const res = r as { ok: boolean; ms: number; code?: string; message?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SSH_CONNECT');
    expect(res.message).toContain('mock ssh handshake refused');
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('SSH 节点命中缓存隧道 → 走本地端口，且隧道保留复用（不关）', async () => {
    const entry = fakeTunnel(33455);
    __testRegisterTunnel('n1', entry);
    const conn = fakeConn();
    vi.mocked(createConnection).mockResolvedValue(conn as never);
    const node = baseNode({
      ssh: { enabled: true, host: 'h', port: 22, user: 'u', authType: 'password' },
    });
    const r = await testConnection(node, {});
    expect(r.ok).toBe(true);
    expect(vi.mocked(createConnection).mock.calls[0][0]).toMatchObject({
      host: '127.0.0.1',
      port: 33455,
    });
    // 隧道保留复用：testConnection 不关缓存隧道
    expect(listTunnels()).toEqual([{ nodeId: 'n1', localPort: 33455 }]);
  });

  it('ssh.enabled=false 时走直连（不建隧道）', async () => {
    const conn = fakeConn();
    vi.mocked(createConnection).mockResolvedValue(conn as never);
    const r = await testConnection(baseNode({ ssh: { enabled: false, host: 'x', port: 22, user: 'u', authType: 'password' } }), {});
    expect(r.ok).toBe(true);
    expect(listTunnels()).toEqual([]);
    expect(vi.mocked(createConnection).mock.calls[0][0]).toMatchObject({ host: 'db.internal' });
  });
});
