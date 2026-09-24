# Research: SqlDiff 验证证据、缺口与成熟度基线

- **Query**: 复核当前 SqlDiff 的自动化、真实环境、打包和历史任务证据，区分“代码存在”“测试通过”“真实环境验证”“环境豁免/未闭环”，并给出当前产品成熟度基线。
- **Scope**: internal（当前工作树、Vitest 运行、Git 提交/任务状态、归档 E2E/冒烟/发布报告、Trellis specs）
- **Date**: 2026-09-24
- **证据标记**: **FACT** = 直接观察/命令或报告记录；**INFERENCE** = 从证据推导；**HYPOTHESIS** = 尚无证据支持的产品判断。
- **路径约定**：正文中未重复写 `apps/desktop/` 前缀的 `src-*`、`App.tsx` 等引用均相对于 `apps/desktop/`；归档任务和 spec 按仓库实际路径书写。

## Findings

### 1. 本次自动化复核

- **FACT**：从 `apps/desktop` 执行 `npm test -- --run`，Vitest 报告 **17 passed test files、167 passed tests**。输出中的文件包括 core/main/renderer 的结构 diff、数据 diff/身份、metadata、connection config、Vault、download、IPC error、DBeaver、node-filter 和 SQL helper 测试。证据：本次命令输出（2026-09-24）；`apps/desktop/vitest.config.ts:1-5`。
- **FACT**：本次 `npm run typecheck` 和 `npm run lint` 均以 exit code 0 完成。证据：本次命令输出。
- **FACT**：研究采集阶段没有执行 `npm run build`/`npm run pack`，因为它们会写 `dist-*`/`release`；本次 Check Agent 质检阶段另行运行了 `npm run build`（未运行 pack）。最新已有 build/pack 证据仍来自归档 E2E 报告，不应标成此次 pack。证据：任务边界；`e2e-report.md:101-111`。

#### 1.1 测试覆盖分组

| 测试组 | 文件与测试事实 | 证明的边界 | 未覆盖的边界 |
|---|---|---|---|
| 结构 diff | `src-core/diff.test.ts` 29 tests | 表/列/PK/普通 KEY/routine/DEFINER/分类/风险/统计/导出顺序 | 完整 MySQL 版本 DDL、UNIQUE/FULLTEXT/SPATIAL 结构生成、trigger/foreign key 等未见覆盖 |
| 语句拆分/过滤 | `ddl-dml-index.test.ts` 21、`verb-search.test.ts` 19 | 表语句独立条目、aspect/verb/对象组合、复制=所见 | live IPC/UI state、真实下载完成回调 |
| 数据 diff/身份 | `data-diff.test.ts` 7、`data-unique.test.ts` 11、`data-run-identity.test.ts` 7 | PK/联合 PK、UNIQUE 资格、DML、typed identity decision | live fetch loop、BLOB、异形列、超大表内存 |
| metadata/连接 | `metadata.test.ts` 13、`connection.test.ts` 11 | SQL 形状、identifier escaping、并发上限、配置和 tunnel cache fake | live DB/SSH、真实 forwarding、pool partial failure |
| 数据读取 | `data-fetch.test.ts` 2 | keyset WHERE、参数、nextKey | `fetchAllByPK` 全循环、threshold、AbortSignal、异常 |
| 本地安全/存储 | `vault.test.ts` 12 | safeStorage/AES-GCM、加密 JSON、旧串、nodes/history | 多机密钥迁移、并发写、备份恢复策略 |
| 输出/下载 | `download.test.ts` 4 | `will-download` 路径和文件名 | renderer Blob 真实落盘由 E2E 补证 |
| UI 纯 helper | `sql.test.ts` 5、`node-filter.test.ts` 3 | 高亮/导出文本、节点 tab 过滤 | React mount、keyboard/a11y、store actions |
| 转换器 | `converters/dbeaver.test.ts` 8 | DBeaver topology/no-secret/determinism | DBeaver IDE 真机导入、driver ID 发行版差异 |
| IPC error | `ipc-error.test.ts` 4 | Electron 前缀消毒 | main handler 全链路和权限边界 |

