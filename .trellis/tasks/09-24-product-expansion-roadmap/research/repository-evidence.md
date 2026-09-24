# Research: SqlDiff 仓库能力证据索引

- **Query**: 为产品扩展路线建立可复核的当前实现基线；重点回答“已经做了什么、明确没做什么、哪些结论仍只是推断”。
- **Scope**: internal（当前源码、测试、任务报告、构建配置与规范）
- **Date**: 2026-09-24
- **证据标记**: `FACT` = 直接观察；`INFERENCE` = 从事实推导；`HYPOTHESIS` = 尚未由用户/市场证据验证。

> 详细盘点见同目录的 [`capability-inventory.md`](capability-inventory.md) 与 [`current-technical-baseline.md`](current-technical-baseline.md)。本文件是面向后续研究主题的短索引，避免把同一事实重复解释成不同结论。

## Findings

### 1. 当前可交付的最小闭环（FACT）

| 结论 | 可复核证据 | 边界 |
|---|---|---|
| 产品是 Electron + Vite + React + TypeScript 的本地桌面应用，UI 为节点库 / A-B 槽 / 差异与 SQL 预览三栏。 | `apps/desktop/README.md:1-18,39-65` | 不是 HTTP 服务、云控制台或多人平台。 |
| 核心比较是 MySQL A/B 的只读快照比较；A 是来源/期望，B 是目标/待升级，输出方向是把 B 对齐到 A。 | `apps/desktop/src-core/compare.ts:100-103`；`apps/desktop/src-renderer/App.tsx:373-380,450-455` | 生成结果不等于执行结果。 |
| 结构对象覆盖表、视图、过程、函数；表级 ALTER 会拆成单语句，例程保持原子重建块。 | `apps/desktop/src-core/types.ts:4-31`；`apps/desktop/src-core/diff.ts:65-79,212-242`；`apps/desktop/src-core/compare.ts:51-61` | 解析依赖 MySQL `SHOW CREATE` 文本。 |
| 结构 diff 会生成 CREATE、DROP、ALTER，并提供分类、切面、风险、中文说明和回滚建议。 | `apps/desktop/src-core/diff.ts:46-175`；`apps/desktop/src-core/classify.ts:17-93`；`apps/desktop/src-core/risk.ts:37-116` | 风险是本地规则提示，不是数据库实际执行验证。 |
| 数据比较在可选范围内按 PK/全列非空 UNIQUE 识别行，生成 INSERT/DELETE/UPDATE；无行身份时跳过行级 diff。 | `apps/desktop/src-core/data-diff.ts:83-142`；`apps/desktop/src-main/data-run.ts:121-166,180-248` | 大表、无主键、BLOB 与列顺序仍有明显限制，见下文。 |
| 数据读取已从旧 CLI 的 `LIMIT 5000` 改为 `COUNT(*)` + keyset 分页，带阈值确认、进度和取消。 | `apps/desktop/src-main/data-fetch.ts:1-8,49-135`；`apps/desktop/src-core/data-options.ts:1-77`；`mysqldiff/DB.js:102-105` | 分页后仍将整表 materialize 到内存，并非流式 diff。 |
| 连接支持 MySQL 直连和单跳 SSH（密码或私钥+passphrase），连接池/隧道由 main 管理。 | `apps/desktop/src-main/connection.ts:55-103,228-318` | 没有 jump-host/多跳；尚未证明所有真实 SSH 环境可用。 |
| 密码、SSH 密码、私钥和 passphrase 走 safeStorage 或 AES-GCM；普通节点/历史 JSON 不存秘密。 | `apps/desktop/src-core/types.ts:50-78`；`apps/desktop/src-main/vault.ts:1-12,210-315`；`apps/desktop/src-main/store-json.ts:1-7` | 加密导出仍绑定本机 master key，不是团队凭据包。 |
| SQL 可复制/导出；含 DROP 时有二次确认；数据 DML 也只生成文本。 | `apps/desktop/src-renderer/App.tsx:880-975`；`apps/desktop/src-core/compare.ts:156-173`；`apps/desktop/src-core/data-diff.ts:1-4` | 用户可把导出文件交给外部执行器，应用不掌握后续审计。 |
| DBeaver 导出是 topology-only，不迁移密码/私钥；DataGrip 仍等待真实 fixture。 | `apps/desktop/src-main/converters/dbeaver.ts:137-205`；`apps/desktop/README.md:51-54`；`.trellis/tasks/09-24-datagrip-converter/prd.md:1-42` | DBeaver 真机导入、DataGrip 格式兼容性不能从结构测试推导为已验证。 |

### 2. 已知边界与技术债（FACT）

