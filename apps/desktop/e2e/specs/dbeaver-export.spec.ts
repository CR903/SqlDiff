import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { launchElectron, closeElectron, type ElectronHandle } from '../helpers/electron';
import {
  assertNoSecrets,
  parseDBeaverJson,
} from '../helpers/assertions';
import { TEST_NODES, DIRECT_NODE_ID, PWD_SSH_NODE_ID, KEY_SSH_NODE_ID } from '../fixtures/test-nodes';

let handle: ElectronHandle;

test.beforeAll(async () => {
  handle = await launchElectron(TEST_NODES);
});

test.afterAll(async () => {
  await closeElectron(handle);
});

/** 在弹窗中通过直接调用 API 导出（绕过 UI 点击，用于确定性测试）。 */
async function exportViaApi(
  page: ElectronHandle['page'],
  ids: string[],
): Promise<string[]> {
  const result = await page.evaluate(async (nodeIds: string[]) => {
    const api = (window as unknown as { sqldiff: unknown }).sqldiff as {
      nodes: { exportDbeaver: (ids: string[]) => Promise<{ fileName: string; content: string; exportedCount: number; warnings: string[] }> };
      file: { save: (req: { kind: string; files: { name: string; content: string }[]; title: string }) => Promise<{ status: string; filePaths?: string[] }> };
    };
    if (!api) throw new Error('window.sqldiff not available');
    const exportResult = await api.nodes.exportDbeaver(nodeIds);
    const saveResult = await api.file.save({
      kind: 'bundle',
      files: [{ name: exportResult.fileName, content: exportResult.content }],
      title: '导出 DBeaver 连接配置',
    });
    if (saveResult.status !== 'saved') throw new Error(`Save failed: ${JSON.stringify(saveResult)}`);
    return saveResult.filePaths as string[];
  }, ids);
  return result;
}

test.describe('DBeaver 导出', () => {
  test('导出单个直连节点', async () => {
    const { page } = handle;

    // 通过 API 导出单个直连节点
    const filePaths = await exportViaApi(page, [DIRECT_NODE_ID]);
    expect(filePaths.length).toBe(1);
    expect(existsSync(filePaths[0])).toBe(true);

    const content = readFileSync(filePaths[0], 'utf8');
    const json = parseDBeaverJson(content);

    // JSON 顶层结构
    expect(json.folders).toEqual({});
    expect(json['connection-types']).toEqual({});

    // 连接数
    expect(Object.keys(json.connections).length).toBe(1);

    // 找到唯一的连接
    const conn = Object.values(json.connections)[0];
    expect(conn).toBeDefined();

    // MySQL 直连字段
    expect(conn.provider).toBe('mysql');
    expect(conn.driver).toBe('mysql8');
    expect(conn['save-password']).toBe(false);
    expect(conn.configuration.configurationType).toBe('MANUAL');
    expect(conn.configuration['auth-model']).toBe('native');
    expect(conn.configuration['auth-properties'].userName).toBe('app_user');
    expect(conn.configuration.host).toBe('db.internal');
    expect(conn.configuration.port).toBe('3306');
    expect(conn.configuration.database).toBe('shop');

    // 无 SSH handler
    expect(conn.configuration.handlers).toBeUndefined();

    // 无秘密字段
    assertNoSecrets(content);
  });

  test('导出含 SSH 的节点', async () => {
    const { page } = handle;

    // 导出密码 SSH + 私钥 SSH 两个节点
    const filePaths = await exportViaApi(page, [PWD_SSH_NODE_ID, KEY_SSH_NODE_ID]);
    expect(filePaths.length).toBe(1);
    expect(existsSync(filePaths[0])).toBe(true);

    const content = readFileSync(filePaths[0], 'utf8');
    const json = parseDBeaverJson(content);

    // 两个连接
    expect(Object.keys(json.connections).length).toBe(2);

    const conns = Object.values(json.connections);

    // 密码 SSH 节点
    const pwdConn = conns.find((c) => c.name === 'staging-db');
    expect(pwdConn).toBeDefined();
    expect(pwdConn?.configuration.handlers?.ssh_tunnel).toBeDefined();
    expect(pwdConn?.configuration.handlers?.ssh_tunnel?.properties?.authType).toBe('PASSWORD');
    expect(pwdConn?.configuration.handlers?.ssh_tunnel?.properties?.host).toBe('jump.internal');
    expect(pwdConn?.configuration.handlers?.ssh_tunnel?.properties?.port).toBe(2222);
    expect(pwdConn?.configuration.handlers?.ssh_tunnel?.properties?.user).toBe('ops');

    // 私钥 SSH 节点
    const keyConn = conns.find((c) => c.name === 'dev-db');
    expect(keyConn).toBeDefined();
    expect(keyConn?.configuration.handlers?.ssh_tunnel).toBeDefined();
    expect(keyConn?.configuration.handlers?.ssh_tunnel?.properties?.authType).toBe('PUBLIC_KEY');
    expect(keyConn?.configuration.handlers?.ssh_tunnel?.properties?.host).toBe('dev-jump.internal');

    // 无 keyPath/keyValue
    const handlerJson = JSON.stringify(conns.flatMap((c) => c.configuration.handlers ?? []));
    expect(handlerJson).not.toContain('keyPath');
    expect(handlerJson).not.toContain('keyValue');

    // 无秘密字段
    assertNoSecrets(content);
  });

  test('确定性：不同输入顺序 → 相同内容', async () => {
    const { page } = handle;

    // 第一次导出（按定义顺序）
    const result1 = await exportViaApi(page, [
      'e2e-direct', 'e2e-pwd-ssh', 'e2e-key-ssh',
    ]);
    const content1 = readFileSync(result1[0], 'utf8');

    // 第二次导出（反转顺序）
    const result2 = await exportViaApi(page, [
      'e2e-key-ssh', 'e2e-pwd-ssh', 'e2e-direct',
    ]);
    const content2 = readFileSync(result2[0], 'utf8');

    // 内容完全一致
    expect(content1).toBe(content2);
  });
});
