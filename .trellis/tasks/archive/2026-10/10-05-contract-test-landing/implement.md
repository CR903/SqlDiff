# implement.md — 契约落地（父任务）

## 本文件的作用

父任务**不实现**。这里是编排顺序 + 集成复核清单。

## 编排顺序

1. **子任务 A**（`10-05-unit-test-gap-landing`）先跑 —— 纯 vitest，秒级反馈，先把基线项数抬高
2. **子任务 B**（`10-05-export-e2e-landing`）后跑 —— 含真机 E2E，环境问题不污染 A 的信号
3. **父任务集成复核** —— 全量门禁 + 逐条核 Cross-Child AC

不并行：两条线共享 `tests/` 目录与 vitest 进程，并行会让项数难以核对。

## 集成复核清单（A、B 都完成后）

```bash
cd apps/desktop

# 门禁
npx vitest run                      # 项数应 ≥ 748 + A 的增量 + B 的单测增量
npm run typecheck
npm run lint
npm run build

# 秘密与产物边界
git grep -i "DB.smarterlab" | wc -l          # 期望 0
git ls-files | grep -c "\.env\.e2e$"         # 期望 0（注意别匹配到 .example）
git diff --name-only HEAD~2 -- src-core src-main src-renderer   # 期望空（AC7）

# 目标函数直测确认
for n in escapeDataIdent isNodeMeta isHistoryEntry nodesFilePath historyFilePath \
         resolveUserDataDir clearHistory testConnection diffTableField; do
  printf '%-24s %s\n' "$n" "$(grep -rl "\b$n\b" tests/ | wc -l | tr -d ' ')"
done                                            # 每个都应 ≥ 1

# §11.1 无秘密断言存在性
grep -rn "vaultCiphertext\|sshPassword\|privateKey\|passphrase" tests/core/preflight*.test.ts

# 真机（依赖 .env.e2e，无需 export）
npm run e2e:preflight:mysql                    # 确认既有真机用例未回归
npm run e2e                                    # B 的 UI E2E 需对应开关

# cleanup
# 两台分别确认 SHOW DATABASES LIKE 'sqldiff_preflight_test%' 为空
# 以及 B 新增的 A/B 双库 fixture 无残留
```

## 逐条核 Cross-Child AC

- [ ] AC1 项数净增且全绿
- [ ] AC2 三门禁全绿
- [ ] AC3 9 个函数各有直测；`escapeDataIdent` 覆盖反引号边界
- [ ] AC4 §11.1 断言覆盖 Preflight 三格式 + Manifest；**变异测试自证非空转**（把 `escapeDataIdent` 破坏掉，无秘密断言应变红）
- [ ] AC5 UI E2E 真机真实执行，产出 3 + N 个文件并校验
- [ ] AC6 秘密零入库
- [ ] AC7 产品代码零改动
- [ ] AC8 spec 口径与代码一致

## 变异测试自证（AC4 的关键）

无秘密断言最危险的失效模式是**断言写成永真**（例如误用 `expect(content).not.toContain('')`）。自证方法：

1. 临时在导出链里注入一个真实凭据值（例如让 recommendation 文本带上密码）
2. 跑无秘密断言 → **必须变红**
3. 恢复 → 全绿

只跑绿不算验证过。

## 日志门禁（archive 前）

- [ ] `docs/daily/2026-10-05_contract-test-landing.md`
- [ ] `docs/index.md` 追加一行
- [ ] P2 知识沉淀三问：本次的「spec 交叉引用留旧」规律已在父任务 design.md 记录；若 A/B 挖出新的通用坑（如守卫矩阵的判别方法），同步 `docs/knowledge/common/best-practices/`

## 回滚点

两条子任务均为纯增量（只新增测试文件），产品代码零改动。回滚 = 删对应测试文件，无数据迁移、无兼容性风险。
