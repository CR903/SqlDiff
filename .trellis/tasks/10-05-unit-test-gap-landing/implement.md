# implement.md — 9 个零直测导出的契约测试

## 有序检查表

1. **读实现**（先读，别猜）
   - `src-core/data-diff.ts:37` `escapeDataIdent`
   - `src-core/diff.ts:82` `diffTableField`
   - `src-main/store-json.ts` 全文（181 行，6 个目标函数）
   - `src-main/connection.ts` `testConnection`

2. **`tests/core/data-diff.test.ts` 追加**（`escapeDataIdent`）
   - 按 design.md 的**逃逸判定**写断言，不写字符串等值
   - 覆盖 7 类输入（正常 / 单反引号 / 连续反引号 / 仅反引号 / 空串 / 含控制字符 / 非字符串）

3. **`tests/core/diff.test.ts` 追加**（`diffTableField`）
   - 只补**畸形输入不抛**：空串、纯空白、非 DDL 文本、残缺 `SHOW CREATE TABLE`
   - 断言返回可解析（不抛 + 返回 string）

4. **`tests/main/store-json.test.ts` 新建**（6 个函数）
   - `isNodeMeta`：基准对象 + 9 字段逐个三态变异 + 4 条结构性用例
   - `isHistoryEntry`：基准对象 + 5 字段逐个三态变异 + 4 条结构性用例
   - `nodesFilePath` / `historyFilePath`：显式传参与不传参两条
   - `resolveUserDataDir`：显式参数 / `vi.stubEnv` 环境变量 / 缺省三条
   - `clearHistory`：文件存在删除 + 文件不存在不抛
   - 每个涉及 env 的 describe 配 `afterEach(() => vi.unstubAllEnvs())`

5. **`tests/main/connection.test.ts` 新建**（`testConnection`）
   - mock 连接层，**严禁真实 TCP 连接**
   - 成功路径 + 失败路径（错误码透传）

6. **跑门禁**（见下）

7. **变异测试自证**（三处，见 design.md 表）

## 验证命令

```bash
cd apps/desktop

npx vitest run                                  # 全绿，项数 ≥ 748 + 新增
npx vitest run tests/main/store-json.test.ts   # 单文件快速迭代
npx vitest run tests/core/data-diff.test.ts

npm run typecheck
npm run lint
npm run build

# 目标函数直测确认（每个都应 ≥ 1）
for n in escapeDataIdent isNodeMeta isHistoryEntry nodesFilePath historyFilePath \
         resolveUserDataDir clearHistory testConnection diffTableField; do
  printf '%-24s %s\n' "$n" "$(grep -rl "\b$n\b" tests/ | wc -l | tr -d ' ')"
done

# 产品代码零改动
git diff --name-only -- src-core src-main src-renderer    # 期望空
```

## 变异测试（必须看到红）

```bash
# 1. 破坏注入防线 → escapeDataIdent 用例应变红
#    把 replace(/`/g, '``') 改成 replace(/`/g, '')
npx vitest run tests/core/data-diff.test.ts     # 期望红
git checkout src-core/data-diff.ts

# 2. 删守卫字段约束 → isNodeMeta 用例应变红
#    删掉 id.length > 0
npx vitest run tests/main/store-json.test.ts    # 期望红
git checkout src-main/store-json.ts

# 3. 放宽守卫类型判据 → isHistoryEntry 用例应变红
#    typeof v.diffCount === 'number' 改成 !== undefined
npx vitest run tests/main/store-json.test.ts    # 期望红
git checkout src-main/store-json.ts
```

三次都必须**先看到红**再恢复。全程绿 = 断言空转，视为未完成。

## 高风险点

- **给已有测试文件追加时误改既有断言**：只追加，不动现有行。提交前 `git diff` 确认已有断言零改动。
- **`testConnection` 真连网**：mock 不彻底会让测试变慢且不稳定，且可能真的去连 `.env.e2e` 里的机器。
- **`vi.stubEnv` 泄漏**：不清理会污染同文件后续用例，表现为"单跑绿、全跑红"这种难查现象。

## 发现产品 bug 时

只记录、另开任务，**不在本任务改产品代码**（R9）。记录格式：函数名 + 触发输入 + 实际输出 + 为什么是 bug。写进最终报告。

## start 前检查

- [ ] `implement.jsonl` / `check.jsonl` 已填真实条目
- [ ] 父任务与本任务的三件文档已获用户审阅批准
