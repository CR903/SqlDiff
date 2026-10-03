import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launchElectron, closeElectron, type ElectronHandle } from '../helpers/electron';
import {
  assertNoSecrets,
  assertWellFormedXml,
  extractDataSources,
  extractLocalDataSources,
  extractSshConfigs,
  extractSshConfigIds,
} from '../helpers/assertions';
import { TEST_NODES, DIRECT_NODE_ID, PWD_SSH_NODE_ID, KEY_SSH_NODE_ID, COLLAPSE_NODE_IDS } from '../fixtures/test-nodes';

let handle: ElectronHandle;

test.beforeAll(async () => {
  handle = await launchElectron(TEST_NODES);
});

test.afterAll(async () => {
  await closeElectron(handle);
});

/** 通过 API 导出 DataGrip 三件套并返回文件路径列表。 */
async function exportDatagrip(
  page: ElectronHandle['page'],
  ids: string[],
): Promise<string[]> {
  const result = await page.evaluate(async (nodeIds: string[]) => {
    const api = (window as unknown as { sqldiff: unknown }).sqldiff as {
      nodes: { exportDatagrip: (ids: string[]) => Promise<{ files: { fileName: string; content: string }[]; exportedCount: number; warnings: string[] }> };
      file: { save: (req: { kind: string; files: { name: string; content: string }[]; title: string }) => Promise<{ status: string; filePaths?: string[] }> };
    };
    if (!api) throw new Error('window.sqldiff not available');
    const exportResult = await api.nodes.exportDatagrip(nodeIds);
    const saveResult = await api.file.save({
      kind: 'bundle',
      files: exportResult.files.map((f: { fileName: string; content: string }) => ({ name: f.fileName, content: f.content })),
      title: '导出 DataGrip 三件套 XML',
    });
    if (saveResult.status !== 'saved') throw new Error(`Save failed: ${JSON.stringify(saveResult)}`);
    return saveResult.filePaths as string[];
  }, ids);
  return result;
}

