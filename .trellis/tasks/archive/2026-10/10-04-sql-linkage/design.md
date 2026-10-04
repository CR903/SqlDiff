# design.md — SQL 生成联动

## 架构与边界

- 建议是**派生数据**，不是新事实：纯函数 `deriveSuggestedEdits(report): Suggestion[]`，不进 schema、不改规则引擎（schema-v2 的 `summary` 保持轻量，Q1 结论不变）。
- 交付物默认不变：导出的 DDL 文件本体不受影响，只有用户显式"应用"才改待导出文本。

```ts
interface SuggestedEdit {
  issueId: string;        // 例 'LARGE_TABLE_INSTANT_ADD:diff-item:d01'
  tableName: string;
  find: string;           // 待匹配的 DDL 片段（归一化后）
  replace: string;        // 追加 ALGORITHM=INSTANT 后的片段
  reason: string;         // 引用规则与版本依据
}
```

- 首批只覆盖 `LARGE_TABLE_INSTANT_ADD`（ADD_COLUMN + ≥8.0.12 + 大表 + 矩阵 INSTANT，四条件与规则同源，避免建议与判定打架）。
- v1 乐观推断风险对冲：建议文案必须带版本前提（"≥8.0.12 且无特殊 DEFAULT 子句"），应用前预览 diff 强制可见。

## 数据流

```
runPreflight → report → deriveSuggestedEdits(report) → executive md 新增一节
                                              ↓
                              UI 预览 diff → 用户确认 → 待导出 DDL 文本替换（可撤销）
```

## 兼容与迁移

- 无 schema 变更，无旧文件问题；`mysqldiff` 未改；只读边界不变（改的是用户本地待导出文本，不是线上执行）。

## 重要权衡

- 建议与判定同源（都读 inferences/issues）：规则改了建议自动跟上，不会出现"报告说行、建议说不行"。
- `find` 用归一化匹配而非字符串死抠：DDL 大小写/空白差异不影响命中；匹配不上则该条建议静默丢弃并记 unknown，不硬套。

## 运维/回滚

- UI 应用动作全在 renderer 本地，可撤销；revert 即回建议前文本。
