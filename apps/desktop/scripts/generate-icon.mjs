#!/usr/bin/env node
/* global Buffer, clearTimeout, console, process, setTimeout */

import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RENDER_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const ICONSET_ENTRIES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const rendererSource = String.raw`'use strict';

const { app, BrowserWindow } = require('electron');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');

app.disableHardwareAcceleration();

const sourcePath = process.env.SQLDIFF_ICON_SOURCE;
const outputDir = process.env.SQLDIFF_ICON_OUTPUT;
const sizesValue = process.env.SQLDIFF_ICON_SIZES;
const sizes = sizesValue ? sizesValue.split(',').map(Number) : [];

async function render() {
  if (!sourcePath || !outputDir || sizes.some((size) => !Number.isInteger(size) || size <= 0)) {
    throw new Error('Invalid icon renderer arguments');
  }

  const windows = [];
  for (const size of sizes) {
    const window = new BrowserWindow({
      width: size,
      height: size,
      useContentSize: true,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: '#00000000',
      autoHideMenuBar: true,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    windows.push(window);

    window.webContents.setFrameRate(30);
    window.setMenu(null);
    await window.loadFile(sourcePath);
    await window.webContents.executeJavaScript(
      "(async () => { if (document.fonts) await document.fonts.ready; " +
        "await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()",
      true,
    );

    const image = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    const dimensions = image.getSize();
    if (dimensions.width !== size || dimensions.height !== size) {
      throw new Error(
        'Electron returned a ' + dimensions.width + 'x' + dimensions.height +
        ' capture for the requested ' + size + 'x' + size + ' icon',
      );
    }

    const png = image.toPNG();
    if (png.length === 0) {
      throw new Error('Electron returned an empty PNG for size ' + size);
    }

    const destination = join(outputDir, 'icon-' + size + '.png');
    await writeFile(destination, png);
    process.stdout.write('[generate-icon] rendered icon-' + size + '.png\n');
  }

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

app.whenReady().then(async () => {
  try {
    await render();
    app.exit(0);
  } catch (error) {
    console.error('[generate-icon] Electron renderer failed:', error);
    app.exit(1);
  }
});
`;

function describeCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(' ');
}

function runCommand(command, args, options = {}) {
  const { timeoutMs = 120_000, ...spawnOptions } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const label = describeCommand(command, args);
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...spawnOptions,
    });
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`Command timed out: ${label}`));
    }, timeoutMs);

    child.once('error', (error) => {
      finish(new Error(`Unable to start ${label}: ${error.message}`, { cause: error }));
    });

    child.once('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      finish(new Error(`Command failed with ${reason}: ${label}`));
    });
  });
}

async function assertPng(filePath, expectedSize) {
  const png = await readFile(filePath);
  if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`Invalid PNG data: ${filePath}`);
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(
      `Unexpected PNG dimensions in ${filePath}: ${width}x${height}; expected ${expectedSize}x${expectedSize}`,
    );
  }
}

async function createIco(stageDir) {
  const images = [];
  for (const size of ICO_SIZES) {
    const filePath = join(stageDir, `icon-${size}.png`);
    const image = await readFile(filePath);
    if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`Invalid ICO source PNG: ${filePath}`);
    }
    images.push({ size, image });
  }

  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach(({ size, image }, index) => {
    const entryOffset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += image.length;
  });

  const ico = Buffer.concat([header, ...images.map(({ image }) => image)]);
  await writeFile(join(stageDir, 'icon.ico'), ico);
}

async function createIcns(stageDir) {
  if (process.platform !== 'darwin') {
    throw new Error('Creating icon.icns requires macOS and the iconutil command');
  }

  const iconsetDir = join(stageDir, 'icon.iconset');
  await mkdir(iconsetDir);
  for (const [filename, sourceSize] of ICONSET_ENTRIES) {
    await copyFile(join(stageDir, `icon-${sourceSize}.png`), join(iconsetDir, filename));
  }

  const outputPath = join(stageDir, 'icon.icns');
  await runCommand('iconutil', ['-c', 'icns', iconsetDir, '-o', outputPath]);

  const signature = (await readFile(outputPath)).subarray(0, 4).toString('ascii');
  if (signature !== 'icns') {
    throw new Error(`iconutil produced an invalid ICNS file: ${outputPath}`);
  }
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(scriptDir, '..');
  const buildDir = join(appDir, 'build');
  const outputDir = join(buildDir, 'icon');
  const sourcePath = join(scriptDir, 'icon-source.html');

  await access(sourcePath);
  await mkdir(buildDir, { recursive: true });
  const stageDir = await mkdtemp(join(buildDir, '.icon-'));
  let published = false;

  try {
    const require = createRequire(import.meta.url);
    const electronBinary = require('electron');
    const rendererPath = join(stageDir, '.render-icon.cjs');
    await writeFile(rendererPath, rendererSource, 'utf8');

    console.log(`[generate-icon] Rendering ${RENDER_SIZES.join(', ')} px with Electron`);
    await runCommand(
      electronBinary,
      ['--force-device-scale-factor=1', rendererPath],
      {
        cwd: appDir,
        env: {
          ...process.env,
          SQLDIFF_ICON_SOURCE: sourcePath,
          SQLDIFF_ICON_OUTPUT: stageDir,
          SQLDIFF_ICON_SIZES: RENDER_SIZES.join(','),
        },
      },
    );
    await rm(rendererPath);

    for (const size of RENDER_SIZES) {
      await assertPng(join(stageDir, `icon-${size}.png`), size);
    }
    await copyFile(join(stageDir, 'icon-1024.png'), join(stageDir, 'icon.png'));
    await createIco(stageDir);
    await createIcns(stageDir);

    const requiredOutputs = [
      'icon.png',
      'icon.icns',
      'icon.ico',
      ...RENDER_SIZES.map((size) => `icon-${size}.png`),
    ];
    for (const filename of requiredOutputs) {
      const details = await stat(join(stageDir, filename));
      if (details.size === 0) {
        throw new Error(`Generated an empty icon output: ${filename}`);
      }
    }

    await rm(outputDir, { recursive: true, force: true });
    await rename(stageDir, outputDir);
    published = true;

    console.log(`[generate-icon] Created ${outputDir}`);
    console.log(`[generate-icon] PNG sizes: ${RENDER_SIZES.join(', ')}`);
    console.log('[generate-icon] ICO sizes: 16, 32, 48, 64, 128, 256');
  } finally {
    if (!published) {
      await rm(stageDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`[generate-icon] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
