import { createHash } from 'node:crypto';
import type { NodeMeta } from '../../src-core/types';

// SqlDiff → DataGrip 三件套 XML 导出（dataSources.xml + dataSources.local.xml + sshConfigs.xml）。
// 与 ./dbeaver.ts 同层：拓扑优先、无秘密、字节稳定。
// 结构依据 .trellis/tasks/archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md
// 的 2026-10-03 Addendum：SSH 定义在独立 sshConfigs.xml，dataSources.local.xml 只承载
// <ssh-properties><enabled><ssh-config-id></ssh-config-id></ssh-properties> 引用。

const PROJECT_VERSION = '4';
const DATA_SOURCE_COMPONENT = 'DataSourceManagerImpl';
const DATA_SOURCE_LOCAL_COMPONENT = 'dataSourceStorageLocal';
const SSH_CONFIG_COMPONENT = 'SshConfigs';
const DATAGRIP_DRIVER_REF = 'mysql.8';
const DATAGRIP_JDBC_DRIVER = 'com.mysql.cj.jdbc.Driver';
const DATAGRIP_WORKING_DIR = '$ProjectFileDir$';
const DATAGRIP_SECRET_STORAGE = 'master_key';

// RFC 4122 §6 命名空间 UUID（v5 用）：从任意名字派生确定 UUID，跨进程/跨运行稳定。
const NS_SQLDIFF_DS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'; // URL namespace（RFC 4122 保留）
const NS_SQLDIFF_SSH = 'f81d4fae-7dec-718f-e42a-4a04728f92ff'; // 本任务内部保留；用于 SSH 配置 ID

export type DatagripSshAuthType = 'PASSWORD' | 'PRIVATE_KEY';

export interface DatagripFile {
  fileName: 'dataSources.xml' | 'dataSources.local.xml' | 'sshConfigs.xml';
  content: string;
}

export interface DatagripExportResult {
  files: DatagripFile[];
  exportedCount: number;
  warnings: string[];
}

/** 私有常量导出给测试断言用。 */
export const DATAGRIP_EXPORT_FILE_NAMES = {
  dataSources: 'dataSources.xml' as const,
  dataSourcesLocal: 'dataSources.local.xml' as const,
  sshConfigs: 'sshConfigs.xml' as const,
};

// -- v5 UUID（自包含，零外部依赖；仅使用 Node 内置 crypto） -----------------

function bytesToUuid(hex: string): string {
  // UUID 格式：8-4-4-4-12（共 32 hex）。
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidV5(namespace: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace)) {
    throw new Error(`datagrip: UUID v5 命名空间非法: ${namespace}`);
  }
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  // RFC 4122 §4.3：byte 6 high 4 bits = version (0x50)，byte 8 high 2 bits = variant (0x80)。
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return bytesToUuid(hash.toString('hex'));
}

/** 数据源 UUID：由 node.id 派生，同一节点两次导出完全一致。 */
function dataSourceUuid(nodeId: string): string {
  return uuidV5(NS_SQLDIFF_DS, `sqldiff:datasource:${nodeId}`);
}

/**
 * SSH 配置 UUID：由跳板机四元组 (host, port, user, authType) 派生；
 * 四元组相同时自然折叠为同一个 <sshConfig>，四元组任意不同即为独立配置。
 * 不含 node.id —— 若含 node.id，两个不同节点即使共用同一跳板机也得不到同一 UUID，
 * 折叠语义就无法实现。
 */
function sshConfigUuid(host: string, port: number, user: string, authType: DatagripSshAuthType): string {
  return uuidV5(NS_SQLDIFF_SSH, `sqldiff:ssh:${host}:${port}:${user}:${authType}`);
}

// -- XML 转义 ---------------------------------------------------------------

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#xD;')
    .replace(/\n/g, '&#xA;')
    .replace(/\t/g, '&#x9;');
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;')
    .replace(/\n/g, '&#xA;');
}

