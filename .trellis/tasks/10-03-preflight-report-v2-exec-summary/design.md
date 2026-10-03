# Design：Preflight Report v2 结论式渲染

## 1. 边界与非目标

**只改渲染层**：
- `apps/desktop/src-core/preflight.ts` 新增两个函数：`preflightToExecutiveMarkdown` + `preflightToDetailMarkdown`
- 保留旧 `preflightToMarkdown`（不删），但主流程 `runPreflight` 不再调用它
- 单元测试可继续引用旧函数，也可迁移到新函数
- JSON 序列化（`serializePreflight`）、类型契约（`PreflightReport`）、规则引擎（`evaluateRules`）**完全不动**

**不动的层**：
- `preflight-types.ts`（schema v1）
- `preflight-rules.ts`（9 条规则）
- `preflight-collect.ts`（6 类采集）
- `preflight-run.ts` 主流程（只改 import 与 exportBundle 装配）
- UI 渲染、store、IPC 类型签名（除了 `PreflightExportResult` 增字段）

## 2. 数据结构分层

三层产物各自服务不同消费者：

| 产物 | 消费者 | 语言 | 用途 |
|---|---|---|---|
| `report.json` | 程序（CI、审计、归档）| JSON | 结构化读写 |
| `report.md` | 人（开发 + 运维）| 结论 Markdown | 首屏决策 |
| `report-detail.md` | 人（怀疑结论时）| 原始 Markdown | 追溯细节 |

三者**同源**（都由同一份 `PreflightReport` 对象派生），**不重复**（结论文件里不塞 facts 表；细节文件里不放决策语）, **可交叉引用**（结论里有链接跳到细节的锚点）。

## 3. 结论文件（report.md）结构

```
# Preflight Executive Summary

## 决策 · {GO | DEGRADED | BLOCK}
一句话结论 + 依据

**目标** {alias} / {database}  ·  MySQL {version}  ·  检查时间 {checkedAt}

## 开发视角（我写的 DDL 对不对）

### DDL 分类
- 共 N 条 DDL 项，成功分类 M 条（M/N%）
- 分类分布: {op1}:n1, {op2}:n2, ...

### ⚠️ 未能解析的 DDL（N 条）
表格列出 unparsed-ddl 的 SQL + 原因（若无则显示「全部可识别」）

### 表结构隐患
表格：表名 / 隐患类型（无 PK / 无索引 / 缺 UNIQUE） / 影响

## 运维视角（执行会发生什么）

### 建议动作
- bullet 列表（按优先级）

### DDL 分组（按风险）
🔴 EXCLUSIVE 锁 + 重建 (n)
  表格：DDL 编号 / 表名 / 操作
🟡 INPLACE 重建（允许并发 DML） (n)
  表格：...
🟢 INSTANT 无锁无重建 (n)
  表格：...

### 表风险热图
表格：表 / 行数 / 大小 / PK / 涉及 DDL 数 / 风险标记

### 环境状态
- read_only / replica_lag / gtid_mode / permission 各自的当前值与判定

## 详情
→ 完整原始数据（Facts / Inferences / Unknowns / Issues）见 [report-detail.md](./xxx-detail.md)
```

## 4. 双视角信息映射

| 视角 | 数据源 | 派生逻辑 |
|---|---|---|
| 决策语 | issues + inferences | block 判定 + EXCLUSIVE 判定 |
| DDL 分类成功率 | inferences.length vs items.length | 相除得百分比 |
| DdlOp 分布 | inferences[].statement 解析 | 正则 `(\w+) on` 提取 op |
| Unparsed 清单 | unknowns.filter(reason='unparsed-ddl') | 直接引用 |
| 表结构隐患 | issues（NO_PRIMARY_KEY / NO_UNIQUE_INDEX_AFTER_CHANGE / LARGE_TABLE_REBUILD）+ facts（table.*.indexes.*.primary_indexes）| 组合表结构快照 |
| DDL 风险分组 | inferences[].statement 含 `INSTANT/INPLACE/EXCLUSIVE` | 字符串匹配分组 |
| 表热图 | facts.filter(category='table') 聚合 | 按表名 groupby，取 rows/size/pk/涉及 DDL 数 |
| 环境状态 | facts.filter(category in 'server','replication','permissions') | 提取 read_only / seconds_behind_master / gtid_mode / visibility |

**关键实现细节**：`inferences.statement` 是自由文本（例如 `d01: ADD_COLUMN on users_big → INSTANT/SHARED`），需要正则解析。设计一个 `parseInferenceStatement` 工具函数返回 `{ op, tableName, algorithm, lockMode, rebuilds }`，避免各处各写正则。

## 5. 细节文件（report-detail.md）结构

```
# Preflight Detail Report

← [返回结论](./xxx.md)

## 目标信息
（头部元数据：时间/schemaVersion/appVersion/alias/database/source）

## Facts
### Facts · server
| Key | Value | Source | Observed At |
...

### Facts · variables
...

（7 类，按 CATEGORY_ORDER 顺序渲染，与旧 preflightToMarkdown 一致）

## Inferences
| Subject | Statement | Confidence | Rule | Evidence |

## Unknowns
| Subject | Reason | Attempt | Observed At |

## Issues（block 优先）
| ID | Severity | Subject | Title | Recommendation |

## Verdict
- Level: **xxx**
- Blocking: n
- Warnings: n
- Unknowns: n

## 保密声明
```

