# 安全迁移审查证据链（来源→Manifest→集成测试）

## Goal

把路线图 `09-24-product-expansion-roadmap/roadmap.md` 的 Phase 0 护栏和 Phase 1 最小闭环拆成三个可独立验收的串行子任务，先修语义地基，再建报告合同，最后补齐回归网。

本父任务只持有需求集、任务地图、跨子任务验收和最终集成复核；**每个子任务独立规划、实现、检查、归档**，父任务不作为实现目标。

## Source Requirement

来源是已归档路线图的三处结论，不是新增需求：

- §2.3 / §5.2 P0：比较结果必须区分真实/演示/部分失败，demo fallback 不得进入机器结果。
- §5.1 步骤 3：定义 `ProjectManifest`、`RunManifest`、`ReviewReport`、`CoverageStatus` 及版本迁移规则。
- §5.2 P0：compare/data 应用服务补齐 cleanup / cancel / partial failure 测试。

## Task Map

| 顺序 | 子任务 | 优先级 | 前置 | 独立验收锚点 |
|---|---|---|---|---|
| 1 | `09-29-result-source-state` | P0 | 无 | `CompareResult` 带显式来源与状态；UI 醒目区分演示/真实；headless 禁止 demo fallback |
| 2 | `09-29-review-manifest` | P0 | 子任务 1 | versioned 无秘密 manifest + 覆盖状态分类 + 脱敏 JSON/Markdown 导出；无执行入口 |
| 3 | `09-29-compare-service-integration-tests` | P1 | 子任务 1、2 | 应用的 cleanup / cancel / partial failure 有可重复的集成测试覆盖 |

**依赖是串行的，不是树形隐含的**：子任务 2 的 manifest 契约必须建立在子任务 1 定稿的来源与覆盖状态语义上；子任务 3 的断言依赖前两者的终态形状。子任务 1 不完成，2 和 3 不得启动。

## Requirements

1. **只读边界不扩大**：全链不得引入 SQL 执行入口、自动迁移、在线 cut-over 或任何写库路径。
2. **秘密不外流**：manifest、报告和导出物不得包含密码、私钥、passphrase、Vault 密文或连接串原文。
3. **行值默认脱敏**：进入 manifest/报告的标识、DDL 与行值遵循最小披露；是否放行由子任务 2 显式裁决并记录，不得默认全量输出。
4. **语义可判定**：覆盖状态至少区分成功、权限失败、无行身份、超阈、取消、错误；不得只表达"有差异"。
5. **不扩大未验证声明**：本链的验收证据来自单测、构建和本地 CDP；内网真库、SSH 跳板、Windows 原生和 IDE 真实导入仍不在本链内。

## Available Resource (本周)

用户确认有**可达的内网 MySQL 真库**。它用于：

- 子任务 1、3 的真实失败矩阵验证（连接失败、权限不足、大表超阈），不作为"已支持内网库"的对外声明；
- 子任务 2 的报告体积与脱敏边界的真实规模抽样。

**约束**：凭据不得写入仓库、任务产物或报告；真库实验必须在测试库/脱敏对象上进行，且不得与生产写操作混用。若真库不可用，子任务降级为 Docker fixture 验证，不得因此放宽 AC。

## Cross-Child Acceptance Criteria

- [ ] AC1 三个子任务各自归档，验收结论各自可独立复核。
- [ ] AC2 任一界面/导出物上的比较结果，用户能在不读日志的情况下分辨真实结果、演示结果和部分失败。
- [ ] AC3 没有任何机器可读产物包含 secret 或未经裁定的行值。
- [ ] AC4 manifest 有显式 schema 版本，且版本升级路径有测试覆盖。
- [ ] AC5 全链无 SQL 执行入口，`mysqldiff/` 未被改动。
- [ ] AC6 typecheck、lint、全量测试、build 四件套在每个子任务归档前为绿。
- [ ] AC7 父任务完成一次集成复核：三条链路的语义一致，无重复实现或命名冲突。

## Out of Scope

- 自动执行 SQL、在线迁移、cut-over。
- 账号、RBAC、审批、审计、云端服务。
- 多数据库方言（MariaDB/PG/SQL Server/Oracle）与 `DialectAdapter` 实现。
- headless CLI / CI runner（依赖子任务 2 的 manifest 合同，单独排期）。
- baseline / 漂移（依赖用户访谈证据，单独排期）。
- DataGrip 转换器（仍 blocked 于 `09-24-datagrip-converter` 等待真实 fixture）。

## Schedule

串行推进，一次只启动一个子任务。父任务不进入实现状态。

| 阶段 | 动作 | 出口条件 |
|---|---|---|
| S1 | 规划并启动 `09-29-result-source-state` | AC1–AC2 语义定稿并通过评审 |
| S2 | 规划并启动 `09-29-review-manifest` | manifest 合同评审通过 |
| S3 | 规划并启动 `09-29-compare-service-integration-tests` | 集成测试全绿 |
| S4 | 父任务集成复核并归档 | AC7 通过 |

## Notes

- 依据：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/roadmap.md`（复核基线 `f51d562`，代码现状于 `653a80c` 复核一致）。
- `CompareResult` 当前无来源/状态字段（`apps/desktop/src-core/types.ts:197-202`）；demo fallback 仍在（`apps/desktop/src-renderer/store.ts:611-629`）。
