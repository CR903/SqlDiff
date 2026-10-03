# Preflight E2E on MySQL 8（真实库验证）

## 背景

`10-03-production-preflight` 补齐 12/12 AC、6 commits 收尾，但 Step 11「Docker MySQL 5.7 + 8.0 fixture 集成测试」因环境无 Docker 被跳过，task.json notes 明确记录「已完成的替代证据：preflight-collect.test.ts 27 项 + preflight-run.test.ts 18 项 + 全套 168 preflight 单测 + grep 硬边界」。

单元与编排层已证明**代码正确性**，但**真实 MySQL 交互层**（information_schema 真实 schema、SHOW GRANTS 真实输出、SHOW REPLICA STATUS 真实降级、真实 DDL 字符串的 parse 结果）从未跑过一次。本任务补齐这一层验证。

## 前置

- `10-03-production-preflight` 已完成（commit `a3a5071..c62234e`），PreflightReport v1 契约与 UI 均已上线
- `10-03-datagrip-cdp-harness` 已完成，Playwright + Electron CDP harness 已在 `apps/desktop/e2e/` 就位，`npm run e2e` 一键可跑
- 两台真实 MySQL 8.x 开发机可达，均支持建库：
  - `192.168.5.9` → MySQL **8.0.46**（≥8.0.29，INSTANT ADD + INSTANT DROP 均支持）
  - `192.168.5.15` → MySQL **8.0.26**（≥8.0.12 但 <8.0.29，INSTANT ADD 支持、INSTANT DROP 不支持）

## 范围

### 必须做

- [ ] **Fixture 建库模块**：`apps/desktop/e2e/fixtures/mysql-fixture.ts`，输入 host/port/user/pass，输出已建好的 8 表测试库 + 清理函数
- [ ] **8 表 fixture**（覆盖 preflight 9 条规则的触发面）：
  - `orders_empty` — 有 PK、空表（baseline）
  - `users_big` — 有 PK、~100 万行（触发 `BIG_TABLE_COPY` + `LARGE_TABLE_INSTANT_ADD` 阈值）
  - `products_no_pk` — 无主键（触发 `NO_PRIMARY_KEY`）
  - `tags_unique` — 有 UNIQUE 索引（触发 `ADD_UNIQUE_INDEX` rebuild）
  - `events_fk` — 有外键（触发 FK 相关分类）
  - `config_wide` — 宽表，100+ 列（覆盖列多场景）
  - `audit_pk_unique` — 同时有 PK + UNIQUE 索引
  - `slow_log_no_index` — 有数据但无索引
- [ ] **E2E spec**：`apps/desktop/e2e/specs/preflight-on-mysql-8.spec.ts`，参数化跑两台机器
- [ ] **PreflightRequest items 构造**：手工构造覆盖 10+ DDL 分类的 DDL 字符串（`ADD_COLUMN` / `DROP_COLUMN` / `ADD_INDEX` / `ADD_UNIQUE_INDEX` / `DROP_INDEX` / `ADD_PRIMARY_KEY` / `CHANGE_COLUMN` / `MODIFY_COLUMN` / `CONVERT_TO_CHAR_SET` / `CHANGE_ENGINE` / `OTHER`）
- [ ] **断言覆盖**：
  - `PreflightReport` schema 完整性：`schemaVersion=1` / `source='real'` / 6 category 均有 fact / `verdict` 存在
  - 6 类 Fact 各自非空（server / variables / tables / indexes / permissions / ddl inference）
  - `permissions.visibility` 真实返回（不是 mock）
  - `server.mysql_version` 与 fixture 建库机器版本一致
  - `table.<t>.rows` 与建表后实际 `SELECT COUNT(*)` 一致（`users_big` 至少 100 万行）
  - **版本分叉断言**（关键）：对同一条 `ALTER TABLE ... ADD COLUMN` 与 `DROP COLUMN` DDL，8.0.26 与 8.0.46 的 Inference `algorithm` 字段表现差异：8.0.26 `DROP_COLUMN` → `INPLACE + rebuildsTable=true`；8.0.46 `DROP_COLUMN` → `INSTANT + rebuildsTable=false`
  - `READ_ONLY_TARGET` 触发验证：临时 `SET GLOBAL read_only=1`（在 fixture 建表后独立子事务中，跑 preflight，再 `SET GLOBAL read_only=0` 还原）→ 断言 issue `READ_ONLY_TARGET` severity=block
- [ ] **测试矩阵**：两台机器各跑一次完整 fixture + preflight，产出 2 个报告对比
- [ ] **Cleanup**：`afterAll` 里 DROP DATABASE，不污染 dev 机器
- [ ] **CI 跳过**：本 E2E 依赖外部 MySQL，不加入 CI 强制（`npm run e2e` 主 harness 不跑，用独立 `npm run e2e:preflight:mysql` 手动触发）
- [ ] **规格文档**：更新 `.trellis/spec/backend/e2e-harness.md` 追加 preflight e2e 章节，说明触发方式、版本矩阵、断言清单

