# 数据对比二期

## Goal

在桌面版补齐数据对比：分页/流式读取、联合主键全支持、无主键表明确告警并给替代策略，修复老 `mysqldiff` 的 `limit 5000` 与单主键缺陷。只读生成 INSERT/DELETE/UPDATE，不执行。

## Background（老逻辑已确认）

- `DB.js:102-105`：`select * limit 5000` 全量拉内存。
- `mysqldiff:218-222 getTablePK`：正则取第一个反引号主键，联合主键/无主键必错。
- `mysqldiff:143-212 diffData`：按主键拼 key，全表 map 比对，生成 INSERT（多VALUES）/DELETE/UPDATE；`addslashes:140-142` 转义。
- M7已验证两库各515+表，数据对比必须分页否则内存爆炸。

## Requirements

- R1 主键解析：SHOW CREATE 全量解析 PRIMARY KEY(a,b) 联合主键；无主键/无唯一键表 → 告警 calibre high + 跳过行级diff，只给行数差异+建议（加主键/按整行hash预览）。
- R2 读取：主键范围分页（order by pk limit N）或流式 cursor，默认批量1000，可配置；大表进度条+可取消。
- R3 比对：按联合主键拼key，INSERT多VALUES分批（默认500行一批）、DELETE按主键、UPDATE只列变更列；沿用 addslashes 转义语义。
- R4 UI：R3范围勾选恢复“数据”项，表映射（同名自动+手动改），逐表状态（待比/进行中/完成/跳过无主键），结果进 DiffTable（INSERT/DELETE/UPDATE归类到 CREATE/DROP/CHANGE？见Q1）。
- R5 安全：全程只读；单表行数阈值（默认10万）超限需二次确认。

## Acceptance Criteria

- [ ] 联合主键表diff正确（单测3例）。
- [ ] 无主键表跳过+告警+行数差异展示。
- [ ] 万级表分页完成不OOM，有进度+取消。
- [ ] UI选表跑一次数据对比，结果可按类复制/导出。

## Out of Scope

- 自动执行；跨库异构表结构映射；BLOB大字段优化（首批按文本处理，超限截断提示）。

## Open Questions

- [x] Q1 DML归类：已定 **独立INSERT/DELETE/UPDATE三Tab**（2026-09-21用户确认，与结构四Tab并列展示，数据结果独立分组）。

## Validation（真库只读）

- 主键解析覆盖率：两库1031表全单主键（515+516），composite 0 / nopk 0 / fail 0，`parseTablePK` 真DDL零失败。
- 联合主键/无主键路径由单测覆盖（check已验）；行级diff未跑真数据（用户约束只读元数据验证，行数据对比待用户指定小表后冒烟）。
