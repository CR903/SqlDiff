# 验证闭环：SSH单跳+行级数据冒烟

## Goal

闭环 M7 遗留的两项真机验证：SSH 密码+密钥单跳连通（AC-M7.3），指定小表行级数据对比只读冒烟（数据二期行级未跑真数据）。全部只读，不执行任何生成脚本。

## Background

- 连接层 `apps/desktop/src-main/connection.ts`：ssh2 单跳（密码/密钥），隧道复用 Map，随机本地端口；单测 11 例全过，但无真机验证。
- 数据链 `data-fetch.ts`/`data-run.ts`：主键范围分页+阈值确认+取消；真库只验到主键覆盖率（1031 表全单主键），行级 diff 未跑真数据。
- 约束：用户要求只做测试，不碰数据、不执行脚本；凭证会话传递不落库。

## Requirements

- R1 SSH 密码单跳：testConnection 连通+延迟，隧道复用/closeAll 正常。
- R2 SSH 密钥单跳：同 R1（privateKey+passphrase）。
- R3 行级冒烟：用户指定小表（同名，两库共有），跑 fetchAllByPK+diffData，核对 INSERT/DELETE/UPDATE 分类与数量合理，进度+取消可用。
- R4 结果记 `smoke-report2.md`（无凭证），后端语义与 UI 表现一致即过。

## Acceptance Criteria

- [ ] AC-V1 SSH 密码单跳连通，复用/关闭正常。
- [ ] AC-V2 SSH 密钥单跳连通。
- [ ] AC-V3 指定小表行级对比完成，分类正确，无 OOM。
- [ ] AC-V4 三件套全绿，`mysqldiff/` 零改动。

## Out of Scope

- 跳板机/多跳；自动执行；行数超阈大表全量（只做小表）。

## Open Questions

- [x] Q1 材料已收：SSH（host/port/user/密码）+ 两库名（2026-09-22用户提供）。发现：SSH 实际在 22 端口（给的 21 非 SSH）；隧道转发被服务端拒；密钥未给，AC-V2 待补。
