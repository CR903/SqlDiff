# DataGrip 兼容节点导出（fixture 后）

## Status

**BLOCKED — 2026-09-24**：DataGrip 真实 `dataSources.xml` / `dataSources.local.xml` 脱敏 fixture 尚未提供，尤其缺少包含 SSH 隧道的真实样本。本任务不进入实现，避免猜测 JetBrains 私有 XML 标签。

## Goal

在获得真实 fixture 后，把 SqlDiff MySQL 节点导出为 DataGrip 可导入的数据源文件，并提供可验证的 SSH 拓扑迁移路径。

## Prerequisites

需要用户提供一份脱敏样本，至少包含：

- `dataSources.xml`
- `dataSources.local.xml`
- 一个普通 MySQL 源
- 一个 SSH 隧道 MySQL 源（密码、私钥和 passphrase 可删除）

样本中的主机名、库名、用户名、UUID 和路径必须替换为测试值，但 XML 结构和属性不能删改。

## Planned Deliverables

- 复用 DBeaver 导出任务的节点选择/下载入口，增加 DataGrip 目标。
- 生成同一 UUID 的 `dataSources.xml` 与 `dataSources.local.xml`。
- 精确映射已由 fixture 证实的 host、port、database、user 和 SSH 字段。
- 不导出密码、私钥或 passphrase；明确提示用户在 IDE 内补充秘密和未映射字段。
- 用 XML well-formed、UUID 一致性和 IDE 真实导入测试验收。

## Acceptance Criteria

- [ ] 真实 fixture 已脱敏并归档。
- [ ] 生成的两个 XML 可被目标 DataGrip 版本导入，连接名和拓扑与 SqlDiff 一致。
- [ ] SSH 隧道字段按 fixture 精确映射，不编造未验证标签。
- [ ] 导出内容不含密码、私钥、passphrase 或 Vault 密文。
- [ ] 单测、CDP 下载验证和三件套全绿。

## Out of Scope

- 反向导入 DataGrip → SqlDiff。
- DataSpell 特有偏离，除非后续 fixture 证明必须支持。
- 在没有 fixture 时凭公开文档猜测 SSH XML 结构。

## Related Work

- DBeaver 导出：`09-22-converters`
- 研究材料：`.trellis/tasks/09-22-converters/research/datagrip-dataspell-connection-import.md`
