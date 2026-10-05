# Journal - smarterlab (Part 1)

> AI development session journal
> Started: 2026-09-21

---



## Session 1: SqlDiff桌面版M1-M5落地并推送
<!-- trellis-session: v=2 fp=c5b11f804278b0ff -->

**Date**: 2026-09-21
**Task**: SqlDiff桌面版M1-M5落地并推送
**Branch**: `main`

### Summary

需求收敛6问全定(Electron/自定义JSON/加密导出/无数据/SSH单跳/风险回滚);HTML原型+M1骨架+M2 vault/M3连接/M4 diff/M5 UI并行落地;check修11项71测全绿;4组提交推送origin main;归档09-21-sqldiff-desktop

### Git Commits

| Hash | Message |
|------|---------|
| `0e2214a` | feat(sqldiff-desktop): 任务PRD/design/implement规划与需求收敛 |
| `c888d17` | feat(desktop-mock): 三栏交互HTML原型(拖拽/四Tab/复制导出) |
| `2ffa0b0` | feat(desktop): Electron正式骨架+vault/ssh2/diff引擎/三栏UI(M1-M5) |
| `4b296d8` | docs(spec): 前后端质量规范沉淀(diff/vault/高亮规则) |

### Status

[OK] **Completed**


## Session 2: M7打包冒烟闭环
<!-- trellis-session: v=2 fp=b186dbd266c1a564 -->

**Date**: 2026-09-21
**Task**: M7打包冒烟闭环
**Branch**: `main`

### Summary

双端包全出(arm64 dmg/x64 dmg/Win setup);真库521项对比冒烟只读通过;SSH单跳待节点;归档m7

### Git Commits

| Hash | Message |
|------|---------|
| `c710d09` | fix(desktop): electron移devDeps+补author修打包 |
| `8e1f6d2` | chore(m7): 打包冒烟任务PRD+冒烟报告 |

### Status

[OK] **Completed**


## Session 3: 数据二期+启动崩修复
<!-- trellis-session: v=2 fp=22a5c17cc00627ee -->

**Date**: 2026-09-21
**Task**: 数据二期+启动崩修复
**Branch**: `main`

### Summary

联合主键+分页+data-run+独立三Tab,check修5项80测绿,真库1031表PK零失败;esModuleInterop修npm start启动崩并验证窗口拉起;归档data-diff-v2

### Git Commits

| Hash | Message |
|------|---------|
| `8b9579c` | feat(datadiff): 联合主键+分页流式+data-run+独立三Tab UI |
| `75258ef` | chore(datadiff): 二期任务PRD+真库主键覆盖率验证 |
| `6b41c81` | fix(desktop): esModuleInterop修node内置默认导入启动崩+规范沉淀 |

### Status

[OK] **Completed**


## Session 4: SSH+行级冒烟验证闭环
<!-- trellis-session: v=2 fp=c74d520ab44fe724 -->

**Date**: 2026-09-22
**Task**: SSH+行级冒烟验证闭环
**Branch**: `main`

### Summary

SSH密码22端口连通340ms,隧道被服务端拒;buildings行级删26改1通过;80测绿;归档verify-closeout,AC-V2密钥待用户补后另起微任务

### Git Commits

| Hash | Message |
|------|---------|
| `7c550f3` | chore(verify): SSH+行级冒烟任务PRD+报告2 |

### Status

[OK] **Completed**


## Session 5: UI修单四项+动词搜索R7收尾
<!-- trellis-session: v=2 fp=de7ec76288e1688b -->

**Date**: 2026-09-22
**Task**: UI修单四项+动词搜索R7收尾
**Branch**: `main`

### Summary

will-download落盘/错误消毒/全部Tab/筛选去重多选；verbOf动词chips；159测绿；归档ui-fix-batch+ddl-dml-index+small-enhance

### Git Commits

| Hash | Message |
|------|---------|
| `ba1f781` | feat(desktop): UNIQUE等价身份+选项可调+DDL/DML/INDEX三维过滤 |
| `9881e57` | feat(desktop): 动词级搜索R7(verbOf+正交过滤+chips) |
| `f83f91c` | feat(desktop): UI修单四项(落盘/消毒/全部Tab/筛选去重) |

