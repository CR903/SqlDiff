# Implement — 授权盲区导致假 DROP

## 1. 类型与纯解析（`src-core/`）

- [x] 新增 `Visibility`、`ExcludedObject`、`CompareVisibility` 到 `src-core/types.ts`
- [x] 新增授权文本解析纯函数（放 `src-core`，可单测）：
  - 输入 `SHOW GRANTS` 行数组
  - 库级 ``ON `db`.*`` / 全局 `ON *.*`(非 USAGE) → `full`
  - 表级 ``ON `db`.`tbl` `` → `partial`
  - 角色授权（`GRANT \`role\` TO`，无 `ON`）/ 无法解析 / 空 → `reliable:false` + 全 `partial`
- [x] `CompareResult` 加可选 `visibility?`

## 2. 授权探针（`src-main/grants.ts` 新文件）

- [x] `assessVisibility(db: DbQueryable)`：执行 `SHOW GRANTS FOR CURRENT_USER()`，交给 core 纯解析
- [x] **只允许 CURRENT_USER**，不提供 `FOR <user>` 入口（R4）
- [x] 查询抛错 → `reliable:false`，不冒泡（不阻断正常比较）
- [x] 不记录/不返回授权原文，只返回 `VisibilityAssessment`

## 3. 收窄（`src-main/compare-run.ts`）

- [x] 并发执行 `assessVisibility(A)` / `assessVisibility(B)`
- [x] 新增 `narrowToSharedVisibility(filteredA, filteredB, visA, visB, scopes)`：任一侧非 `full` 时取双方可见交集，单侧对象移出并记 `ExcludedObject`
- [x] 收窄在 `compareRun` **之前**（`compare.ts:110-117` 假 DROP 在 core 内生成）
- [x] `result.visibility = { excluded, compared, reliable }`
- [x] 不改 `compareRun` 签名/语义

## 4. Store + UI

- [x] store 新增 `visibility` 状态；成功路径写入，其余路径复位
- [x] `App.tsx` 状态行：`excluded.length > 0` 时追加「· N 个对象因授权未参与比较」，可展开明细
- [x] `reliable === false` 时用更强措辞「授权范围无法确认，已按最保守范围比较」
- [x] `excluded.length === 0 && reliable` → 不显示任何提示（界面安静）
- [x] 明细复用上一任务 `coverage-card` / `st-skipped` 样式，不新增独立面板
- [x] 展开态归 `App` 局部 `useState`，**不进 Zustand**

## 5. 测试

- [x] 授权解析：库级→full、表级→partial、混合→逐库、角色→unreliable、无法解析→unreliable、查询失败→unreliable
- [x] 收窄：单侧不可见对象移出交集
- [x] **回归（核心）**：`cov_limited` 实证输入下 `secret_tbl` **不产生 DROP**
- [x] 库级账号路径不变（AC5）：不收窄、无额外提示
- [x] `reliable:false` 时保守收窄
- [x] `CompareResult.visibility` 可选，既有 core 测试不回归

## 6. 规格同步（Phase 3.3）

- [x] `database-guidelines.md:36` 限定 null 跳过为「可列举但 SHOW CREATE 失败」，补不可见对象约定（该声明已被证伪）
- [x] `error-handling.md` 新增 `SHOW GRANTS FOR CURRENT_USER()` 只读声明 + 角色授权降级说明
- [x] `state-management.md` / `quality-guidelines.md` 补范围明示与 CDP 验证点

## 7. 端到端验证（隔离 MySQL @ 127.0.0.1:3307）

- [x] `cov_limited`（表级）：假 DROP 归零 + 覆盖提示 + 范围明示三者成立（主会话 PROBE_PASS 实证）
- [x] `cov_view`（库级）：行为与改动前一致，不收窄（主会话实证）
- [x] `cov_mixed`（A 全 B 不全）：逐库判定正确（主会话实证）
- [x] 顺带清理上一任务欠账：视图 `SHOW CREATE` 返回 1142 时 `permission-denied` 分支对真库生效
- [x] 凭据未写入任何任务产物（全仓扫描无残留）

## Validation

```bash
cd apps/desktop
npm run typecheck
npm run lint
npm test
npm run build
```

步骤 1–2 完成后先跑一次 typecheck + test，确认 core 契约未破坏。步骤 3 完成后重点跑回归测试确认假 DROP 归零。

## Risky Files / Rollback Points

| 文件 | 风险 | 回滚 |
|---|---|---|
| `src-main/compare-run.ts` | 步骤 3 改变既有用户输出（表级账号） | 单独回滚 3–4，不影响 1–2 |
| `src-core` 授权解析 | 版本敏感文本匹配，8.0 角色授权形态不同 | 已在 `reliable:false` 降级；单测覆盖退化分支 |
| `src-main/grants.ts` | 新 SQL 类型超出既有只读清单 | 需先在 spec 登记（步骤 6），再实现 |

## Review Gates

1. 步骤 1–2 后：解析单测全绿，`reliable:false` 分支覆盖
2. 步骤 3 后：`cov_limited` 回归测试确认假 DROP 归零；`cov_view` 确认不变
3. 步骤 7 后：三账号 fixture + 视图 permission-denied 端到端通过
4. 全量四件套通过后进入 `trellis-check`

## Before `task.py start`

- [x] `implement.jsonl` / `check.jsonl` 各含至少一条真实 spec 条目
- [x] 用户已明确批准最终规划摘要
