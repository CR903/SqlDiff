# Preflight E2E on MySQL 5.7（INPLACE baseline 验证）

## Goal

在 MySQL 5.7 真实库上跑 preflight 端到端验证：补齐 8.x 双机未覆盖的 INPLACE baseline 分支（ADD/DROP COLUMN 均走 INPLACE+rebuild），复用 8.x fixture 与 harness

## Background（已确认事实）

- `10-03-production-preflight`（AC1–AC12 全达标）与 `10-03-preflight-e2e-mysql-8`（8.0.46 INSTANT DROP vs 8.0.26 INPLACE DROP 双机验证通过）均已归档；5.7 分支是唯一未验证的版本分叉（见 8.x 任务 `task.json: meta.followUp = preflight-e2e-mysql-5.7`）。
- 5.7 语义预期：`ADD_COLUMN` 与 `DROP_COLUMN` 均走 `INPLACE + rebuildsTable=true`（5.7 无 INSTANT DDL，8.0.12 才引入 INSTANT ADD、8.0.29 才引入 INSTANT DROP）；单测层已覆盖该分支，缺的是真实库交互证据。
- 可复用资产：`apps/desktop/e2e/fixtures/mysql-fixture.ts`（8 表建库 + cleanup）、`apps/desktop/e2e/helpers/preflight-fixture.ts`（11 DDL items + 断言工具）、`apps/desktop/e2e/specs/preflight-on-mysql-8.spec.ts`（skip-if-missing 参数化模式）、`.env.e2e.example`（9/15 双机 env 约定）。
- 本机环境现状（2026-10-04 实测）：无 `docker` 命令、无 `apps/desktop/.env.e2e` 文件；8.x 两台机器密码当时经 `.env.e2e` 注入、未入库。
- 5.7 目标机（用户 2026-10-04 提供）：`192.168.2.84`，CentOS 8.5 x86_64，OS 账号 root/zhou（密码用户已给），SSH 连通已验证；装机前无任何 MySQL/MariaDB，磁盘可用 30G，内存 3G，`repo.mysql.com` 可达；AppStream 自带 mysql 8.0 module 已禁用，MySQL 官方 yum 源安装进行中。
- Fixture 5.7 兼容性初查（`apps/desktop/e2e/fixtures/mysql-fixture.ts` 全文已读）：8 张表只用 BIGINT/VARCHAR/TIMESTAMP/DECIMAL/TEXT/JSON + PK/UNIQUE/KEY/FK + `ROW_FORMAT=DYNAMIC`，无表达式索引/不可见列等 8.0 专有语法，`utf8mb4_unicode_ci` 建库字符集 5.7 支持——预期可原样复用，装机后以真实建库验证为准。
- 5.7 采集面初查：`@@read_only`、`SHOW SLAVE STATUS`（无 `REPLICA` 语法，代码降级链单测已覆盖）、information_schema 常规列在 5.7 均存在；8.x 修过的三个真实库 bug（大写列名、`@@read_only` 数值、`referential_constraint` 缺列）均为 8.0 特有，5.7 无此坑。

## Requirements

- [ ] R1 5.7 装机：`192.168.2.84` 上经官方 yum 源安装 MySQL 5.7 最新 5.7.x，`mysqld` 开机自启，root 密码走强密码本地保管（不入库），建 `sqldiff` 专用 E2E 账号（仅建库/读写 fixture 库权限）
- [ ] R2 Fixture 复用：同一套 8 表 fixture 在 5.7 库上建库验证；若个别语法不兼容，只做最小兼容调整（保持与 8.x 同表名同数据量级）
- [ ] R3 E2E spec：新增 `apps/desktop/e2e/specs/preflight-on-mysql-5-7.spec.ts`，沿用 8.x 的 skip-if-missing + 独立 npm script 模式（env 约定 `E2E_MYSQL_57_*`，示例追加到 `.env.e2e.example`）
- [ ] R4 版本分叉断言：同一条 `ADD COLUMN` / `DROP COLUMN` DDL 在 5.7 上均为 `INPLACE + rebuildsTable=true`，与 8.0.46（双 INSTANT）、8.0.26（ADD INSTANT + DROP INPLACE）形成三段对比
- [ ] R5 其余断言与 8.x 对齐：report 结构（schemaVersion/source/6 category/verdict）、`server.mysql_version` 与真实版本一致、`READ_ONLY_TARGET` block、`OTHER → Unknown`、cleanup 后无残留库
- [ ] R6 不修改产品代码（同 8.x 任务硬边界：`git diff -- apps/desktop/src-main/preflight-*.ts apps/desktop/src-core/preflight-*.ts apps/desktop/src-renderer/` 为空）；若 5.7 跑出产品 bug，只记录、不顺手修（另开任务）

## Acceptance Criteria

- [ ] AC1 `npm run e2e:preflight:mysql57` 在 5.7 真机上一键跑通（env 缺失时静默 skip，不影响主 harness）
- [ ] AC2 `ADD/DROP COLUMN` 在 5.7 上均断言为 `INPLACE + rebuildsTable=true`
- [ ] AC3 report 结构、`mysql_version` 一致性、`READ_ONLY_TARGET`、`OTHER → Unknown` 全过
- [ ] AC4 测试结束 `SHOW DATABASES LIKE 'sqldiff_preflight_test%'` 为空
- [ ] AC5 不引入新运行时依赖；全套 vitest 单测不回归；`typecheck + lint` 全绿
- [ ] AC6 5.7 env 示例进 `.env.e2e.example`，真实密码不入库

## Out of Scope

- 修改 `src-main/preflight-*` / `src-core/preflight-*` / `src-renderer/*` 产品代码
- UI 层 Preflight 按钮 E2E、主从复制 fixture、≥5GB 超大表（沿用 8.x 任务的不做清单）
- 5.7 上的 `LARGE_TABLE_REBUILD`（5 GiB 阈值）真实触发——同 8.x 理由不建 5GB 数据

## Open Questions

无阻塞问题。Q1（CentOS 8 IP）已答：`192.168.2.84`，SSH 已通，装机进行中。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
