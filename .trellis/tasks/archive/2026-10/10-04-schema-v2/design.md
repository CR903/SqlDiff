# design.md — Schema v2：结论进结构

## 架构与边界

- 只动结构装配 + 读取适配，不动规则引擎、采集器、渲染文案。
- `summary` 是 `verdict/issues` 的派生快照（写入时一次算出），不是新的事实来源；规则层零改动。

## 数据契约

```ts
// preflight-types.ts，追加在 verdict 之后（字段顺序即序列化顺序，v1 前缀字段不动）
summary: {
  decision: 'GO' | 'DEGRADED' | 'BLOCK';
  message: string;          // 与 deriveDecision.message 同文案
  blocking: number;         // = verdict.blocking，快照
  warnings: number;
  unknowns: number;
};
```

- `PREFLIGHT_REPORT_VERSION` 1 → 2。
- 写入点：`preflight.ts` 报告装配处（`schemaVersion: PREFLIGHT_REPORT_VERSION` 附近，约 `:101`），`summary: deriveDecision(report)` 一次算出。
- 读取适配：新增 `getSummary(report)`——有 `summary` 直接返回；v1 缺字段时 `deriveDecision(report)` 回填（纯函数，无数据损失）。
- UI：`App.tsx:681,685` 改 `getSummary(...).decision`；`verdict` 保留做计数展示。

## 兼容与迁移

- 旧 v1 JSON：可读、可渲染、可参与历史 diff（回填后的 `summary` 与 issues 一致）。
- 旧序列化快照测试：预期更新（byte 变化是本任务的目的，不是回归）。
- 回滚：删字段即回 v1；`getSummary` 保留则新旧通吃。

## 重要权衡

- 计数冗余（blocking/warnings/unknowns 在 verdict 和 summary 各存一份）：为让 `summary` 自包含（JEV prompt 可只喂 summary），接受这点冗余。
- 双视角全文不进 JSON（Q1 已定）：JSON 保持轻量，避免与 md 文件双写不一致。

## 运维/回滚

- 纯本地结构变更，无迁移脚本；`mysqldiff` 未改；只读边界不变。