### Status

[OK] **Completed**


## Session 6: E2E图标发布任务验收收口
<!-- trellis-session: v=2 fp=fe875cabd71ab230 -->

**Date**: 2026-09-24
**Task**: E2E图标发布任务验收收口
**Branch**: `main`

### Summary

完成22项E2E、应用图标与双端打包核验；用户批准Docker fixture和Windows交叉构建环境豁免；修正报告口径，tsc/lint及159测试全绿；归档发布任务及被其接管的deep-e2e任务。

### Git Commits

| Hash | Message |
|------|---------|
| `73ddc77` | feat(icon): 应用图标生成管线(icns/ico)+builder挂载 |
| `19cec8a` | docs(e2e): 全面测试报告22/22通过+图标打包规范沉淀 |
| `30035a3` | docs(e2e): 澄清真库验证与环境限制 |
| `33e98b1` | docs(task): 记录E2E环境豁免与验收边界 |

### Status

[OK] **Completed**


## Session 7: 补齐Trellis项目开发规范
<!-- trellis-session: v=2 fp=cc83a8064518579c -->

**Date**: 2026-09-24
**Task**: 补齐Trellis项目开发规范
**Branch**: `main`

### Summary

基于Electron/React/TypeScript真实代码完成backend/frontend全部规范与索引，记录进程边界、MySQL只读契约、状态管理、类型安全、CDP E2E、安全与打包规则；typecheck/lint/159测试/build全绿并归档bootstrap任务。

### Git Commits

| Hash | Message |
|------|---------|
| `5ab55f4` | docs(spec): 补齐前后端项目开发规范 |

### Status

[OK] **Completed**


## Session 8: DBeaver导出与桌面版二期收口
<!-- trellis-session: v=2 fp=c1779b4647bfabf6 -->

**Date**: 2026-09-24
**Task**: DBeaver导出与桌面版二期收口
**Branch**: `main`

### Summary

将转换器拆为DBeaver交付与DataGrip fixture后任务；实现DBeaver拓扑导出、节点选择弹窗、SSH映射和无秘密下载；8项focused与167项全量测试、typecheck/lint/build及可信CDP通过；归档转换器和二期父任务。

### Git Commits

| Hash | Message |
|------|---------|
| `81ea19e` | chore(task): 拆分DBeaver与DataGrip转换器规划 |
| `7b96696` | chore(task): 确认DBeaver结构化验收边界 |
| `a09c254` | feat(desktop): add DBeaver node export |

### Status

[OK] **Completed**


## Session 9: 完成产品可扩展性与需求路线图
<!-- trellis-session: v=2 fp=543984c6acb8d9c6 -->

**Date**: 2026-09-24
**Task**: 完成产品可扩展性与需求路线图
**Branch**: `main`

### Summary

完成SqlDiff能力地图、技术扩展性、用户需求与竞品研究；形成安全迁移审查/报告为近期推荐、preflight/CI/数据reconciliation条件分阶段路线，明确暂缓自动执行、云协作、跨数据库和AI；产出研究材料与验证判据并归档路线图任务。

### Git Commits

| Hash | Message |
|------|---------|
| `ace57f6` | docs(product): add expansion roadmap research |

### Status

[OK] **Completed**


## Session 10: 比较结果来源与覆盖状态显式化
<!-- trellis-session: v=2 fp=1388b61eb120453b -->

**Date**: 2026-09-29
**Task**: 比较结果来源与覆盖状态显式化
**Branch**: `main`

### Summary

读取路线图规划并建立安全迁移审查证据链三任务串行链；修复真实比较失败回填demo导致假diff、权限盲区等同于无差异两个缺陷；新增 ResultSource/CoverageReason 契约与结构覆盖报告；四件套全绿（194测试）

### Git Commits

| Hash | Message |
|------|---------|
| `414bf29` | chore(task): 规划安全迁移审查证据链三任务 |
| `b91e002` | feat(desktop): 显式化比较结果来源与覆盖状态 |
| `dc721c7` | docs(spec): 同步结果来源与覆盖契约 |

### Status

[OK] **Completed**


## Session 11: 授权盲区假 DROP 修复与 CDP 交互面验证
<!-- trellis-session: v=2 fp=a39d4f0a2a96706b -->

