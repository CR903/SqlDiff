# DBeaver 兼容节点导出

## Goal

把 SqlDiff 已保存的 MySQL 节点拓扑导出为 DBeaver 当前 JSON 连接配置，方便用户从 SqlDiff 迁移到 DBeaver。首版只交付 DBeaver；DataGrip 依赖真实 IDE 导出样本，另立 `09-24-datagrip-converter` 任务，不阻塞本任务和桌面版二期收口。

## Background

- 现有节点模型 `NodeMeta` 包含 alias、host、port、user、database 和单跳 SSH 拓扑；秘密只在 Vault 中，转换器不得读取或导出秘密。
- DBeaver 官方格式和字段研究见 `research/dbeaver-connection-import.md`：目标文件为 `data-sources*.json`，放在 DBeaver workspace 的 `General/.dbeaver/` 或项目 `.dbeaver/` 目录。
- 官方文档确认密码、SSH 密码和私钥不能安全地通过该导入路径迁移；用户首次连接需要重新输入。
- `src-main/converters/index.ts` 现有 `NodeConverter` 是“第三方配置 → SqlDiff 节点”的反向接口，本任务不把它误用为导出接口。

## Requirements

- R1 节点选择：左侧节点库提供 DBeaver 导出入口；弹窗支持逐节点勾选、全选/全不选、已选数量和取消，默认全选。
- R2 文件生成：按当前 DBeaver `data-sources.json` 结构生成稳定、可重复的 JSON（包含 `folders`、`connections`、`connection-types`）；文件名为 `data-sources-sqldiff.json`，可直接放入 `.dbeaver/` 目录。
- R3 字段映射：`alias → name`，`host/port/database` 直映；MySQL 使用 `provider: "mysql"`、文档默认 `driver: "mysql8"`、`configurationType: "MANUAL"`、`auth-model: "native"`，用户名写入 `auth-properties.userName`。
- R4 SSH 映射：启用 SSH 时生成 `handlers.ssh_tunnel`，映射 SSH host/port/user 和 `PASSWORD`/`PUBLIC_KEY`；SqlDiff 当前没有可靠的私钥文件路径模型，因此不得编造 `keyPath`，只提示用户在 DBeaver 中补选密钥。
- R5 安全边界：导出的 JSON、toast、任务证据和下载文件不得包含 `password`、`sshPassword`、`privateKey`、`passphrase` 或 Vault 密文；`save-password` 保持关闭。
- R6 明确提示：导出弹窗在下载前说明“不会迁移密码/私钥，导入后需重新输入”；每个 SSH 私钥节点显示待补密钥提示。
- R7 回归覆盖：纯函数单测覆盖无 SSH、密码 SSH、私钥 SSH、空选择、重复/非法输入；CDP 验证真实点击、下载落盘、JSON 结构和无秘密。

## Acceptance Criteria

- [ ] AC1 节点选择弹窗可逐项勾选、全选/全不选，并能对至少 3 个样本节点生成导出。
- [ ] AC2 生成文件是合法 JSON，包含 `folders`、`connections` 和必要的 MySQL `configuration` 字段；连接名与拓扑和 SqlDiff 节点一致。
- [ ] AC3 SSH 节点生成 `ssh_tunnel` 拓扑；私钥路径不被编造；导出内容不含任何密码、私钥、passphrase 或密文。
- [ ] AC4 下载文件真实落盘，文件名和内容符合 R2；UI 在导出前明确提示需要首连重输秘密。
- [ ] AC5 单测、tsc、lint、test、build 和可信 CDP 回归通过；`mysqldiff/` 零改动。
- [ ] AC6 DBeaver 真机导入验证：若当前环境没有 DBeaver，则以结构化 JSON 校验作为本任务验收，另记录未完成的 IDE 真机验证；不得将结构校验表述为真机导入成功。

## Out of Scope

- 密码、私钥、passphrase 迁移或加密凭据文件生成。
- DataGrip 双 XML/ZIP 导出；该项转入 `09-24-datagrip-converter`。
- 反向导入 DBeaver → SqlDiff、连接测试、批量修改节点。
- 自动写入用户 DBeaver workspace、自动启动 DBeaver、自动打开文件所在目录。
- 依赖 DBeaver 私有/未公开字段的扩展格式。

## Risks and Deferred Items

- `mysql8` driver ID 依据官方研究，但不同 DBeaver 发行版的 Driver ID 仍需在可用环境核验；导出器应集中常量，不能散落硬编码。
- 当前没有 DBeaver 安装和真实导入证据。用户已于 2026-09-24 批准采用 AC6 的结构性验收；真实 DBeaver IDE 导入烟测作为后续补验记录，不阻塞本任务收口。
- DataGrip SSH XML 标签尚未有真实 fixture，继续保持阻塞，不用猜测标签。
