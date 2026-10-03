import { _electron, type ElectronApplication, type Page } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import type { NodeMeta } from '../../src-core/types';

export interface ElectronHandle {
  app: ElectronApplication;
  page: Page;
  tmpDir: string;
  userDataDir: string;
  downloadsDir: string;
}

/**
 * 启动 Electron 实例，预置测试节点数据，设置 E2E env。
 * 每个 spec 文件的 beforeAll 调用一次，afterAll 调用 closeElectron。
 *
 * E2E 保存目录通过 SQLDIFF_E2E_SAVE_DIR 环境变量注入，
 * save-file.ts 检测到后跳过系统对话框直接写入该目录。
 */
export async function launchElectron(nodes: NodeMeta[]): Promise<ElectronHandle> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sqldiff-e2e-'));
  const userDataDir = join(tmpDir, 'userData');
  const downloadsDir = join(tmpDir, 'downloads');

  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });

  // 写入测试用 nodes.json（模拟真实用户数据，经过完整 loadNodes → validate → render 路径）。
  writeFileSync(join(userDataDir, 'nodes.json'), JSON.stringify(nodes), 'utf8');

  // 启动 Electron（使用项目构建产物，非 dev server）。
  const app = await _electron.launch({
    args: [process.cwd(), '--disable-gpu', '--no-sandbox'],
    env: {
      ...process.env,
      SQLDIFF_USER_DATA_DIR: userDataDir,
      SQLDIFF_E2E_SAVE_DIR: downloadsDir,
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // 等待 store 完成节点加载（App 挂载后调 refreshNodes）。
  await page.waitForTimeout(1500);

  return { app, page, tmpDir, userDataDir, downloadsDir };
}

export async function closeElectron(handle: ElectronHandle): Promise<void> {
  await handle.app.close();
  rmSync(handle.tmpDir, { recursive: true, force: true });
}
