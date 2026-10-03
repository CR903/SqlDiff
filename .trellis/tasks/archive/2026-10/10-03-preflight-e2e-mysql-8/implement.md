# Implement — Preflight E2E on MySQL 8

## 1. 前置准备

- [ ] 确认两台 MySQL 8.x 可达：`node -e "require('mysql2/promise').createConnection({...}).query('SELECT VERSION()')"`（前置任务已验过，可跳过）
- [ ] 写 `.env.e2e.example`（`.env.e2e` 已加 .gitignore）：
  ```
  E2E_MYSQL_9_HOST=192.168.5.9
  E2E_MYSQL_9_PORT=3306
  E2E_MYSQL_9_USER=root
  E2E_MYSQL_9_PASSWORD=***
  E2E_MYSQL_9_DATABASE=sqldiff_preflight_test_8_0_46
  
  E2E_MYSQL_15_HOST=192.168.5.15
  E2E_MYSQL_15_PORT=3306
  E2E_MYSQL_15_USER=root
  E2E_MYSQL_15_PASSWORD=***
  E2E_MYSQL_15_DATABASE=sqldiff_preflight_test_8_0_26
  
  E2E_RUN_PREFLIGHT_MYSQL=1
  ```
- [ ] `.gitignore` 追加 `.env.e2e`（若未包含）

## 2. Fixture 建库模块（`apps/desktop/e2e/fixtures/mysql-fixture.ts`）

- [ ] 新建 `apps/desktop/e2e/fixtures/mysql-fixture.ts`
- [ ] 导出 `createFixtureDatabase(host, port, user, password, database, version): Promise<void>`
- [ ] 导出 `dropFixtureDatabase(host, port, user, password, database): Promise<void>`
- [ ] 8 表 CREATE SQL 全部幂等（DROP IF EXISTS → CREATE）
- [ ] `users_big` 数据用翻倍 INSERT 20 次（≈100 万行）
- [ ] `config_wide` 用循环生成 100 列（`c01...c100`）
- [ ] 使用现有 `mysql2/promise`，不引入新依赖
- [ ] 中文注释、2 空格缩进、LF、UTF-8

**校验**：手动跑一次 fixture，`SELECT COUNT(*) FROM users_big` ≥ 100 万；8 表全部存在；`DROP DATABASE` 后无残留

## 3. Fixture items 与断言工具（`apps/desktop/e2e/helpers/preflight-fixture.ts`）

- [ ] 新建 `apps/desktop/e2e/helpers/preflight-fixture.ts`
- [ ] 导出 `buildFixtureItems(): DiffItem[]`（11 项，覆盖 10 DdlOp + 1 OTHER）
- [ ] 导出 `assertReportStructure(report: PreflightReport): void`：
  - `schemaVersion === 1`
  - `source === 'real'`
  - `facts.length > 0`
  - 6 category（server/variables/tables/indexes/permissions/ddl）至少各有一个 fact 或 inference
  - `verdict.level` 是 `'pass'|'warn'|'block'|'unknown'` 之一
- [ ] 导出 `findInferenceBySubject(report, subject): PreflightInference | undefined`
- [ ] 导出 `findIssueById(report, issueId): PreflightIssue | undefined`
- [ ] 导出 `assertInstantAddDrop(report, expectedDropAlgo): void`：
  - 找到 `ADD_COLUMN` Inference → `algorithm === 'INSTANT'`
  - 找到 `DROP_COLUMN` Inference → `algorithm === expectedDropAlgo`

**校验**：单元级 import 编译通过；断言工具对空 report 抛错

## 4. E2E spec（`apps/desktop/e2e/specs/preflight-on-mysql-8.spec.ts`）

- [ ] 新建 spec，参数化两台机器
- [ ] 顶部读环境变量：
  ```ts
  const cfg9 = loadMysqlConfig('9');   // { host, port, user, password, database }
  const cfg15 = loadMysqlConfig('15');
  const RUN_MYSQL = process.env.E2E_RUN_PREFLIGHT_MYSQL === '1';
  ```
- [ ] 未开启开关时 `test.describe.skip` 整套 spec
- [ ] 单个机器凭据缺失时对应 describe.skip
- [ ] 每个 describe 内部 `beforeAll` 建 fixture，`afterAll` cleanup
- [ ] `beforeAll` 中通过 Playwright `page.evaluate` 调 `window.sqldiff.nodes.create` 注册测试节点（参考 `dbeaver-export.spec.ts` 的 `TEST_NODES` 模式）
- [ ] `beforeAll` 里通过 `page.evaluate` 调 `window.sqldiff.preflight.run` 跑 preflight
- [ ] 断言清单：
  - `schemaVersion === 1`
  - `server.mysql_version` fact 与 fixture 版本一致（8.0.26 或 8.0.46）
  - `facts` 至少含 6 category
  - `permissions.visibility` 存在（'full' | 'partial' | 'none' 之一）
  - `table.users_big.rows` fact 存在且 `value ≥ 1_000_000`
  - `findInferenceBySubject(report, 'diff-item:d01')` 存在，`algorithm === 'INSTANT'`（ADD_COLUMN 双机一致）
  - `findInferenceBySubject(report, 'diff-item:d02')` 存在，`algorithm === expectedDropAlgo`（8.0.26 → INPLACE；8.0.46 → INSTANT）
  - `findInferenceBySubject(report, 'diff-item:d11')` 不存在（OTHER 分类）
  - `report.unknowns.some(u => u.reason === 'unparsed-ddl' && u.subject === 'diff-item:d11')`（OTHER → Unknown）
  - `findIssueById(report, 'LARGE_TABLE_INSTANT_ADD:table.users_big')` 存在（severity='warn'，正面提示）
