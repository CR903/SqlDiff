import type { NodeMeta } from '../../src-core/types';

const DBEAVER_PROVIDER = 'mysql';
const DBEAVER_DRIVER = 'mysql8';
const CONNECTION_ID_PREFIX = 'sqldiff-';

export const DBEAVER_EXPORT_FILE_NAME = 'data-sources-sqldiff.json';

export type DBeaverSshAuthType = 'PASSWORD' | 'PUBLIC_KEY';

export interface DBeaverSshTunnel {
  type: 'TUNNEL';
  enabled: true;
  'save-password': false;
  properties: {
    host: string;
    port: number;
    user: string;
    authType: DBeaverSshAuthType;
  };
}

export interface DBeaverConnection {
  provider: typeof DBEAVER_PROVIDER;
  driver: typeof DBEAVER_DRIVER;
  name: string;
  'save-password': false;
  configuration: {
    host: string;
    port: string;
    database: string;
    configurationType: 'MANUAL';
    'auth-model': 'native';
    'auth-properties': {
      userName: string;
    };
    handlers?: {
      ssh_tunnel: DBeaverSshTunnel;
    };
  };
}

export interface DBeaverDataSources {
  folders: Record<string, never>;
  connections: Record<string, DBeaverConnection>;
  'connection-types': Record<string, never>;
}

export interface DBeaverExportResult {
  fileName: typeof DBEAVER_EXPORT_FILE_NAME;
  content: string;
  exportedCount: number;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function assertExportNode(value: unknown, index: number): asserts value is NodeMeta {
  if (!isRecord(value)) {
    throw new Error(`dbeaver: 第 ${index + 1} 个节点格式非法`);
  }
  for (const field of ['id', 'alias', 'host', 'user', 'database', 'createdAt'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      throw new Error(`dbeaver: 节点字段 ${field} 非法`);
    }
  }
  if (!isValidPort(value.port)) {
    throw new Error('dbeaver: 节点端口须为 1-65535 的整数');
  }
  if (!isRecord(value.ssh)) {
    throw new Error('dbeaver: 节点 SSH 配置格式非法');
  }
  if (
    typeof value.ssh.enabled !== 'boolean' ||
    !isValidPort(value.ssh.port) ||
    (value.ssh.authType !== 'password' && value.ssh.authType !== 'privateKey')
  ) {
    throw new Error('dbeaver: 节点 SSH 配置格式非法');
  }
  if (
    value.ssh.enabled &&
    (typeof value.ssh.host !== 'string' ||
      value.ssh.host.trim().length === 0 ||
      typeof value.ssh.user !== 'string' ||
      value.ssh.user.trim().length === 0)
  ) {
    throw new Error('dbeaver: 已启用 SSH 的节点缺少 host 或 user');
  }
}

/** 按 IPC 传入的 id 顺序取节点元数据；不读取或接收任何秘密。 */
export function resolveDBeaverNodes(nodes: readonly NodeMeta[], ids: unknown): NodeMeta[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('nodes: DBeaver 导出请至少选择一个节点');
  }

  const selectedIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of ids) {
    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      throw new Error('nodes: DBeaver 导出节点 id 非法');
    }
    const id = rawId.trim();
    if (seen.has(id)) {
      throw new Error('nodes: DBeaver 导出节点 id 重复');
    }
    seen.add(id);
    selectedIds.push(id);
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  return selectedIds.map((id) => {
    const node = byId.get(id);
    if (!node) {
      throw new Error('nodes: DBeaver 导出包含未知节点，请刷新后重试');
    }
    return node;
  });
}

function connectionId(nodeId: string): string {
  return `${CONNECTION_ID_PREFIX}${nodeId}`;
}

function compareNodeIds(a: NodeMeta, b: NodeMeta): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** SqlDiff NodeMeta → DBeaver data-sources 文档；输出仅含拓扑，不含任何秘密。 */
export function buildDBeaverDocument(nodes: readonly NodeMeta[]): {
  document: DBeaverDataSources;
  warnings: string[];
} {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('dbeaver: 至少需要一个待导出节点');
  }

  nodes.forEach(assertExportNode);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new Error('dbeaver: 待导出节点 id 重复');
    }
    seen.add(node.id);
  }

  const sorted = [...nodes].sort(compareNodeIds);
  const connections: Record<string, DBeaverConnection> = {};
  const warnings: string[] = [];
  for (const node of sorted) {
    const connection: DBeaverConnection = {
      provider: DBEAVER_PROVIDER,
      driver: DBEAVER_DRIVER,
      name: node.alias,
      'save-password': false,
      configuration: {
        host: node.host,
        port: String(node.port),
        database: node.database,
        configurationType: 'MANUAL',
        'auth-model': 'native',
        'auth-properties': {
          userName: node.user,
        },
      },
    };

    if (node.ssh.enabled) {
      const authType: DBeaverSshAuthType = node.ssh.authType === 'privateKey' ? 'PUBLIC_KEY' : 'PASSWORD';
      connection.configuration.handlers = {
        ssh_tunnel: {
          type: 'TUNNEL',
          enabled: true,
          'save-password': false,
          properties: {
            host: node.ssh.host,
            port: node.ssh.port,
            user: node.ssh.user,
            authType,
          },
        },
      };
      if (node.ssh.authType === 'privateKey') {
        warnings.push(`${node.alias}：SSH 私钥需在 DBeaver 中重新选择。`);
      }
    }

    connections[connectionId(node.id)] = connection;
  }

  return {
    document: {
      folders: {},
      connections,
      'connection-types': {},
    },
    warnings,
  };
}

/** 构造可下载结果；内容稳定、无时间戳，相同节点集合可重复生成相同 JSON。 */
export function createDBeaverExportResult(nodes: readonly NodeMeta[]): DBeaverExportResult {
  const { document, warnings } = buildDBeaverDocument(nodes);
  return {
    fileName: DBEAVER_EXPORT_FILE_NAME,
    content: `${JSON.stringify(document, null, 2)}\n`,
    exportedCount: nodes.length,
    warnings,
  };
}
