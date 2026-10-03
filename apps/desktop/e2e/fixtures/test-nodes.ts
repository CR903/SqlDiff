import type { NodeMeta } from '../../src-core/types';

/**
 * E2E 测试用节点集合（5 个）：
 * - e2e-direct: 直连 MySQL（无 SSH）
 * - e2e-pwd-ssh: 密码 SSH 隧道
 * - e2e-key-ssh: 私钥 SSH 隧道
 * - e2e-collapse-1: 共用跳板机节点 1（SSH 折叠测试）
 * - e2e-collapse-2: 共用跳板机节点 2（SSH 折叠测试）
 */
export const TEST_NODES: NodeMeta[] = [
  {
    id: 'e2e-direct',
    alias: 'prod-db',
    host: 'db.internal',
    port: 3306,
    user: 'app_user',
    database: 'shop',
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: '2026-10-03T00:00:00.000Z',
  },
  {
    id: 'e2e-pwd-ssh',
    alias: 'staging-db',
    host: 'staging.internal',
    port: 3306,
    user: 'staging_user',
    database: 'shop_staging',
    ssh: { enabled: true, host: 'jump.internal', port: 2222, user: 'ops', authType: 'password' },
    createdAt: '2026-10-03T00:00:00.000Z',
  },
  {
    id: 'e2e-key-ssh',
    alias: 'dev-db',
    host: 'dev.internal',
    port: 3306,
    user: 'dev_user',
    database: 'shop_dev',
    ssh: { enabled: true, host: 'dev-jump.internal', port: 22, user: 'devops', authType: 'privateKey' },
    createdAt: '2026-10-03T00:00:00.000Z',
  },
  {
    id: 'e2e-collapse-1',
    alias: 'coll-ap',
    host: 'a.internal',
    port: 3306,
    user: 'app_a',
    database: 'shop_a',
    ssh: { enabled: true, host: 'shared-jump.internal', port: 2200, user: 'shared_ops', authType: 'password' },
    createdAt: '2026-10-03T00:00:00.000Z',
  },
  {
    id: 'e2e-collapse-2',
    alias: 'coll-bp',
    host: 'b.internal',
    port: 3306,
    user: 'app_b',
    database: 'shop_b',
    ssh: { enabled: true, host: 'shared-jump.internal', port: 2200, user: 'shared_ops', authType: 'password' },
    createdAt: '2026-10-03T00:00:00.000Z',
  },
];

/** 所有节点 id 列表（按定义顺序）。 */
export const ALL_NODE_IDS = TEST_NODES.map((n) => n.id);

/** 直连节点 id。 */
export const DIRECT_NODE_ID = 'e2e-direct';

/** 密码 SSH 节点 id。 */
export const PWD_SSH_NODE_ID = 'e2e-pwd-ssh';

/** 私钥 SSH 节点 id。 */
export const KEY_SSH_NODE_ID = 'e2e-key-ssh';

/** SSH 折叠测试节点 ids。 */
export const COLLAPSE_NODE_IDS = ['e2e-collapse-1', 'e2e-collapse-2'];

/** 所有含 SSH 的节点 ids。 */
export const SSH_NODE_IDS = ['e2e-pwd-ssh', 'e2e-key-ssh', 'e2e-collapse-1', 'e2e-collapse-2'];
