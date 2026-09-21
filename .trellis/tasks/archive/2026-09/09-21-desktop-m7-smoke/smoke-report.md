# M7 冒烟报告（进行中）

日期：2026-09-21；约束：只读，不碰数据、不执行生成脚本；凭证会话传递，不落库。

## 环境

- A=`smarterlab_demo_1`，B=`smarterlab_zky_260420`，host=`rm-2zehh94hpck8mm4lm6o.mysql.rds.aliyuncs.com`（直连，无SSH段）。
- 方向：把 B 升级到 A（与老 CLI db1/db2 同向）。

## 本地回归 ✅

- `npx tsc --noEmit` clean；`npm run lint` clean；`npm test` 6文件71例全绿。

## 连通冒烟 ✅（AC-M7.3直连部分）

- demo_1：121ms，515表/0视图/0过程函数，SHOW CREATE ok。
- zky_260420：67ms，516表/0视图/0过程函数，SHOW CREATE ok。

## 全量结构对比 ✅（AC-M7.2）

- 用编译后 `src-core`（compareRun + metadata同源SQL，并发10）跑全量 SHOW CREATE 双库。
- 结果：共521项，其中 DROP 332 / CREATE 15 / CHANGE 174；对象全为 table（两库均0视图/0例程）。
- 前8条均为 `DROP table <name> [high]`（如 aerometer_log/allocation/...），风险引擎正常打标high。
- 说明：DROP偏多因两库表集合差异大，符合“把B升级到A”语义；未执行任何脚本。

## 打包 ✅（AC-M7.1）

- 首轮失败：`electron` 误放 `dependencies`（builder要求devDeps）+ 缺 `author`；已修复。
- 二轮x64/win卡在github直连EOF；走 `ELECTRON_MIRROR` 镜像源后全绿。
- 产物（`release/`，gitignored不入库）：`SqlDiff-0.1.0-arm64.dmg` 113M、`SqlDiff-0.1.0.dmg`(x64) 117M、`SqlDiff Setup 0.1.0.exe` 98M。签名均为skip（无证书，公证另立项）。
- SSH单跳冒烟待补（需跳板/SSH测试节点，当前两RDS为直连）。

## 缺陷/风险

- 无阻塞。DROP 332条均为高危，UI侧二次确认+回滚建议已覆盖（M5）。
- SSH密码+密钥单跳尚未真机验证（AC-M7.3部分待闭环）。