test.describe('DataGrip 导出', () => {
  test('导出单个直连节点', async () => {
    const { page } = handle;

    const filePaths = await exportDatagrip(page, [DIRECT_NODE_ID]);
    // 直连节点无 SSH，应只有 2 个文件（dataSources.xml + dataSources.local.xml）
    expect(filePaths.length).toBe(2);

    const dataSourcesXml = readFileSync(filePaths[0], 'utf8');
    const localXml = readFileSync(filePaths[1], 'utf8');

    // XML well-formed
    assertWellFormedXml(dataSourcesXml);
    assertWellFormedXml(localXml);

    // dataSources.xml 断言
    const sources = extractDataSources(dataSourcesXml);
    expect(sources.length).toBe(1);
    expect(sources[0].name).toBe('prod-db');

    // 检查 driver-ref 和 jdbc-driver
    expect(dataSourcesXml).toContain('<driver-ref>mysql.8</driver-ref>');
    expect(dataSourcesXml).toContain('<jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>');
    expect(dataSourcesXml).toContain('<jdbc-url>jdbc:mysql://db.internal:3306/shop</jdbc-url>');

    // local XML 断言
    const localSources = extractLocalDataSources(localXml);
    expect(localSources.length).toBe(1);
    expect(localSources[0].name).toBe('prod-db');
    expect(localSources[0].hasSsh).toBe(false);
    // user-name 在 local XML 中
    expect(localXml).toContain('<user-name>app_user</user-name>');

    // UUID 一致性：dataSources.xml 和 local XML 的 UUID 应一致
    expect(sources[0].uuid).toBe(localSources[0].uuid);

    // 无秘密字段
    assertNoSecrets(dataSourcesXml);
    assertNoSecrets(localXml);
  });

  test('导出含密码 SSH 的节点', async () => {
    const { page } = handle;

    const filePaths = await exportDatagrip(page, [PWD_SSH_NODE_ID]);
    // 有 SSH 节点应有 3 个文件
    expect(filePaths.length).toBe(3);

    const dataSourcesXml = readFileSync(filePaths[0], 'utf8');
    const localXml = readFileSync(filePaths[1], 'utf8');
    const sshXml = readFileSync(filePaths[2], 'utf8');

    // XML well-formed
    assertWellFormedXml(dataSourcesXml);
    assertWellFormedXml(localXml);
    assertWellFormedXml(sshXml);

    // dataSources.xml
    const sources = extractDataSources(dataSourcesXml);
    expect(sources.length).toBe(1);
    expect(sources[0].name).toBe('staging-db');

    // local XML：应有 ssh-properties
    const localSources = extractLocalDataSources(localXml);
    expect(localSources.length).toBe(1);
    expect(localSources[0].hasSsh).toBe(true);

    // UUID 一致性
    expect(sources[0].uuid).toBe(localSources[0].uuid);

    // sshConfigs.xml：应有 1 个 sshConfig
    const sshConfigs = extractSshConfigs(sshXml);
    expect(sshConfigs.length).toBe(1);
    expect(sshConfigs[0].authType).toBe('PASSWORD');
    expect(sshConfigs[0].host).toBe('jump.internal');
    expect(sshConfigs[0].port).toBe(2222);
    expect(sshConfigs[0].username).toBe('ops');

    // ssh-config-id 引用一致性
    const sshConfigIds = extractSshConfigIds(localXml);
    expect(sshConfigIds.length).toBe(1);
    expect(sshConfigIds[0]).toBe(sshConfigs[0].id);

    // 无秘密字段
    assertNoSecrets(dataSourcesXml);
    assertNoSecrets(localXml);
    assertNoSecrets(sshXml);
  });

  test('导出私钥 SSH 节点', async () => {
    const { page } = handle;

    const filePaths = await exportDatagrip(page, [KEY_SSH_NODE_ID]);
    expect(filePaths.length).toBe(3);

    const sshXml = readFileSync(filePaths[2], 'utf8');
    const sshConfigs = extractSshConfigs(sshXml);
    expect(sshConfigs.length).toBe(1);
    expect(sshConfigs[0].authType).toBe('PRIVATE_KEY');
    // 无 keyPath 属性
    expect(sshXml).not.toContain('keyPath');
    // 无 keyPath 属性
    assertNoSecrets(sshXml);
  });

  test('SSH 折叠：两个节点共用跳板机', async () => {
    const { page } = handle;

    const filePaths = await exportDatagrip(page, COLLAPSE_NODE_IDS);
    expect(filePaths.length).toBe(3);

    const localXml = readFileSync(filePaths[1], 'utf8');
    const sshXml = readFileSync(filePaths[2], 'utf8');

    // 应有 2 个 data-source 引用同一个 sshConfig
    const localSources = extractLocalDataSources(localXml);
    expect(localSources.length).toBe(2);
    expect(localSources[0].hasSsh).toBe(true);
    expect(localSources[1].hasSsh).toBe(true);

    // sshConfigs.xml 应只有 1 个 sshConfig（折叠）
    const sshConfigs = extractSshConfigs(sshXml);
    expect(sshConfigs.length).toBe(1);
    expect(sshConfigs[0].host).toBe('shared-jump.internal');
    expect(sshConfigs[0].port).toBe(2200);

    // 2 个 ssh-config-id 引用同一个 id
    const sshConfigIds = extractSshConfigIds(localXml);
    expect(sshConfigIds.length).toBe(2);
    expect(sshConfigIds[0]).toBe(sshConfigIds[1]);
    expect(sshConfigIds[0]).toBe(sshConfigs[0].id);

    assertNoSecrets(sshXml);
  });

  test('确定性：不同输入顺序 → 相同内容', async () => {
    const { page } = handle;

    // 第一次导出（按定义顺序）
    const result1 = await exportDatagrip(page, ['e2e-direct', 'e2e-pwd-ssh', 'e2e-key-ssh']);
    const content1 = result1.map((p) => readFileSync(p, 'utf8'));

    // 第二次导出（反转顺序）
    const result2 = await exportDatagrip(page, ['e2e-key-ssh', 'e2e-pwd-ssh', 'e2e-direct']);
    const content2 = result2.map((p) => readFileSync(p, 'utf8'));

    // 文件数量一致
    expect(content1.length).toBe(content2.length);

    // 逐文件字节比对
    for (let i = 0; i < content1.length; i++) {
      expect(content1[i]).toBe(content2[i]);
    }
  });
});
