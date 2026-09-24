# Research: 能力地图与当前产品成熟度

- **Query**: 基于当前仓库事实输出最终能力地图，并给出当前产品成熟度摘要。
- **Scope**: internal synthesis
- **Date**: 2026-09-24
- **成熟度标记**: 本文分数是 `INFERENCE`，用于表达“已有实现/验证证据的层级”，不是市场份额、用户满意度或收入判断。事实依据来自 `capability-inventory.md`、`data-security-deployment-constraints.md`、`desktop-ui-flow.md` 和 `technical-debt-and-reusable-seams.md`。

## Findings

### 1. 一句话能力地图

**SqlDiff 当前是一个已具备单机 MySQL 双库只读迁移检查闭环的 Electron 桌面工具：它能把 A(Source)/B(Target) 的表/视图/过程/函数结构及可选数据行差异，转换为带风险/回滚说明的 SQL，并支持节点加密存储、过滤、复制、.sql 导出、自定义 JSON 迁移和 DBeaver 拓扑导出。**

证据链：产品定位见 `.trellis/tasks/09-24-product-expansion-roadmap/prd.md:9-15`；结构/数据主链见 `apps/desktop/src-main/compare-run.ts:61-141`、`apps/desktop/src-main/data-run.ts:255-321`；UI 见 `apps/desktop/src-renderer/App.tsx:1637-1760`；只读边界见 `.trellis/spec/backend/index.md:1-3`。

### 2. 分层能力地图

```text
用户任务层
  节点维护 → A/B 选择 → 范围/映射 → 运行 → 过滤/审查 → 复制/导出 → 历史/迁移辅助
      │
存储与信任层
  NodeMeta / HistoryEntry（本地 JSON）
  SecretBundle（safeStorage 或 AES-GCM Vault）
  renderer 只通过 contextBridge 调 main
      │
连接与资源层
  MySQL pool / 单跳 SSH tunnel / latency test / cleanup
      │
读取与快照层
  information_schema + SHOW CREATE + COUNT + keyset SELECT
      │
确定性比较层
  structural diff + row identity + DML generation + classify/aspect/risk/filter
      │
交付与证据层
  SQL preview/copy/download + history + CDP/unit/E2E evidence + Electron packages
```

### 3. 能力状态图例

- **已验证**：代码路径存在，且有 focused test、fixture、CDP 或历史报告证据。
- **部分验证**：核心代码存在，但真实环境/平台/规模/IDE 验证仍有明确限制。
- **接口/预留**：类型、handler 或字段存在，但用户流程尚未闭合。
- **明确边界**：当前任务/规范明确不做，或源码没有执行/运行时路径。

### 4. 当前能力分层状态

| 层 | 状态 | 已有能力 | 主要未闭合部分 | 证据 |
|---|---|---|---|---|
| 核心结构 diff | **已验证（MySQL 窄域）** | 表/视图/过程/函数；表语句拆分；分类、风险、回滚；A→B 方向 | legacy text parser 对复杂 DDL 的覆盖未形成完整语义模型 | `apps/desktop/src-core/diff.ts`; `apps/desktop/src-core/compare.ts`; `apps/desktop/src-core/diff.test.ts` |
| 数据 diff | **已验证（小表/明确身份）** | PK/联合 PK/全非空 UNIQUE；分页；阈值；进度/取消；INSERT/DELETE/UPDATE | 大表内存、schema 形状、BLOB、no-PK/nullable UNIQUE 只能跳过或告警 | `apps/desktop/src-main/data-fetch.ts`; `apps/desktop/src-main/data-run.ts`; `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md`; `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` |
| 连接/SSH | **部分验证** | 直连、单跳 password/privateKey、pool、tunnel cache、延迟 | 私钥真机、目标服务器转发、更多连接选项未闭环 | `apps/desktop/src-main/connection.ts`; `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md` |
| 节点/秘密 | **已验证（本地）** | CRUD、safeStorage/AES-GCM、加密 JSON、老串导入、原子写 | 跨机器自定义导入、pin/notes/clear-history UI 不完整 | `apps/desktop/src-main/vault.ts`; `apps/desktop/src-main/store-json.ts`; `apps/desktop/src-renderer/App.tsx` |
| UI 主闭环 | **已验证（demo + Docker fixture）** | 三栏、拖拽/选择、过滤、单条/批量复制、导出、数据面板 | demo/real 结果同模型；无 React/a11y 自动化；部分历史规划已漂移 | `apps/desktop/src-renderer/App.tsx`; `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md`; `.trellis/spec/frontend` |
| 互操作 | **部分验证** | DBeaver topology JSON、确定性输出、CDP 下载 | 无真实 DBeaver IDE import；DataGrip fixture 阻塞；反向 converter registry 空 | `apps/desktop/src-main/converters/dbeaver.ts`; `.trellis/tasks/archive/2026-09/09-22-converters/dbeaver-report.md`; `.trellis/tasks/09-24-datagrip-converter/prd.md` |
| 桌面交付 | **部分验证** | Win x64 NSIS、mac x64/arm64 DMG、图标、可重复 pack | unsigned；无 updater/CI；Windows 真机未验证；Linux target 未配置 | `apps/desktop/electron-builder.yml`; `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` |
| 产品运营/协作 | **未证实** | 本地 history 和导出文件 | 无账号、项目、评论、审批、审计、调度、通知、用户数据 | `apps/desktop/src-core/types.ts:118-128`; `.trellis/tasks/09-24-product-expansion-roadmap/prd.md:70-76` |

