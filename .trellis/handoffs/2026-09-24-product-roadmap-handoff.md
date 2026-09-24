# SqlDiff 会话交接：产品路线图与后续工作

> 用途：把这轮会话压缩成可在另一台电脑继续工作的上下文。
> 交接日期：2026-09-24
> 原会话 ID：`ses_f2e6f983dffeR16dxRrZGFSNi9`
> 仓库：`/Users/apple/project/SqlDiff`
> 目标远端：`git@github.com:CR903/SqlDiff.git`

## 0. 继续前先做

1. 阅读仓库根目录 `AGENTS.md`，遵守 Trellis 工作流。
2. 执行：
   ```bash
   cd /path/to/SqlDiff
   git status --short --branch
   python3 ./.trellis/scripts/task.py list --mine
   ```
3. 当前交接时仓库状态：`main` 工作区干净，较 `origin/main` 超前 17 个提交，**尚未 push**。如果要在另一台电脑继续，需要先把这 17 个提交推送或同步到远端。
4. 当前没有 active task；唯一未归档任务是：
   - `.trellis/tasks/09-24-datagrip-converter/`（planning，blocked）

## 1. 本轮已经完成的事情

### 1.1 既有工程任务已收口

以下任务已经实现、验证并归档，不要重复开始：

- `09-24-e2e-icon-release`
  - 22 项 E2E 动作在 demo/Docker fixture 范围通过。
  - 图标、macOS x64/arm64 DMG、Windows x64 NSIS 构建核验完成。
  - 用户批准环境豁免：指定内网真库、Windows 原生启动、DBeaver IDE 导入不作为本任务阻塞条件。
  - 归档路径：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/`

- `09-22-deep-e2e`
  - 被 `09-24-e2e-icon-release` 接管，已归档。

- `00-bootstrap-guidelines`
  - backend/frontend Trellis 规范全部补齐。
  - 代码、测试、安全、CDP、图标/打包约定已沉淀到 `.trellis/spec/`。
  - 归档路径：`.trellis/tasks/archive/2026-09/00-bootstrap-guidelines/`

- `09-22-converters`
  - 已收敛为 SqlDiff → DBeaver 拓扑导出。
  - `NodeMeta` → `data-sources-sqldiff.json`，支持直连、密码 SSH、私钥 SSH；不读取 Vault、不导出秘密、不编造 keyPath。
  - UI 支持节点多选、全选/全不选、警告和可信下载。
  - 归档路径：`.trellis/tasks/archive/2026-09/09-22-converters/`

- `09-22-desktop-phase2`
  - 4/4 子任务完成，已归档。

### 1.2 产品研究任务已完成

- 任务：`09-24-product-expansion-roadmap`
- 归档路径：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/`
- 主路线图：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/roadmap.md`
- 研究材料：该目录下 `research/` 全部文件。
- 文档审查已通过：AC1–AC7 完成；manifests、Markdown 链接、占位符、评分口径和证据分层均已检查。

## 2. 产品判断（不要误读为已验证需求）

### 当前成熟度

- 当前 MySQL 桌面产品继续纵向深化：**4.0/5**。
- 扩展成跨数据库、自动化、团队/云服务平台：**2.2/5**。
- 产品本质：已经形成可用的**单机 MySQL 迁移检查器**，还不是通用数据库平台。

### 推荐重点

近期唯一推荐方向：

> **安全迁移审查工作台 / 可交接报告**

目标是把一次性 diff 变成可保存、可复比、可交接的审查记录：

- versioned、无秘密的 project/run manifest；
- A→B 方向、scope、options、映射和输入 fingerprint；
- 成功、权限失败、无行身份、超阈、取消、错误等 coverage；
- 风险、回滚提示、差异结果；
- 脱敏 Markdown/JSON 报告；
- 人工“接受/排除/待确认”备注；
- 继续只读，不提供 SQL 执行按钮。

### 条件性后续方向

Phase 2 三选一，不要同时做：

1. MySQL 生产变更只读 preflight；
2. headless CLI / project manifest / CI gate；
3. 可审计数据 reconciliation 报告。

Phase 3 条件触发：

- baseline / drift；
- DataGrip；
- MariaDB/PostgreSQL 等新数据库；
- 团队评论/审批/审计；
- 持续巡检/通知；
- AI 解释；
- Tauri/新桌面壳。

### 明确暂缓

- 自动执行 SQL、在线 cut-over；
- 云端多租户和完整权限平台；
- 没有真实需求证据的多数据库打包支持；
- 默认 AI 生成修复 SQL；
- 没有重复使用证据的 DataGrip 双向同步；
- Tauri 重写。

## 3. 已确认的产品约束

- 保持“只读、生成但不执行 SQL”的安全边界。
- 不把 `SecretBundle`、密码、私钥、passphrase、Vault 密文放进普通报告、project、CI artifact 或交接文件。
- `mysqldiff/` 是只读历史实现，不要直接修改。
- 当前 MySQL 的 `SHOW CREATE`、反引号、PK/UNIQUE、MySQL literal/formatter 语义是窄域，不要把现有 parser 误称为通用数据库抽象。
- 任何 headless/CI 方案必须禁止 renderer 的 demo fallback 进入机器结果。
- 结果模型需要区分 real/demo/partial failure；当前真实比较失败时 renderer 会填 demo 结果，这是待处理的可信度问题。

## 4. 研究得出的关键技术事实

- renderer → preload/contextBridge → Electron main → MySQL/SSH → pure core 的边界已经清晰。
- `src-core` 适合复用确定性比较逻辑，但当前 metadata 类型仍由 `src-main` 提供，跨宿主/CLI 前需要整理 contract。
- `CompareResult` 仍是一次性完整返回；renderer 全量持有/渲染 `items`，没有 job/stream/virtualization。
- `fetchAllByPK` 虽使用 keyset 分页，但最终仍 materialize 整表，再建立 A/B Map；threshold 不是内存上限。
- `runCompareRequest` / `runDataCompare` 直接依赖 user-data 目录和具体 Vault；headless 前需要 repository/secret provider/history sink 等窄接口。
- pool 部分构造失败、全局单一 abort、退出时未等待 tunnel cleanup 等边界已记录，后续工程任务需单独处理。
- 新数据库不是增加一个 driver：至少涉及 connection/auth、metadata、DDL normalizer/diff、row identity、value renderer、risk policy、formatter、fixtures。
- 当前没有用户访谈、下载/活跃/留存、付费或 CI 使用数据；竞品功能/价格只能作为方向信号，不能当作 SqlDiff 需求证明。

## 5. 下一步建议

### 立即建议（需用户确认后建任务）

1. 创建 `sqldiff-result-source-state`：
   - 让结果显式区分 real/demo/partial failure；
   - 结果区显示 demo/真实来源和 coverage；
   - 禁止 headless 使用 demo fallback；
   - 加 E2E 回归。
2. 创建 `sqldiff-review-manifest`：
   - 先做无秘密 versioned manifest 和脱敏 JSON/Markdown 报告；
   - 用 5–8 名发布/测试/DBA 用户做“保存→复比→交接”实验；
   - 成功判据预先登记，不能只看技术实现完成。

### 之后依据访谈选择

- 生产风险最痛 → `sqldiff-preflight-fixture`；
- PR/CI 最痛 → `sqldiff-headless-runner`；
- 数据恢复最痛 → `sqldiff-data-diff-hardening` / reconciliation report。

### 仍需外部输入

DataGrip 任务需要用户提供脱敏的：

- `dataSources.xml`
- `dataSources.local.xml`
- 至少一个普通 MySQL 源和一个 SSH MySQL 源；

在此之前不要猜 JetBrains SSH XML 标签。

## 6. 重要提交

- `a09c254` — `feat(desktop): add DBeaver node export`
- `ace57f6` — `docs(product): add expansion roadmap research`
- `27dde3c` — `chore(task): archive 09-24-product-expansion-roadmap`
- `7a7772b` — `chore: record journal`

更早的 DBeaver/二期收口提交可查看 git log；不要重复已经归档的任务。

## 7. Suggested skills（下一台机器的 agent）

- `trellis-start`：重新建立项目上下文。
- `trellis-continue`：若用户决定继续 DataGrip 或创建新任务。
- `trellis-brainstorm`：创建 `result-source-state` / `review-manifest` 前梳理需求。
- `trellis-before-dev`：写代码前加载项目规范。
- `trellis-implement`：实现已批准的独立切片。
- `trellis-check`：实现后做跨层质量检查。
- `decision-mapping` 或 `domain-modeling`：若继续拆解项目/manifest/审查领域模型。
- `research`：只有在用户访谈、性能 fixture 或新数据库证据出现时使用。

## 8. 交接文件

本文件路径：

`.trellis/handoffs/2026-09-24-product-roadmap-handoff.md`

该文件已按用户要求准备提交到 Git；不包含密码、API key 或其他秘密。
