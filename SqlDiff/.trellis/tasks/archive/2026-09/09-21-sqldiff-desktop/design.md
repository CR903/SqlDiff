# Design — sqldiff-desktop (Electron+Vite+React)

## Architecture

```
apps/desktop (Electron)
  main/      : BrowserWindow, safeStorage vault, ssh2 tunnel pool, mysql2 pool, IPC
  preload/   : contextBridge api (nodes, compare, export)
  renderer/  : React + Zustand + Monaco + sql-formatter
    left/ NodeLibrary (search + 历史/我的/常用)
    center/ CompareSlots (A/B drag+select, swap, scope checkboxes, table filter)
    bottom/ DiffTable (全部/CREATE/DROP/CHANGE + type filter)
    right/ SqlPreview (Monaco, copy/export, risk+rollback)
core/      : diff engine (port from mysqldiff: diffTable/diffTableField/filterTable/diffProcedure/filterProcedure/changeProcedure)
             + classifier (CREATE/DROP/CHANGE) + risk-engine + rollback-suggester
storage/   : nodes.json (meta) + keychain (secrets) + history.json
```

主进程做DB/SSH（复用老语义，换 `mysql2/promise` + `ssh2`，替代 `DB.js:8-18` + `ssh` expect）；渲染进程纯展示，IPC一次性拿结果，避免大数据卡顿。

## Data flow

1. 拖拽/选择 A/B → 测试连接（延迟）→ 读范围+表过滤 → main 并发拉元数据（information_schema + SHOW CREATE，限流10）→ core diff → classifier打标 → 渲染分组 → Monaco格式化展示 → 复制/导出。
2. 节点CRUD → safeStorage存secret，nodes.json存meta；导出时secret按约定加密（AES-GCM，主密钥存钥匙串）拼成JSON；导入逆向解码。

## Contracts

- Node: `{id, alias, host, port, user, database, group, tags, star, pinned, useCount, ssh:{enabled,host,port,user,authType}, createdAt}`
- Secret: keychain `sqldiff/<nodeId>` → `{password, sshPassword, privateKey}`；导出段 `{enc:"aes-gcm", iv, data}`。
- DiffItem: `{id, objectType, objectName, changeType:CREATE|DROP|CHANGE, risk:high|medium|low, sql, rollback, explain}`
- ExportJSON: `{version:1, exportedAt, nodes:[{meta, secretsEnc}]}`；`converters/` 预留。
- IPC: `nodes.*`, `conn.test`, `compare.run({aId,bId,scopes,tableFilter})-> {items, stats}`, `sql.format/copy/export`.

分类规则：含 `DROP TABLE|DROP .*PROCEDURE|DROP INDEX|DROP COLUMN|DROP PRIMARY` →DROP；含 `CREATE` 且无DROP →CREATE；`ALTER|CHANGE|ADD COLUMN|CREATE OR REPLACE` →CHANGE；过程函数 DROP+CREATE 合并一条归CHANGE（风险medium，DROP单条场景归DROP）。

## Compatibility / migration

- 老连接串解析器兼容 `Tools.js:10-31`，特殊字符密码走表单不再拼串。
- 首版diff与老逻辑一致（含 filter忽略项 `filterTable:342-351`），不修联合主键（数据对比已defer）。

## Trade-offs

- Electron包大但复用最快 vs Tauri轻但重写多 → 选前者。
- 本地规则风险解释 vs 接LLM → 选前者保离线。
- SHOW CREATE全拉 vs 按需 → 首版全拉+表过滤+进度，二期虚拟化。

## Rollout / rollback

- 首版只读对比+生成SQL，不执行；DROP复制二次确认。
- 出错回退：隧道/连接失败抛结构化错误码，UI重试；无需DB migration。
