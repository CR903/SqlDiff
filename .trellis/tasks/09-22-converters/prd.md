# DBeaver-DataGrip兼容转换器

## Goal

把本应用自定义节点 JSON 一键转换为 DBeaver / DataGrip 可导入的连接配置，方便迁移。只导拓扑（host/port/db/user/SSH），不导密码（两家都不支持密码导入，用户首连重输）。

## Background（research已确认，见 `research/`）

- DBeaver：发 `data-sources.json`（`General/.dbeaver/`），MySQL driverId `mysql8` 待实现时核对，SSH 经 handler props；不支持 CSV 列 schema，不要发 CSV。
- DataGrip：发 `dataSources.xml` + `dataSources.local.xml`（uuid v4 新生成，两文件一致），密码只进钥匙串；SSH 隧道 XML tag 未公开——不编 tag，只导 jdbc-url+user，SSH 让用户在 IDE 内配（或实现时抓一份真实导出做 fixture 再定）。
- 两家都不吃密码：转换器只出拓扑。

## Requirements

- R1 导出：节点多选/全部 → 生成目标文件（DBeaver `data-sources.json` / DataGrip 双 XML 打 zip），下载/落盘。
- R2 字段映射：别名→name，host/port/user/database 直映；SSH（host/port/user/key路径）按 research 映射，缺失项留空+提示。
- R3 无密码提示：导出前明确告知“需首连重输密码”，报告列出未带字段。
- R4 回归：示例节点转出后做格式校验（JSON schema/XML well-formed + 必填字段断言），单测覆盖。

## Acceptance Criteria

- [ ] 选3个样本节点（含SSH/无SSH/密钥）转出，两格式文件结构正确。
- [ ] 用户实测可导入（DBeaver 文件导入/DataGrip file-drop），连接名与拓扑一致。
- [ ] 三件套全绿，`mysqldiff/` 零改动。

## Out of Scope

- 密码迁移；SSH隧道tag编造；反向导入（DataGrip→本应用，二期再议）。

## Status

**SUSPENDED 2026-09-23**：用户无 DBeaver/DataGrip，无法提供真实导出 fixture，任务搁置。DBeaver 侧格式已吃透；DataGrip 侧待 fixture 到后再启。恢复条件：用户补 `dataSources.xml` + `dataSources.local.xml`（脱敏）。

## Open Questions

- [x] Q1 目标优先级：已定 **DBeaver+DataGrip都要**（2026-09-22用户确认，一次到位）。
- [x] Q2 DataGrip侧SSH：已定 **按真实导出做fixture精确映射**（2026-09-22用户确认）。待用户提供一份脱敏的 `dataSources.xml` + `dataSources.local.xml`（需含一个SSH隧道MySQL源，密码可删）。