### 5. 成熟度评分（1–5，INFERENCE）

评分含义：1 = 原型/未闭环；2 = 功能存在但依赖手工/局部验证；3 = 核心路径可用且有回归证据；4 = 关键真实环境与发布流程已验证；5 = 具备长期运营、支持和用户证据。当前没有用户研究数据，因此没有“商业成熟度”评分。

| 维度 | 分数 | 解释 | 证据/限制 |
|---|---:|---|---|
| 核心算法可回归性 | 4 | 纯 core 拆分清楚；当前 17 files/167 tests 绿；结构/数据/过滤/身份/风险均有 focused tests | `npm test` 本次输出；`apps/desktop/src-core/*.test.ts`、`apps/desktop/src-main/*.test.ts` |
| 核心用户闭环 | 3 | 桌面 UI 从节点到 SQL 导出完整；demo/Docker/CDP 证据充分；真实目标环境和部分连接场景受限 | `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:22-58` |
| 数据规模能力 | 2–3 | 已从 5000 全量升级到 keyset/阈值/取消；仍 materialize 单表、无 stream/BLOB 策略 | `apps/desktop/src-main/data-fetch.ts`; `technical-debt-and-reusable-seams.md` |
| 安全/秘密边界 | 3 | Electron lockdown、加密 vault、no-secret export、只读 SQL 都有代码/测试；结构 DDL legacy interpolation、跨机器导入和手工执行责任仍在 | `.trellis/spec/backend/quality-guidelines.md`; `apps/desktop/src-main/vault.ts`; `apps/desktop/src-core/diff.ts` |
| 连接覆盖 | 2–3 | 直连可用，单跳 SSH password 有部分真机证据；private key/tunnel forwarding 未闭环 | `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:5-18` |
| 互操作 | 2–3 | DBeaver 结构导出可用；真实 IDE 和 DataGrip 尚无实证/被阻塞 | `.trellis/tasks/archive/2026-09/09-22-converters/dbeaver-report.md`; `.trellis/tasks/09-24-datagrip-converter/prd.md` |
| 发布/运维 | 2 | 包和图标已产出；unsigned、无 updater/CI/签名，Windows 仅交叉构建 | `apps/desktop/electron-builder.yml`; `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111` |
| 可访问性/自动化 | 2 | 有 trusted CDP 和 pure tests；无 React Testing Library/jsdom/a11y 自动化，已知键盘/focus 缺口 | `.trellis/spec/frontend/quality-guidelines.md` |
| 协作/规模化产品 | 1 | 当前数据模型是单机 NodeMeta/HistoryEntry/DiffItem，无身份、项目、审批、审计 | `apps/desktop/src-core/types.ts`; `apps/desktop/src-main/store-json.ts` |

### 6. 按产品阶段的总体判断

#### 6.1 已经跨过的阶段：可用的本地迁移检查器

- **FACT**：结构比较和结果审查有确定性 core、测试和 UI；数据比较有真实小表/Docker fixture；节点 CRUD/秘密存储/下载有 E2E 断言。
- **INFERENCE**：如果目标用户是单个 DBA/开发/发布人员，在可访问的 MySQL 和本机 Electron 环境下，SqlDiff 已能完成一次从连接到 SQL 交付的工作流。

#### 6.2 尚未跨过的阶段：可重复的迁移治理/团队产品