**Date**: 2026-09-30
**Task**: 授权盲区假 DROP 修复与 CDP 交互面验证
**Branch**: `main`

### Summary

实证发现表级授权账号下 A 侧不可见对象被当作不存在而输出 DROP TABLE 假象；新增 SHOW GRANTS 可见性判定并在 compareRun 前收窄为双方可见交集，消除假 DROP/CREATE；经 headless Electron CDP 验证错误卡片、覆盖明细、可见性范围明示，四件套 240 测试全绿

### Git Commits

| Hash | Message |
|------|---------|
| `0984cb4` | chore(task): 记录授权盲区假DROP任务与父任务进度 |
| `c72df06` | feat(desktop): 授权盲区导致假 DROP 的可见性收窄 |
| `e2bc632` | docs(spec): 同步可见性收窄契约并证伪 null 跳过声明 |
| `0543029` | docs: 更新前端质量规范并忽略 CDP 临时文件 |

### Status

[OK] **Completed**


## Session 12: Review Manifest v1 版本化无秘密导出
<!-- trellis-session: v=2 fp=58e97c21cc1198b4 -->

**Date**: 2026-09-30
**Task**: Review Manifest v1 版本化无秘密导出
**Branch**: `main`

### Summary

实现 versioned 无秘密 Review Manifest：统一 CoverageStatus 七分类、DML 脱敏器、确定性 JSON 序列化与 Markdown 交接报告、仅真实比较可导出；四件套全绿（277 测试）

### Git Commits

| Hash | Message |
|------|---------|
| `2f21605` | chore(task): 规划Review Manifest导出任务 |
| `d790df4` | feat(desktop): 版本化无秘密Review Manifest导出 |
| `79d8b82` | docs(spec): 记录Review Manifest导出契约 |

### Status

[OK] **Completed**


## Session 13: compare/data应用服务集成测试
<!-- trellis-session: v=2 fp=d2759c901274a8aa -->

**Date**: 2026-09-30
**Task**: compare/data应用服务集成测试
**Branch**: `main`

### Summary

为 runCompareRequest/runDataCompare 补齐 cleanup/cancel/partial failure 可重复集成测试：纯 mock 连接层、被测编排逻辑全真；10 个新测试覆盖元数据失败关池、ABORTED 取消、多表混合状态、全链路喂 buildManifest；四件套全绿（287 测试）

### Git Commits

| Hash | Message |
|------|---------|
| `4234a94` | chore(task): 规划compare服务集成测试任务 |
| `db3799c` | test(desktop): compare/data应用服务集成测试 |
| `48c47cf` | docs(spec): 记录应用服务集成测试策略 |

### Status

[OK] **Completed**


## Session 14: 证据链父任务S4集成复核与归档
<!-- trellis-session: v=2 fp=7146679afbd62c94 -->

**Date**: 2026-09-30
**Task**: 证据链父任务S4集成复核与归档
**Branch**: `main`

### Summary

执行 09-29-review-evidence-chain 的 S4 最终集成复核：AC1-AC7 全部通过（四件套 26/287 全绿、mysqldiff 零改动、契约单一定义无重复实现）；发现并修复 backend/index.md 缺 manifest-export 索引；父任务归档，证据链收官

### Git Commits

| Hash | Message |
|------|---------|
| `ff6d474` | docs(evidence-chain): S4集成复核通过并补录manifest索引 |

### Status

[OK] **Completed**


## Session 15: Preflight E2E on real MySQL 8.x — dual version matrix
<!-- trellis-session: v=2 fp=1fda681a42bef4b0 -->

**Date**: 2026-10-03
**Task**: Preflight E2E on real MySQL 8.x — dual version matrix
**Branch**: `main`

### Summary