**关键点**：细节文件是旧 `preflightToMarkdown` 输出的**几乎逐字复用**，只是把标题从 `# Preflight Report` 改成 `# Preflight Detail Report`，加一个返回链接，去掉结论文件已经渲染的部分（其实旧输出本来就没有决策语，所以几乎原样）。

## 6. 决策语三态逻辑

```ts
function deriveDecision(report: PreflightReport): Decision {
  const blocks = report.issues.filter(i => i.severity === 'block');
  if (blocks.length > 0) {
    return {
      level: 'BLOCK',
      message: `不能发布。${blocks.length} 条阻断规则触发，需人工处理后再试。`,
    };
  }

  const hasExclusive = report.inferences.some(i =>
    i.statement.includes('INPLACE/EXCLUSIVE')
  );
  const hasBigTableRebuild = report.issues.some(i => i.id.startsWith('BIG_TABLE_REBUILD') || i.id.startsWith('LARGE_TABLE_REBUILD'));
  const hasReplicaLag = report.issues.some(i => i.id.startsWith('REPLICA_LAG'));

  if (hasExclusive || hasBigTableRebuild || hasReplicaLag) {
    return {
      level: 'DEGRADED',
      message: `可发布但需排期。${exclusiveCount} 条 DDL 会 EXCLUSIVE 锁 + 重建，${warnCount} 条 warn 规则触发，建议低峰执行。`,
    };
  }

  return {
    level: 'GO',
    message: `可发布。全部 DDL 可用 INSTANT/INPLACE 完成，无阻断、无严重警告。`,
  };
}
```

**注意**：unknown 不单独影响决策（多数是 not-applicable 噪声）。若 unknowns 全部是 not-applicable，等价于 GO；若有 `permission-denied` 或 `query-failed` 等非噪声 unknowns，可以在决策语里加「附 N 条待确认的未知项」但不升级为 BLOCK。

## 7. API 表面变更

### 新增（`preflight.ts`）

```ts
export function preflightToExecutiveMarkdown(m: PreflightReport): string;
export function preflightToDetailMarkdown(m: PreflightReport): string;

/** 保留向后兼容，但主流程不再调用 */
export function preflightToMarkdown(m: PreflightReport): string; // 旧实现
```

### 新增内部工具

```ts
interface InferenceStatement {
  op: string;
  tableName: string | null;
  algorithm: 'INSTANT' | 'INPLACE' | null;
  lockMode: 'EXCLUSIVE' | 'SHARED' | 'NONE' | null;
  rebuilds: boolean;
}

function parseInferenceStatement(s: string): InferenceStatement;

type DecisionLevel = 'GO' | 'DEGRADED' | 'BLOCK';
interface Decision { level: DecisionLevel; message: string; }

function deriveDecision(m: PreflightReport): Decision;

function groupDdlByRisk(inferences: PreflightInference[]): {
  exclusive: { inference: PreflightInference; stmt: InferenceStatement }[];
  inplaceShared: { inference: PreflightInference; stmt: InferenceStatement }[];
  instant: { inference: PreflightInference; stmt: InferenceStatement }[];
};

function buildTableHeatmap(facts: PreflightFact[], inferences: PreflightInference[]): TableRow[];

function buildDeveloperView(m: PreflightReport): {
  totalDdl: number;
  classifiedCount: number;
  classifiedPct: number;
  opDistribution: Record<string, number>;
  unparsed: PreflightUnknown[];
  tableIssues: { table: string; issue: string; severity: string }[];
};

function buildOpsView(m: PreflightReport): {
  decision: Decision;
  exclusive: { id: string; table: string; op: string }[];
  inplaceShared: { id: string; table: string; op: string }[];
  instant: { id: string; table: string; op: string }[];
  tableHeatmap: TableRow[];
  envStatus: { key: string; label: string; value: string; status: 'ok'|'warn'|'block' }[];
};
```

### 修改（`PreflightExportResult` 类型，位于 `preflight-run.ts`）

```ts
export interface PreflightExportResult {
  jsonFileName: string;
  markdownFileName: string;         // 改为指向 executive summary（保留字段名）
  detailMarkdownFileName: string;   // 新增：指向 detail 文件
  jsonContent: string;
  markdownContent: string;          // 改为 executive summary 内容
  detailMarkdownContent: string;    // 新增：detail 内容
  verdictLevel: PreflightReport['verdict']['level'];
}
```

### 新增（`preflightFileNames`）

```ts
export function preflightFileNames(checkedAt: string): {
  jsonFileName: string;
  markdownFileName: string;          // 'sqldiff-preflight-{ts}.md'
  detailMarkdownFileName: string;   // 'sqldiff-preflight-{ts}-detail.md'
}
```

