// M3 连接层：mysql2/promise 直连 + ssh2 单跳隧道（密码 / 私钥+passphrase）。
//
// 对应老语义 `mysqldiff/DB.js:8-39`：
// - 无 SSH → mysql 直连（host/port/user/password/database）。
// - 有 SSH → 先建隧道（老实现调 expect 脚本 `ssh -f -N -L <随机本地端口>:<dbHost>:<dbPort>`），
//   再把 DB host 改写为 127.0.0.1 + 随机本地端口。本文件用 `ssh2` 实现同样语义，
//   因此 Windows 可用（老 `README.md:37` 明确 ssh 不支持 Windows，本次换掉）。
// - 随机本地端口沿用老范围（`Tools.js:35-37` randPort 32000-35000），冲突自动重试。
//
// 隧道按 nodeId 复用（Map<nodeId, TunnelEntry>），退出时 closeAll() 统一关闭。

import { createConnection, createPool, type ConnectionOptions, type Pool } from 'mysql2/promise';
import net from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import type { ConnTestResult, NodeMeta, SecretBundle } from '../src-core/types';

/** ssh2 ready 超时（ms）。 */
export const SSH_READY_TIMEOUT_MS = 15_000;
/** mysql 建连超时（ms）。 */
export const MYSQL_CONNECT_TIMEOUT_MS = 8_000;
/** 本地转发端口取值范围（沿用老 Tools.randPort 32000-35000）。 */
export const RAND_PORT_MIN = 32_000;
export const RAND_PORT_MAX = 35_000;
/** 建隧道时端口冲突的最大重试次数。 */
export const MAX_TUNNEL_ATTEMPTS = 10;

/** 结构化连接错误（testConnection 把它转成 ConnTestResult）。 */
export class ConnectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 纯函数：配置生成（可单测，无需真实 DB/SSH）
// ---------------------------------------------------------------------------

/** 取 [min, max] 闭区间随机整数。 */
export function pickRandomPort(min = RAND_PORT_MIN, max = RAND_PORT_MAX): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error(`pickRandomPort: 非法端口区间 [${String(min)}, ${String(max)}]`);
  }
  return min + Math.floor(Math.random() * (max - min + 1));
}

function normPort(port: unknown, fallback: number): number {
  return typeof port === 'number' && Number.isFinite(port) && port > 0 && port < 65536
    ? Math.floor(port)
    : fallback;
}

/**
 * 生成 ssh2 ConnectConfig（单跳）。
 * - authType=password → secret.sshPassword
 * - authType=privateKey → secret.privateKey（+ secret.passphrase 可选）
 */
export function buildSshConnectConfig(node: NodeMeta, secret: SecretBundle = {}): ConnectConfig {
  const ssh = node.ssh;
  if (!ssh || !ssh.enabled) throw new ConnectionError('SSH_DISABLED', '该节点未启用 SSH');
  if (!ssh.host || typeof ssh.host !== 'string' || ssh.host.trim().length === 0) {
    throw new ConnectionError('SSH_CONFIG', `节点 ${node.alias} 缺少 ssh.host`);
  }
  if (!ssh.user || typeof ssh.user !== 'string' || ssh.user.trim().length === 0) {
    throw new ConnectionError('SSH_CONFIG', `节点 ${node.alias} 缺少 ssh.user`);
  }
  const cfg: ConnectConfig = {
    host: ssh.host,
    port: normPort(ssh.port, 22),
    username: ssh.user,
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: 10_000,
  };
  if (ssh.authType === 'privateKey') {
    if (!secret.privateKey || secret.privateKey.length === 0) {
      throw new ConnectionError('SSH_CONFIG', `节点 ${node.alias} 缺少私钥（secret.privateKey）`);
    }
    cfg.privateKey = secret.privateKey;
    if (secret.passphrase) cfg.passphrase = secret.passphrase;
  } else {
    cfg.password = secret.sshPassword ?? '';
  }
  return cfg;
}

/** mysql 直连或经隧道（localPort 给定时 host 改写为 127.0.0.1，老 DB.js:37 同语义）。 */
export function buildMysqlConfig(
  node: NodeMeta,
  secret: SecretBundle = {},
  localPort?: number,
): ConnectionOptions {
  const viaTunnel = typeof localPort === 'number';
  return {
    host: viaTunnel ? '127.0.0.1' : node.host,
    port: viaTunnel ? localPort : normPort(node.port, 3306),
    user: node.user,
    password: secret.password ?? '',
    database: node.database,
    connectTimeout: MYSQL_CONNECT_TIMEOUT_MS,
  };
}

/** 解析最终 DB endpoint（直连返回节点 host/port，经隧道返回 127.0.0.1/localPort）。 */
export function resolveMysqlEndpoint(
  node: NodeMeta,
  localPort?: number,
): { host: string; port: number } {
  if (typeof localPort === 'number') return { host: '127.0.0.1', port: localPort };
  return { host: node.host, port: normPort(node.port, 3306) };
}