补齐 10-03-production-preflight Step 11 Docker e2e 缺口。放弃 Docker（Mac 系统版本不够），改用两台真实开发机：192.168.5.9 = MySQL 8.0.46（INSTANT ADD + INSTANT DROP）、192.168.5.15 = MySQL 8.0.26（INSTANT ADD + INPLACE DROP），正好覆盖 8.0.12 与 8.0.29 两个关键版本分叉。新增 e2e/fixtures/mysql-fixture.ts（8 表建库 + cleanup）、e2e/helpers/preflight-fixture.ts（11 DDL items + 断言工具）、e2e/specs/preflight-on-mysql-8.spec.ts（双机参数化 + READ_ONLY_TARGET 触发验证）；package.json 加 e2e:preflight:mysql 独立 script；e2e-harness.md spec 追加 preflight 章节。真实 e2e 跑通了三个产品 bug：(1) information_schema 大写列名 TABLE_NAME/table_name 未兼容→新增 cell() helper；(2) @@read_only 返回数字但 toStr() 拿到 null→改 toNumber；(3) information_schema.key_column_usage.referential_constraint 列在 MySQL 8.0.46 不存在→改 referenced_table_name。3/3 e2e 通过，558/558 单元测试全绿。MySQL 5.7 分支缺口写入 follow-up（preflight-e2e-mysql-5.7）。密码通过 .env.e2e 环境变量注入，已加 .gitignore，未进 commit。

### Git Commits

| Hash | Message |
|------|---------|
| `e7e10b8` | feat(desktop): add preflight e2e on real MySQL 8.x |

### Status

[OK] **Completed**

---

## Session 16: Preflight Report v2 结论式渲染（双视角 + 分层文件）

**日期**: 2026-10-03
**任务**: `.trellis/tasks/10-03-preflight-report-v2-exec-summary`
**类型**: 渲染层改造，不动 schema v1

### 背景

用户反馈现有 preflight 报告"含金量不高"——实测 213 行报告中 83%（165 行）是原始 facts，verdict 埋在最底部，Issues 只有 1 条却埋在 facts 之后。

### 用户决定

1. **双视角分开**：开发 vs 运维不同人视角不一样
2. **方案 C**：两个 md 文件（结论 + 细节），先看结论，有疑问再追溯
3. **先出完整 PoC**：渲染层先行，不满意再调整数据结构层

### 关键洞察

- 决策语应该三态（GO/DEGRADED/BLOCK）而非四态（pass/warn/block/unknown）—— unknown 多数是 not-applicable 噪声
- 开发视角关心：DDL 分类成功率、unparsed 清单、表结构隐患
- 运维视角关心：锁/重建风险分组、表风险热图、环境状态、建议执行窗口
- `inferences.statement` 是自由文本（如 `d01: ADD_COLUMN on users_big → INSTANT/SHARED`），需正则解析

### 实现

| 文件 | 改动 |
|---|---|
| `preflight.ts` | +576 行：工具函数 + 2 个渲染函数 + `preflightFileNames` 扩展 |
| `preflight-run.ts` | `PreflightExportResult` 新增 detail 字段 |
| `App.tsx` | `handleExportPreflight` 保存 3 个文件 |
| `preflight-exec.test.ts` | 新建，47 项单测 |
| `preflight.md` spec | 追加 §14 v2 结论式渲染章节 |

### 真实 dump 验证

用 `/tmp/preflight-dump/report.json`（8.0.46 真实数据）跑 v2 渲染：

- **report.md**：89 行（原 213 行），首屏含决策 + 双视角
- **report-detail.md**：217 行，保留完整 5 段结构
- **交叉引用**：结论底部 `→ [完整原始数据](./xxx-detail.md)`，细节顶部 `← [返回结论](./xxx.md)`

决策语示例：`🟡 DEGRADED` ——「可发布但需排期。1 条 DDL 会 EXCLUSIVE 锁 + 重建，1 条 warn 规则触发，建议低峰执行。」

### 测试

- 605/605 全绿（558 原 + 47 新）
- typecheck 通过
- lint（改动文件）无错误
- JSON schemaVersion=1 保持，序列化 byte 稳定

### Commits

| Hash | Message |
|---|---|
| `654a928` | feat(preflight): Report v2 结论式渲染（双视角 + 分层文件） |
| `4f1148f` | chore(task): mark preflight-report-v2-exec-summary done |

### Status

[OK] **Completed** — PoC 完成，用户可看真实 dump 决定是否满意，不满意再评估 schema v2。


## Session 17: UI 徽标三态同步（GO/DEGRADED/BLOCK）
<!-- trellis-session: v=2 fp=f560a7160512aecc -->

