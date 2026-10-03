# DataGrip 兼容节点导出

## Status

**READY — 2026-10-03**：2026-09-24 标记的 BLOCKED 已在追加研究中解除。SSH XML 标签的准确结构从 DBeaver 官方 DataGrip 迁移插件（Apache-2.0）、`nyetdb`（MIT）和真实 GitHub `.idea/sshConfigs.xml` 样本三处独立来源交叉验证（详见 `../archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md` 的 "Addendum 2026-10-03"）。真实脱敏 IDE 导出 fixture 仍未提供，但不作为前置条件：本次按公开证据 + DBeaver 导出先例实施，验收以结构化 XML 校验替代 IDE 真机导入烟测，与 `09-22-converters` AC6 采用同一口径。

## Goal

把 SqlDiff 已保存的 MySQL 节点拓扑导出为 DataGrip 可识别的三件套 XML（`dataSources.xml` + `dataSources.local.xml` + 按需 `sshConfigs.xml`），让用户能通过 IDE 内 File-drop / 项目 `.idea/` 导入路径恢复连接清单。拓扑、驱动引用、用户、SSH 主机三元组与认证类型精确映射；秘密（密码、私钥内容、passphrase）与不可跨机的本地路径（`keyPath`）保持不导出，由用户在 IDE 内补充。

## Background

- 节点模型 `NodeMeta` 提供 `alias / host / port / user / database` 与单跳 SSH 拓扑；秘密只在 Vault 中。
- DataGrip 采用项目级共享 XML 与全局 SSH 配置分离的双层模型：`.idea/dataSources.xml` 存共享数据源，`.idea/dataSources.local.xml` 存每用户层（用户、secret-storage、schema 映射、`ssh-properties` 引用），`<config>/options/sshConfigs.xml` 存全局 SSH 定义。详见研究材料 "Addendum 2026-10-03"。
- `09-22-converters` 已经按同样的"拓扑优先、秘密后置"原则交付 DBeaver 导出，并采用用户批准的 AC6 结构性验收口径。本任务复用同一导出入口、同一选择弹窗、同一 trusted `file.save` 通道，仅增加 DataGrip 目标。
- `src-main/converters/index.ts` 的 `NodeConverter` 是反向导入接口，本任务不与其混淆。

## Prerequisites

- 研究材料：`.trellis/tasks/archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md` 及其 2026-10-03 Addendum 已交叉验证 SSH XML 结构，可作为实施基线。
- 现有 DBeaver 导出：`src-main/converters/dbeaver.ts`、`nodes.export-dbeaver` IPC、`DBeaverExportModal`、`file.save` 通道。
- 目标 DataGrip 2024.1+ / 2025.x / 2026.2 版本行为无差异；`<project version="4">` 与 `DataSourceManagerImpl` + `dataSourceStorageLocal` + `SshConfigs` 组件名跨版本稳定。
- 真实脱敏 IDE fixture 不再作为前置条件；仅作为可选后续补验材料，不阻塞本任务实施。

## Planned Deliverables

- 新增 `src-main/converters/datagrip.ts`：类型化文档构造器 + 结果类型 + 无秘密拓扑映射；保持 DBeaver 导出同层的"纯函数 + `resolveXNodes` 校验 + `createXExportResult`"结构。
- 新增 `src-main/converters/datagrip.test.ts`：覆盖 direct / password SSH / private-key SSH / 多节点确定性 / 空选择与非法输入 / sentinel 污染对象，断言 XML well-formed、UUID 一致、SSH 三元组正确、无秘密字段。
- 新增 `nodes.exportDatagrip(ids)` IPC，`SqlDiffApi` + `preload.ts` + `main.ts` 三处对齐，错误域前缀 `datagrip:` / `nodes:`。
- 新增 `DatagripExportModal`（或扩展 `DBeaverExportModal` 支持多目标）：默认全选当前加载节点；每个 SSH 私钥节点提示"需在 DataGrip 中重新选择密钥"。
- 新增通用 `saveTextFiles`（若尚不存在）复用 `file.save kind:'bundle'`：一次系统保存对话框选择目录，同时写入 2–3 个 XML 文件，落盘路径回显在成功 toast。
- 生成同一 UUID 的 `dataSources.xml` 与 `dataSources.local.xml`；启用 SSH 的节点额外写入 `sshConfigs.xml`（项目级作用域）。
- 精确映射已由公开证据证实的字段：host、port、database、user、`driver-ref=mysql.8`、`jdbc-driver=com.mysql.cj.jdbc.Driver`、`jdbc-url=jdbc:mysql://host:port/db`、`working-dir=$ProjectFileDir$`、`user-name`、`<secret-storage>master_key</secret-storage>`、`<ssh-properties><enabled>true</enabled><ssh-config-id>…</ssh-config-id></ssh-properties>`、`<sshConfig authType host id port username>`。
- 不导出密码、私钥、passphrase、Vault 密文；`keyPath` 因用户本地路径不跨机迁移而显式省略，SSH 私钥节点在弹窗中提示用户在 IDE 中补选密钥。
- 验收：单测覆盖三种 SSH 形态与确定性；XML well-formed 与 UUID 一致性由测试断言；CDP 走一次真实点击 → 目录选择 → 三文件落盘 → 反解校验路径，与 DBeaver CDP 使用相同的 trusted 事件与 `file.save` 断言。

