# mysqldiff桌面版重设计

## Goal

将 `mysqldiff/` CLI 重设计为 Windows + macOS 可交互桌面软件，操作简单便捷，保留核心对比能力，新增节点管理、拖拽对比、分类脚本查看与一键复制。智能化深色风格，离线可用。

用户价值：无需记连接串，一拖即比，按 CREATE/DROP/CHANGE 维度复制执行，DROP高危警示+回滚建议，排查更快。

## Background

源码：`mysqldiff/mysqldiff` (523行 CLI入口), `mysqldiff/DB.js:1-127`, `mysqldiff/Tools.js:1-37`, `mysqldiff/ssh` (expect脚本), `mysqldiff/README.md:1-37`

- 连接串 `user:pass@host~db#port+sshuser:sshpass@sshhost#sshport`，解析 `Tools.js:10-31` / `DB.js:22-39`，密码含特殊字符会错；`README.md:37` 明确 ssh不支持windows。
- 连接 `DB.js:8-15` mysql直连，`DB.js:16-18` 调expect建隧道。
- 对比：table/procedure/function/view/data（`mysqldiff:25,33`），默认前四者；data需 `--table` 且 `limit 5000`（`DB.js:102-105`）。
- 表diff `diffTable:257-266` + `diffTableField:267-335` 生成 ADD/DROP/CHANGE COLUMN、主键/索引变更；过程/函数/视图 `diffProcedure:223-237` 归一化DEFINER后 DROP+CREATE（视图 CREATE OR REPLACE）；数据 `diffData:143-212` 按单主键生成 INSERT/DELETE/UPDATE（联合主键缺陷 `getTablePK:218-222`）。
- 输出仅 console.log（`mysqldiff:51-70`），无格式化/分类/文件。
- `--reverse` 交换db1/db2。

## Requirements

### R1 节点管理
- 表单字段：别名、host、port(默认3306)、user、password、database、SSH开关（sshHost/sshPort默认22/sshUser/authType密码或密钥privateKey+passphrase）、分组、标签、备注。
- 连接串导入兼容老格式；JSON文件导入。
- 左栏三Tab：历史（最近20次对比：时间+A/B别名+差异数）/ 我的（收藏星标）/ 常用（按频次自动Top+手动置顶）。
- 测试连接（含延迟ms），搜索过滤。
- 存储：electron safeStorage + OS钥匙串；导出JSON密码按约定加密（非明文），导入自动解码免重输。

### R2 节点导出JSON
- 一键导出全部节点自定义JSON（含分组/标签/SSH配置，密码加密段），导入回填恢复。
- schema预留 `converters/` 接口，二期再兼容DBeaver/DataGrip。

### R3 对比区拖拽（首版无数据对比）
- 中央双槽 Source(A)/Target(B)：拖拽+下拉二选一，交换按钮（替代老`--reverse`）、清空、记忆上次组合。
- 范围勾选：表/视图/过程/函数（默认全选）；表列表支持搜索+多选后再比。
- 数据对比二期（R3-data deferred）。

### R4 差异多维度查看
- 一级Tab：全部 / CREATE / DROP / CHANGE（ALTER含列/键变更，过程函数重建归CHANGE；DROP TABLE/PROCEDURE归DROP；CREATE归CREATE）。
- 二级过滤：对象类型 table/view/procedure/function。
- 每条：对象名、类型徽标、风险等级、SQL预览；DROP红色警示+复制二次确认。

### R5 脚本展示与复制
- Monaco高亮+行号，默认 sql-formatter 格式化（关键字大写）。
- 一键复制当前Tab全部 / 单条复制 / 导出.sql（含顺序 DROP→CREATE→ALTER + 头注释A/B/时间）。
- 风险解释+回滚建议本地规则引擎：如 DROP COLUMN 提示备份+给出回滚占位，DROP TABLE 提示高危。

### R6 跨平台与体验
- Electron+Vite+React，Win10+ / macOS13+（x64+arm64），离线可用，中文。
- 三栏布局（左节点库/中对比+差异表/右SQL预览），深色圆角微交互，空状态引导，快捷键 Cmd/Ctrl+Enter对比。
- `ui-ux-pro-max` 当前环境缺失，首版用通用布局+HTML mock原型，二期补高保真。

### R7 兼容
- 老CLI连接串一键解析导入；首版diff语义与老逻辑一致。

## Acceptance Criteria

- [ ] AC1 Win/mac双端安装运行，离线完成一次表+视图+过程+函数对比。
- [ ] AC2 节点增删改查+测试连接可用；历史/我的/常用三Tab可见。
- [ ] AC3 导出JSON（密码加密）可导入恢复，无需重输密码。
- [ ] AC4 拖拽A/B+交换+清空可用；范围勾选+表搜索多选生效。
- [ ] AC5 全部/CREATE/DROP/CHANGE切换正确，批量复制内容与所见一致；DROP有红色警示+二次确认。
- [ ] AC6 SQL默认格式化高亮，可一键复制/导出.sql（含头注释+顺序）。
- [ ] AC7 每条DROP/ALTER有风险说明；DROP COLUMN/TABLE有回滚建议。
- [ ] AC8 SSH密码+密钥单跳可连；直连可用。

## Out of Scope

- 自动执行SQL到目标库；数据对比（ limit5000/联合主键问题二期解）；PG/Oracle；跳板机/多跳；团队云同步；AI自然语言（首版仅本地规则引擎）。

## Key Decisions

- D1 Electron+Vite+React（复用Node mysql逻辑，SSH换ssh2支持Windows）。
- D2 导出仅自定义JSON+预留转换器。
- D3 钥匙串+导出约定加密，导入自动解码。
- D4 首版不做数据对比。
- D5 SSH密码+密钥单跳。
- D6 智能化首版=风险解释+回滚SQL本地规则，不接外部AI。

## Risks / Deferred

- 包体积~150MB（接受）；后续可用Tauri瘦身。
- 大库 SHOW CREATE 并发需限流+进度条，二期优化。
- DBeaver/DataGrip兼容、跳板机、数据对比、定时巡检均为二期。
