# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

- `mysqldiff/` 老代码禁止直改，只读移植到 `apps/desktop/src-core/diff.ts`（diff语义须与 `diffTable:257-266` / `diffTableField:267-335` / `diffProcedure:223-237` 一致，判空用过滤后文本）。
- secrets禁止进 `nodes.json`，只进vault；导出JSON禁止明文，统一 `ExportJSON {version:1, secretsEnc:{enc:"aes-gcm",iv,data}}`。
- 渲染进程禁止直引 `node:crypto/mysql2/ssh2`，跨层共享纯函数放 `src-core/compare-filter.ts`。

### Don't: node内置模块默认导入（启动崩坑）

**Problem**:
```ts
// tsconfig 无 esModuleInterop 时这样写：
import path from 'node:path';   // 编译后 path_1.default.join -> TypeError: Cannot read properties of undefined (reading 'join')
import fs from 'node:fs';       // 同理，vault/store-json 启动即崩
```

**Why it's bad**: `allowSyntheticDefaultImports` 只消类型错、不发互操作桩；主进程 CommonJS 下 default 为 undefined，`npm start` 建窗口直接崩且无窗口（2026-09-21实测）。

**Instead**:
```ts
// 根 tsconfig.json 常开：
"esModuleInterop": true,
import path from 'node:path'; // 或 import * as path，二选一全仓统一
```

---

## Required Patterns

- DB直连用 `mysql2/promise`，SSH单跳用 `ssh2`（密码+密钥），本地端口32000-35000随机+EADDRINUSE重试，隧道复用Map，`before-quit`关池。
- metadata SQL与 `DB.js:75/79/83` 字面一致，SHOW CREATE缺行返回null不抛错，并发限流10。
- 分类：DROP优先但DROP+CREATE同现归CHANGE；视图CREATE OR REPLACE归CHANGE；导出排序DROP→CREATE→CHANGE。
- DiffItem一律单语句：表多ALTER按 `/;\s*\n/` 拆条目（id 后缀 `:s<n>`，末块无换行防双分号），例程 DELIMITER 块不拆；过滤/复制/统计走同一条目模型，保证复制=所见。
- aspect判定顺序固定 table→primary→index→column（CREATE TABLE 体内含 PRIMARY KEY，table 必须先判）；PRIMARY KEY 增删归 primary，UNIQUE/FULLTEXT/SPATIAL 归 index。
- stats 对称：`recountStats` 与 `compare-run` 数据合并分支必须计数字段一致（新增 stats 字段两处同步加，否则过滤与合并口径分裂）。
- DDL/DML 维度：`objectType==='data'` 即 DML，其余 DDL；维度与 CREATE/DROP/CHANGE、DML 三 Tab 正交 AND 过滤。
- 动词桶取首关键字（`verbOf`）：`CREATE OR REPLACE`→CREATE，前导注释/DELIMITER 块→OTHER；动词与 changeType 正交（`DROP+ADD PRIMARY KEY` 合写 changeType=DROP 但 verb=ALTER）；过滤链顺序固定 维度→对象→动词→切面→关键字，缺省/空数组视为 ALL 向后兼容。

---

## Testing Requirements

- `src-core/diff.test.ts` 覆盖表增删改列/主键/索引+过程增删改+DEFINER相等无差；`connection.test.ts` 覆盖SSH配置/端口/复用；`vault.test.ts` 覆盖加密往返+导出导入往返+老串解析。
- 每次必跑：`npx tsc --noEmit` + `npm run lint` + `npm test` 全绿。

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
