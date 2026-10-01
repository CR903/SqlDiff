# Design — DROP / CHANGE Tab 按切面分子标签

## 1. 边界

改动集中在 `src-renderer/App.tsx`（UI 与筛选状态编排）与
`src-core/compare-filter.ts`（一个纯函数），**不碰 `classify` / `aspectOf` / `assessRisk` / `verbOf`**。

与前一版规划的差异：原计划改 `classify.ts` + `risk.ts`（核心层），
本版改为纯展示层，核心零改动——这是 D1 换方案后最大的结构性收益。

| 文件 | 改什么 |
|---|---|
| `src-core/compare-filter.ts` | `countAspects` 扩展为「按给定条目集计数」（签名已够用，无需改）；新增 `ASPECT_SCOPES`：Tab → 该 Tab 可用切面的有序表 |
| `src-renderer/App.tsx` | 移除全局 chip 渲染；新增作用域化子标签行；Tab 切换时清理不可用切面 |
| `src-renderer/styles.css` | 子标签行样式（复用 `.obj-filters` / `.chip`，预计零新增样式） |

## 2. 数据流

现有链路（`App.tsx:1827-1838`）已完整，本任务只改其**作用域**与**入口**：

```
byKw → byObj ──(aspSet)──> byAspect ──(diffFilter Tab)──> rows
           │                    │
      objCounts            aspectCounts ← 子标签计数基数取这里
```

关键点：**子标签计数基数是 `byAspect` 之下、Tab 过滤之上的列表**，
即「点这个子标签会得到几条」——必须排除自身过滤，否则数字无法回答点击意图（R4）。

新增一个中间层以获得该基数：

```ts
const byTab = useMemo(
  () => (diffFilter === 'ALL' ? byAspect : byAspect.filter((it) => it.changeType === diffFilter)),
  [byAspect, diffFilter],
);
const aspectCounts = useMemo(() => countAspects(byTab), [byTab]);
```

`ASPECT_SCOPES` 定义每个 Tab 的子标签集合与顺序（来自实测矩阵）：

```ts
export const ASPECT_SCOPES: Record<'DROP' | 'CHANGE', { value: StmtAspect; label: string }[]> = {
  DROP: [
    { value: 'table',   label: '表' },
    { value: 'column',  label: '列' },
    { value: 'primary', label: '主键' },
    { value: 'index',   label: '索引' },
    { value: 'routine', label: '例程' },
  ],
  CHANGE: [
    { value: 'column',  label: '列' },
    { value: 'primary', label: '主键' },
    { value: 'index',   label: '索引' },
    { value: 'routine', label: '例程' },
    { value: 'data',    label: '数据' },
  ],
};
```

`全部` / `CREATE` 无此键 → 不渲染子标签行（R3）。

## 3. 切面选择的状态与清理（R8）

这是本任务最主要的失败模式：选了当前 Tab 不存在的切面 → 结果空且无可见原因。

策略：**Tab 切换时，把选择裁剪到新 Tab 可用的切面集；裁剪后为空则回落 `ALL`**。

```ts
// 切换 Tab 后 effect 裁剪
useEffect(() => {
  const allowed = ASPECT_SCOPES[diffFilter as 'DROP' | 'CHANGE']?.map((a) => a.value);
  if (!allowed) { if (aspectFilter !== 'ALL') setAspectFilter('ALL'); return; }
  if (aspectFilter === 'ALL') return;
  const kept = aspectFilter.filter((a) => allowed.includes(a));
  setAspectFilter(kept.length === 0 ? 'ALL' : kept);
}, [diffFilter]);
```

多选 OR（D5）意味着裁剪后可能仍有剩余（如 DROP 同时选了「表」和「索引」，
切到 CHANGE 后两者都存在于 CHANGE，无需变动）。仅当**全部**被裁掉时才回落 `ALL`。

沿用既有 `toggleAspect` 语义：空数组或全选等同 `ALL`（`store.ts:344-348` 已有该逻辑）。

## 4. UI 形态

子标签行插在 Tab 行之后、对象 chips 行之前（紧贴 Tab，强化「隶属于该 Tab」的从属关系）：

```
[ 全部 | CREATE | DROP | CHANGE ]        ← Tab 行
[ 表 | 列 | 主键 | 索引 | 例程 ]          ← 仅 DROP/CHANGE 时出现
[ 全部 | 表 | 视图 | 过程 | 函数 | 数据 ]  ← 对象 chips（已删 INDEX/主键/列）
[ CREATE | DROP | ALTER | … ]            ← 动词 chips
```

- 复用 `.obj-filters` + `.chip` 样式，预计**无需新增 CSS**；
- 每个子标签 tooltip 写明作用域，如「仅看 DROP Tab 中的表级删除（DROP TABLE）」，
  避免用户误以为它跨 Tab 生效；
- 计数为 0 的子标签**照常显示但 disabled**（保留可见性，说明该 Tab 下确无此类语句），
  不隐藏——隐藏会让用户以为漏了功能。

## 5. 兼容性与迁移

- **无数据迁移**：不涉及持久化结构与 IPC 契约。
- **统计口径不变**：各 Tab 条数与改动前完全一致（AC8 锁定）。这是相对前一版规划的关键优势。
- **能力回退**：`全部` / `CREATE` Tab 下无切面入口（D2 已接受，用户明确选择）。
- **导出物不变**：`aspects` 已在审查报告导出物中，语义与取值均未变。

## 6. 取舍

- **删除全局 chip 的代价**：跨 Tab 看切面需逐个 Tab 进入。但保留两套入口的认知负担更大，
  且二者筛的是同一维度，用户会困惑该点哪个（D2 已接受）。
- **不改核心分类的代价**：`DROP` Tab 内仍同时存在 high（删表）与 low（删索引）条目，
  即原 AC5「Tab 内风险档一致」不再成立。缓解：子标签把类别显式标出，
  且 `risk` 列本就逐行展示，透明度由 UI 承担而非由分类器隐藏。
- **子标签不适用于 CREATE**：实测其切面仅 table/routine，细分收益低，不做（D4）。

## 7. 回滚

改动为纯展示层，无数据写入、无迁移。回滚 = `git revert` 单个 commit，
或单独还原 `App.tsx` 的 chip 渲染分支即可，无残留状态。