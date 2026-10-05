# design.md — §11.1 保密断言 + 导出 UI E2E

## 边界

**只新增测试文件**（单测 + e2e spec），产品代码零改动。分两层：

- **B1 纯单测层**：`tests/core/` —— §11.1 无秘密属性 + 3 文件名契约。不需要 Electron、不需要 DB。
- **B2 UI E2E 层**：`e2e/specs/` —— 真机全链路。env 开关门控。

两层独立：B1 恒跑（进默认 harness），B2 按开关跑。

## B1：§11.1 无秘密属性

### 为什么必须是「跨环节的不变量」测试

§11.1 的契约不是「某个函数不读某个字段」，而是：

> 构造一份含凭据的输入 → 经过 序列化 / 结论渲染 / 细节渲染 / 写盘 → 产物里搜不到任何凭据**值**。

这个链条跨 4 个环节。任何单环节断言都捕获不了跨环节的泄漏。

### 测试构造方法

1. 造一个**含真实凭据值**的 `NodeMeta`（password / sshPassword / privateKey / passphrase / vaultCiphertext 各给一个**可识别的哨兵值**，如 `SENTINEL_PW_9f3a`）
2. 让它进入 `buildPreflightReport` 的输入（facts / inferences / issues 都会承载节点信息）
3. 走全部出口：
   - `serializePreflight(report)` → JSON
   - `preflightToExecutiveMarkdown(report)` → 结论 md
   - `preflightToDetailMarkdown(report)` → 细节 md
   - Manifest：`buildManifest` + `serializeManifest` + `manifestToMarkdown`
4. 对每个产物断言：**5 个哨兵值全部不出现**，且 7 个敏感字段名全部不出现

### 断言两层，都要

| 层 | 断言 | 挡住的泄漏 |
|---|---|---|
| 字段名 | 不含 `password` / `sshPassword` / `privateKey` / `passphrase` / `vaultCiphertext` / `userPassword` / `SecretBundle` / `SHOW GRANTS` | 结构化字段被直接序列化 |
| **值** | 5 个哨兵值逐个 `not.toContain` | 值被拼进 SQL 字面量、recommendation、targetAlias 等非字段名位置 |

**值这一层是关键**。`escapeDataIdent` / `redactDmlSql` 之外，preflight 会把 SQL 文本写进 `inferences[].statement`——如果 DDL 或 recommendation 里含连接串，字段名黑名单完全挡不住。

复用 `e2e/helpers/assertions.ts` 的 `assertNoSecrets` 思路，但**单测层要独立实现**（e2e helper 在 `e2e/` 下，单测不 import e2e 目录）。若发现两者判据重复，优先把判据提到 `src-core` 或测试共享目录——但这会动文件，需确认是否越界（本任务原则是产品代码零改动，`src-core` 属产品代码，所以**在测试目录内各自实现**）。

### 3 文件名契约

`preflightFileNames` 的 3 个名字要与 `handleExportPreflight`（`App.tsx:2363-2370`）实际写盘对齐。测试断言：

- 3 个文件名各自正确
- `checkedAt` 的 `:` 与 `.` 全被替换（这正是 `safe` 的语义）
- **文件数量为 3**（防止实现回退成 2 份而 spec/测试都没察觉——这正是本任务规划期修掉的漂移）

## B2：真机 UI E2E

### 核心约束

`导出 Preflight 报告` 读 renderer 的 React state `lastPreflightResult`（`App.tsx:2353`）。现有真机 spec 全部走 `page.evaluate(() => api.preflight.run(...))`——**API 直调不设这个 state**，所以无法验证 UI 层。

而 `canRunPreflight`（`App.tsx:673`）的前置条件是：**真实比较（非 demo）+ 至少 1 条表级 DDL 项**。

结论：**必须做一次真实比较**，且比较结果必须含表级 DDL 差异。

### 流程（全部真实点击）

```
launchElectron([])
  ↓ page.evaluate: api.nodes.create 注入含 secret 的节点（沿用现有 spec 做法）
  ↓ 真实比较：选 A 库 / 选 B 库 → 点「对比 ⚡」→ 等结果
  ↓ 点「运行 Preflight」→ 等 lastPreflightResult 出现（role="status" 的 verdict 块）
  ↓ 点「导出 Preflight 报告」→ 等 toast
  ↓ 点「导出审查报告」→ 等 toast
断言 downloadsDir 下 3 个 preflight 文件 + manifest 文件
```

关键选择器：

| 元素 | 选择器 |
|---|---|
| 比较按钮 | `button:has-text("对比 ⚡")`（`App.tsx:515`，class `btn btn-primary`） |
| Preflight 按钮 | `button:has-text("运行 Preflight")`（`App.tsx:672`），运行中文案变「Preflight 运行中…」 |
| Preflight 结果块 | `[role="status"][aria-live="polite"]`（`App.tsx:682`），内含 `getSummary().decision` |
| Preflight 导出按钮 | `button:has-text("导出 Preflight 报告")`（`App.tsx:690`，class `preflight-export-btn`） |
| Manifest 导出按钮 | `button:has-text("导出审查报告")`（`App.tsx:661`） |

保存目录靠 `SQLDIFF_E2E_SAVE_DIR`（`launchElectron` 已注入到 `downloadsDir`），`save-file.ts` 检测到就跳过系统对话框。

### 双库 fixture

需要 A、B 两个数据库且产生表级 DDL 差异（B 比 A 多一列）。沿用 `e2e/fixtures/mysql-fixture.ts` 的既有模式，扩展成建两个库。

**一举两得**：同一次比较同时满足两个导出（R5 / AC5），fixture 只建一次。

### env 门控

沿用 `e2e-harness.md` 既有约定，扩展既有开关体系：

- host / password 缺失 → skip，消息**点名变量**并说明「目标机 IP 动态，请填 `.env.e2e`」（这是上一任务 `10-05-e2e-env-readiness` 定的防回退护栏）
- `.env.e2e` 缺失是**正常状态**，静默 skip，不抛

复用 `e2e/helpers/env-loader.ts` 的 `readRequiredEnv` / `missingEnvReason`——**上一任务刚建的**，不要重写。

### 稳定性

- `timeout`：Playwright config 是 60s，单测项含真实比较 + preflight 可能不够 → 该 spec 内 `test.setTimeout(120_000)`
- 等 verdict 块出现而非固定 `waitForTimeout`
- `finally` 删两个库 + 删下载目录文件

## 权衡

**为什么 B1 用哨兵值而不是真实密码**：真实密码进测试文件 = 秘密入库（AC10 红）。哨兵值（如 `SENTINEL_PW_9f3a`）能同样证明「值没泄漏」，且自证不含真秘密。这是标准做法。

**为什么不在单测里 import `e2e/helpers/assertions.ts`**：会让 `tests/` 依赖 `e2e/` 目录，破坏上一任务确立的目录边界（`tests/` 与 `e2e/` 各自独立）。各自实现判据，代价是两份相似代码——接受，并在两处注释里互相指认，避免未来单边修改。

**为什么 UI E2E 不做 Manifest 之外的其他导出**：DataGrip/DBeaver 已有 E2E（`ui-smoke.spec.ts` 3 项）。本任务只补 spec 明确要求却缺失的两个。
