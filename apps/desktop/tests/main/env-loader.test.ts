// e2e/helpers/env-loader.ts 的单测。
//
// 覆盖任务门禁要求的三态：外部 env 优先 / 文件缺失静默 / 不覆盖已有值。
// 另外锁住 "host 无默认值" 的判据（readRequiredEnv），这是 R3 的行为契约：
// 目标机是虚拟机、IP 每次重启都变，代码里一旦出现默认 host，IP 一变就可能静默连错机器。
//
// 被测模块位于 e2e/helpers/（测试基础设施，不在 src-main/ 下），因此本文件不带
// tests/{core,main,converters,renderer} 的目录镜像前缀；文件名仍与模块同名。
//
// 说明：三个函数都不依赖 `process.env` 这个可变全局（env 以参数注入），
// 因此无需 stubEnv 即可断言"不覆盖"这条安全边界——真正被验证的就是传入的那个对象。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadEnvFile,
  readRequiredEnv,
  missingEnvReason,
  type EnvMap,
} from '../../e2e/helpers/env-loader';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqldiff-e2e-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一个 .env 文件，返回其绝对路径。 */
function writeEnv(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('loadEnvFile', () => {
  it('文件缺失时静默返回，不改动 env（主 harness 不需要 .env.e2e）', () => {
    const env: EnvMap = { EXISTING: 'keep-me' };

    const result = loadEnvFile(join(dir, 'does-not-exist.env'), env);

    expect(result).toEqual({ loaded: false, injected: [], kept: [] });
    expect(env).toEqual({ EXISTING: 'keep-me' });
  });

  it('文件存在时注入文件独有的键', () => {
    const path = writeEnv('.env.e2e', [
      'E2E_MYSQL_57_HOST=10.0.0.5',
      'E2E_MYSQL_57_PORT=3306',
      '',
    ].join('\n'));

    const env: EnvMap = {};

    const result = loadEnvFile(path, env);

    expect(result.loaded).toBe(true);
    expect(result.injected).toEqual(['E2E_MYSQL_57_HOST', 'E2E_MYSQL_57_PORT']);
    expect(result.kept).toEqual([]);
    expect(env.E2E_MYSQL_57_HOST).toBe('10.0.0.5');
    expect(env.E2E_MYSQL_57_PORT).toBe('3306');
  });

  it('已存在的键不被文件覆盖（外部 / CI 注入优先，这是安全边界）', () => {
    const path = writeEnv('.env.e2e', [
      'E2E_MYSQL_57_PASSWORD=from-file',
      'E2E_MYSQL_57_HOST=from-file',
    ].join('\n'));

    const env: EnvMap = { E2E_MYSQL_57_PASSWORD: 'from-shell' };

    const result = loadEnvFile(path, env);

    // 关键断言：命令行注入的密码胜出，文件里的旧值不能把它顶掉。
    expect(env.E2E_MYSQL_57_PASSWORD).toBe('from-shell');
    expect(result.kept).toEqual(['E2E_MYSQL_57_PASSWORD']);
    expect(result.injected).toEqual(['E2E_MYSQL_57_HOST']);
  });

  it('外部注入的空字符串也算"已设置"，不被文件覆盖', () => {
    // 与 dotenv 自身 override:false 的 hasOwnProperty 判据一致。
    // 若这里改成"非空才算已设置"，CI 显式清空一个变量时会被本地文件悄悄复活。
    const path = writeEnv('.env.e2e', 'E2E_MYSQL_57_PASSWORD=from-file\n');
    const env: EnvMap = { E2E_MYSQL_57_PASSWORD: '' };

    const result = loadEnvFile(path, env);

    expect(env.E2E_MYSQL_57_PASSWORD).toBe('');
    expect(result.kept).toEqual(['E2E_MYSQL_57_PASSWORD']);
    expect(result.injected).toEqual([]);
  });

  it('只有注释与空行的文件不注入任何键', () => {
    const path = writeEnv('.env.e2e', '# 只有注释\n\n   \n');

    const env: EnvMap = {};

    const result = loadEnvFile(path, env);

    expect(result.loaded).toBe(true);
    expect(result.injected).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(env).toEqual({});
  });

  it('文件内重复键后者覆盖前者（dotenv 自身语义）', () => {
    const path = writeEnv('.env.e2e', 'K=first\nK=second\n');

    const env: EnvMap = {};

    loadEnvFile(path, env);

    expect(env.K).toBe('second');
  });
});

describe('readRequiredEnv', () => {
  it('全部命中时返回取值且 missing 为空', () => {
    const env: EnvMap = {
      E2E_MYSQL_9_HOST: '10.0.0.9',
      E2E_MYSQL_9_PASSWORD: 'pw',
      UNRELATED: 'x',
    };

    const result = readRequiredEnv(env, ['E2E_MYSQL_9_HOST', 'E2E_MYSQL_9_PASSWORD']);

    expect(result.missing).toEqual([]);
    expect(result.values).toEqual({
      E2E_MYSQL_9_HOST: '10.0.0.9',
      E2E_MYSQL_9_PASSWORD: 'pw',
    });
  });

  it('host 缺失时点名该变量，且不返回任何取值（无默认 host 的判据）', () => {
    const env: EnvMap = { E2E_MYSQL_9_PASSWORD: 'pw' };

    const result = readRequiredEnv(env, ['E2E_MYSQL_9_HOST', 'E2E_MYSQL_9_PASSWORD']);

    expect(result.missing).toEqual(['E2E_MYSQL_9_HOST']);
    expect(result.values).toEqual({ E2E_MYSQL_9_PASSWORD: 'pw' });
    // 关键：没有 host 就没有 host 取值 —— spec 据此 skip，而不是去连某个默认地址。
    expect(result.values.E2E_MYSQL_9_HOST).toBeUndefined();
  });

  it('空字符串按未设置处理', () => {
    const env: EnvMap = { E2E_MYSQL_9_HOST: '', E2E_MYSQL_9_PASSWORD: '' };

    const result = readRequiredEnv(env, ['E2E_MYSQL_9_HOST', 'E2E_MYSQL_9_PASSWORD']);

    expect(result.missing).toEqual(['E2E_MYSQL_9_HOST', 'E2E_MYSQL_9_PASSWORD']);
    expect(result.values).toEqual({});
  });

  it('保持传入顺序，便于诊断文案可读', () => {
    const env: EnvMap = {};

    const result = readRequiredEnv(env, ['B_HOST', 'A_HOST']);

    expect(result.missing).toEqual(['B_HOST', 'A_HOST']);
  });

  it('空 keys 列表不报错', () => {
    const result = readRequiredEnv({ A: '1' }, []);

    expect(result).toEqual({ values: {}, missing: [] });
  });
});

describe('missingEnvReason', () => {
  it('点名缺失变量并说明为什么不能有默认值', () => {
    const reason = missingEnvReason(['E2E_MYSQL_9_HOST'], 'apps/desktop/.env.e2e');

    expect(reason).toContain('E2E_MYSQL_9_HOST');
    expect(reason).toContain('apps/desktop/.env.e2e');
    // 这句是防回归的重点：不解释"IP 是动态的"，下一个人会把默认 host 加回去。
    expect(reason).toContain('IP 每次重启都会变');
    expect(reason).toContain('不要把 IP 写死回代码里');
  });

  it('多个缺失变量全部列出', () => {
    const reason = missingEnvReason(
      ['E2E_MYSQL_9_HOST', 'E2E_MYSQL_9_PASSWORD'],
      'apps/desktop/.env.e2e',
    );

    expect(reason).toContain('E2E_MYSQL_9_HOST / E2E_MYSQL_9_PASSWORD');
  });
});