证据：各测试文件本身；本次 Vitest 输出。

#### 1.2 自动化测试未覆盖的文件/流程

- **FACT**：没有同名 `main.ts`、`preload.ts`、`compare-run.ts`、`data-run.ts`、`store.ts`、`App.tsx` 测试；`store-json.ts` 没有同名测试，但由 `src-core/vault.test.ts` 间接覆盖。证据：`vitest.config.ts` 和文件清单；`vault.test.ts:180-205`。
- **FACT**：`connection.test.ts` 文件头明确真实建连路径依赖手工冒烟；测试主体使用 fake tunnel/纯配置。证据：`apps/desktop/src-main/connection.test.ts:1-2,36-47`。
- **FACT**：`data-fetch.test.ts` 只测两个 keyset page helper，没有调用 `fetchAllByPK`；因此 threshold、取消、循环结束和进度行为在单测层面没有被直接验证。证据：`apps/desktop/src-main/data-fetch.test.ts:1-39`。
- **INFERENCE**：167 个单测证明纯逻辑和窄 fake boundary 的确定性，但不能直接推出 Electron 进程生命周期、真实 MySQL 权限、Windows 原生运行或大数据性能已成熟。

### 2. 任务演进与实现状态证据

- **FACT**：Git 历史显示能力按里程碑逐步加入：桌面骨架（`23a111e`）、数据 diff（`8b9579c`）、UNIQUE/选项/DDL-DML-INDEX（`ba1f781`）、动词过滤（`9881e57`）、UI 实测修复（`f83f91c`）、图标管线（`73ddc77`）、DBeaver exporter（`a09c254`）。证据：`git log --oneline -- apps/desktop`（本次复核）。
- **FACT**：归档任务 `09-21-sqldiff-desktop`、`09-21-data-diff-v2`、`09-22-small-enhance`、`09-22-ddl-dml-index`、`09-22-ui-fix-batch`、`09-22-verify-closeout`、`09-24-e2e-icon-release` 和 `09-22-converters` 均标记 completed；当前 `09-24-product-expansion-roadmap` 与 `09-24-datagrip-converter` 仍 planning。证据：对应 `task.json`。
- **FACT**：历史任务把自动执行 SQL、跨数据库、团队云同步、AI、多跳 SSH、自动更新等列为首版 out-of-scope；后续任务又实际补上了数据 diff、UNIQUE 身份和 DBeaver exporter，因此任务 PRD 不能单独代表当前能力。证据：`.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:67-84`; `.trellis/tasks/archive/2026-09/09-21-data-diff-v2/prd.md:1-40`; `.trellis/tasks/archive/2026-09/09-22-desktop-phase2/prd.md:1-20`。
- **INFERENCE**：当前“已实现”集合应以最新源码 + 后续任务测试/报告为准，早期 PRD 只能作为历史范围和设计意图证据。

### 3. E2E 与真实环境证据

#### 3.1 最新 CDP E2E（2026-09-24）