function validateNode(node: NodeMeta): void {
  if (!node || typeof node !== 'object') throw new ConnectionError('BAD_NODE', '节点为空');
  if (!node.host) throw new ConnectionError('BAD_NODE', `节点 ${node.alias || node.id} 缺少 host`);
  if (!node.user) throw new ConnectionError('BAD_NODE', `节点 ${node.alias || node.id} 缺少 user`);
  if (!node.database) {
    throw new ConnectionError('BAD_NODE', `节点 ${node.alias || node.id} 缺少 database`);
  }
}

// ---------------------------------------------------------------------------
// 隧道池（按 nodeId 复用）
// ---------------------------------------------------------------------------

/** 最小结构形状：生产用 ssh2 Client / net.Server，单测可注入假对象。 */
export interface TunnelClient {
  end(): unknown;
}
export interface TunnelServer {
  close(cb?: (err?: Error) => void): unknown;
}
export interface TunnelEntry {
  client: TunnelClient;
  server: TunnelServer;
  localPort: number;
}

const tunnels = new Map<string, TunnelEntry>();
/** 建隧道中的去重（同 nodeId 并发 ensureTunnel 只建一次）。 */
const inflight = new Map<string, Promise<TunnelEntry>>();

/** 只读快照：当前复用的隧道（nodeId → 本地端口），供诊断/UI 展示。 */
export function listTunnels(): Array<{ nodeId: string; localPort: number }> {
  return [...tunnels.entries()].map(([nodeId, t]) => ({ nodeId, localPort: t.localPort }));
}

function connectSsh(cfg: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      try {
        client.end();
      } catch {
        // 关闭幂等，忽略。
      }
      reject(new ConnectionError('SSH_CONNECT', `SSH 连接超时（${cfg.host}:${String(cfg.port)}）`));
    }, SSH_READY_TIMEOUT_MS);
    // 避免超时后 unref 悬挂（Electron 主进程退出时不被拖住）。
    if (typeof timer.unref === 'function') timer.unref();
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(
        new ConnectionError('SSH_CONNECT', `SSH 连接失败（${cfg.host}:${String(cfg.port)}）：${err.message}`),
      );
    });
    try {
      client.connect(cfg);
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      reject(new ConnectionError('SSH_CONNECT', `SSH 连接失败：${message}`));
    }
  });
}

/** 在本地起转发服务：每个入连接经 ssh forwardOut 透传到远端 dbHost:dbPort。 */
function startForwardServer(client: Client, dbHost: string, dbPort: number): net.Server {
  const server = net.createServer((sock) => {
    client.forwardOut('127.0.0.1', 0, dbHost, dbPort, (err, stream) => {
      if (err || !stream) {
        sock.destroy();
        return;
      }
      sock.pipe(stream).pipe(sock);
      const cleanup = (): void => {
        try {
          sock.destroy();
        } catch {
          // 忽略二次销毁。
        }
        try {
          stream.destroy();
        } catch {
          // 忽略二次销毁。
        }
      };
      sock.once('close', cleanup);
      stream.once('close', cleanup);
      sock.once('error', cleanup);
      stream.once('error', cleanup);
    });
  });
  return server;
}