## Acceptance Criteria

- [ ] AC1 生成文件是合法 XML（`<?xml version="1.0" encoding="UTF-8"?>` + `<project version="4">` 根），`dataSources.xml` 与 `dataSources.local.xml` 内同名 `<data-source>` 使用同一个 UUID；含 SSH 时 `sshConfigs.xml` 内 `<sshConfig id>` 与 `dataSources.local.xml` 的 `<ssh-config-id>` 一致。
- [ ] AC2 至少 3 个样本节点（direct / password SSH / private-key SSH）生成 3 条 `<data-source>`；`driver-ref=mysql.8`、`jdbc-driver=com.mysql.cj.jdbc.Driver`、`jdbc-url=jdbc:mysql://host:port/db`、`<user-name>` 与 SqlDiff 节点一致。
- [ ] AC3 SSH 节点生成 `<sshConfig authType host id port username>`（`password → PASSWORD`，`privateKey → PRIVATE_KEY`）+ `<ssh-properties>` 中的 `<enabled>true</enabled>` 与匹配 `<ssh-config-id>`；不编造 `keyPath` 或 `passphrase`。
- [ ] AC4 导出内容、toast、任务证据均不含密码、私钥、passphrase 或 Vault 密文；仅允许 `<secret-storage>master_key</secret-storage>` 控制标记。
- [ ] AC5 节点选择弹窗可逐节点勾选、全选/全不选，展示每个 SSH 私钥节点的"需在 DataGrip 中重新选择密钥"提示；一次导出落盘 2–3 个 XML 到同一目录，成功 toast 回显真实路径。
- [ ] AC6 单测、`typecheck`、`lint`、`test`、`build` 和可信 CDP 回归全绿；`mysqldiff/` 零改动；真实 DataGrip IDE 导入烟测作为后续补验记录，不作为本任务阻塞项（与 `09-22-converters` AC6 同口径）。

## Out of Scope

- 反向导入 DataGrip → SqlDiff。
- DataSpell 特有偏离，除非后续 fixture 证明必须支持。
- 密码、私钥、passphrase 迁移或凭据加密文件生成。
- 自动写入用户 DataGrip workspace、自动启动 DataGrip、自动打开文件所在目录。
- 全局级（`<config>/options/`）SSH 配置输出；本任务只生成项目级三件套。
- 依赖未验证 DataGrip 私有字段的扩展格式（如数据库 introspection 输出 `<database-info>`、`<schema-mapping>` 的具体节点）。

## Risks and Deferred Items

- **组件名与结构稳定性**：`DataSourceManagerImpl` / `dataSourceStorageLocal` / `SshConfigs` 与 `<project version="4">` 结构在 2024.1–2026.2 期间由 DBeaver 插件、`nyetdb` 与真实仓库样本持续使用，未观察到迁移。若目标用户 IDE 版本更老（< 2023.3）或更新（> 2026.2），需人工烟测确认。
- **`keyPath` 省略的影响**：SqlDiff 保存的是私钥内容而非文件路径；导出器不编造本地路径。用户在 DataGrip 导入后需重新选择密钥文件。这与 DBeaver 导出 R4 采用相同口径。
- **`<ssh-config-id>` 作用域**：本任务输出项目级 `<data-source>` + 项目级 `sshConfigs.xml`，用户导入到 `.idea/` 后 IDE 视为同一项目内联配置。若目标用户希望全局可见，需手动把 `<sshConfig>` 复制到 `<config>/options/sshConfigs.xml`，本任务不代替。
- **无 IDE 真机验证**：按用户 2026-09-24 已批准 AC6 结构性验收口径执行，与本任务的 AC6 一致；真实 DataGrip 导入烟测记入后续补验，不阻塞收口。
- **数据源 introspection 输出缺失**：`<database-info>` 与 `<schema-mapping>` 由 IDE 首次连接后自动填充，本任务不生成（详见研究材料 required/optional 划分）。若用户希望共享 schema 白名单，需要单独补充 fixture。

## Related Work

- DBeaver 导出：`09-22-converters`（已归档，`.trellis/tasks/archive/2026-09/09-22-converters/`）
- 研究材料：`.trellis/tasks/archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md`（含 2026-10-03 Addendum）
- 导出契约：`.trellis/spec/backend/dbeaver-export.md`、`.trellis/spec/backend/manifest-export.md`