**Date**: 2026-10-04
**Task**: UI 徽标三态同步（GO/DEGRADED/BLOCK）
**Branch**: `main`

### Summary

UI 显示从 v1 四态（pass/warn/block/unknown）改为 v2 三态（GO/DEGRADED/BLOCK），与导出的 Markdown 报告保持一致。改动：App.tsx 导入 deriveDecision 使用三态决策显示徽标；store.ts toast 消息使用三态；styles.css 新增 .preflight-verdict-go / .preflight-verdict-degraded 样式，保留 v1 四态向后兼容。605/605 测试全绿，typecheck 通过。

### Git Commits

| Hash | Message |
|------|---------|
| `04c529f` | feat(preflight): UI 徽标三态同步（GO/DEGRADED/BLOCK） |

### Status

[OK] **Completed**


## Session 18: Preflight E2E on MySQL 5.7（INPLACE baseline，真机验证）
<!-- trellis-session: v=2 -->

**Date**: 2026-10-04
**Task**: `.trellis/tasks/archive/2026-10/10-04-preflight-e2e-mysql-5-7`
**Branch**: `main`

### Summary

补齐 8.x 双机未覆盖的 5.7 INPLACE baseline 分支（`meta.followUp = preflight-e2e-mysql-5.7`），形成 5.7 / 8.0.26 / 8.0.46 三段版本对比。环境：用户给 CentOS 8.5 虚拟机 `192.168.2.84`，yum 源无 5.7（只到 el7），改官方 `mysql-5.7.44` tarball 装到 `/opt/mysql-5.7` + datadir `/data/mysql57` + systemd `mysqld57`（中间踩坑：首包下断 586MB gzip EOF、VM curl 不认 `--retry-all-errors`、client 缺 `libncurses.so.5`）。MySQL root 密码用户定为 `DB.smarterlab@2018`；E2E 用 `sqldiff@%` 专用账号（fixture 库 ALL + 全局 SELECT/REPLICATION CLIENT/SUPER），密码走 env 不入库。

实现：新增 `e2e/specs/preflight-on-mysql-5-7.spec.ts`（2 tests：全量断言 + READ_ONLY_TARGET）+ `assertInplaceBaseline`/`assertNoIssue` 断言 + `e2e:preflight:mysql57` script + `.env.e2e.example` 示例段；fixture 零改动（5.7 语法全合法）。真机 2/2 通过约 17s：d01/d02 均 `INPLACE + rebuild`、零 INSTANT、`BIG_TABLE_COPY` block（8.x 同位置是 `LARGE_TABLE_INSTANT_ADD` warn——正是三段对比证据点）；cleanup 后无残留库。605/605 单测、typecheck、lint 全绿，产品代码 diff 为空。check 另修 `e2e-harness.md` 过期"5.7 缺口"段落。

### Git Commits

| Hash | Message |
|------|---------|
| `0d59ed0` | feat(preflight): 5.7 E2E on real MySQL 5.7.44（INPLACE baseline） |

### Status

[OK] **Completed** — AC1–AC6 全达成，已归档


## Session 19: Schema v2 结论进结构
<!-- trellis-session: v=2 -->

**Date**: 2026-10-04
**Task**: `.trellis/tasks/archive/2026-10/10-04-schema-v2`
**Branch**: `main`

### Summary

V2 三个 follow-up 的第一个：`summary { decision, message, blocking/warnings/unknowns }` 进 `PreflightReport`，`schemaVersion` 1→2。`buildPreflightReport` 一次算出写入；新增 `getSummary`（v2 直读 / v1 回填 / 非法回退）；UI 徽标 + toast 改读 `getSummary`，renderer 无 `deriveDecision` 残留；`verdict` 四态保留。单测修 2 处版本断言、新增 6 项，check 另修 1 处弱断言；611/611、typecheck、lint、build 全绿。E2E helper 改要求 version 2；`preflight.md` 追加 §15。

### Git Commits

| Hash | Message |
|------|---------|
| `55df03c` | feat(preflight): schema v2 结论进结构（summary + getSummary） |

### Status

[OK] **Completed** — AC1–AC5 全达成，已归档