- **FACT**：报告使用 Electron remote debugging + CDP `Runtime.evaluate`、可信 `Input.dispatchMouseEvent`、dialog handler、剪贴板/文件实证。证据：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:1-5`。
- **FACT**：报告记录 T1–T8 共 22/22 动作已执行；可判定断言覆盖节点 CRUD、demo fallback、Docker MySQL fixture、结构/数据 diff、联合主键、无主键、中文、对象/INDEX/动词过滤、复制、DROP 二次确认、导出落盘、秘密文件、交换、快捷键和搜索。证据：`e2e-report.md:22-49`。
- **FACT**：Docker fixture 为 `mysql:8.0`，包含结构差异、联合主键 `pair_kv`、无主键 `no_pk_table` 和小表数据；fixture 证据不等同于指定内网真库。证据：`e2e-report.md:7-12`。
- **FACT**：报告明确 T1 截图是种子演示态，独立空节点库冷启动由 T2 证据覆盖；不能把 T1 截图单独解读为空态验证。证据：`e2e-report.md:24-26,49-57`。
- **FACT**：报告指出真实对比失败会填 demo 示例；当前有原因 toast/lastCombo，但结果对象没有独立 `real/demo` 标记。证据：`e2e-report.md:51-57`; `store.ts:611-629`; `types.ts:202-207`。

#### 3.2 历史直连/SSH/数据冒烟

- **FACT**：M7 报告记录两套 RDS 直连 metadata：515/516 表、0 view/routine、SHOW CREATE 成功；全量结构结果 521 条（DROP 332、CREATE 15、CHANGE 174），全程只读。证据：`.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md:5-24`。
- **FACT**：验证闭环报告记录 SSH 密码认证和 `exec` 连通（340ms），但目标 sshd 拒绝 `forwardOut`/TCP forwarding；私钥材料未提供，AC-V2 待补。证据：`smoke-report2.md:5-13,28-33`。
- **FACT**：同一报告记录直连 `buildings` 表 A=1/B=27 的真实 row diff：INSERT 0、DELETE 26、UPDATE 1，进度回调和中文输出正常。证据：`smoke-report2.md:15-26`。
- **INFERENCE**：已有 live 证据覆盖“直连 MySQL + 结构 + 小表数据 + 密码 SSH 认证”的一部分组合；它不覆盖 SSH forwarding 成功、private key、Windows 或所有 MySQL 版本。

#### 3.3 打包与分发

- **FACT**：electron-builder 配置目标是 Windows NSIS x64、macOS DMG x64/arm64；builder 显式引用 `icon.ico`/`icon.icns`。证据：`apps/desktop/electron-builder.yml:1-27`。
- **FACT**：最新报告记录 macOS 两个 DMG 和 Windows NSIS/PE 产物，核验了架构、DMG、图标资源和 `RT_GROUP_ICON`；报告没有 Windows 真机启动证据，且包均 unsigned。证据：`e2e-report.md:101-111`。
- **FACT**：自动更新、签名证书、公证和 CI 流水线不在最新任务范围；当前 builder 未配置这些能力。证据：`09-24-e2e-icon-release/prd.md:61-64`; `electron-builder.yml:10-27`。
- **FACT**：DBeaver 验收在无 DBeaver 安装环境采用结构化 JSON + no-secret + CDP 下载断言，报告明确不声称 IDE 真机导入。证据：`dbeaver-report.md:5-7,34-54`。
- **FACT**：DataGrip 任务仍 blocked，缺少真实脱敏 XML fixture。证据：`09-24-datagrip-converter/prd.md:1-20`。

### 4. 证据强度矩阵

| 维度 | 当前证据 | 证据强度 | 仍缺什么 |
|---|---|---|---|
| MySQL 结构 core | diff 单测 29 + metadata 13 + live 521 条报告 | **高（受 legacy parser 语义限制）** | 真实版本/复杂 DDL fixture |
| MySQL 数据 core | data diff/identity focused tests + live buildings 1/27 + Docker pair_kv/no_pk | **中高** | 大表/BLOB/无主键替代/异形列/峰值性能 |
| 连接配置/单跳 tunnel | connection 11 fake tests + SSH 密码认证 live | **中** | forwarding 成功、private key、Windows native |
| Electron UI 交互 | CDP 22/22（demo/Docker） | **中高** | live target DB、Windows native, committed harness |
| secrets/local persistence | Vault 12 tests + E2E file assertions | **中高** | 多机/备份恢复/并发/审计策略 |
| DBeaver converter | 8 unit + CDP download/no-secret | **中高（结构）** | DBeaver IDE 真机导入/发行版 driver ID |
| DataGrip converter | 无实现，fixture blocked | **无** | 真实 XML/local XML/SSH 样本和 IDE 验证 |
| 发布 | 三类包/图标/架构报告 | **中** | 签名、公证、更新、Windows 真机、CI |
| 用户/市场成熟度 | 无访谈、遥测、付费、留存 | **未知** | 目标角色、频次、痛点、替代工具、付费证据 |

### 5. 需求证据分层

#### 已证实事实

- **FACT**：代码和任务明确了一个 MySQL A→B 只读 diff 工作流；Docker/live 直连至少证明过结构和一条小表数据路径。证据：本文件 3.1–3.2；`compare-run.ts:53-135`。
- **FACT**：代码和 E2E 明确实现了结果筛选、复制、导出、风险提示和本地节点密钥隔离。证据：`App.tsx:506-975`; `e2e-report.md:35-46`; `vault.test.ts:101-140`。
- **FACT**：代码和报告明确没有自动执行、团队服务、跨库、AI、调度、DataGrip 和发布治理闭环。证据：`09-21-sqldiff-desktop/prd.md:67-69`; `09-24-product-expansion-roadmap/prd.md:27-32`; `e2e-report.md:101-111`。

#### 高价值但仍属假设

- **HYPOTHESIS**：用户是否需要把一次比较变成可交接审查包/发布前检查，当前无用户研究。仓库只有“导出 SQL、风险、回滚、history 摘要”的能力事实。证据：`types.ts:118-128`; `compare.ts:156-173`; 无 interview/telemetry 文件。
- **HYPOTHESIS**：用户是否需要在 CI/脚本中复用结果，当前只有 core/fake seam 可供推断，没有第二个入口或用户样本。证据：`preload.ts:66-106`; `package.json:6-15`。
- **HYPOTHESIS**：PostgreSQL/Oracle/其他数据库是否构成高频阻塞，当前没有目标版本、迁移频率、真实 fixture 或替代工具成本。证据：`09-24-product-expansion-roadmap/prd.md:70-76`; NodeMeta 无 engine 字段。
- **HYPOTHESIS**：团队协作/审批/审计/持续巡检的需求频次和付费意愿没有任何仓库证据。证据：根目录无账号/server/team 模块；history 只有摘要。

#### 尚待验证的问题

- **FACT**：目标用户角色、每周使用频率、一次比较后的手工步骤、报告分享方式、CI 采用情况、非 MySQL 阻塞规模、凭据/报告隐私边界，任务 PRD 明确列为 open questions。证据：`.trellis/tasks/09-24-product-expansion-roadmap/prd.md:70-76`。
- **INFERENCE**：在这些证据出现前，路线图中的“优先方向”只能是验证主题，不应被写成已证实需求；这是 [`README.md`](README.md) 的证据规则。

### 6. 当前成熟度基线（不把市场未知伪装成事实）

- **FACT：核心功能成熟度较高**：结构 diff、数据 diff、过滤、风险文本、Vault、复制/下载和 DBeaver exporter 都有当前源码与自动化/手工证据。证据：本次 17/167；`e2e-report.md:33-46`; `dbeaver-report.md:17-40`。
- **FACT：交付成熟度为预发布**：版本 `0.1.0`，包已生成但 unsigned、无 updater/CI，Windows 证据是交叉构建。证据：`package.json:2-3`; `e2e-report.md:101-111`。
- **FACT：真实环境成熟度中等**：直连和 Docker 证据较强，指定内网库、SSH forwarding/private key、Windows 真机、DBeaver IDE、DataGrip 未闭环。证据：3.2–3.3。
- **FACT：安全产品边界已建立但非审计系统**：Electron isolation、secret 分离、DBeaver no-secret、只读执行约束有证据；没有 server identity/ACL/event audit/runtime logger。证据：`main.ts:367-380`; `vault.ts:274-315`; `dbeaver.ts:137-217`; `logging-guidelines.md:1-31`。
- **INFERENCE：综合标签**：`功能完整度较高的 MySQL 单机桌面预发布/早期 Beta` 比“成熟平台”更符合当前证据。
- **HYPOTHESIS：市场成熟度未知**：无客户访谈、活跃用户、留存、付费、竞品替代成本和需求频率数据；不能进一步给出商业成熟度判断。

## Files Found

| File Path | Description |
|---|---|
| `apps/desktop/vitest.config.ts` | 当前测试收集规则 |
| `apps/desktop/src-core/*.test.ts` | core 纯逻辑和输出测试 |
| `apps/desktop/src-main/*.test.ts` | main service fake/contract 测试 |
| `apps/desktop/src-renderer/*.test.ts` | renderer pure helper 测试 |
| `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` | 22/22 CDP/Docker/打包报告和环境豁免 |
| `.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md` | 大库直连结构证据 |
| `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md` | SSH 与真实小表行级证据 |
| `.trellis/tasks/archive/2026-09/09-22-converters/dbeaver-report.md` | DBeaver 结构/no-secret/CDP 证据与真机限制 |
| `.trellis/tasks/09-24-datagrip-converter/prd.md` | DataGrip blocked 证据 |
| `apps/desktop/package.json` | 当前版本、脚本、依赖和测试命令 |
| `apps/desktop/electron-builder.yml` | 当前发布平台矩阵 |

## Code Patterns

### 证据分层原则

```text
源码存在 ≠ 测试通过 ≠ live 环境通过 ≠ 用户需求成立
```

本文件把每层分别记录：代码/单测在 `src-*`，Docker/CDP 在 `e2e-report.md`，真实直连/SSH 在 `smoke-report*.md`，外部需求在任务 PRD/open questions；没有客户数据时明确写 HYPOTHESIS。

### E2E 可信路径

```text
build/start Electron
  -> CDP Runtime.evaluate inspect
  -> Input.dispatchMouseEvent trusted click
  -> Page.handleJavaScriptDialog confirm
  -> clipboard / will-download filesystem assertion
  -> temporary user-data / Downloads cleanup
```

证据：`e2e-report.md:1-5,22-49,60-64`; `09-24-e2e-icon-release/design.md:3-10`。

## External References

- 本文件没有新增外部资料；DBeaver/DataGrip 外部事实引用当前任务已有 converter research，不把社区/官方资料当作产品需求证据。

## Related Specs

- `.trellis/tasks/09-24-product-expansion-roadmap/prd.md` — 研究目标、边界、验收与 open questions。
- `.trellis/tasks/09-24-product-expansion-roadmap/research/README.md` — FACT/INFERENCE/HYPOTHESIS 规则。
- `.trellis/tasks/09-24-product-expansion-roadmap/research/scorecard.md` — 方向评分的证据门槛。
- `.trellis/spec/backend/quality-guidelines.md` — 测试、只读、安全、打包门禁。
- `.trellis/spec/frontend/quality-guidelines.md` — CDP、可访问性和下载验证。
- `.trellis/spec/backend/database-guidelines.md` — MySQL live 验证和资源边界。
- `.trellis/spec/backend/dbeaver-export.md` — DBeaver 验收合同。

## Caveats / Not Found

- 本次没有启动真实数据库/SSH、DBeaver、DataGrip、Windows 真机或 CI；live 结论来自已归档报告，不是本次新执行。
- 任务报告的截图能证明特定 UI 状态，但原始 CDP 命令、剪贴板内容和临时 user-data 未全部归档；复现需重新运行 harness。证据：`e2e-report.md:58`。
- 17/167 单测通过不代表所有测试目标都被断言；尤其 main/preload/compare-run/data-run/UI integration 仍缺直接测试。
- 没有客户访谈、遥测、付费、留存、目标角色、需求频率或数据脱敏政策，因此市场成熟度保持未知。

## 当前产品成熟度摘要（本文件结尾）

- **FACT**：这是一个已经能完成 MySQL 双库只读结构/数据比较、筛选、风险展示、复制/下载并通过 Docker/CDP 验证的 `0.1.0` 桌面预发布产品。
- **FACT**：它有可回归的 core 与本地 Vault/DBeaver exporter 证据，但没有团队服务、跨数据库、CI/调度、AI、自动执行、DataGrip、签名/更新或完整真实环境闭环。
- **INFERENCE**：最准确的产品成熟度标签是“单机 MySQL 工作流功能完整、工程证据中等偏强、商业与平台成熟度未验证的早期 Beta/预发布”。
- **HYPOTHESIS**：是否进入安全迁移审查、自动化入口或其他扩展方向，不能由现有代码能力直接证明；需要目标用户和真实场景证据。