- **FACT**：history 只记录摘要，不保存 diff snapshot、基线版本、审查状态或审批；没有项目文件、服务端、账号、评论或通知。
- **FACT**：当前部署是 unsigned desktop package；没有 updater/CI 证据。
- **INFERENCE**：产品成熟度更像“功能完整的单机工具/技术验证产品”，而不是已经被团队流程、版本治理和运维责任验证的平台。

### 7. 事实、推断、假设分层摘要

#### 已证实事实（FACT）

1. MySQL 直连、单跳 SSH、节点加密存储、结构/数据只读 diff、SQL preview/copy/export、history、DBeaver topology export、双平台包均有当前源码或任务证据。
2. 生成 SQL 没有应用内执行路径；无 PG/Oracle/云协作/AI/自动更新/签名配置。
3. 当前自动门禁 17 test files/167 tests、typecheck、lint 全绿；E2E 22/22 动作在 demo/Docker fixture 范围通过，但环境限制仍在报告中。
4. DataGrip 任务阻塞于真实脱敏 fixture；指定内网真库、SSH 私钥/隧道、Windows 真机、DBeaver IDE import 未闭环。

#### 高价值推断（INFERENCE）

1. 当前最稳固的产品边界是“本地、只读、MySQL 定向、输出迁移 SQL”，而不是跨数据库或执行平台。
2. `src-core` 与 `runCompareRequest`/`runDataCompare` 是最清晰的可复用能力面；这说明技术上有扩展入口，但不证明用户需要某种新产品。
3. 主要成熟度瓶颈已从“能否比较”转移到“真实环境/大表/发布/互操作/结果治理”的证据完整性。

#### 待验证假设（HYPOTHESIS）

1. 目标用户更可能是 DBA/发布/测试人员，还是独立开发者；当前没有访谈/角色数据。
2. 用户完成一次比较后最耗时的是发现差异、生成安全 SQL、传递审查材料，还是持续回归；当前没有使用研究。
3. 团队是否需要把审查包接入 CI/项目文件；当前只有技术 seam，没有需求证据。
4. DataGrip/更多数据库/AI/协作的真实频次和付费意愿未知；不能从可实现性直接推出优先级。

### 8. 当前明确的能力地图边界

```text
已覆盖：NodeMeta / SecretBundle / CompareRequest / CompareResult / DiffItem / DataTableStatus
未覆盖：Project / BaselineSnapshot / ReviewPackage / User / Permission / Approval / AuditEvent / Schedule / Notification / DialectAdapter
```

- `NodeMeta`、`SecretBundle`、`CompareRequest`、`DiffItem`、`DataTableStatus` 是当前真实领域契约：`apps/desktop/src-core/types.ts:41-207`。
- `HistoryEntry` 只有 id/time/A-B alias/ids/diffCount：`apps/desktop/src-core/types.ts:118-128`；没有结果快照或审查状态。
- `NodeConverter` registry 是空的后续入口：`apps/desktop/src-main/converters/index.ts:14-32`；DBeaver exporter 独立实现，不等于反向导入。
- 路线图中若出现 Project/Baseline/Review/Team/Automation 等概念，当前仓库只能把它们视为候选假设，不是已有对象。

## Related Research

- [`capability-inventory.md`](capability-inventory.md) — 详细能力矩阵、用户流程、已实现/未实现清单。
- [`data-security-deployment-constraints.md`](data-security-deployment-constraints.md) — 数据流、只读 SQL、Vault、部署矩阵和环境限制。
- [`desktop-ui-flow.md`](desktop-ui-flow.md) — 三栏 UI、状态/IPC、下载、a11y 和测试证据。
- [`technical-debt-and-reusable-seams.md`](technical-debt-and-reusable-seams.md) — 技术债分类、模块边界和可复用 seam。
- [`README.md`](README.md)、[`scorecard.md`](scorecard.md) — 证据等级和候选方向评分框架。
- [`../roadmap.md`](../roadmap.md) — 主路线图草案；最终决策仍需把本文件的事实与用户验证结合。

## Caveats / Not Found

- 本文的成熟度分数不是用户满意度、市场成熟度或安全审计结论；它们只反映仓库中可见的实现和验证证据。
- 真实用户访谈、留存/频次、付费、目标数据库分布、CI 使用情况在仓库中未找到。
- 指定内网数据库、SSH 私钥/转发、Windows 真机和 DBeaver IDE import 的证据缺口已在相关报告中保留，没有被本地 Docker/结构化 JSON 证据替代。
- 研究阶段没有修改产品代码、PRD 或 spec，只写入当前任务的 `research/` 文件；本次 Check Agent 仅修正当前任务文档，未修改产品代码、spec 或任务配置。
