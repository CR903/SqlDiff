# design.md — 多次 preflight 历史对比

## 架构与边界

- 存储在 main 进程（有 userDataDir 权限），沿用 `store-json.ts` 的读写模式：新增 `preflight-history.json`，`preflightHistoryFilePath` + `load/append` 函数。
- diff 是纯函数，活在 `src-core`（可单测、无 Electron 依赖）：`diffPreflight(a, b)`。
- UI 只做展示：历史视图读 IPC 数据，不直接碰文件。

```ts
interface PreflightHistoryEntry {
  id: string;                 // run id
  at: string;                 // ISO 时间
  bId: string; bAlias: string; database: string;
  schemaVersion: number; appVersion: string;
  report: PreflightReport;    // 完整报告（含 summary，v1 旧文件读时回填）
}

interface PreflightDiff {
  verdictChanged: boolean;
  from / to: summary快照;
  addedIssues: PreflightIssue[];
  removedIssues: PreflightIssue[];
  severityChanged: { id: string; from: string; to: string }[];
}
```

## 数据流

```
runPreflight 成功 → main 进程 append（同组超 10 份滚动淘汰）
UI 历史视图 → IPC list（按目标库分组）→ 选两次 → IPC get → diffPreflight → 展示
```

- 同库约束：只允许同 `(bId, database)` 的两次对比，跨组选择 UI 直接禁用。
- v1 旧报告进历史：允许存，diff 时 `getSummary` 回填后参与对比。

## 兼容与迁移

- 新文件，无旧数据迁移；`history.json`（compare 历史）不动。
- 无秘密：report 本不含 secret（facts 是版本/行数/结构计数）；check 阶段逐项扫描入库字段。

## 重要权衡

- 存完整报告而非摘要：任意两次 diff 需要 issues/inferences 全量，摘要不够；代价是文件更大，故每组只留 10 份（compare 摘要留 20 条，体量不同）。
- 写盘时机：只在成功 run 后写；失败/取消不留痕，避免半份报告污染对比。

## 运维/回滚

- 删文件即清空历史，无迁移脚本；`mysqldiff` 未改。
