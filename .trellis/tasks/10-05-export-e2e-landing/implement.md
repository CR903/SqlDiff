# implement.md — §11.1 保密断言 + 导出 UI E2E

## 有序检查表

### B1 纯单测层（先做，秒级反馈）

1. **读实现**
   - `src-core/preflight.ts` —— `serializePreflight` / `preflightToExecutiveMarkdown` / `preflightToDetailMarkdown` / `preflightFileNames`
   - `src-core/manifest.ts` —— `buildManifest` / `serializeManifest` / `manifestToMarkdown`
   - `src-core/preflight-types.ts` —— 报告类型与 `PREFLIGHT_REPORT_VERSION = 2`
   - 现有 `tests/core/preflight*.test.ts` 的造报告方式（**复用现成 fixture，不要从零造**）

2. **`tests/core/preflight-export-secrets.test.ts`（新建）**
   - 造含 5 个哨兵值的节点：`SENTINEL_PW_*` / `SENTINEL_SSH_*` / `SENTINEL_KEY_*` / `SENTINEL_PASS_*` / `SENTINEL_VAULT_*`
   - 走 3 个 Preflight 出口 + 3 个 Manifest 出口
   - 每个产物两层断言：8 个敏感字段名 + 5 个哨兵值
   - 文件放 `tests/core/`（纯函数层）

3. **3 文件名契约**（可放同一文件或追加进现有 preflight 测试）
   - 断言 3 个文件名各自正确
   - 断言 `checkedAt` 的 `:` `.` 全被替换
   - **断言返回对象恰好 3 个键**（防止回退成 2 份）

4. **跑 B1 门禁 + 变异自证**（见下）

### B2 UI E2E 层（后做，依赖真机）

5. **读现有真机 spec 作范本**
   - `e2e/specs/preflight-on-mysql-5-7.spec.ts` —— `launchElectron` / `createTestNodeViaApi` / env 门控 / cleanup 全套模式
   - `e2e/fixtures/mysql-fixture.ts` —— 建库 helper，本任务需扩展成建 A/B 两库
   - `e2e/helpers/env-loader.ts` —— **复用** `readRequiredEnv` / `missingEnvReason`，不要重写

6. **fixture 扩展**：建 A 库（基线）+ B 库（多一列 → 产生 ADD COLUMN 的表级 DDL 差异）
   - `finally` 里两个库都删

7. **`e2e/specs/export-ui.spec.ts`（新建）**
   - `test.setTimeout(120_000)`
   - env 门控 + skip 消息点名变量（沿用 `e2e-harness.md` 约定）
   - `launchElectron([])` → `api.nodes.create` 注入含 secret 的节点
   - **真实点击**：选 A/B → `对比 ⚡` → 等结果 → `运行 Preflight` → 等 `[role="status"]` verdict 块 → `导出 Preflight 报告` → 等 toast → `导出审查报告` → 等 toast
   - 断言 `downloadsDir` 下 **3 个** preflight 文件（json / md / -detail.md）+ manifest 文件
   - 解析 JSON 断言 `schemaVersion === 2` / `source === 'real'`
   - 对所有导出物跑无秘密断言（字段名 + 值）
   - 取消路径：断言取消不写盘不报错（若时间允许）

## 验证命令

```bash
cd apps/desktop

# B1 单测
npx vitest run tests/core/preflight-export-secrets.test.ts
npx vitest run                                        # 全绿

# 门禁
npm run typecheck && npm run lint && npm run build

# 产品代码零改动（AC9）
git diff --name-only -- src-core src-main src-renderer   # 期望空

# 秘密边界（AC10）
git grep -i "DB.smarterlab" | wc -l                     # 期望 0

# B2 真机（依赖 .env.e2e，无需 export）
npm run e2e:preflight:mysql        # 确认既有真机用例未回归
npm run e2e                        # 新 spec 需对应开关

# cleanup（两台分别执行）
# SHOW DATABASES LIKE 'sqldiff_preflight_test%' → 空
```

## 变异测试自证（AC2，必须看到红）

无秘密断言最危险的失效是**写成永真**。两次变异：

```bash
# 1. 往导出链注入真实凭据值 → 无秘密断言必须变红
#    临时在造报告时把哨兵值塞进 inferences[].statement 的 SQL 文本里
npx vitest run tests/core/preflight-export-secrets.test.ts    # 期望红
#    恢复

# 2. 破坏脱敏（若定位到具体泄漏点）→ 对应断言必须变红
#    例如让 redactDmlSql 不再替换
#    恢复
```

**只跑绿不算验证过**。AC2 的交付证据是「看到红」，不是「看到绿」。

## 高风险点

- **UI E2E 走成 API 旁路**：若用 `page.evaluate` 调 `api.preflight.run` 就不设 `lastPreflightResult`，导出按钮不出现——**AC5 要求全程真实点击**，这是本任务最容易走偏的地方
- **等待固定 `waitForTimeout`**：真实比较 + preflight 耗时不定，必须等 verdict 块出现（`[role="status"]`）或 toast 文本
- **`test.setTimeout` 忘了设**：Playwright config 是 60s，本任务链路可能超时
- **单测 import `e2e/helpers/assertions.ts`**：破坏目录边界（见 design.md）。B1 的无秘密判据在 `tests/` 内独立实现，两处注释互相指认
- **fixture 只删一个库**：A/B 两库都要在 `finally` 里删
- **`.env.e2e` 缺失时抛错**：必须静默 skip

## 发现产品 bug 时

只记录、另开任务，**不改产品代码**（R8/R10）。特别地：若 §11.1 断言**发现真实泄漏**（哨兵值出现在产物里），这是重要发现——记录完整证据（哪个出口、哪个字段、什么值），但**本任务不修**。这是本任务最可能的"意外产出"。

## start 前检查

- [ ] `implement.jsonl` / `check.jsonl` 已填真实条目
- [ ] 父任务 + 两个子任务的六份文档已获用户审阅批准
- [ ] `.env.e2e` 存在且指向 `.115` / `.84`（B2 需要；B1 不需要）
