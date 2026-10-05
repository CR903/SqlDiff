# 2026-10-05 e2e-env-readiness

## 做了什么

把 preflight 真机 E2E 从「必须手工 export 一串变量 + 依赖写死 IP」改成「填好 `.env.e2e` 就一键跑通」。

1. **5.7 远程账号**：在 `192.168.2.84` 的 MySQL 5.7.44 上建 `sqldiff@'%'`（密码由用户指定，不入库），授 fixture 库 ALL + 全局 `SELECT, REPLICATION CLIENT, SUPER`。
2. **dotenv 自动加载**：`dotenv` 从传递依赖提升为显式 devDependency；新增 `e2e/helpers/env-loader.ts`（纯函数），在 `playwright.config.ts` 加载 `.env.e2e`。
3. **spec 去写死 IP**：两个 preflight spec 移除 `defaultHost`，改为缺失即 skip + 点名变量。
4. **8.x 单机化**：删除 8.0.26 describe 与 `E2E_MYSQL_15_*`，只留 8.0.46。变量名 `E2E_MYSQL_9_*` 保留不改。
5. **单测**：`tests/main/env-loader.test.ts` 13 项（外部 env 优先 / 文件缺失静默 / 空串算已设置 / skip 文案）。

## 为什么这么做

用户说明目标机都是虚拟机，**每次重启 IP 会变**。原先 spec 里 `defaultHost` 写死 `192.168.5.9` / `.15`，IP 一变的后果不是「连不上」，而是「连到错误的那台机器」——后者更糟，因为它看起来跑通了。

同时实测发现 `.env.e2e.example` 写着「复制为 `.env.e2e` 并填入真实密码」，但全仓无 dotenv 加载代码，**填了也不生效**。文档与实现的偏差让每跑一次真机都要先手工 export 一串变量，密码还容易进 shell history。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `e2e/helpers/env-loader.ts` | 新建：`loadEnvFile` / `readRequiredEnv` / `missingEnvReason` 三个纯函数 |
| `tests/main/env-loader.test.ts` | 新建 13 项单测 |
| `e2e/playwright.config.ts` | 加载 `.env.e2e`（用 `__dirname`，与 cwd 无关） |
| `e2e/specs/preflight-on-mysql-8.spec.ts` | 删 8.0.26 describe；去写死 IP；`loadMysqlEnvConfig()` 去掉 suffix 参数 |
| `e2e/specs/preflight-on-mysql-5-7.spec.ts` | 去写死 IP；改用 `readRequiredEnv` |
| `e2e/helpers/preflight-fixture.ts` | 9 行 JSDoc（双机分叉 → 版本阈值表述），函数体零改动 |
| `e2e/fixtures/mysql-fixture.ts` | 1 行注释（版本示例） |
| `.env.e2e.example` | 删 8.0.26 段；补 dotenv 自动加载说明 |
| `package.json` / `package-lock.json` | 显式声明 dotenv |
| `eslint.config.mjs` | 补 `playwright-report` / `test-results` 到 ignores（终审修复） |
| `.trellis/spec/backend/e2e-harness.md` | 同步版本矩阵、断言清单、触发方式 |

产品代码 `src-core/` / `src-main/` / `src-renderer/` **零改动**。

## 踩到的坑

**① dotenv 判据不能用真值**：`if (env[key]) continue` 会让外部注入的空串被文件里的旧值覆盖——「显式清空」变成「静默回退到陈旧凭据」。必须用 `hasOwnProperty`。终审用变异测试自证：改成真值判断 → 套件变红。

**② skip 消息是防回退护栏**：不写「为什么不给默认地址」，下一个维护者看到「缺个环境变量」很可能「顺手」把默认值加回去。终审实测过端到端：置 `E2E_MYSQL_57_HOST=` 后 skip 消息正确点名变量，且文件里的真实 host **没有被注入**。

