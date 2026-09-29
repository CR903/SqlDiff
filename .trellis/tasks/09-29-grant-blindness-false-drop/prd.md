# P0 授权盲区导致假 DROP

- 父任务：`.trellis/tasks/09-29-review-evidence-chain`
- 前置：`09-29-result-source-state`（已归档，本任务修正其覆盖模型的盲区）
- 后续：`09-29-review-manifest` 依赖本任务，否则报告会把假 DROP 当合法 DDL 交接

## Goal

当连接账号的授权只覆盖部分对象时，SqlDiff 目前会把「看不见的对象」误判为「不存在的对象」，输出看起来合法的破坏性 DDL。本任务自动判定比较的**完整性是否可证明**，在不可证明时收窄比较范围并明示，让用户永远拿不到基于无知推断出的 `DROP TABLE`。

## Background / Confirmed Facts

全部为 2026-09-29 在隔离 MySQL 5.7.18（`127.0.0.1:3307`，独立 datadir，fixture `cov_src`/`cov_tgt`）上的实测结果，非推理。

### 1. 缺陷已实证：假 DROP

受限账号 `cov_limited` 对 `cov_src` 只授 `open_tbl`/`open_view`，对 `cov_tgt` 额外授 `secret_tbl`：

```
cov_limited → SHOW TABLES FROM cov_src = open_tbl, open_view
cov_limited → SHOW TABLES FROM cov_tgt = open_tbl, open_view, secret_tbl
```

`compareRun` 对该输入的实际输出（`src-core/compare.ts:110-117`）：

```
PROBE_ITEMS=[{"ct":"DROP","sql":"DROP TABLE `secret_tbl`;\n"}]
PROBE_STATS={"ALL":1,"DROP":1}
```

`secret_tbl` 在 A 侧只是**不可见**，却被当作不存在，产出 `DROP TABLE`。且 `stats.DROP = 1`，界面完全正常，用户无从察觉。

### 2. 覆盖模型有一个洞

`StructureCoverage`（`src-core/types.ts`）只记录「被列举但 `SHOW CREATE` 失败」的对象。不可见对象从未进入 `skipped`，因此上一任务新增的覆盖提示**也报不出来**。

### 3. 既定 spec 声明被证伪

`.trellis/spec/backend/database-guidelines.md:36` 写着 null 跳过的作用是 "prevents a permission error from becoming a false CREATE/DROP"。实测表明它只挡住「可列举但 `SHOW CREATE` 失败」，**挡不住「根本列举不到」**。该声明必须修正。

### 4. 库级授权是完整比较的充分条件（关键且反直觉）

| 账号 | 授权 | `SHOW TABLES` 覆盖 | 比较完整性 |
|---|---|---|---|
| `cov_view` | `GRANT SELECT ON cov_src.*`（库级） | 全部对象，含 `secret_tbl` | **可证明完整** |
| `cov_limited` | 5 条表级 | 部分对象 | 可证明不完整 |
| `cov_mixed` | 库级(A) + 表级(B) | 两侧完整度不同 | 混合，逐库判定 |

即：**表级授权才是盲区来源**；绝大多数只读账号用的库级授权本就没有盲区。

### 5. 判别式实测可靠

```
cov_limited → 库级行=0 表级行=5
cov_view    → 库级行=1 表级行=0
cov_mixed   → 库级行=1 表级行=1
```

区分 ``ON `db`.*``（库级，完整）与 ``ON `db`.`tbl` ``（表级，可能盲区）。

### 6. 判据必须走 SHOW GRANTS，不能走 information_schema

`information_schema.SCHEMA_PRIVILEGES` / `TABLE_PRIVILEGES` 是 **MySQL 8.0 才引入**，5.7 上查询直接失败（实测 `ERROR 1054 Unknown column 'schema_name'`）。`SHOW GRANTS FOR CURRENT_USER()` 在 5.7/8.0 均可用，且只暴露当前用户自己的授权。

### 7. 插入点已就位

`DbQueryable`（`metadata.ts:19`）就是 `{ query(sql, params) }`，`SHOW GRANTS` 可走同一接口，无需新管道。`fetchMetadata` 已返回 `MetadataSnapshot`，`compare-run.ts:119-133` 已是 tuple 解包结构。

### 8. MySQL 8.0 角色授权会改变输出形态

8.0 下 `SHOW GRANTS` 可能返回 `GRANT \`role\` TO ...` 而不展开表级授权，按字符串匹配会漏判为「完整」。必须降级为「未证明」。

## Requirements

### R1 完整性可判定

- 比较开始前，自动判定「本次比较的可见性是否可证明完整」。
- 判据基于 `SHOW GRANTS FOR CURRENT_USER()` 的授权形态，区分库级与表级授权。
- **逐库判定**：A、B 可能完整度不同（如 `cov_mixed`）。
- 判据失败（查询失败、输出无法解析、存在角色授权）一律降级为「未证明完整」，不得默认完整。

### R2 不可证明完整时收窄比较范围

- 收窄为 **A、B 双方都可见的对象集**。
- 仅单侧可见的对象**不产生 CREATE/DROP DDL**，改列为「无法比较」并附原因。
- 假 DROP 必须归零：单侧不可见对象不再被当作「应删除」。
- 收窄不改变 A→B 方向语义，不改变已确定对象的正常 diff。

