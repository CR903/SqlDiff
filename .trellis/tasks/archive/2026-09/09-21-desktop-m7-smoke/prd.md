# 桌面版M7打包冒烟

## Goal

`apps/desktop` 双端可安装包 + 真库离线对比冒烟，闭环AC1（双端运行离线比）/AC8（SSH单跳+直连），确认M1-M5交付可发布。

## Requirements

- R1 打包：`electron-builder --win --mac` 出 nsis(x64)+dmg(arm64/x64) 到 `release/`，包可安装启动（离线）。
- R2 直连冒烟：两本地/测试MySQL库一次表+视图+过程+函数对比，四Tab数量与复制一致，导出.sql可用。
- R3 SSH冒烟：密码+密钥单跳各一例，隧道复用/关闭正常。
- R4 回归：`npx tsc --noEmit` + `npm run lint` + `npm test` 全绿；`mysqldiff/` 零改动复查。
- R5 记录：冒烟矩阵（平台×连接×范围）+ 缺陷清单进 `smoke-report.md`。

## Acceptance Criteria

- [ ] AC-M7.1 Win/mac包构建成功并可启动（三栏可见）。
- [ ] AC-M7.2 真库对比出差异，四Tab+复制/导出与所见一致。
- [ ] AC-M7.3 SSH密码+密钥单跳连通，复用/关闭正常。
- [ ] AC-M7.4 三件套全绿，`mysqldiff/` 零改动。

## Out of Scope

- 数据对比/跳板机/DBeaver兼容/定时巡检（二期）；应用签名公证（需证书，另立项）。

## Open Questions

- [x] Q1 冒烟库环境：已定 **两套阿里云RDS只读冒烟**（2026-09-21用户提供：`rm-2zehh94hpck8mm4lm6o.mysql.rds.aliyuncs.com` 上 `smarterlab_demo_1` vs `smarterlab_zky_260420`，凭证会话内传递不落库）。约束：只做连接+元数据读取冒烟，不碰数据、不执行任何生成脚本。
