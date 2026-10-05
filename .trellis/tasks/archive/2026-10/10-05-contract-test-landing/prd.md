# 契约落地：补齐已声明但未兑现的测试

## Goal

把**代码或 spec 已经声明、但至今没有任何测试兑现**的契约补上。两个来源，都用代码面证据扫出来，不凭记忆：

1. **代码声明了但没测**：9 个导出函数测试零引用，其中 `escapeDataIdent` 是表名/列名进 SQL 的必经防线。
2. **spec 要求了但没测**：`§11.1` 保密硬边界（导出物不得含凭据）在全仓**零断言**——`assertNoSecrets` 只用在 DataGrip/DBeaver，Preflight 与 Manifest 导出物一条都没有。

两条线都属"让已有契约变成真的"，不新增产品能力。

## 背景（已核实事实 · 2026-10-05）

### 来源 1：9 个导出函数测试零引用

代码面扫描（grep 函数名在 `tests/**/*.test.ts` 的出现）：

| 函数 | 风险 | 现状 |
|---|---|---|
| `escapeDataIdent`（`src-core/data-diff.ts`） | **SQL 标识符注入防线**，注释明写「表名/列名进 SQL 前必经此函数」 | `data-diff.test.ts` 覆盖同文件其余 4 个导出，**唯独漏它** |
| `isHistoryEntry`（`src-main/store-json.ts`） | 5 字段反序列化守卫，被 `src-main/main.ts:23` **直接 import** 走 IPC | 仅经 `loadHistory` 间接覆盖，无字段级判别矩阵 |
| `isNodeMeta` | 9 字段结构守卫（读 `nodes.json`） | 同上 |
| `nodesFilePath` / `historyFilePath` | 路径构造，`userDataDir` 是路径穿越面 | 无直测 |
| `resolveUserDataDir` | 路径解析与环境变量回落 | 无直测 |
| `clearHistory` | 破坏性操作（删文件） | 无直测 |
| `testConnection` | 连接冒烟，4 处内部引用 | 无直测 |
| `diffTableField` | 核心 diff 引擎，生成 ALTER 语句串 | 无直测（经 `diffTable` 间接覆盖） |

注：这不是"零覆盖"——多数有间接覆盖，缺的是**直接契约测试**（字段级判别矩阵、边界输入、异常路径）。

### 来源 2：spec 强制要求的测试不存在

- `.trellis/spec/frontend/quality-guidelines.md:69` 要求：点 `导出 Preflight 报告` → 接原生保存框 → 校验落盘 → 解析 JSON 断言 `schemaVersion === 2` / `source === 'real'` / 正文不含凭据字段；并要求"与 review-manifest 导出断言放同一个 CDP harness run"。实测 `e2e/` 无对应 spec。
- `.trellis/spec/backend/preflight.md §11.1` 把"导出物必须不含连接凭据"列为**保密硬边界**。实测：`tests/core/preflight*.test.ts` 与 `e2e/` 对 Preflight / Manifest 导出物的凭据字段**零断言**。

### 关键约束：导出物是三个文件，不是两个

`preflightFileNames` 返回 3 个文件名（`.json` / `.md` 结论 / `-detail.md` 细节），`handleExportPreflight`（`App.tsx:2363-2370`）一次 `saveTextFiles` 写 3 份。spec 的两处交叉引用原本写"2 份"，本任务规划期间已修正（`6818043`）。

## 用户决策

- **D1**：采用**父 + 二子任务**结构，两条线独立验证。
- **D2**：子任务 B 的 UI 可达性走**真机 UI 全链路**，**零产品代码改动**（拒绝 env 门控的测试 seed 方案）。

## Task Map

| 子任务 | 范围 | 可独立验证 |
|---|---|---|
| [A · unit-test-gap-landing](./unit-test-gap-landing/) | 9 个零直测导出的契约测试 | 是（vitest） |
| [B · export-e2e-landing](./export-e2e-landing/) | §11.1 无秘密属性 + 3 文件契约 + UI 可达性真机 E2E | 是（vitest + e2e） |

无依赖关系，可并行 dispatch。父任务只做集成复核，不承担实现。

## Requirements

- [ ] R1 每个功能与优化项都带测试用例，统一放 `apps/desktop/tests/` 目录（用户长期规则，见 `.trellis/spec/backend/quality-guidelines.md`）
- [ ] R2 新增测试放对子目录：纯函数 → `tests/core/`，主进程/IO → `tests/main/`
- [ ] R3 §11.1 保密硬边界必须有**直接断言**：构造含凭据的输入 → 走 Preflight 三种导出格式 + Manifest 导出 → 断言产物不含任何凭据值
- [ ] R4 导出物文件名契约（3 个文件）必须有测试锁死，防止 spec/实现再次分叉
- [ ] R5 UI 可达性 E2E 走真机：`对比 ⚡` → `运行 Preflight` → `导出 Preflight 报告` + `导出审查报告`，**不新增任何产品代码 hook**
- [ ] R6 不引入新依赖；浏览器/Node API 用现有 mock 手段
- [ ] R7 测试不得把产品 bug 顺手改掉：发现缺陷记录并另开任务
- [ ] R8 秘密不入库：真实密码只进 `.env.e2e`（已 gitignored）

## Cross-Child Acceptance Criteria

- [ ] AC1 `npx vitest run` 全绿且**项数净增**（当前基线 748 项 / 50 文件）
- [ ] AC2 `npm run typecheck` / `lint` / `build` 全绿
- [ ] AC3 9 个目标函数各自至少有 1 项直测；`escapeDataIdent` 覆盖反引号加倍等注入边界
- [ ] AC4 §11.1 无秘密断言覆盖 Preflight 三种导出格式 **与** Manifest 导出，且断言非空转（变异测试自证）
- [ ] AC5 UI 可达性 E2E 在真机上真实执行（非 skip），产出 3 个 Preflight 文件 + Manifest 文件并校验内容
- [ ] AC6 `git grep -i "DB.smarterlab"` 为 0；`.env.e2e` 未入库
- [ ] AC7 产品代码 `src-core/` `src-main/` `src-renderer/` 零改动（D2 硬约束）
- [ ] AC8 spec 与代码口径一致：`schemaVersion === 2`、导出 3 份文件

## Out of Scope

- **preflight 产品能力扩展**（A 侧 preflight / DML preflight / 视图例程 DDL / 多目标并行，见 `preflight.md §11`）——属产品方向，需独立立项
- **8.0.12–8.0.28 中间版本真机覆盖**——需新机器，阻塞在硬件
- **SSH 隧道真机覆盖**——历史上服务端拒绝转发
- **改动产品代码加测试 hook**——用户已明确拒绝（D2）
- **覆盖率工具接入**（c8/nyc）——不引入新依赖

## Key Decisions

- **D2 是有代价的选择，代价要写明**：真机 UI E2E 慢（~30s/项）、依赖数据库可达、开关关闭时不执行。收益是零产品代码改动 + 测的是真链路。接受这个权衡。
- **补测范围以代码面扫描为准**，不按任务历史追认——历史任务的 AC 当时已覆盖过，追认会产生无价值重复用例。
- **区分"零覆盖"与"无直测"**：多数函数有间接覆盖，PRD 用词准确，避免把已有覆盖说成完全没有。

## Open Questions

无。
