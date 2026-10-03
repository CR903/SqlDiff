import { describe, expect, it } from 'vitest';
import type { NodeMeta, SecretBundle } from '../../src-core/types';
import {
  buildDatagripDocuments,
  createDatagripExportResult,
  DATAGRIP_EXPORT_FILE_NAMES,
  resolveDatagripNodes,
} from './datagrip';

// -- 测试 fixture -------------------------------------------------------------

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

/** 断言 XML 是 well-formed 的最小子集：根节点闭合 + 无非法空标签 + 引号配对。 */
function assertWellFormedXml(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(xml.endsWith('</project>\n')).toBe(true);
  expect(xml).toContain('<project version="4">');
  // 属性引号必须配对。
  const doubleQuotes = (xml.match(/"/g) ?? []).length;
  expect(doubleQuotes % 2).toBe(0);
  // 每个 <data-source 必须有对应 </data-source>（自闭合 sshConfig 除外）。
  const dataSourceOpens = (xml.match(/<data-source[\s>]/g) ?? []).length;
  const dataSourceCloses = (xml.match(/<\/data-source>/g) ?? []).length;
  expect(dataSourceOpens).toBe(dataSourceCloses);
  // 自闭合 sshConfig 数量必须与打开数一致（sshConfig 一律自闭合）。
  const sshOpen = (xml.match(/<sshConfig /g) ?? []).length;
  const sshClose = (xml.match(/<sshConfig [^>]*\/>/g) ?? []).length;
  expect(sshOpen).toBe(sshClose);
}

/** 从 dataSources.xml 中抽出所有 data-source 的 (name, uuid) 对。 */
function extractDataSources(xml: string): Array<{ name: string; uuid: string }> {
  const re = /<data-source\s+name="([^"]*)"\s+source="LOCAL"\s+uuid="([^"]*)"/g;
  const out: Array<{ name: string; uuid: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ name: m[1], uuid: m[2] });
  return out;
}

/** 从 dataSources.local.xml 中抽出所有 data-source 的 (name, uuid) 对。 */
function extractLocalDataSources(xml: string): Array<{ name: string; uuid: string }> {
  const re = /<data-source\s+name="([^"]*)"\s+uuid="([^"]*)"/g;
  const out: Array<{ name: string; uuid: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ name: m[1], uuid: m[2] });
  return out;
}

// -- buildDatagripDocuments --------------------------------------------------

describe('buildDatagripDocuments — 直连节点', () => {
  it('生成 dataSources.xml 与 dataSources.local.xml 且不产 sshConfigs.xml', () => {
    const { dataSourcesXml, dataSourcesLocalXml, sshConfigsXml, warnings } =
      buildDatagripDocuments([node('n-direct')]);

    expect(sshConfigsXml).toBeUndefined();
    expect(warnings).toEqual([]);

    assertWellFormedXml(dataSourcesXml);
    assertWellFormedXml(dataSourcesLocalXml);

    // dataSources.xml 结构。
    expect(dataSourcesXml).toContain('<component name="DataSourceManagerImpl" format="xml" multifile-model="true">');
    expect(dataSourcesXml).toContain('<driver-ref>mysql.8</driver-ref>');
    expect(dataSourcesXml).toContain('<synchronize>true</synchronize>');
    expect(dataSourcesXml).toContain('<jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>');
    expect(dataSourcesXml).toContain('<jdbc-url>jdbc:mysql://db.internal:3306/shop</jdbc-url>');
    expect(dataSourcesXml).toContain('<working-dir>$ProjectFileDir$</working-dir>');

    // dataSources.local.xml 结构。
    expect(dataSourcesLocalXml).toContain('<component name="dataSourceStorageLocal">');
    expect(dataSourcesLocalXml).toContain('<secret-storage>master_key</secret-storage>');
    expect(dataSourcesLocalXml).toContain('<user-name>app_user</user-name>');
    expect(dataSourcesLocalXml).not.toContain('<ssh-properties>');
  });

  it('SSH 未启用时不生成 sshConfigs.xml（files 数组只含 2 个文件）', () => {
    const result = createDatagripExportResult([node('n-direct')]);
    expect(result.files.map((f) => f.fileName)).toEqual([
      DATAGRIP_EXPORT_FILE_NAMES.dataSources,
      DATAGRIP_EXPORT_FILE_NAMES.dataSourcesLocal,
    ]);
    expect(result.exportedCount).toBe(1);
    expect(result.warnings).toEqual([]);
  });
});