// -- 校验 -------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function assertExportNode(value: unknown, index: number): asserts value is NodeMeta {
  if (!isRecord(value)) {
    throw new Error(`datagrip: 第 ${index + 1} 个节点格式非法`);
  }
  for (const field of ['id', 'alias', 'host', 'user', 'database', 'createdAt'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      throw new Error(`datagrip: 节点字段 ${field} 非法`);
    }
  }
  if (!isValidPort(value.port)) {
    throw new Error('datagrip: 节点端口须为 1-65535 的整数');
  }
  if (!isRecord(value.ssh)) {
    throw new Error('datagrip: 节点 SSH 配置格式非法');
  }
  if (
    typeof value.ssh.enabled !== 'boolean' ||
    !isValidPort(value.ssh.port) ||
    (value.ssh.authType !== 'password' && value.ssh.authType !== 'privateKey')
  ) {
    throw new Error('datagrip: 节点 SSH 配置格式非法');
  }
  if (
    value.ssh.enabled &&
    (typeof value.ssh.host !== 'string' ||
      value.ssh.host.trim().length === 0 ||
      typeof value.ssh.user !== 'string' ||
      value.ssh.user.trim().length === 0)
  ) {
    throw new Error('datagrip: 已启用 SSH 的节点缺少 host 或 user');
  }
}

/** 按 IPC 传入的 id 顺序取节点元数据；不读取或接收任何秘密。 */
export function resolveDatagripNodes(nodes: readonly NodeMeta[], ids: unknown): NodeMeta[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('nodes: DataGrip 导出请至少选择一个节点');
  }

  const selectedIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of ids) {
    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      throw new Error('nodes: DataGrip 导出节点 id 非法');
    }
    const id = rawId.trim();
    if (seen.has(id)) {
      throw new Error('nodes: DataGrip 导出节点 id 重复');
    }
    seen.add(id);
    selectedIds.push(id);
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  return selectedIds.map((id) => {
    const node = byId.get(id);
    if (!node) {
      throw new Error('nodes: DataGrip 导出包含未知节点，请刷新后重试');
    }
    return node;
  });
}

// -- SSH 折叠 ---------------------------------------------------------------

interface SshConfigEntry {
  id: string;
  authType: DatagripSshAuthType;
  host: string;
  port: number;
  user: string;
  /** 被多少 data-source 引用（含自身）。 */
  references: number;
  /** 折叠发生时，记录首个触发折叠的节点别名，用于 warning 文案。 */
  collapsedAliases: string[];
}

// -- 文档构造 ---------------------------------------------------------------