- [ ] `READ_ONLY_TARGET` 触发验证：单独一个 test 里
  - `page.evaluate` 内 `SET GLOBAL read_only=1`
  - 跑 preflight → 断言 `findIssueById(report, 'READ_ONLY_TARGET')` severity='block'
  - **finally** `SET GLOBAL read_only=0`（无论成败）
- [ ] Playwright `workers: 1`（已由 playwright.config.ts 设定）

**校验**：`E2E_RUN_PREFLIGHT_MYSQL=1` 环境变量设置后 `npm run e2e --grep preflight` 全绿；未设置时 `npm run e2e` 全绿（skip 该 spec）

## 5. npm script（`package.json`）

- [ ] 追加 `"e2e:preflight:mysql": "cross-env E2E_RUN_PREFLIGHT_MYSQL=1 npx playwright test --config e2e/playwright.config.ts --grep preflight"`
- [ ] 检查 `cross-env` 是否已在 devDependencies（如果没有，用 shell 前缀 `. ./.env.e2e && npx playwright test ...`）

**校验**：`npm run e2e:preflight:mysql` 命令一键启动，两台机器跑通

## 6. 规格文档更新（`.trellis/spec/backend/e2e-harness.md`）

- [ ] 在现有 e2e-harness.md 末尾追加「Preflight E2E on Real MySQL」章节：
  - 触发方式：`npm run e2e:preflight:mysql`（依赖环境变量）
  - 版本矩阵：8.0.26（INSTANT DROP 不生效）/ 8.0.46（INSTANT DROP 生效）
  - 8 表 fixture 覆盖清单
  - 断言清单（11 项）
  - 5.7 缺口说明（follow-up）
- [ ] 更新 `.trellis/spec/backend/index.md` 中 e2e-harness 章节的 use 描述

**校验**：文档 lint（可选）、章节可发现性

## 7. 全量验证（不阻塞实现）

- [ ] `cd apps/desktop && npm run typecheck`
- [ ] `cd apps/desktop && npm run lint`
- [ ] `cd apps/desktop && npm test`（558 项全绿不回归）
- [ ] `cd apps/desktop && E2E_RUN_PREFLIGHT_MYSQL=1 npm run e2e`（手动跑一次）
- [ ] `cd apps/desktop && npm run e2e`（未设置开关时全套跳过 preflight spec 仍全绿）

## Validation

```bash
cd apps/desktop
npm run typecheck
npm run lint
npm test
# 手动跑 e2e：
E2E_RUN_PREFLIGHT_MYSQL=1 \
E2E_MYSQL_9_PASSWORD='<pw9>' \
E2E_MYSQL_15_PASSWORD='<pw15>' \
npm run e2e:preflight:mysql
```

## Risky Files / Rollback Points

| 文件 | 风险 | 回滚 |
|---|---|---|
| `apps/desktop/e2e/fixtures/mysql-fixture.ts` | 建库 SQL 可能超时/失败 | 独立文件，删除即可 |
| `apps/desktop/e2e/helpers/preflight-fixture.ts` | 断言逻辑错误 | 独立文件，删除即可 |
| `apps/desktop/e2e/specs/preflight-on-mysql-8.spec.ts` | 断言过严导致 flaky | 独立文件，删除即可 |
| `package.json` | 新增 script 名冲突 | 只增不删，回滚删该行 |
| `.trellis/spec/backend/e2e-harness.md` | 追加段落 | 追加，回滚删段落 |

**产品代码零风险**：`git diff -- apps/desktop/src-main/ apps/desktop/src-core/ apps/desktop/src-renderer/` 应为空

## Review Gates

1. 步骤 2-3 后：手动跑 fixture + 手工构造 items，typecheck 全绿
2. 步骤 4 后：单机（8.0.26）跑通所有断言
3. 步骤 5 后：双机串跑通；`npm run e2e` 未设开关时该 spec 静默 skip
4. 步骤 6-7 后：typecheck/lint/test 四件套全绿，进入 `trellis-check`

## Before `task.py start`

- [ ] 用户已明确批准本 PRD + Design + Implement
- [ ] 两台 MySQL 的 root 密码已放入 `.env.e2e`（不入库）
- [ ] MySQL 5.7 follow-up 已记入本任务 notes