### R3 明示而非静默

- 界面明示：本次比较在受限账号下进行、比较范围为双方均可见的 N 个对象、哪些对象因授权未参与比较。
- 明示走常驻位，不依赖 2.2s toast。
- 全部可见时保持界面安静（与上一任务的覆盖提示一致）。
- 人工介入点为**账号配置一次**，不是每份 diff 逐项复核。

### R4 秘密与只读边界

- `SHOW GRANTS FOR CURRENT_USER()` 只读取**当前用户自身**授权，不查询其他用户（无 `FOR <user>` 形式）。
- 不得把授权原文写进 `CompareResult`、界面或未来 manifest；只传递判别结论与对象名清单。
- 不得新增任何写库路径；`mysqldiff/` 不动。

### R5 修正被证伪的 spec 声明

- `database-guidelines.md:36` 关于 null 跳过防假 CREATE/DROP 的表述必须限定为「可列举但 `SHOW CREATE` 失败」，并补上不可见对象的处理约定。
- 不得让新读者以为 null 跳过已覆盖全部授权场景。

## Acceptance Criteria

- [ ] AC1 完整性判别有单测：库级→完整、表级→不完整、混合→逐库、角色/无法解析→未证明、查询失败→未证明。
- [ ] AC2 受限账号下 A 侧不可见、B 侧可见的对象**不再产生 DROP**（针对本任务实证输入的回归测试）。
- [ ] AC3 单侧不可见对象被列入「无法比较」清单，含对象名、所在侧、原因。
- [ ] AC4 界面常驻明示比较范围与被排除对象，不依赖 toast。
- [ ] AC5 库级授权账号的既有行为完全不变（不收窄、无额外提示），既有测试不回归。
- [ ] AC6 隔离 MySQL 5.7 fixture 上完成端到端验证：假 DROP 归零 + 覆盖提示 + 明示三者同时成立。
- [ ] AC7 `database-guidelines.md:36` 已修正；新增 `SHOW GRANTS` 只读声明并说明角色授权降级。
- [ ] AC8 `CompareResult` 仍不携带授权原文、凭据或连接串。
- [ ] AC9 typecheck / lint / test / build 四件套全绿。
- [ ] AC10 无写库路径；renderer 无 `node:*`/`electron`/`mysql2`/`ssh2` 导入。

## Out of Scope

- 反向检测：判断「对象真的不存在」而非「不可见」——原理上不可判定（不可见对象连名字都无从获得）。
- 视图/例程的 `SHOW VIEW` 授权补齐（`cov_view` 实测 `SHOW CREATE VIEW` 返回 1142 属**可见**盲区，已由上一任务的 `permission-denied` 覆盖处理）。
- 数据 diff 的授权盲区：数据比对只对双方可见表发生，天然无假数据。
- 让用户去改数据库授权 —— 本任务只判定与提示，不代管权限。
- 自动改用更高权限账号重试。
- 上一任务的 CDP 交互验证欠账（错误卡片/明细展开仍无 CDP 证据）。

## Key Decisions

| # | 决策 | 依据 |
|---|---|---|
| Q1 | 收窄到双方可见交集，而非「拒绝比较」或「仅警告放行」 | 用户批准推荐方案。假 DROP 归零，保留部分比较能力，人工只需配账号时决定一次 |
| Q2 | 判据用 `SHOW GRANTS FOR CURRENT_USER()` | 实测：`information_schema.SCHEMA_PRIVILEGES` 在 5.7 不存在（`ERROR 1054`） |
| Q3 | 无法解析/角色授权一律降级「未证明」 | 8.0 角色授权会改变输出形态，漏判为「完整」比误判为「不完整」危险得多 |
| Q4 | 新建独立任务，不塞进 `09-29-review-manifest` | 它改变 `compareRun` 语义并证伪既有 spec 声明；manifest 会序列化该契约，必须先修 |

## Risks

- **`SHOW GRANTS` 输出解析是版本敏感的文本匹配**：8.0 角色授权、部分 `SUPER` 账号、云厂商托管实例可能改写形态。缓解：任何未识别形态降级「未证明」，不猜测。
- **收窄会改变既有用户的输出**：表级授权用户原本能看到单侧对象的 CREATE/DROP，改后消失。这是修正而非回归，但需在 AC5 用库级账号证明正常路径不受影响。
- **判据本身需要一次往返查询**：与元数据拉取并发执行，避免串行拖慢。
- **A/B 完整度可能不同**（`cov_mixed`）：必须逐库判定，不能用单一布尔。

## Open Questions

- 无阻塞性问题。Q1–Q4 已定。

## Notes

- 实证环境：隔离 MySQL 5.7.18 @ `127.0.0.1:3307`，datadir 在临时目录，fixture `cov_src`/`cov_tgt`，账号 `cov_limited`（表级）/ `cov_view`（库级）/ `cov_mixed`（混合）。**凭据仅为本地 fixture，非生产凭据。**
- 该 fixture 同时可覆盖上一任务遗留的真库 `permission-denied` 验证欠账（视图需 `SHOW VIEW`）。
- 依据：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/roadmap.md` §2.2 覆盖率、§5.2 P0 护栏。
