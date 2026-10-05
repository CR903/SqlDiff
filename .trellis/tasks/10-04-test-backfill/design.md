# design.md — 测试补齐总设计

## 目录结构（迁移后 + 新增）

```
apps/desktop/
├── src-core/  src-main/  src-renderer/    # 产品代码，不再放 *.test.ts
├── tests/
│   ├── core/            # 对应 src-core（现有 19 个 + 新增 risk/compare-filter/compare）
│   ├── main/            # 对应 src-main（现有 15 个 + 新增 vault 原语）
│   ├── converters/      # 对应 src-main/converters（datagrip/dbeaver）
│   └── renderer/        # 对应 src-renderer（现有 6 个 + 新增 sql 导出/保存、demo）
└── e2e/                 # Playwright harness，不动
```

- 文件名保持 `*.test.ts`（vitest 默认匹配），不改名
- import 统一用 `@/` 风格之外的相对路径（保持现有风格，不引入 alias 以免动 tsconfig/vite 双份配置）

## 为什么不用 `@/` alias

`vite.config.ts` 与 `tsconfig.json` 各需一份 alias 配置，且 main/preload 走 `tsconfig.main.json` 三套配置；相对路径多一层 `../../` 但零配置改动、零构建风险。41 文件迁移的 diff 已经不小，不叠加 alias 变更。

## 新增测试文件清单

| 文件 | 覆盖函数 | 预计项数 |
|---|---|---|
| `tests/core/risk.test.ts` | `riskFor` / `explainFor` / `rollbackFor` | 6 |
| `tests/core/compare-filter-scope.test.ts` | `normalizeScopes` / `hasDataScope` | 6 |
| `tests/core/compare-sort.test.ts` | `sortDiffItems` | 4 |
| `tests/main/vault-primitives.test.ts` | `loadOrCreateMasterKey` / `aesGcmEncrypt` / `aesGcmDecrypt` / `assertSafeNodeId` | 9 |
| `tests/main/compare-run-pairs.test.ts` | `resolveDataPairs` | 4 |
| `tests/renderer/sql-io.test.ts` | `saveTextFile(s)` / `copyText` / `downloadTextFile` / `formatSqlSafe` / `exportSavedMessage` | 8 |
| `tests/renderer/demo-metadata.test.ts` | `buildDemoMetadata` | 3 |

合计约 40 项（AC2 按 ≥25 保守门槛）。

## 权衡

- 补测不动产品代码：即使发现 bug 也只记录。理由是纯测试任务混入产品修复会让 diff 失焦，且产品修复需要独立验收。
- 不接 coverage 工具：先补齐事实性缺口，工具化会引出阈值争议且可能掩盖"补齐了但断言弱"的问题。

## 回滚

- 迁移回滚：`git revert` 迁移提交即可（无数据迁移）
- 补测回滚：删除新增 7 个文件即可