function listenOnce(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 确保 nodeId 的隧道存在（复用优先，并发去重）。
 * 端口冲突（EADDRINUSE）时换随机端口重试，最多 MAX_TUNNEL_ATTEMPTS 次。
 */
export async function ensureTunnel(node: NodeMeta, secret: SecretBundle = {}): Promise<TunnelEntry> {
  validateNode(node);
  if (!node.ssh || !node.ssh.enabled) {
    throw new ConnectionError('SSH_DISABLED', `节点 ${node.alias} 未启用 SSH`);
  }
  const cached = tunnels.get(node.id);
  if (cached) return cached;
  const ongoing = inflight.get(node.id);
  if (ongoing) return ongoing;

  const task = (async (): Promise<TunnelEntry> => {
    const sshCfg = buildSshConnectConfig(node, secret);
    const client = await connectSsh(sshCfg);
    const dbPort = normPort(node.port, 3306);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_TUNNEL_ATTEMPTS; attempt += 1) {
      const port = pickRandomPort();
      const server = startForwardServer(client, node.host, dbPort);
      try {
        await listenOnce(server, port);
      } catch (err) {
        try {
          server.close();
        } catch {
          // 忽略。
        }
        lastErr = err;
        // 非端口冲突直接抛；冲突则换端口重试。
        if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
          throw new ConnectionError('SSH_TUNNEL', `本地转发端口监听失败（${port}）：${errMessage(err)}`);
        }
        continue;
      }
      const entry: TunnelEntry = { client, server, localPort: port };
      tunnels.set(node.id, entry);
      return entry;
    }
    try {
      client.end();
    } catch {
      // 忽略。
    }
    throw new ConnectionError(
      'SSH_TUNNEL',
      `本地转发端口分配失败（重试 ${MAX_TUNNEL_ATTEMPTS} 次）：${errMessage(lastErr)}`,
    );
  })();

  inflight.set(node.id, task);
  try {
    return await task;
  } catch (err) {
    // 建隧道失败不留脏缓存（server 已在分支内关，client 在重试耗尽时已关；
    // ssh 建连失败时 client 由 ssh2 自行收尾，这里只清 inflight）。
    tunnels.delete(node.id);
    throw err;
  } finally {
    inflight.delete(node.id);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 对外 API：pool / 测试连接 / 关闭
// ---------------------------------------------------------------------------

/** 建 mysql2 pool（SSH 节点自动经隧道，直连节点直接连）。调用方负责 pool.end()。 */
export async function createMysqlPool(node: NodeMeta, secret: SecretBundle = {}): Promise<Pool> {
  validateNode(node);
  if (node.ssh && node.ssh.enabled) {
    const tunnel = await ensureTunnel(node, secret);
    return createPool({
      ...buildMysqlConfig(node, secret, tunnel.localPort),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
  }
  return createPool({
    ...buildMysqlConfig(node, secret),
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });
}

async function pingDirect(node: NodeMeta, secret: SecretBundle): Promise<void> {
  let conn;
  try {
    conn = await createConnection(buildMysqlConfig(node, secret));
  } catch (err) {
    throw new ConnectionError('MYSQL_CONNECT', `MySQL 连接失败（${node.host}）：${errMessage(err)}`);
  }
  try {
    await conn.query('SELECT 1');
  } catch (err) {
    throw new ConnectionError('MYSQL_CONNECT', `MySQL 查询失败（${node.host}）：${errMessage(err)}`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function pingViaTunnel(node: NodeMeta, secret: SecretBundle, localPort: number): Promise<void> {
  let conn;
  try {
    conn = await createConnection(buildMysqlConfig(node, secret, localPort));
  } catch (err) {
    throw new ConnectionError(
      'MYSQL_CONNECT',
      `MySQL 连接失败（经隧道 127.0.0.1:${localPort}）：${errMessage(err)}`,
    );
  }
  try {
    await conn.query('SELECT 1');
  } catch (err) {
    throw new ConnectionError('MYSQL_CONNECT', `MySQL 查询失败（经隧道）：${errMessage(err)}`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

/**
 * 测试连接并测延迟（ms）。只建临时 mysql 连接做 `SELECT 1`，隧道保留复用不关。
 * 失败返回 {ok:false, ms, code, message}，不抛异常（UI 可直接展示）。
 */
export async function testConnection(
  node: NodeMeta,
  secret: SecretBundle = {},
): Promise<ConnTestResult> {
  const started = Date.now();
  const fail = (code: string, message: string): ConnTestResult => ({
    ok: false,
    ms: Date.now() - started,
    code,
    message,
  });
  try {
    validateNode(node);
    if (node.ssh && node.ssh.enabled) {
      let tunnel: TunnelEntry;
      try {
        tunnel = await ensureTunnel(node, secret);
      } catch (err) {
        if (err instanceof ConnectionError) return fail(err.code, err.message);
        return fail('SSH_CONNECT', `SSH 隧道失败：${errMessage(err)}`);
      }
      await pingViaTunnel(node, secret, tunnel.localPort);
    } else {
      await pingDirect(node, secret);
    }
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof ConnectionError) return fail(err.code, err.message);
    return fail('UNKNOWN', errMessage(err));
  }
}

/** 关闭单个节点的隧道（幂等；mysql pool/connection 由调用方自己 end）。 */
export async function closeTunnel(nodeId: string): Promise<void> {
  const entry = tunnels.get(nodeId);
  if (!entry) return;
  tunnels.delete(nodeId);
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        entry.client.end();
      } catch {
        // 忽略。
      }
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      entry.server.close(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/** 关闭全部隧道（应用退出前调用）。 */
export async function closeAll(): Promise<void> {
  const ids = [...tunnels.keys()];
  await Promise.all(ids.map((id) => closeTunnel(id)));
}

// ---------------------------------------------------------------------------
// 单测后门（同模块复用逻辑的无网验证；生产代码不调用）
// ---------------------------------------------------------------------------

/** 仅单测用：预置隧道缓存条目（验证复用/关闭逻辑，无需真实 SSH）。 */
export function __testRegisterTunnel(nodeId: string, entry: TunnelEntry): void {
  tunnels.set(nodeId, entry);
}
/** 仅单测用：清空隧道缓存。 */
export function __testClearTunnels(): void {
  tunnels.clear();
  inflight.clear();
}
