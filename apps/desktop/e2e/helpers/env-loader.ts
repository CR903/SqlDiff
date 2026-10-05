// E2E 环境变量装载：`.env.e2e` 自动加载 + 必填变量诊断。
//
// 背景：preflight 真机 E2E 的目标机是虚拟机，**IP 每次重启都会变**，所以 host
// 不能写死在代码默认值里（写死后 IP 一变，spec 要么静默 skip、要么连到错误的那台
// 机器——后者更糟，因为它看起来跑通了）。真实 host 与密码只能从环境变量传入，
// 而手工 `export` 一串变量既繁琐又容易漏。
//
// 两个函数都是纯函数（外部 env 以参数注入，不直接依赖 `process.env` 的可变全局），
// 因此可以按测试门禁直接单测，无需 stub 全局。

import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';

/** 环境变量容器。`process.env` 满足该形状；测试可传普通对象。 */
export type EnvMap = Record<string, string | undefined>;

/** `loadEnvFile` 的结果。 */
export interface EnvFileLoad {
  /** 文件是否存在并被解析。`false` = 正常状态（主 harness 不需要 `.env.e2e`），静默。 */
  loaded: boolean;
  /** 实际写入 `env` 的键（仅 `.env.e2e` 独有、且 env 里原本没有的）。 */
  injected: string[];
  /** 因 `env` 里已存在而**保留原值、未被覆盖**的键。 */
  kept: string[];
}

/**
 * 加载 dotenv 文件到 `env`，**已存在的键不覆盖**。
 *
 * "已有优先"是安全边界而非便利性：否则开发者/CI 注入的
 * `E2E_MYSQL_57_PASSWORD=x` 会被本地文件里的旧值顶掉。
 * 判据是 `hasOwnProperty`（与 dotenv 自身的默认 `override: false` 一致）：
 * 即使外部注入的是空字符串，也算"已设置"，同样不被文件覆盖。
 *
 * 文件缺失时静默返回（`loaded: false`），不抛错——`.env.e2e` 不存在是**正常状态**
 * （`npm run e2e` 主 harness 完全不需要它）。诊断由各 spec 自己的 skip 消息给出。
 */
export function loadEnvFile(filePath: string, env: EnvMap): EnvFileLoad {
  if (!existsSync(filePath)) {
    return { loaded: false, injected: [], kept: [] };
  }
  const parsed = parse(readFileSync(filePath, 'utf8'));
  const injected: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      kept.push(key);
      continue;
    }
    env[key] = value;
    injected.push(key);
  }
  return { loaded: true, injected, kept };
}

/** `readRequiredEnv` 的结果。 */
export interface RequiredEnv {
  /** 全部命中时的取值，键为原始变量名。 */
  values: Record<string, string>;
  /** 未设置或为空字符串的变量名（保持传入顺序，便于诊断信息可读）。 */
  missing: string[];
}

/**
 * 读取一组**必填**环境变量，同时报告缺了哪些。
 *
 * 空字符串按"未设置"处理：空 host / 空密码对 spec 没有意义，
 * 与其让它在连库时才炸成一个费解的 socket 错误，不如当场 skip 并点名变量。
 */
export function readRequiredEnv(env: EnvMap, keys: readonly string[]): RequiredEnv {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined || raw === '') {
      missing.push(key);
      continue;
    }
    values[key] = raw;
  }
  return { values, missing };
}

/**
 * 生成 spec 的 skip 诊断文案。
 *
 * 刻意说明 **为什么**这个变量不能有代码默认值：目标机是虚拟机、IP 每次重启都变。
 * 不写这句话，下一个维护者只会看到"缺个环境变量"，很可能会"顺手"把默认值加回去，
 * 于是 IP 一变就静默连到错误的机器上。
 */
export function missingEnvReason(missing: readonly string[], envFileHint: string): string {
  const list = missing.join(' / ');
  return `缺少 ${list}。目标机是虚拟机，IP 每次重启都会变，因此代码里刻意不提供默认地址；`
    + `请在 ${envFileHint} 中填入真实 host 与密码（Playwright 会自动加载该文件），不要把 IP 写死回代码里。`;
}