function compareNodeIds(a: NodeMeta, b: NodeMeta): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** SqlDiff NodeMeta → DataGrip 三件套 XML；输出仅含拓扑，不含任何秘密。 */
export function buildDatagripDocuments(nodes: readonly NodeMeta[]): {
  dataSourcesXml: string;
  dataSourcesLocalXml: string;
  sshConfigsXml?: string;
  warnings: string[];
} {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('datagrip: 至少需要一个待导出节点');
  }

  nodes.forEach(assertExportNode);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new Error('datagrip: 待导出节点 id 重复');
    }
    seen.add(node.id);
  }

  const sorted = [...nodes].sort(compareNodeIds);
  const warnings: string[] = [];

  // 第一遍：按 node.id 稳定顺序收集数据源条目 + SSH 折叠表。
  // SSH 折叠键 = UUID 派生元组（host + port + user），authType 变化会产生新 UUID，不会误合并。
  const dataSources: Array<{
    uuid: string;
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    sshConfigId: string | null;
  }> = [];
  const sshConfigs = new Map<string, SshConfigEntry>();

  for (const node of sorted) {
    const uuid = dataSourceUuid(node.id);
    const entry: {
      uuid: string;
      name: string;
      host: string;
      port: number;
      database: string;
      user: string;
      sshConfigId: string | null;
    } = {
      uuid,
      name: node.alias,
      host: node.host,
      port: node.port,
      database: node.database,
      user: node.user,
      sshConfigId: null,
    };

    if (node.ssh.enabled) {
      const authType: DatagripSshAuthType =
        node.ssh.authType === 'privateKey' ? 'PRIVATE_KEY' : 'PASSWORD';
      const sshId = sshConfigUuid(node.ssh.host, node.ssh.port, node.ssh.user, authType);
      const existing = sshConfigs.get(sshId);
      if (existing) {
        existing.references += 1;
        existing.collapsedAliases.push(node.alias);
      } else {
        sshConfigs.set(sshId, {
          id: sshId,
          authType,
          host: node.ssh.host,
          port: node.ssh.port,
          user: node.ssh.user,
          references: 1,
          collapsedAliases: [node.alias],
        });
      }
      entry.sshConfigId = sshId;

      if (node.ssh.authType === 'privateKey') {
        warnings.push(`${node.alias}：SSH 私钥需在 DataGrip 中重新选择。`);
      }
    }

    dataSources.push(entry);
  }

  // 折叠 warning：仅当同一 <sshConfig> 被 ≥ 2 个 data-source 引用时才输出。
  for (const ssh of sshConfigs.values()) {
    if (ssh.references > 1) {
      warnings.push(
        `SSH 拓扑已折叠：${ssh.collapsedAliases.join('、')} 共用同一个 sshConfig。`,
      );
    }
  }

  // 第二遍：按 node.id 顺序发射 dataSources.xml 与 dataSources.local.xml；
  // sshConfigs.xml 仅在至少有一个 SSH 节点时生成，条目按 UUID 字典序。

  const dataSourcesLines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project version="${PROJECT_VERSION}">`,
    `  <component name="${DATA_SOURCE_COMPONENT}" format="xml" multifile-model="true">`,
  ];
  for (const ds of dataSources) {
    dataSourcesLines.push(
      `    <data-source name="${escapeAttr(ds.name)}" source="LOCAL" uuid="${ds.uuid}">`,
      `      <driver-ref>${escapeText(DATAGRIP_DRIVER_REF)}</driver-ref>`,
      `      <synchronize>true</synchronize>`,
      `      <jdbc-driver>${escapeText(DATAGRIP_JDBC_DRIVER)}</jdbc-driver>`,
      `      <jdbc-url>jdbc:mysql://${escapeText(ds.host)}:${ds.port}/${escapeText(ds.database)}</jdbc-url>`,
      `      <working-dir>${escapeText(DATAGRIP_WORKING_DIR)}</working-dir>`,
      `    </data-source>`,
    );
  }
  dataSourcesLines.push(`  </component>`, `</project>`, '');
  const dataSourcesXml = dataSourcesLines.join('\n');

  const localLines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project version="${PROJECT_VERSION}">`,
    `  <component name="${DATA_SOURCE_LOCAL_COMPONENT}">`,
  ];
  for (const ds of dataSources) {
    localLines.push(`    <data-source name="${escapeAttr(ds.name)}" uuid="${ds.uuid}">`);
    localLines.push(`      <secret-storage>${escapeText(DATAGRIP_SECRET_STORAGE)}</secret-storage>`);
    localLines.push(`      <user-name>${escapeText(ds.user)}</user-name>`);
    if (ds.sshConfigId) {
      localLines.push(`      <ssh-properties>`);
      localLines.push(`        <enabled>true</enabled>`);
      localLines.push(`        <ssh-config-id>${ds.sshConfigId}</ssh-config-id>`);
      localLines.push(`      </ssh-properties>`);
    }
    localLines.push(`    </data-source>`);
  }
  localLines.push(`  </component>`, `</project>`, '');
  const dataSourcesLocalXml = localLines.join('\n');

  let sshConfigsXml: string | undefined;
  if (sshConfigs.size > 0) {
    const sortedConfigs = [...sshConfigs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sshLines: string[] = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<project version="${PROJECT_VERSION}">`,
      `  <component name="${SSH_CONFIG_COMPONENT}">`,
      `    <configs>`,
    ];
    for (const ssh of sortedConfigs) {
      sshLines.push(
        `      <sshConfig authType="${ssh.authType}" host="${escapeAttr(ssh.host)}" id="${ssh.id}" port="${ssh.port}" username="${escapeAttr(ssh.user)}" />`,
      );
    }
    sshLines.push(`    </configs>`, `  </component>`, `</project>`, '');
    sshConfigsXml = sshLines.join('\n');
  }

  return { dataSourcesXml, dataSourcesLocalXml, sshConfigsXml, warnings };
}

/** 装配最终结果：files[] 顺序固定，测试可字节比对。 */
export function createDatagripExportResult(nodes: readonly NodeMeta[]): DatagripExportResult {
  const { dataSourcesXml, dataSourcesLocalXml, sshConfigsXml, warnings } =
    buildDatagripDocuments(nodes);
  const files: DatagripFile[] = [
    { fileName: DATAGRIP_EXPORT_FILE_NAMES.dataSources, content: dataSourcesXml },
    { fileName: DATAGRIP_EXPORT_FILE_NAMES.dataSourcesLocal, content: dataSourcesLocalXml },
  ];
  if (sshConfigsXml) {
    files.push({ fileName: DATAGRIP_EXPORT_FILE_NAMES.sshConfigs, content: sshConfigsXml });
  }
  return {
    files,
    exportedCount: nodes.length,
    warnings,
  };
}
