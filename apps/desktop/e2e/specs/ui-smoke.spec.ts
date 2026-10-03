import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchElectron, closeElectron, type ElectronHandle } from '../helpers/electron';
import { assertNoSecrets, assertWellFormedXml, extractSshConfigs } from '../helpers/assertions';
import { TEST_NODES } from '../fixtures/test-nodes';

/**
 * UI 冒烟测试：通过真实的按钮点击 + 弹窗交互走完整个导出流程。
 *
 * 与 datagrip-export.spec.ts / dbeaver-export.spec.ts 的 API 直调测试互补：
 * - API 直调测试负责深度断言（JSON/XML 结构、字段映射、确定性）；
 * - 本文件负责验证 UI 层（按钮、弹窗、勾选、确认按钮、toast）真实可达。
 *
 * 保存对话框通过 SQLDIFF_E2E_SAVE_DIR 环境变量跳过，
 * 因此 UI 流程可无阻塞地走完整条 saveTextFiles → file.save 路径。
 */

let handle: ElectronHandle;

test.beforeAll(async () => {
  handle = await launchElectron(TEST_NODES);
});

test.afterAll(async () => {
  await closeElectron(handle);
});

function cleanup(files: string[], dir: string): void {
  for (const f of files) {
    const p = join(dir, f);
    if (existsSync(p)) rmSync(p);
  }
}

test.describe('UI 冒烟：DataGrip 导出全链路', () => {
  test('点击 DataGrip 按钮 → 弹窗 → 勾选节点 → 点击导出 → 文件落盘', async () => {
    const { page, downloadsDir } = handle;

    cleanup(['dataSources.xml', 'dataSources.local.xml', 'sshConfigs.xml'], downloadsDir);

    // 1. 点击左侧「DataGrip」按钮打开导出弹窗。
    await page.getByRole('button', { name: 'DataGrip', exact: true }).click();

    // 2. 弹窗出现（dialog role）。
    const dialog = page.getByRole('dialog', { name: '导出到 DataGrip' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // 3. 弹窗默认全选所有节点；先「全不选」再只勾选私钥 SSH 节点（验证勾选操作）。
    await dialog.getByRole('button', { name: '全不选' }).click();
    await dialog.getByLabel('dev-db').check();

    // 4. 确认按钮文案应为「导出 1 个节点」。
    const exportBtn = dialog.getByRole('button', { name: '导出 1 个节点' });
    await expect(exportBtn).toBeEnabled();

    // 5. 点击导出。saveTextFiles 走 env 路径，无系统对话框，直接落盘。
    await exportBtn.click();

    // 6. 弹窗应关闭。
    await expect(dialog).not.toBeVisible();

    // 7. 验证 3 个文件都落盘（私钥 SSH 节点 → sshConfigs.xml 存在）。
    const dsPath = join(downloadsDir, 'dataSources.xml');
    const localPath = join(downloadsDir, 'dataSources.local.xml');
    const sshPath = join(downloadsDir, 'sshConfigs.xml');

    expect(existsSync(dsPath)).toBe(true);
    expect(existsSync(localPath)).toBe(true);
    expect(existsSync(sshPath)).toBe(true);

    // 8. XML well-formed 且 sshConfig 正确。
    const sshXml = readFileSync(sshPath, 'utf8');
    assertWellFormedXml(sshXml);
    const sshConfigs = extractSshConfigs(sshXml);
    expect(sshConfigs.length).toBe(1);
    expect(sshConfigs[0].authType).toBe('PRIVATE_KEY');
    expect(sshConfigs[0].host).toBe('dev-jump.internal');

    // 9. 无秘密字段。
    assertNoSecrets(readFileSync(dsPath, 'utf8'));
    assertNoSecrets(readFileSync(localPath, 'utf8'));
    assertNoSecrets(sshXml);
  });

  test('点击 DBeaver 按钮 → 弹窗 → 全不选 → 导出按钮 disabled', async () => {
    const { page } = handle;

    // 点击 DBeaver 按钮打开弹窗。
    await page.getByRole('button', { name: 'DBeaver', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出到 DBeaver' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // 全不选。
    await dialog.getByRole('button', { name: '全不选' }).click();

    // 导出按钮应 disabled（selectedCount === 0）。
    await expect(dialog.getByRole('button', { name: '导出 0 个节点' })).toBeDisabled();

    // 关闭弹窗。
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('DBeaver 导出成功 → 文件落盘且无秘密', async () => {
    const { page, downloadsDir } = handle;

    cleanup(['data-sources-sqldiff.json'], downloadsDir);

    // 打开 DBeaver 弹窗，默认全选 5 个节点。
    await page.getByRole('button', { name: 'DBeaver', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出到 DBeaver' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // 点击「导出 5 个节点」。
    await dialog.getByRole('button', { name: '导出 5 个节点' }).click();

    // 弹窗关闭。
    await expect(dialog).not.toBeVisible();

    // 文件落盘。
    const jsonPath = join(downloadsDir, 'data-sources-sqldiff.json');
    expect(existsSync(jsonPath)).toBe(true);

    // 内容无秘密。
    assertNoSecrets(readFileSync(jsonPath, 'utf8'));
  });
});
