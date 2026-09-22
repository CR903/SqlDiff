# 验证闭环冒烟报告2（SSH+行级数据）

日期：2026-09-22；约束：只读，不碰数据、不执行生成脚本；凭证会话传递，不落库。

## R1 SSH 密码单跳 ✅（部分）

- `ssh2` 密码认证 `smarterlab@192.168.0.5` 连通，延迟 340ms，`exec echo ok` 正常。
- 注意：用户给的端口 21 不是 SSH（TCP 通但握手超时，疑为 FTP）；实际 SSH 在 **22** 端口。UI 表单默认 22 正确，无需改。
- 隧道转发 ❌：`forwardOut` 到 127.0.0.1/192.168.0.5:3306 均被服务端拒绝 `Channel open failure`，疑 `AllowTcpForwarding=no`。本环境 3306 直连可达，应用直连链路不受影响；但“经 SSH 隧道连 DB”整条路在此服务器上走不通，需用户在 sshd 开转发或换节点复测。

## R2 SSH 密钥单跳 ⏳

- 用户只给了密码，未给密钥；待补 `privateKey+passphrase` 后复测同 R1 流程。

## 直连数据库 ✅

- `smarterlab`：458ms，526 表/0 视图/0 例程；`smarterlab_zky`：10ms，516 表；共有表 513。
- 行级候选（A/B 行数）：buildings 1/27、appt_seqno 1/48、casbin_rule 117/11213。

## R3 行级冒烟 ✅（表 buildings）

- 用编译后应用代码（`parseTablePK` + `fetchAllByPK` + `diffDataRows`）真实链路：
  - pk=[id]，A=1 行/B=27 行，进度回调 `0/1→1/1`、`0/27→27/27` 正常。
  - 结果：inserts 0 / deletes 26 / updates 1，耗时 1ms。
  - 抽样：`DELETE FROM \`buildings\` WHERE \`id\`=1;`，`UPDATE ... SET \`name\`='大洋',... WHERE \`id\`=20;`（中文转义正常）。
- 方向语义与老 `diffData` 一致（把 B 向 A 对齐：B 多的删、B 少的插、共有 key 列级更新）。

## AC 状态

- AC-V1 ✅（认证+延迟+exec；隧道被服务端拒，非应用问题）。
- AC-V2 ⏳ 待密钥。
- AC-V3 ✅。
- AC-V4 待跑三件套（下轮提交前跑）。
