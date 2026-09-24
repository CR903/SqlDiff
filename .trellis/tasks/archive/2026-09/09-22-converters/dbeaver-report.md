# DBeaver 导出验收报告

日期：2026-09-24 · 平台：macOS · 任务：DBeaver 兼容节点导出

## 验收边界

用户已批准在当前没有 DBeaver 安装的环境采用结构化验收：官方 JSON 结构、字段断言、无秘密检查和 Electron/CDP 下载验证作为本任务验收；真实 DBeaver IDE 导入作为后续补验，不阻塞任务归档。

## 样本覆盖

使用 3 个隔离的 SqlDiff 节点：

1. 直连 MySQL；
2. 密码 SSH 隧道；
3. 私钥 SSH 隧道（只验证 `PUBLIC_KEY` 标记和警告，不输出密钥路径）。

## 验证结果

| 检查项 | 结果 | 证据/断言 |
|---|---|---|
| 文件名 | ✅ | `data-sources-sqldiff.json` |
| JSON 顶层结构 | ✅ | `folders`、`connections`、`connection-types` |
| MySQL 直连字段 | ✅ | `provider=mysql`、`driver=mysql8`、`MANUAL`、`native`、`auth-properties.userName` |
| SSH 密码认证 | ✅ | `handlers.ssh_tunnel` + `PASSWORD` |
| SSH 私钥认证 | ✅ | `PUBLIC_KEY`；无 `keyPath`/`keyValue`；显示待补密钥警告 |
| 秘密隔离 | ✅ | 无秘密值或密文（报告仅列 `password`、`sshPassword`、`privateKey`、`passphrase` 等字段名）；仅允许 `save-password: false` 控制字段 |
| 节点选择 UI | ✅ | 默认全选、逐项选择、全选、全不选、已选数量、取消 |
| 真实下载 | ✅ | 使用可信鼠标事件并确认 `will-download` 保存路径的文件落盘 |
| 确定性 | ✅ | 相同节点集合不同输入顺序生成相同内容 |
| 自动化测试 | ✅ | focused 8/8；全量 17 个测试文件、167 个测试通过 |
| 静态门禁 | ✅ | typecheck、lint、build 通过 |
| `mysqldiff/` | ✅ | 无任务相关改动 |

## 本次复核记录（2026-09-24）

- `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过；Vitest 为 17 个测试文件、167 个测试，focused exporter 为 8/8。
- `git diff --check`、任务/spec 文件的未解析占位符扫描和本任务涉及 Markdown 的本地链接检查均通过；`git diff -- mysqldiff` 为空。
- 在隔离的临时 `SQLDIFF_USER_DATA_DIR` 中放入直连、密码 SSH、私钥 SSH 三个元数据节点；通过 `Input.dispatchMouseEvent` 验证默认全选、逐项取消、全不选和全选状态。
- 通过可信导出点击和主进程 `will-download` 保存路径确认 `~/Downloads/data-sources-sqldiff.json` 实际落盘并可解析；连接数、字段、SSH handler、私钥警告及无秘密字段断言均通过。临时 user-data、下载文件和 Electron 进程已清理。
- `/Applications` 与 `$HOME/Applications` 未发现 DBeaver 安装，因此没有把结构化校验表述为真实 IDE 导入。

## CDP 验证方式

- 启动 Electron 并使用隔离的临时 user-data；
- 通过 `Input.dispatchMouseEvent` 触发 DBeaver 入口、选择操作和导出；
- 确认主进程 `will-download` 保存路径的目标文件实际落盘；
- 解析下载 JSON，检查连接数量、MySQL 字段、SSH handler 和秘密字段；
- 验证完成后清理临时 user-data、下载文件和 Electron 进程。

## 已知限制

- 当前环境没有 DBeaver，未声称完成真实 IDE 导入；后续可在目标 DBeaver 版本中补一次导入烟测。
- `mysql8` 是官方文档中的默认 driver ID，已集中为常量；不同 DBeaver 发行版仍需在真实环境核验。
- 本次 DBeaver CDP 证据以 DOM 状态、可信输入和落盘内容断言为主，未持久化截图；临时 harness 与下载文件已清理。
- DataGrip 任务保持独立阻塞，等待脱敏 `dataSources.xml` / `dataSources.local.xml` fixture。