describe('buildDatagripDocuments — UUID 一致性与驱动常量', () => {
  it('dataSources.xml 与 dataSources.local.xml 同名 data-source 使用同一 UUID', () => {
    const { dataSourcesXml, dataSourcesLocalXml } = buildDatagripDocuments([
      node('u1', { alias: 'Alpha' }),
      node('u2', { alias: 'Beta' }),
      node('u3', { alias: 'Gamma' }),
    ]);

    const shared = extractDataSources(dataSourcesXml);
    const local = extractLocalDataSources(dataSourcesLocalXml);
    expect(shared.length).toBe(3);
    expect(local.length).toBe(3);
    expect(local.map((x) => x.uuid)).toEqual(shared.map((x) => x.uuid));
    expect(local.map((x) => x.name)).toEqual(shared.map((x) => x.name));

    // UUID 必须符合 RFC 4122 格式（version 5, variant 8/9/a/b）。
    for (const ds of shared) {
      expect(ds.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('buildDatagripDocuments — 密码 SSH', () => {
  it('在 local.xml 写入 ssh-properties 引用；在 sshConfigs.xml 写入 authType=PASSWORD 的 sshConfig', () => {
    const { dataSourcesLocalXml, sshConfigsXml, warnings } = buildDatagripDocuments([
      node('n-ssh-pass', {
        ssh: {
          enabled: true,
          host: 'bastion.example.com',
          port: 2222,
          user: 'deploy',
          authType: 'password',
        },
      }),
    ]);

    expect(warnings).toEqual([]);
    assertWellFormedXml(dataSourcesLocalXml);
    expect(sshConfigsXml).toBeDefined();

    // ssh-properties 引用。
    expect(dataSourcesLocalXml).toContain('<ssh-properties>');
    expect(dataSourcesLocalXml).toContain('  <enabled>true</enabled>');
    expect(dataSourcesLocalXml).toMatch(/<ssh-config-id>[0-9a-f-]{36}<\/ssh-config-id>/);

    // sshConfigs.xml。
    assertWellFormedXml(sshConfigsXml as string);
    expect(sshConfigsXml as string).toContain('<component name="SshConfigs">');
    expect(sshConfigsXml as string).toContain('<configs>');
    expect(sshConfigsXml as string).toContain('authType="PASSWORD"');
    expect(sshConfigsXml as string).toContain('host="bastion.example.com"');
    expect(sshConfigsXml as string).toContain('port="2222"');
    expect(sshConfigsXml as string).toContain('username="deploy"');
    expect(sshConfigsXml as string).toMatch(/<sshConfig authType="PASSWORD" host="bastion\.example\.com" id="[0-9a-f-]{36}" port="2222" username="deploy" \/>/);
    // 无 keyPath 属性。
    expect(sshConfigsXml as string).not.toContain('keyPath');
  });

  it('ssh-config-id 与 sshConfigs.xml 内 sshConfig id 必须完全一致', () => {
    const { dataSourcesLocalXml, sshConfigsXml } = buildDatagripDocuments([
      node('n-ssh-match', {
        ssh: {
          enabled: true,
          host: 'bastion.example.com',
          port: 2222,
          user: 'deploy',
          authType: 'password',
        },
      }),
    ]);
    const localIds = [...dataSourcesLocalXml.matchAll(/<ssh-config-id>([0-9a-f-]{36})<\/ssh-config-id>/g)].map(
      (m) => m[1],
    );
    const xmlIds = [...(sshConfigsXml ?? '').matchAll(/<sshConfig [^>]*id="([0-9a-f-]{36})"/g)].map(
      (m) => m[1],
    );
    expect(localIds.length).toBe(1);
    expect(xmlIds.length).toBe(1);
    expect(localIds).toEqual(xmlIds);
  });
});

describe('buildDatagripDocuments — 私钥 SSH', () => {
  it('authType=PRIVATE_KEY；不写 keyPath；追加重新选择密钥 warning', () => {
    const { sshConfigsXml, warnings } = buildDatagripDocuments([
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

    expect(sshConfigsXml).toBeDefined();
    expect(sshConfigsXml as string).toContain('authType="PRIVATE_KEY"');
    expect(sshConfigsXml as string).not.toContain('keyPath');
    expect(sshConfigsXml as string).not.toContain('keyValue');
    expect(warnings).toEqual(['生产只读库：SSH 私钥需在 DataGrip 中重新选择。']);
  });
});

describe('buildDatagripDocuments — 多节点 & 排序 & 字节稳定', () => {
  it('相同输入顺序不同，产出字节完全一致（按 node.id 排序）', () => {
    const a = node('a', { alias: 'A库' });
    const b = node('b', { alias: 'B库' });
    const key = node('key', {
      alias: '密钥库',
      ssh: { enabled: true, host: 'ssh', port: 22, user: 'u', authType: 'privateKey' },
    });

    const forward = createDatagripExportResult([a, b, key]);
    const reverse = createDatagripExportResult([key, b, a]);

    expect(reverse.files.map((f) => f.content)).toEqual(forward.files.map((f) => f.content));
    expect(forward.exportedCount).toBe(3);
    expect(forward.warnings).toEqual(['密钥库：SSH 私钥需在 DataGrip 中重新选择。']);

    // 三个文件按 name/uuid 排序为 a, b, key。
    const names = extractDataSources(forward.files[0].content).map((d) => d.name);
    expect(names).toEqual(['A库', 'B库', '密钥库']);
  });

  it('同输入连续调用两次，输出完全字节一致（含 UUID）', () => {
    const input = [
      node('d1', { alias: 'DB1' }),
      node('d2', { alias: 'DB2', ssh: { enabled: true, host: 'h', port: 22, user: 'u', authType: 'password' } }),
    ];
    const r1 = createDatagripExportResult(input);
    const r2 = createDatagripExportResult(input);
    expect(r1.files).toEqual(r2.files);
    // UUID 跨调用稳定。
    const uuids1 = extractLocalDataSources(r1.files[1].content).map((d) => d.uuid);
    const uuids2 = extractLocalDataSources(r2.files[1].content).map((d) => d.uuid);
    expect(uuids1).toEqual(uuids2);
    for (const u of uuids1) {
      expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('sshConfigsXml 内多个 sshConfig 按 id 字典序稳定排序', () => {
    const { sshConfigsXml } = buildDatagripDocuments([
      node('x1', {
        ssh: { enabled: true, host: 'h1', port: 22, user: 'u1', authType: 'password' },
      }),
      node('x2', {
        ssh: { enabled: true, host: 'h2', port: 22, user: 'u2', authType: 'password' },
      }),
      node('x3', {
        ssh: { enabled: true, host: 'h3', port: 22, user: 'u3', authType: 'password' },
      }),
    ]);
    expect(sshConfigsXml).toBeDefined();
    const ids = [...(sshConfigsXml as string).matchAll(/id="([0-9a-f-]{36})"/g)].map((m) => m[1]);
    expect(ids.length).toBe(3);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('buildDatagripDocuments — SSH 折叠', () => {
  it('两个节点共用同一跳板机（host + port + user）时折叠为单个 sshConfig 并追加 warning', () => {
    const sharedJump = {
      enabled: true as const,
      host: 'bastion.corp',
      port: 22,
      user: 'produser',
      authType: 'password' as const,
    };
    const { dataSourcesLocalXml, sshConfigsXml, warnings } = buildDatagripDocuments([
      node('n-shared-a', { alias: 'A 库', ssh: { ...sharedJump } }),
      node('n-shared-b', { alias: 'B 库', ssh: { ...sharedJump } }),
    ]);

    // 本地文件中应有两条 ssh-config-id 引用。
    const localRefs = [...dataSourcesLocalXml.matchAll(/<ssh-config-id>([0-9a-f-]{36})<\/ssh-config-id>/g)].map(
      (m) => m[1],
    );
    expect(localRefs.length).toBe(2);
    expect(new Set(localRefs).size).toBe(1); // 折叠后同一 ID。

    // sshConfigs.xml 只有一个 sshConfig 条目。
    const xmlEntries = (sshConfigsXml ?? '').match(/<sshConfig /g);
    expect(xmlEntries?.length).toBe(1);

    // 折叠 warning 出现一次，含两个节点别名。
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('A 库');
    expect(warnings[0]).toContain('B 库');
    expect(warnings[0]).toContain('共用同一个 sshConfig');
  });

  it('跳板机 host/port/user 完全一致但 authType 不同 → 不折叠，两条 sshConfig', () => {
    const { sshConfigsXml } = buildDatagripDocuments([
      node('n-diff-a', {
        ssh: { enabled: true, host: 'jump', port: 22, user: 'shared', authType: 'password' },
      }),
      node('n-diff-b', {
        ssh: { enabled: true, host: 'jump', port: 22, user: 'shared', authType: 'privateKey' },
      }),
    ]);
    const xmlEntries = (sshConfigsXml ?? '').match(/<sshConfig /g);
    expect(xmlEntries?.length).toBe(2);
  });

  it('不同 host 或 port → 不折叠', () => {
    const { sshConfigsXml } = buildDatagripDocuments([
      node('n-c-a', { ssh: { enabled: true, host: 'h1', port: 22, user: 'u', authType: 'password' } }),
      node('n-c-b', { ssh: { enabled: true, host: 'h2', port: 22, user: 'u', authType: 'password' } }),
      node('n-c-c', { ssh: { enabled: true, host: 'h1', port: 2222, user: 'u', authType: 'password' } }),
    ]);
    const xmlEntries = (sshConfigsXml ?? '').match(/<sshConfig /g);
    expect(xmlEntries?.length).toBe(3);
  });
});

describe('buildDatagripDocuments — XML 转义', () => {
  it('alias 含 & < > " 单双引号时属性与文本均正确转义，输出仍 well-formed', () => {
    const { dataSourcesXml, dataSourcesLocalXml } = buildDatagripDocuments([
      node('n-esc', { alias: "prod & staging <tag> \"quoted\"" }),
    ]);

    assertWellFormedXml(dataSourcesXml);
    assertWellFormedXml(dataSourcesLocalXml);
    // 属性中的原始 & < > " 不应原样出现；只允许转义形式。
    expect(dataSourcesXml).not.toMatch(/name="[^"]*&(?!amp;|lt;|gt;|quot;|apos;|#x[0-9A-Fa-f]+;)[^"]*"/);
    expect(dataSourcesXml).not.toContain('name="prod & staging');
    expect(dataSourcesXml).toContain('&amp;');
    expect(dataSourcesXml).toContain('&lt;tag&gt;');
    expect(dataSourcesXml).toContain('&quot;');
    // user-name 是文本节点，只转义 & < >。
    const userNode = node('n-esc-user', {
      user: 'usr&x',
      alias: 'plain',
    });
    const { dataSourcesLocalXml: withEscapedUser } = buildDatagripDocuments([userNode]);
    expect(withEscapedUser).toContain('<user-name>usr&amp;x</user-name>');
  });
});

describe('buildDatagripDocuments — 秘密哨兵污染', () => {
  it('即便输入对象夹带秘密字段，XML 仍只输出拓扑白名单', () => {
    const polluted = {
      ...node('n-secret', { alias: 'Secret库' }),
      password: 'db-password-sentinel',
      sshPassword: 'ssh-password-sentinel',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY----- sentinel -----END-----',
      passphrase: 'passphrase-sentinel',
      vaultCiphertext: 'vault-ciphertext-sentinel',
      keyValue: 'keyvalue-sentinel',
      keyPath: '/Users/someone/.ssh/leaked',
    } as NodeMeta & SecretBundle & { vaultCiphertext: string; keyValue: string; keyPath: string };

    const result = createDatagripExportResult([polluted]);
    const blob = result.files.map((f) => f.content).join('\n');

    expect(blob).not.toContain('db-password-sentinel');
    expect(blob).not.toContain('ssh-password-sentinel');
    expect(blob).not.toContain('passphrase-sentinel');
    expect(blob).not.toContain('vault-ciphertext-sentinel');
    expect(blob).not.toContain('keyvalue-sentinel');
    expect(blob).not.toContain('/Users/someone/.ssh/leaked');
    expect(blob).not.toMatch(/password/i);
    expect(blob).not.toMatch(/passphrase/i);
    expect(blob).not.toContain('keyValue');
    expect(blob).not.toContain('keyPath');
    expect(blob).not.toContain('privateKey');
    expect(blob).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    // 只有 <secret-storage>master_key</secret-storage> 这个控制标记允许出现。
    expect(blob).toContain('master_key');
  });
});

describe('resolveDatagripNodes', () => {
  const nodes = [node('n1'), node('n2'), node('n3')];

  it('按选择顺序返回已存在节点', () => {
    expect(resolveDatagripNodes(nodes, ['n3', 'n1']).map((n) => n.id)).toEqual(['n3', 'n1']);
  });

  it('空选择、非法 id、重复 id 和未知 id 均抛中文 nodes: 错误', () => {
    expect(() => resolveDatagripNodes(nodes, [])).toThrow(/^nodes:.*至少选择一个节点/);
    expect(() => resolveDatagripNodes(nodes, ['n1', 1 as unknown as string])).toThrow(/^nodes:.*id 非法/);
    expect(() => resolveDatagripNodes(nodes, ['n1', 'n1'])).toThrow(/^nodes:.*id 重复/);
    expect(() => resolveDatagripNodes(nodes, ['missing'])).toThrow(/^nodes:.*未知节点/);
  });
});

describe('buildDatagripDocuments — 校验', () => {
  it('拒绝空、重复和非法节点输入', () => {
    expect(() => buildDatagripDocuments([])).toThrow(/^datagrip:/);
    expect(() => buildDatagripDocuments([node('dup'), node('dup')])).toThrow(/id 重复/);
    expect(() => buildDatagripDocuments([node('bad-port', { port: 0 })])).toThrow(/端口/);
    expect(() =>
      buildDatagripDocuments([
        node('bad-ssh', {
          ssh: { enabled: true, host: '', port: 22, user: '', authType: 'privateKey' },
        }),
      ]),
    ).toThrow(/host 或 user/);
    expect(() =>
      buildDatagripDocuments([
        node('bad-auth', {
          ssh: { enabled: false, host: '', port: 22, user: '', authType: 'magic' as never },
        }),
      ]),
    ).toThrow(/^datagrip:/);
  });
});
