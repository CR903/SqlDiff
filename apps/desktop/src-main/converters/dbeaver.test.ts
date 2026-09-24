import { describe, expect, it } from 'vitest';
import type { NodeMeta, SecretBundle } from '../../src-core/types';
import {
  buildDBeaverDocument,
  createDBeaverExportResult,
  resolveDBeaverNodes,
} from './dbeaver';

function node(id: string, overrides: Partial<NodeMeta> = {}): NodeMeta {
  return {
    id,
    alias: `节点-${id}`,
    host: 'db.internal',
    port: 3306,
    user: 'app_user',
    database: 'shop',
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildDBeaverDocument', () => {
  it('生成直连 MySQL MANUAL / native 配置且关闭秘密保存', () => {
    const { document, warnings } = buildDBeaverDocument([node('n1')]);

    expect(document).toEqual({
      folders: {},
      connections: {
        'sqldiff-n1': {
          provider: 'mysql',
          driver: 'mysql8',
          name: '节点-n1',
          'save-password': false,
          configuration: {
            host: 'db.internal',
            port: '3306',
            database: 'shop',
            configurationType: 'MANUAL',
            'auth-model': 'native',
            'auth-properties': { userName: 'app_user' },
          },
        },
      },
      'connection-types': {},
    });
    expect(warnings).toEqual([]);
  });

  it('密码 SSH 映射为 PASSWORD handler，不输出密码', () => {
    const { document } = buildDBeaverDocument([
      node('n-ssh-password', {
        ssh: {
          enabled: true,
          host: 'bastion.example.com',
          port: 2222,
          user: 'deploy',
          authType: 'password',
        },
      }),
    ]);

    const tunnel = document.connections['sqldiff-n-ssh-password']?.configuration.handlers?.ssh_tunnel;
    expect(tunnel).toEqual({
      type: 'TUNNEL',
      enabled: true,
      'save-password': false,
      properties: {
        host: 'bastion.example.com',
        port: 2222,
        user: 'deploy',
        authType: 'PASSWORD',
      },
    });
    expect(tunnel).not.toHaveProperty('properties.password');
  });

  it('私钥 SSH 映射为 PUBLIC_KEY，省略 keyPath 并给出待补密钥警告', () => {
    const { document, warnings } = buildDBeaverDocument([
      node('n-ssh-key', {
        alias: '生产只读库',
        ssh: {
          enabled: true,
          host: 'jump.example.com',
          port: 22,
          user: 'key-user',
          authType: 'privateKey',
        },
      }),
    ]);

    const tunnel = document.connections['sqldiff-n-ssh-key']?.configuration.handlers?.ssh_tunnel;
    expect(tunnel?.properties.authType).toBe('PUBLIC_KEY');
    expect(tunnel?.properties).not.toHaveProperty('keyPath');
    expect(tunnel?.properties).not.toHaveProperty('keyValue');
    expect(warnings).toEqual(['生产只读库：SSH 私钥需在 DBeaver 中重新选择。']);
  });

  it('多节点按稳定 id 排序，相同集合不受输入顺序影响', () => {
    const a = node('a', { alias: 'A库' });
    const b = node('b', { alias: 'B库' });
    const key = node('key', {
      alias: '密钥库',
      ssh: { enabled: true, host: 'ssh', port: 22, user: 'u', authType: 'privateKey' },
    });

    const forward = createDBeaverExportResult([a, b, key]);
    const reverse = createDBeaverExportResult([key, b, a]);

    expect(reverse.content).toBe(forward.content);
    expect(forward.fileName).toBe('data-sources-sqldiff.json');
    expect(forward.content.endsWith('\n')).toBe(true);
    expect(forward.exportedCount).toBe(3);
    expect(forward.warnings).toEqual(['密钥库：SSH 私钥需在 DBeaver 中重新选择。']);
    expect(Object.keys(JSON.parse(forward.content).connections)).toEqual([
      'sqldiff-a',
      'sqldiff-b',
      'sqldiff-key',
    ]);
  });

  it('即使输入对象夹带秘密字段，JSON 仍只输出拓扑', () => {
    const polluted = {
      ...node('n-secret'),
      password: 'db-password-sentinel',
      sshPassword: 'ssh-password-sentinel',
      privateKey: 'private-key-sentinel',
      passphrase: 'passphrase-sentinel',
      vaultCiphertext: 'ciphertext-sentinel',
    } as NodeMeta & SecretBundle & { vaultCiphertext: string };

    const result = createDBeaverExportResult([polluted]);
    const parsed = JSON.parse(result.content) as ReturnType<typeof buildDBeaverDocument>['document'];
    const connection = parsed.connections['sqldiff-n-secret'];

    expect(result.content).not.toContain('db-password-sentinel');
    expect(result.content).not.toContain('ssh-password-sentinel');
    expect(result.content).not.toContain('private-key-sentinel');
    expect(result.content).not.toContain('passphrase-sentinel');
    expect(result.content).not.toContain('ciphertext-sentinel');
    expect(result.content).not.toMatch(/"(?:password|sshPassword|privateKey|passphrase|vaultCiphertext)"\s*:/);
    expect(connection?.configuration['auth-properties']).not.toHaveProperty('userPassword');
  });

  it('拒绝空、重复和非法节点输入', () => {
    expect(() => buildDBeaverDocument([])).toThrow(/^dbeaver:/);
    expect(() => buildDBeaverDocument([node('dup'), node('dup')])).toThrow(/id 重复/);
    expect(() => buildDBeaverDocument([node('bad', { port: 0 })])).toThrow(/端口/);
    expect(() =>
      buildDBeaverDocument([
        node('bad-ssh', {
          ssh: { enabled: true, host: '', port: 22, user: '', authType: 'privateKey' },
        }),
      ]),
    ).toThrow(/host 或 user/);
  });
});

describe('resolveDBeaverNodes', () => {
  const nodes = [node('n1'), node('n2'), node('n3')];

  it('按选择顺序返回已存在节点', () => {
    expect(resolveDBeaverNodes(nodes, ['n3', 'n1']).map((n) => n.id)).toEqual(['n3', 'n1']);
  });

  it('空选择、非法 id、重复 id 和未知 id 均抛中文 nodes: 错误', () => {
    expect(() => resolveDBeaverNodes(nodes, [])).toThrow(/^nodes:.*至少选择一个节点/);
    expect(() => resolveDBeaverNodes(nodes, ['n1', 1])).toThrow(/^nodes:.*id 非法/);
    expect(() => resolveDBeaverNodes(nodes, ['n1', 'n1'])).toThrow(/^nodes:.*id 重复/);
    expect(() => resolveDBeaverNodes(nodes, ['missing'])).toThrow(/^nodes:.*未知节点/);
  });
});
