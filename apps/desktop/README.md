# SqlDiff 桌面版

Electron + Vite + React + TS 三栏应用：左节点库 / 中对比槽 + 差异表 / 右 SQL 预览。
交互结构复刻 `../desktop-mock/index.html`（M6 原型），已接真实主进程逻辑（vault / 连接层 / diff 引擎）。

> 约束：本目录只新增文件；不碰 `mysqldiff/` 老代码。原型仅作交互参考，不反向修改业务语义。
> 回滚：失败直接删除 `apps/desktop/` 即可（老 CLI 不受影响）。

## 里程碑落点

| 里程碑 | 落点 | 文件 |
|---|---|---|
| M1 工程骨架 | Electron+Vite+React+TS+Zustand，深色三栏，`electron-builder` Win(nsis x64)+mac(dmg arm64/x64) | `src-main/main.ts`，`src-renderer/App.tsx`，`electron-builder.yml` |
| M2 存储 vault | safeStorage + 钥匙串（AES-GCM 回退），nodes.json/history.json，约定加密导出/导入，连接串导入器 | `src-main/vault.ts`，`src-main/store-json.ts` |
| M3 连接层 | mysql2/promise + ssh2 单跳（密码 + 密钥），test + 延迟，隧道复用/关闭 | `src-main/connection.ts`，`src-main/metadata.ts` |
| M4 diff 移植 | port 老逻辑 → core TS + 单测（CREATE/DROP/CHANGE），分类器 + 本地风险规则 | `src-core/diff.ts`，`src-core/classify.ts`，`src-core/risk.ts`，`src-core/compare.ts` |
| M5 UI 三栏 | 对比槽（拖拽/交换/范围/表过滤）+ 差异表（四 Tab + 类型过滤）+ SQL 预览（格式化/复制/导出/DROP 警示/风险回滚）+ 节点表单（增删改查/测试/导入导出） | `src-renderer/App.tsx`，`src-renderer/store.ts`，`src-renderer/sql.ts` |
| M6 原型 | HTML mock 先行（`../desktop-mock/index.html`），正式 UI 已按其交互实现 | `../desktop-mock/index.html` |

## 快速开始

```bash
cd apps/desktop
npm install
npm run dev        # 渲染进程 UI 调试（http://localhost:5173）
```

## 常用命令

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm test           # vitest run（src-core 冒烟）
npm run build      # typecheck + vite build（dist-renderer）+ tsc 主进程（dist-main）
npm start          # electron .（需先 build）
npm run pack       # build + electron-builder --win --mac（nsis x64 / dmg arm64+x64，产物 release/）
```

## 目录结构

```
apps/desktop/
  index.html               # Vite 入口
  electron-builder.yml     # win nsis + mac dmg（arm64/x64）
  src-main/
    main.ts                # BrowserWindow + IPC（nodes/compare/history/sql）
    preload.ts             # contextBridge `window.sqldiff`
    vault.ts               # safeStorage 加密 + 导出约定加密 + 老连接串解析
    store-json.ts          # nodes.json / history.json（原子写，最近 20 条）
    connection.ts          # mysql2 直连 + ssh2 单跳隧道池
    metadata.ts            # information_schema + SHOW CREATE（限流 10）
    compare-run.ts         # compare.run：拉快照 → 对比 → 历史落盘
    converters/            # DBeaver 拓扑导出；DataGrip 转换等待真实 fixture
  src-renderer/
    main.tsx               # React 入口
    App.tsx                # 三栏 UI + 节点表单 Modal
    store.ts               # zustand：nodes / 对比槽 / scopes+过滤 / diff focus
    sql.ts                 # 格式化 + 高亮 + 复制/导出
    styles.css             # 深色样式
  src-core/
    types.ts               # 契约唯一来源：NodeMeta / DiffItem / ExportJSON / IPC 收发
    diff.ts                # 老 mysqldiff diff 语义移植（只读老代码）
    classify.ts / risk.ts  # CREATE/DROP/CHANGE 分类 + 本地风险规则
    compare.ts             # 快照对比组装 + 排序 + 导出文本
    compare-filter.ts      # scopes/表过滤（主 + 渲染共享）
```

## IPC 契约

- `nodes.list / create / update / delete / test / export / export-dbeaver / import / import-legacy`（M2 vault + DBeaver 拓扑导出 + R7 老串）
- `conn.test({node, secret})`（M3，表单免保存测试）
- `history.list / append / clear`（最近 20 条）
- `compare.run({aId,bId,scopes,tableFilter}) → {items, stats}`（M4 diff 引擎 + M5 组装）
- `sql.format(sql) → string`（sql-formatter mysql 方言，关键字大写）/ `sql.copy(text) → boolean`