1. **MySQL-only 是全链路约束。** 连接配置、`information_schema` 查询、`SHOW CREATE` 解析、DDL/DML formatter 与数据分页都固定在 MySQL 语义；不是 UI 增加一个数据库下拉框即可解决。证据：`apps/desktop/src-main/connection.ts:88-102`、`apps/desktop/src-main/metadata.ts:41-50,115-138`、`apps/desktop/src-core/diff.ts:1-15`、`apps/desktop/src-renderer/sql.ts:18-24`。
2. **结果没有可恢复的审查对象。** `HistoryEntry` 仅保存时间、A/B 别名/ID 与差异数；不保存 scopes、filters、数据选项、风险策略、完整 diff 或审批结论。证据：`apps/desktop/src-core/types.ts:118-128`；`apps/desktop/src-main/store-json.ts:98-115`。
3. **回滚不是执行器。** `risk.ts` 只返回备份/恢复占位建议；不存在把 `DiffItem.sql` 送入连接池的路径。证据：`apps/desktop/src-core/risk.ts:50-116`；`apps/desktop/src-core/data-diff.ts:1-4`。
4. **数据比较的身份和资源边界必须显式展示。** 无 PK/可用 UNIQUE 会跳过行级 diff；A/B 身份不一致报 `pk-mismatch`；全表仍装入数组后再建 Map；Buffer 当前按 UTF-8 文本处理，INSERT 没有显式 column list。证据：`apps/desktop/src-main/data-run.ts:121-166,180-210`；`apps/desktop/src-main/data-fetch.ts:105-134`；`apps/desktop/src-core/data-diff.ts:48-80,89-142`。
5. **权限失败可能被“跳过”而不是形成完整缺口。** 单个 `SHOW CREATE` 失败转成 `null`，比较层跳过该对象；这避免把权限问题误报为对象不存在，但可能使用户误以为全库无差异。证据：`apps/desktop/src-main/metadata.ts:190-201`；`apps/desktop/src-core/compare.ts:63-69,111-138`。
6. **当前发布形态有平台与分发边界。** builder 只声明 Windows x64 NSIS、macOS arm64/x64 DMG；历史报告记录产物未签名，代码签名、公证、自动更新和 CI 不在当前交付闭环。证据：`apps/desktop/electron-builder.yml:1-27`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/prd.md:61-64`。
7. **真实环境覆盖不完整。** 已有 Docker/demo、结构比较和真实直连/小表数据证据，但指定内网目标、Windows 原生启动、SSH 私钥和 DBeaver/DataGrip 真机导入仍有未闭环项。证据：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:7-20,49-76`；`.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:5-26`；`.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md:14-36`。

### 3. 可作为路线图输入的推断（INFERENCE）

- 当前 core 的纯函数、main 的连接/快照编排、renderer 的筛选/导出已经形成可复用的 MySQL 工作流底座；近期增加“基线/报告/策略”比直接引入多数据库或团队服务更有技术可行性。依据：`apps/desktop/src-core/compare.ts:104-173`、`apps/desktop/src-main/compare-run.ts:61-141`，以及本文件第 1 节的缺口清单。
- 产品的信任边界是“本地读取、确定性生成、人工执行”；任何自动化方向都必须保持可审阅和可中止，不能把“生成 SQL”悄悄变成“自动写库”。依据：`apps/desktop/src-main/compare-run.ts:1-8`、`apps/desktop/src-core/data-diff.ts:1-4`、`apps/desktop/src-renderer/App.tsx:909-933`。
- 目前最大的产品证据缺口不是再列一个技术功能，而是没有用户访谈、真实使用频次、支持问题、留存、付费或 CI 使用数据；因此“迁移审查、漂移巡检、团队协作”等只能标为 HYPOTHESIS。依据：仓库内未发现 telemetry、访谈记录或用户研究文件；当前任务 PRD `:15,30-32,70-76` 也明确要求区分事实与假设。

## Related Specs

- `.trellis/spec/backend/index.md` — Electron main/core/renderer 分层与只读边界。
- `.trellis/spec/backend/database-guidelines.md` — 连接、查询、方向、并发和 cleanup 约束。
- `.trellis/spec/backend/quality-guidelines.md` — Electron 安全、测试、打包和发布门禁。
- `.trellis/spec/backend/dbeaver-export.md` — topology-only 转换合同。
- `.trellis/tasks/09-24-product-expansion-roadmap/prd.md:34-76` — 评价维度、交付物、决策约束和待研究问题。

## Caveats / Not Found

- `python3 ./.trellis/scripts/task.py current --source` 在本次会话返回 `(none)`；按用户明确指定的 `.trellis/tasks/09-24-product-expansion-roadmap/research/` 写入。
- `mysqldiff/` 是被忽略的旧 CLI 历史实现；其 `LIMIT 5000`、旧 SSH 调用和解析限制只能作为基线/迁移背景，不应当被当作当前桌面版能力。
- 代码注释/README 存在少量历史漂移；引用实现时应优先看当前符号和测试，而不是只看旧里程碑描述。
- 研究阶段没有修改产品代码、PRD、规范或任务配置文件；本次 Check Agent 仅修正当前任务的研究/路线图/PRD 文档，未修改产品代码、规范或任务配置。