## Session 20: Report V2 后续双子任务并行收官
<!-- trellis-session: v2 -->

**Date**: 2026-10-04
**Tasks**: `10-04-sql-linkage` + `10-04-history-diff`（父 `10-04-preflight-report-v2-followups`）
**Branch**: `main`

### Summary

sql-linkage：`deriveSuggestedEdits`/`applySuggestedEdit` 纯函数 + executive"可应用的加速建议"节 + UI 预览→确认→可撤销（默认不改交付物）；仅 LARGE_TABLE_INSTANT_adding 带版本前提。history-diff：`preflight-history.json` 按 (bId,database) 分组各存 10 份 + `diffPreflight` + 独立历史 Modal（任意两次 diff，跨组禁用）。并行冲突 1 处（store-json mock 缺新 export）主会话修；终审各修小问题（注释错字、脏条目守卫、注释路径）。650/650、typecheck、lint、build 全绿，一次提交，三任务归档。

### Git Commits

| Hash | Message |
|------|---------|
| `03449a8` | feat(preflight): SQL 联动加速建议 + 历史对比视图 |

### Status

[OK] **Completed** — 双子 AC 全达成，父任务集成复核通过，已归档


## Session 21: 测试迁入 tests/ + 补齐历史功能缺口
<!-- trellis-session: v=2 -->

**Date**: 2026-10-05
**Tasks**: `10-04-test-backfill`（父）+ `10-04-tests-migration` + `10-04-test-gap-backfill`
**Branch**: `main`

### Summary

用户定规则：每个功能/优化必须带测试用例，统一放 tests/ 目录。两个里程碑：

**M1 迁移**（`068c88b`）：41 个 co-located `*.test.ts` 用 `git mv` 迁入 `tests/{core,main,converters,renderer}/`，vitest include 改 `tests/**/*.test.ts`，两个 tsconfig 同步覆盖 tests。650 项零回归，断言零改动（diff 除 import 外空）。终审另修 4 处 spec 旧测试路径（含一个指向已删文件的历史错误）。

**M2 补测**：代码面 grep 扫描出 18 个零/弱覆盖导出函数，新建 7 个文件 **+73 项**（650→723）。重点：`assertSafeNodeId` 六种穿越形态 + AES-GCM 往返/篡改/错密钥；`normalizeScopes` 非法输入降级；sql-io 22 项用 `vi.stubGlobal` mock 浏览器 API（零新依赖）。终审用变异测试实证断言非空转，并把一处绑定 sql-formatter 排版的脆弱断言改为断言契约。

**沉淀**：`quality-guidelines.md` 新增「每个功能与优化必须带测试」门禁（含安全原语需对抗用例、断言契约而非依赖内部、定时器需 fake timers、纯测试任务不改产品码、变异测试自证非空断言），并入 Review Checklist。

**顺带**：`.gitignore` 加 `.mnemon/`（终审发现归档时 `git add -A` 会误提交 512KB sqlite）。

### 产品问题（按纯测试任务约束只记录未修）

**P1** `normalizeScopes(['data'])` 静默回落四类结构全开——UI 可达（`store.ts:609`）：取消勾选全部结构类型 + 只勾数据对比 → 用户没勾的结构对比被静默跑完。建议区分「结构项全非法」与「仅 data」。另 3 条 P3/记录：rollbackFor 的 undefined 路径不可达（JSDoc 与实现不符）、formatSqlSafe catch 分支不可达、resolveDataPairs 按表名存在性配对含 null 值。

### Git Commits

| Hash | Message |
|------|---------|
| `068c88b` | refactor(tests): 测试统一迁入 tests/ 目录（41 文件，650 项零回归） |
| `fc80d0e` | test: 补齐历史功能测试缺口（+73 项，覆盖 18 个零覆盖函数） |

### Status

[OK] **Completed** — 三任务归档，723 项全绿


## Session 22: 修复 scopes 空回落（静默越权）
<!-- trellis-session: v=2 -->

**Date**: 2026-10-05
**Task**: `.trellis/tasks/archive/2026-10/10-05-scopes-empty-fallback-fix`
**Branch**: `main`

### Summary