**③ lint ignore 要与 .gitignore 同步**（终审发现）：跑过一次 e2e 后 `playwright-report/trace/assets/*.js` 让 `eslint .` 报 **3965 errors**，全是 `no-undef` 误报。之前没人踩到是因为没人真跑过 E2E；本任务把 E2E 变成常规路径后，第一次跑完就会把 Required Quality Gate 打红。已在 `eslint.config.mjs` 补 ignores。

**④ `dotenv` 的 lockfile `resolved` 被本地镜像污染**：本地 npm 镜像把 `registry.npmjs.org` 改成了 `registry.npmmirror.com`。dotenv 本就在 lockfile 里（传递依赖），本次只需加根 `devDependencies` 一行，改 `resolved` 是无关 churn，会让走官方源的 CI 解析到国内镜像。已改回。

**⑤ 服务器 SSH 传长 SQL 会卡**：反引号与多层引号被 shell 吃掉，且长命令触发 expect 超时。改为逐条执行短 SQL（`sqldiff@"%"` 双引号形式可避开反引号）。

**⑥ spec 里 `schemaVersion` 口径整体停在 v1**（spec 更新阶段发现，任务外漂移）：3 处写 `=== 1`，而常量 `PREFLIGHT_REPORT_VERSION` 早已是 `2`（schema v2 在更早的 `preflight.md` §15 就落地了）。其中 `frontend/quality-guidelines.md:69` 尤其危险——它指导未来写的 UI 导出测试去断言 `=== 1`，照做必然失败。另两处在 §14.9「回滚」标题下，是对当时任务的历史陈述，**故意不改**（改了等于伪造历史）。

**规律**：这次漂移和前一轮 `mysqldiff/` 引用漂移同源——**spec 里写死的常量值比代码更难发现**，因为它读起来像事实陈述，不像待更新的占位符。改代码时顺手核一遍 spec 里的字面量断言。

## 可沉淀知识

已写入 [`docs/knowledge/common/best-practices/e2e-env-config.md`](../knowledge/common/best-practices/e2e-env-config.md)（并入 `common/best-practices` 现有分类，未新建分类）：

- dotenv 加载的 `hasOwnProperty` 判据（空串算已设置）
- 动态目标机不给默认地址 + skip 消息写明「为什么」
- lint ignore 与 .gitignore 同步

## 验证

- `npx vitest run` → **50 文件 / 748 项全绿**（原 735，+13）
- `npm run typecheck` / `lint` / `build` → 全绿
- **真机 E2E**：`npm run e2e:preflight:mysql` → 5.7.44 + 8.0.46 共 **4 项全过**（约 50s，真实执行非 skip）
- **安全验证**：`E2E_MYSQL_57_PASSWORD=wrong-password-xyz npm run e2e:preflight:mysql57` → **2 项失败**，证明外部 env 优先于文件
- **cleanup**：两台 `SHOW DATABASES LIKE 'sqldiff_preflight_test%'` 均 CLEAN
- **静态**：`grep "192\.168\." e2e/ src-*/` 为空；`git grep -i "DB.smarterlab"` 为 0；`git ls-files` 不含 `.env.e2e`
- **变异自证**：`hasOwnProperty` → 真值判断，套件变红
- **产品代码零改动**：`git diff --name-only` 不含 `src-core/` `src-main/` `src-renderer/`

## 遗留 / 后续

- **版本矩阵收缩**：原 8.x 双机（8.0.46 + 8.0.26）现只剩 8.0.46。`192.168.5.9` / `.15` 实测 TCP 可连但 MySQL 握手 ETIMEDOUT，已废弃。**8.0.29 分叉**（`DROP COLUMN` 从 INPLACE 变 INSTANT）现在无真机覆盖——5.7 覆盖「全 INPLACE」侧、8.0.46 覆盖「全 INSTANT」侧，中间版本（8.0.12–8.0.28）无真机。拿到机器后可另开任务。
- 远端环境变更（5.7 账号、`.env.e2e`）不在仓库内，换机器需重建。
- UI 层 Preflight 按钮 E2E、SSH 隧道真机覆盖仍不在范围。