### 明确不做

- [ ] **MySQL 5.7 分支**：两台均为 8.x，5.7 INPLACE baseline 分支无法覆盖。写入 follow-up。
- [ ] **修改产品代码**：本次是测试基础设施，不改 `src-main/preflight-*`、`src-core/preflight-*`、`src-renderer/*`
- [ ] **UI E2E 覆盖 Preflight 按钮**：只跑 API 层 `preflight.run`。UI 层的按钮点击、徽标渲染属于 `preflight-v2-ui` 后续任务
- [ ] **主从复制 fixture**：`REPLICA_LAG` 规则的端到端触发需要主从配置，本轮只做「无复制时的 not-applicable Unknown 路径」验证
- [ ] **超大表**：`LARGE_TABLE_REBUILD`（5 GiB 阈值）需要 ≥5GB 数据，dev 机器不建 5GB 数据

## 验收标准

- [ ] `npm run e2e:preflight:mysql` 在开发机上一键跑通，两台 MySQL 均报告通过
- [ ] `PreflightReport` schema 断言全过（含 6 category fact、verdict、unknowns）
- [ ] INSTANT ADD vs INSTANT DROP 版本分叉在 8.0.26 vs 8.0.46 上被明确区分
- [ ] `READ_ONLY_TARGET` block issue 被真实触发并断言
- [ ] 无泄漏：测试结束 `SHOW DATABASES LIKE 'sqldiff_preflight_test%'` 结果为空
- [ ] 不引入新运行时依赖（只用现有 mysql2、playwright）
- [ ] 不修改产品代码，`git diff -- apps/desktop/src-main/preflight-*.ts apps/desktop/src-core/preflight-*.ts apps/desktop/src-renderer/` 为空
- [ ] 全套 vitest 单测不回归（558 项保持全绿）
- [ ] `npm run typecheck && npm run lint` 全绿

## 约束

- Fixture 建表 SQL 必须幂等（DROP IF EXISTS → CREATE）
- 建库耗时控制在 90 秒内（`users_big` 用 INSERT ... SELECT 循环而非真实写入百万行）
- 测试机器的凭据从 `.env.e2e` 或环境变量读取，不写死在代码里（对齐 `e2e-harness.md` 现有 secret 边界）
- Cleanup 无论测试成败都必须执行（`afterAll` + `try/finally`）
- Fixture 建库不写死 root 密码，用环境变量 `E2E_MYSQL_PASSWORD_9` / `E2E_MYSQL_PASSWORD_15` 传入
- 5.7 分支缺口明确记入 follow-up，不在本任务范围

## Open Questions

- ~~Q1 用真实 compare 引擎还是手工构造 PreflightRequest.items？~~ **已定**：手工构造。理由：preflight 消费的 DDL 字符串来自上游 compare，本任务只验证 preflight 自身逻辑正确性；compare 引擎已有独立 E2E 覆盖
- ~~Q2 8 个 fixture 表建在两个数据库（A/B）还是单个？~~ **已定**：单个库，因为 PreflightRequest 只需要目标库 B 的 facts；不做真实 compare
- ~~Q3 双机测试是同一个 test.describe 内并行还是串行？~~ **已定**：串行（Playwright `workers: 1` 已是默认），因为要对比 8.0.26 vs 8.0.46 的算法差异
- ~~Q4 5.7 缺口是否阻塞本任务验收？~~ **已定**：不阻塞。5.7 INPLACE baseline 在单测层已覆盖，本任务只补 8.x 双 patch 版本

## Key Decisions

| # | 决策 | 依据 |
|---|---|---|
| 1 | 手工构造 PreflightRequest.items，不跑 compare | preflight 逻辑与 compare 是解耦的；本次只验 preflight 消费 DDL 字符串的能力 |
| 2 | 双机测试而非单机 | 唯一价值是版本分叉；单机跑一遍等于无版本对比 |
| 3 | 独立 npm script，不合并到 CI | 依赖外部 MySQL，CI 环境不一定能连；开发机手动触发 |
| 4 | 5.7 缺口写 follow-up 不阻塞 | 8.0.26 vs 8.0.46 已覆盖 INSTANT ADD + INSTANT DROP 两个 8.x 关键分叉；5.7 INPLACE baseline 单测层已覆盖 |

## Notes

- 依据：`.trellis/tasks/archive/2026-10/10-03-production-preflight/implement.md:134-136`（Step 11 原始要求）
- 前置任务已验证产品代码正确性，本任务只补真实 MySQL 交互层
- Follow-up：`preflight-e2e-mysql-5.7`（等 MySQL 5.7 环境可用）