补测任务（session 21）暴露的 P1，本轮闭环。**只读工具里的静默越权**：用户取消勾选全部 4 个结构类型、只留「数据」，`normalizeScopes(['data'])` 因 `'data'` 非结构 ObjectType 被过滤成空数组，再走 `kept.length > 0 ? ... : ALL_SCOPES` 回落分支 → 四类结构全跑，而 UI 与 `lastComboText`（显示 `· /data`）都表现为只比数据，事后无从发现。

修法（用户已定「数据单独对比合法」）：`normalizeScopes` 区分两种空——**显式空**（`[]` / 仅含 `'data'` 等词表 token）返回 `[]` 尊重用户；**无法解释**（`null`/非数组/全词表外垃圾）仍回落 `ALL_SCOPES`，IPC fail-safe 不因修复而退化。关键区分点是「raw 数组是否含至少一个已知 token」（`ALL_SCOPE_TOKENS`），不是「过滤后剩几个」——`['data']` 过滤后同样是空但表达合法意图。R3 同步修 `lastComboText` 的前导斜杠。

**最有价值的一条**：这条 bug 正是「每个功能必须带测试」门禁的反向价值证明——`tests/core/compare-filter-scope.test.ts` 里那 9 项 `normalizeScopes` 对抗用例是它被发现的唯一途径。终审用 4 次变异测试自证断言非空转（恢复旧语义→7 项红、删 fail-safe→2 项红、判据放宽→2 项红、恢复旧文案→1 项红）。735 项全绿（+12）。

**沉淀**：`database-guidelines.md` 新增「Scopes Normalization: Respect Selection, Keep Fail-Safe」章节（7 行输入→输出契约表 + 判据说明 + 下游安全性论证 + lastComboText 警告 + hasDataScope 分裂的 follow-up）。

### Git Commits

| Hash | Message |
|------|---------|
| `c135890` | fix(compare): 数据单独对比不再被静默放大为全结构对比 |

### Status

[OK] **Completed** — AC1–AC6 全达成，已归档


## Session 23: 清理 spec 漂移 + docs 门禁落地
<!-- trellis-session: v=2 -->

**Date**: 2026-10-05
**Task**: `.trellis/tasks/archive/2026-10/10-05-docs-spec-drift-cleanup`
**Branch**: `main`

### Summary

清理两处"文档/配置与仓库现实脱节"。**问题 1**：spec 里 9 处引用 `mysqldiff/`，但该目录在本 checkout 不存在且被 `.gitignore:2-3` 双重忽略——近三次 check 报告都重新发现它、各自解释一遍，门禁形同虚设。用户定「全删」。**问题 2**：`AGENTS.md` 的 `docs/daily/` 四件套门禁因 `.gitignore:6` 整条忽略而 100% 无法执行（`git log --all -- docs/daily` 为空，从未存在过），且它引用的 `docs/knowledge/.../daily-to-knowledge.md` 等文件全部不存在。用户定「docs/ 入库」。

处置：9 处引用逐条删除（`quality-guidelines.md:26` 整条删——该条在 Security Invariants 段属错位且归属规则已在 directory-structure/index 各表述一次；`:93` 删前半保后半，`dist-*`/`release/` 检查独立成条；`preflight.md:452` 删表格整行，表头+分隔+9 行结构完好）。`.gitignore` 删 `docs/`，保留 `mysqldiff/` 两条。建立四件套 + knowledge 三级索引（P2 三问 + PR Checklist 7 项 + 3 条拦截条件）。`AGENTS.md:8` 标注 `domain context/`、`agents/` 按需创建——否则这次修漂移会顺手造出两个新悬空引用。

**踩到的坑**：实现代理自己造过一次断链（`daily-to-knowledge.md` 里给日志写的相对链接少一层 `../`），链接检查报出后改回。全量 docs 链接解析复验：13 条有效、0 断链。

**终审异常**：check 子代理返回空结果（工具异常），主会话自行补做全部四项复核（语义连贯性 / 四件套自洽 / 无新悬空引用 / R9 未被违反），全 PASS。

### Git Commits

| Hash | Message |
|------|---------|
| `ecc5bc2` | docs: 清理 spec 漂移引用并让 docs 门禁可执行 |

### Status

[OK] **Completed** — AC1–AC7 全达成，已归档