### UI/IPC 联动

**实际调用路径**（`apps/desktop/src-renderer/App.tsx:2228-2245`）：
- `handleExportPreflight` 直接调用 `preflightToMarkdown(result)` + `serializePreflight(result)`
- 通过 `saveTextFiles` 保存 JSON + Markdown 两个文件
- `lastPreflightResult` 来自 IPC `preflight:run`，但 markdown 序列化在 renderer 端做

**改动点**：
1. `App.tsx` 的 `handleExportPreflight` 需要：
   - import `preflightToExecutiveMarkdown` + `preflightToDetailMarkdown`（替代 `preflightToMarkdown`）
   - `saveTextFiles` 数组从 2 个文件改为 3 个（json + exec md + detail md）
   - toast 文案从「JSON + Markdown」→「JSON + 结论 Markdown + 详细 Markdown」
2. `preflight-run.ts` 的 `PreflightExportResult` 新增字段可选（UI 不用读，但保持数据流一致）
3. `save-file.ts` 无需改动（`saveTextFiles` 已支持任意数量文件）

## 8. 数据流

```
runPreflight()
  ↓ 收集 facts/inferences/unknowns
  ↓ evaluateRules() → issues
  ↓ deriveVerdict() → verdict
  ↓ buildPreflightReport() → PreflightReport 对象
  ↓
  ├─ serializePreflight() → jsonContent          [不变]
  ├─ preflightToExecutiveMarkdown() → markdownContent          [新增]
  ├─ preflightToDetailMarkdown() → detailMarkdownContent      [新增]
  └─ preflightFileNames(checkedAt) → 3 个文件名 [新增 detailMarkdownFileName]
```

## 9. 关键实现约束

1. **纯函数**：所有新函数不引入 IO / 时间 / 随机（`checkedAt` 由上游注入）
2. **byte 稳定性**：JSON 序列化不变，Markdown 输出对同一输入确定性一致
3. **优雅降级**：数据缺失时（如无 inferences）显示「无」而非抛错
4. **不重复渲染**：executive 里不塞 facts 表；detail 里不放决策语
5. **交叉引用**：executive 底部有相对路径链接到 detail；detail 顶部有反向链接
6. **单元格转义**：沿用 `mdCell` / `mdValue` 处理 `|` 与 null/undefined
7. **数字格式化**：新增 `fmtRows`（>1M 显示 M / >1K 显示 K）+ `fmtSize`（GB/MB/KB），两处共用

## 10. 测试策略

新增 `apps/desktop/src-core/preflight-exec.test.ts`，覆盖：

| # | 场景 | 断言 |
|---|---|---|
| 1 | BLOCK 场景（有 read_only 阻断）| 决策 = BLOCK，包含阻断 issue |
| 2 | DEGRADED 场景（有 INPLACE EXCLUSIVE）| 决策 = DEGRADED，含 EXCLUSIVE 分组 |
| 3 | GO 场景（全 INSTANT）| 决策 = GO，建议「可立即执行」|
| 4 | 开发视角：有 unparsed DDL | 显示 unparsed 表，含 SQL + reason |
| 5 | 开发视角：无 unparsed | 显示「全部可识别」 |
| 6 | 表热图：有/无 PK 混合 | 无 PK 表标记 🔴，有 PK 且大表标 🟡 |
| 7 | 环境问题：read_only=1 | 环境状态表含 read_only 且 status=block |
| 8 | 交叉引用链接 | executive 底部含 detail 文件相对链接 |
| 9 | 空数据 | 不抛错，渲染「无」占位 |
| 10 | `parseInferenceStatement` 正则 | 覆盖 3 种典型 statement 格式 |

原有 `preflight.test.ts` 中针对旧 `preflightToMarkdown` 的测试全部保留（旧函数不删）。

## 11. 兼容性 / 回滚

- **JSON 完全不动**：schemaVersion=1、字段顺序、序列化格式 byte 稳定，CI / 审计脚本无感知
- **旧 `preflightToMarkdown` 保留**：任何还在用的地方都能继续引用，不 break
- **回滚路径**：若问题严重，仅需 revert `preflight-run.ts` 的 exportBundle 装配（3 行），把主流程退回用旧函数；其他新代码留在但不调用
- **命名约定**：文件名从 `sqldiff-preflight-{ts}.md` 语义变更（内容改为 executive），若用户此前脚本按内容 grep 需知晓；文件名本身不变（保持兼容），只是同名文件内容变了

## 12. 时间预算

| 项 | 估时 |
|---|---|
| 新增 utility（parseInferenceStatement / fmtRows / fmtSize / md helpers）| 30 行 |
| `preflightToExecutiveMarkdown` | 120 行 |
| `preflightToDetailMarkdown` | 复用旧实现 + 标题改动，20 行 |
| `PreflightExportResult` / `preflightFileNames` 扩展 | 15 行 |
| `preflight-run.ts` exportBundle 装配改动 | 5 行 |
| 单元测试（10 项）| 200 行 |
| 规格文档更新 | 40 行 |
| **总计** | **~430 行** |
