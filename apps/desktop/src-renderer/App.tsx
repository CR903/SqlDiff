import { useEffect, useMemo, useRef, useState } from 'react';
import { VERB_CHIPS, useDesktopStore, type AspectFilter, type DiffFilter, type DmlFilter, type LeftTab, type ObjectTypeFilter, type SlotId, type StmtKindFilter, type VerbFilter } from './store';
import type { DataTableStatus, DiffItem, HistoryEntry, NodeMeta, ObjectType, SecretBundle, Verb } from '../src-core/types';
import { verbOf } from '../src-core/classify';
import type { DataTableLists, NodeCreateInput } from '../src-main/preload';
import { buildExportText, copyText, downloadSqlFile, highlightSql } from './sql';

// M5 正式 UI 三栏联调：左 NodeLibrary / 中 CompareSlots + DiffTable / 右 SqlPreview。
// 交互参考 apps/desktop-mock/index.html；数据经 store 接 IPC（window.sqldiff），
// 无后端时 store.runCompare 用本地示例快照降级，保证离线可交互。

const SCOPES: Array<{ value: ObjectType; label: string }> = [
  { value: 'table', label: '表' },
  { value: 'view', label: '视图' },
  { value: 'procedure', label: '过程' },
  { value: 'function', label: '函数' },
];

const LEFT_TABS: Array<{ value: LeftTab; label: string }> = [
  { value: 'hist', label: '历史' },
  { value: 'mine', label: '我的' },
  { value: 'fav', label: '常用' },
];

const DIFF_TABS: Array<{ value: DiffFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'CREATE', label: 'CREATE' },
  { value: 'DROP', label: 'DROP' },
  { value: 'CHANGE', label: 'CHANGE' },
];

const DML_TABS: Array<{ value: DmlFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'INSERT', label: 'INSERT' },
  { value: 'DELETE', label: 'DELETE' },
  { value: 'UPDATE', label: 'UPDATE' },
];

/** R7 动词 chips 分组展示（DDL组 + DML组；OTHER 无桶不展示）。 */
const VERB_GROUPS: Array<{ label: string; verbs: Verb[] }> = [
  { label: 'DDL', verbs: VERB_CHIPS.slice(0, 3) },
  { label: 'DML', verbs: VERB_CHIPS.slice(3) },
];

/** R1 一级维度：结构 DDL / 数据 DML（与 CREATE/DROP/CHANGE Tab、DML 三 Tab 正交组合）。 */
const STMT_DIM_TABS: Array<{ value: StmtKindFilter; label: string; title: string }> = [
  { value: 'ALL', label: '全部', title: '结构 + 数据全部展示' },
  { value: 'DDL', label: 'DDL', title: '只看结构语句（表/视图/过程/函数）' },
  { value: 'DML', label: 'DML', title: '只看数据行差异（INSERT/DELETE/UPDATE）' },
];

const OBJ_FILTERS: Array<{ value: ObjectTypeFilter; label: string }> = [
  { value: 'ALL', label: '全部类型' },
  { value: 'table', label: '表' },
  { value: 'view', label: '视图' },
  { value: 'procedure', label: '过程' },
  { value: 'function', label: '函数' },
];

function visibleNodes(nodes: NodeMeta[], tab: LeftTab, keyword: string): NodeMeta[] {
  const kw = keyword.trim().toLowerCase();
  const list = nodes.filter((n) => {
    if (kw && !(n.alias + n.host + n.database + (n.group ?? '')).toLowerCase().includes(kw)) return false;
    if (tab === 'mine' && !n.star) return false;
    // 常用 = 手动置顶（pinned）+ 按频次自动 Top（用过即入围，按 useCount 倒序）。
    if (tab === 'fav' && !n.pinned && (n.useCount ?? 0) <= 0) return false;
    return true;
  });
  if (tab === 'fav') return [...list].sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
  return list;
}

function riskClass(risk: string): string {
  if (risk === 'high') return 'risk-high';
  if (risk === 'medium') return 'risk-med';
  return 'risk-low';
}

function riskLabel(risk: string): string {
  if (risk === 'high') return '高危';
  if (risk === 'medium') return '中';
  return '低';
}

// ---------------------------------------------------------------------------
// 左栏：节点库
// ---------------------------------------------------------------------------

function NodeCard({
  node,
  latency,
  testing,
  onPick,
  onToggleStar,
  onEdit,
  onRemove,
  onTest,
}: {
  node: NodeMeta;
  latency?: number;
  testing?: boolean;
  onPick: (id: string) => void;
  onToggleStar: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onTest: (id: string) => void;
}) {
  return (
    <div
      className="node-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', node.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onPick(node.id)}
      title="拖拽到中央 A / B 槽（或点击自动放入）"
    >
      <div className="node-head">
        <span className="node-alias">{node.alias}</span>
        <button
          className={node.star ? 'star on' : 'star'}
          title={node.star ? '取消收藏' : '收藏到我的'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(node.id);
          }}
        >
          {node.star ? '★' : '☆'}
        </button>
      </div>
      <div className="node-meta">
        {node.host} · {node.database}
      </div>
      <div className="node-sub">
        {[node.group, `用过 ${node.useCount ?? 0} 次`].filter(Boolean).join(' · ')}
      </div>
      <div className="node-actions">
        <button
          className="mini-btn"
          title="测试连接（含延迟 ms）"
          disabled={testing}
          onClick={(e) => {
            e.stopPropagation();
            onTest(node.id);
          }}
        >
          {testing ? '测…' : '测'}
        </button>
        {latency != null && (
          <span className={latency < 50 ? 'latency ok' : 'latency slow'} title="上次测试延迟">
            {latency}ms
          </span>
        )}
        <span className="node-actions-right">
          <button
            className="mini-btn"
            title="编辑节点"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(node.id);
            }}
          >
            改
          </button>
          <button
            className="mini-btn danger"
            title="删除节点（密钥一并删除）"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(node.id);
            }}
          >
            删
          </button>
        </span>
      </div>
    </div>
  );
}

function HistoryRow({
  entry,
  onRestore,
}: {
  entry: HistoryEntry;
  onRestore: (entry: HistoryEntry) => void;
}) {
  let when = entry.at;
  try {
    when = new Date(entry.at).toLocaleString();
  } catch {
    // 保持原串。
  }
  return (
    <button
      className="hist-row"
      onClick={() => onRestore(entry)}
      title={entry.aId && entry.bId ? '点击恢复该次 A / B 组合' : '该条无节点 id，仅展示'}
    >
      <div className="hist-main">
        {entry.aAlias} → {entry.bAlias}
      </div>
      <div className="hist-sub">
        {when} · {entry.diffCount} 条差异
      </div>
    </button>
  );
}

function NodeLibrary({
  nodes,
  history,
  leftTab,
  keyword,
  nodesLoading,
  latencies,
  testingId,
  onTab,
  onKeyword,
  onPick,
  onToggleStar,
  onRestoreHistory,
  onNewNode,
  onEditNode,
  onRemoveNode,
  onTestNode,
  onExport,
  onImportFile,
  onImportLegacy,
}: {
  nodes: NodeMeta[];
  history: HistoryEntry[];
  leftTab: LeftTab;
  keyword: string;
  nodesLoading: boolean;
  latencies: Record<string, number>;
  testingId: string | null;
  onTab: (t: LeftTab) => void;
  onKeyword: (kw: string) => void;
  onPick: (id: string) => void;
  onToggleStar: (id: string) => void;
  onRestoreHistory: (entry: HistoryEntry) => void;
  onNewNode: () => void;
  onEditNode: (id: string) => void;
  onRemoveNode: (id: string) => void;
  onTestNode: (id: string) => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onImportLegacy: () => void;
}) {
  const kw = keyword.trim().toLowerCase();
  const histFiltered = kw
    ? history.filter((h) => `${h.aAlias}${h.bAlias}`.toLowerCase().includes(kw))
    : history;
  const list = visibleNodes(nodes, leftTab, keyword);
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <aside className="card pane-left">
      <div className="pane-head">
        <h2>节点库</h2>
        <button className="link-btn" onClick={onNewNode}>
          ＋ 新增
        </button>
      </div>
      <div className="lib-tools">
        <button className="link-btn" title="一键导出全部节点 JSON（密码加密，无明文）" onClick={onExport}>
          导出
        </button>
        <button
          className="link-btn"
          title="从导出的 JSON 导入恢复（免重输密码）"
          onClick={() => fileRef.current?.click()}
        >
          导入
        </button>
        <button className="link-btn" title="粘贴老 CLI 连接串一键解析导入" onClick={onImportLegacy}>
          连串
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onImportFile(f);
          }}
        />
      </div>
      <input
        className="node-search"
        placeholder="搜索 别名 / host / 库名…"
        value={keyword}
        onChange={(e) => onKeyword(e.target.value)}
      />
      <div className="ltabs">
        {LEFT_TABS.map((t) => (
          <button
            key={t.value}
            className={leftTab === t.value ? 'ltab active' : 'ltab'}
            onClick={() => onTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {leftTab === 'hist' ? (
        <div className="node-list">
          {histFiltered.map((h) => (
            <HistoryRow key={h.id} entry={h} onRestore={onRestoreHistory} />
          ))}
          {histFiltered.length === 0 && (
            <div className="empty">{nodesLoading ? '加载中…' : '暂无对比历史 — 对比一次后此处记录时间 + A/B + 差异数'}</div>
          )}
        </div>
      ) : (
        <div className="node-list">
          {list.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              latency={latencies[n.id]}
              testing={testingId === n.id}
              onPick={onPick}
              onToggleStar={onToggleStar}
              onEdit={onEditNode}
              onRemove={onRemoveNode}
              onTest={onTestNode}
            />
          ))}
          {list.length === 0 && (
            <div className="empty">
              {leftTab === 'mine' ? '暂无收藏 — 点击卡片上的 ☆ 收藏到我的' : '暂无常用节点 — 多对比几次或点右上角 ＋ 新增'}
            </div>
          )}
        </div>
      )}
      <p className="hint">💡 拖拽卡片到中央 A / B 槽（或点击自动放入）</p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 中上：对比槽
// ---------------------------------------------------------------------------

function Slot({
  which,
  nodeId,
  nodes,
  onDropNode,
  onSelect,
}: {
  which: 'A' | 'B';
  nodeId: string | null;
  nodes: NodeMeta[];
  onDropNode: (which: SlotId, id: string) => void;
  onSelect: (which: SlotId, id: string | null) => void;
}) {
  const node = nodes.find((n) => n.id === nodeId) ?? null;
  return (
    <div
      className={node ? 'slot filled' : 'slot'}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        if (id) onDropNode(which, id);
      }}
    >
      <div className="slot-label">{which === 'A' ? 'SOURCE · A' : 'TARGET · B'}</div>
      <div className="slot-body">
        {node ? (
          <>
            <div className="slot-node">{node.alias}</div>
            <div className="slot-node-sub">
              {node.host} · {node.database}
            </div>
          </>
        ) : (
          '拖拽节点到此 / 下拉选择'
        )}
      </div>
      <select
        className="slot-select"
        value={nodeId ?? ''}
        onChange={(e) => onSelect(which, e.target.value ? e.target.value : null)}
        title="下拉选择节点（二选一，可替代拖拽）"
      >
        <option value="">选择节点…</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.alias}（{n.database}）
          </option>
        ))}
      </select>
    </div>
  );
}

function CompareSlots({
  nodes,
  slotA,
  slotB,
  scopes,
  includeData,
  tableFilter,
  comparing,
  progress,
  progressPct,
  lastComboText,
  onDropNode,
  onSelect,
  onSwap,
  onClear,
  onToggleScope,
  onToggleIncludeData,
  onTableFilter,
  onRun,
  onCancel,
}: {
  nodes: NodeMeta[];
  slotA: string | null;
  slotB: string | null;
  scopes: ObjectType[];
  includeData: boolean;
  tableFilter: string;
  comparing: boolean;
  progress: string;
  progressPct: number;
  lastComboText: string;
  onDropNode: (which: SlotId, id: string) => void;
  onSelect: (which: SlotId, id: string | null) => void;
  onSwap: () => void;
  onClear: () => void;
  onToggleScope: (s: ObjectType) => void;
  onToggleIncludeData: () => void;
  onTableFilter: (v: string) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  const canRun = !comparing && !!slotA && !!slotB && (scopes.length > 0 || includeData);
  return (
    <div className="card">
      <div className="slots">
        <Slot which="A" nodeId={slotA} nodes={nodes} onDropNode={onDropNode} onSelect={onSelect} />
        <div className="slot-actions">
          <button className="btn" title="交换 A/B（替代老 --reverse）" onClick={onSwap}>
            ⇄ 交换
          </button>
          <button className="btn btn-ghost" onClick={onClear}>
            清空
          </button>
        </div>
        <Slot which="B" nodeId={slotB} nodes={nodes} onDropNode={onDropNode} onSelect={onSelect} />
      </div>
      <div className="scope-row">
        {SCOPES.map((s) => (
          <label key={s.value}>
            <input
              type="checkbox"
              checked={scopes.includes(s.value)}
              onChange={() => onToggleScope(s.value)}
            />{' '}
            {s.label}
          </label>
        ))}
        <label title="数据行对比：主键范围分页拉取，只读生成 INSERT/DELETE/UPDATE">
          <input type="checkbox" checked={includeData} onChange={onToggleIncludeData} /> 数据
        </label>
        <input
          className="table-filter"
          placeholder="表搜索过滤…"
          title="表名子串过滤（只作用于表），对比时传给 compare.run"
          value={tableFilter}
          onChange={(e) => onTableFilter(e.target.value)}
        />
        <button className="btn btn-primary" disabled={!canRun} onClick={onRun} title="快捷键 ⌘/Ctrl + Enter">
          {comparing ? '对比中…' : '对比 ⚡'}
        </button>
        {comparing && (
          <button className="btn btn-ghost" onClick={onCancel} title="中断数据拉取（结构对比不可中断）">
            取消
          </button>
        )}
      </div>
      {comparing && (
        <div className="progress" role="progressbar" aria-label="对比进度">
          <div className="progress-fill" style={{ width: `${Math.max(4, progressPct)}%` }} />
          <span className="progress-text">{progress || '对比中…'}</span>
        </div>
      )}
      <div className="compare-meta">
        {lastComboText ? `已记忆上次组合：${lastComboText}` : '拖入 A / B 后点击对比（⌘/Ctrl + Enter）'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 中下：差异表
// ---------------------------------------------------------------------------

function DiffTable({
  counts,
  total,
  visibleCount,
  rows,
  diffFilter,
  objectTypeFilter,
  stmtKindFilter,
  aspectFilter,
  indexCount,
  verbFilter,
  structVerbCounts,
  dataVerbCounts,
  onDiffFilter,
  onObjFilter,
  onStmtKindFilter,
  onAspectFilter,
  onToggleVerb,
  onSelect,
  selectedId,
}: {
  counts: Record<DiffFilter, number>;
  total: number;
  visibleCount: number;
  rows: DiffItem[];
  diffFilter: DiffFilter;
  objectTypeFilter: ObjectTypeFilter;
  stmtKindFilter: StmtKindFilter;
  aspectFilter: AspectFilter;
  /** 当前维度+类型视图下的索引语句数（chip 标签用，不过滤自身）。 */
  indexCount: number;
  /** R7 动词桶选择（'ALL' = 不限；多选 OR，组间与维度/切面/Tab 正交 AND）。 */
  verbFilter: VerbFilter;
  /** 动词计数基座（Tab/动词自身不过滤，保证开关可逆可见；DDL 桶按结构基座，DML 桶按数据基座）。 */
  structVerbCounts: Record<Verb, number>;
  dataVerbCounts: Record<Verb, number>;
  onDiffFilter: (f: DiffFilter) => void;
  onObjFilter: (f: ObjectTypeFilter) => void;
  onStmtKindFilter: (f: StmtKindFilter) => void;
  onAspectFilter: (f: AspectFilter) => void;
  onToggleVerb: (v: Verb) => void;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
}) {
  const isVerbOn = (v: Verb): boolean => verbFilter !== 'ALL' && verbFilter.includes(v);
  const verbCount = (v: Verb): number =>
    v === 'INSERT' || v === 'UPDATE' || v === 'DELETE' ? dataVerbCounts[v] : structVerbCounts[v];
  return (
    <div className="card diff-card">
      <div className="diff-tabs">
        {STMT_DIM_TABS.map((t) => (
          <button
            key={t.value}
            className={stmtKindFilter === t.value ? 'tab-btn active' : 'tab-btn'}
            title={t.title}
            onClick={() => onStmtKindFilter(t.value)}
          >
            {t.label}
          </button>
        ))}
        <span className="diff-stat">维度（DDL=结构 / DML=数据）</span>
      </div>
      <div className="diff-tabs">
        {DIFF_TABS.map((t) => (
          <button
            key={t.value}
            className={diffFilter === t.value ? 'tab-btn active' : 'tab-btn'}
            onClick={() => onDiffFilter(t.value)}
          >
            {t.label} ({counts[t.value]})
          </button>
        ))}
        <span className="diff-stat">当前 {visibleCount} 条 / 共 {total} 条</span>
      </div>
      <div className="obj-filters">
        {OBJ_FILTERS.map((f) => (
          <button
            key={f.value}
            className={objectTypeFilter === f.value ? 'chip active' : 'chip'}
            onClick={() => onObjFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
        <button
          className={aspectFilter === 'index' ? 'chip active' : 'chip'}
          title="仅看索引语句（ADD/DROP INDEX|KEY；PRIMARY KEY 归主键不归此类，结构范围）"
          onClick={() => onAspectFilter(aspectFilter === 'index' ? 'ALL' : 'index')}
        >
          INDEX ({indexCount})
        </button>
      </div>
      <div className="obj-filters" title="按语句首动词过滤（CREATE/DROP/ALTER/INSERT/UPDATE/DELETE 多选；与维度/切面/Tab/关键字正交 AND；复制=所见）">
        <span className="diff-stat" style={{ marginLeft: 0 }}>
          动词
        </span>
        {VERB_GROUPS.map((g) => (
          <span key={g.label} style={{ display: 'contents' }}>
            <span style={{ fontSize: 12, color: '#64748b', alignSelf: 'center' }} title={g.label === 'DDL' ? '结构语句动词' : '数据语句动词'}>
              {g.label}
            </span>
            {g.verbs.map((v) => (
              <button
                key={v}
                className={isVerbOn(v) ? 'chip active' : 'chip'}
                title={`只看 ${v} 开头语句（当前 ${verbCount(v)} 条）`}
                onClick={() => onToggleVerb(v)}
              >
                {v} ({verbCount(v)})
              </button>
            ))}
          </span>
        ))}
      </div>
      <div className="diff-scroll">
        <table className="diff-table">
          <thead>
            <tr>
              <th>对象</th>
              <th>类型</th>
              <th>变更</th>
              <th>风险</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={selectedId === r.id ? 'diff-row selected' : 'diff-row'}
                onClick={() => onSelect(selectedId === r.id ? null : r.id)}
              >
                <td className="mono">{r.objectName}</td>
                <td>
                  <span className="badge b-obj">{r.objectType}</span>
                </td>
                <td>
                  <span className={`badge b-${r.changeType.toLowerCase()}`}>{r.changeType}</span>
                </td>
                <td className={riskClass(r.risk)}>{riskLabel(r.risk)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">空空如也 — 换个 Tab / 类型过滤或清空表过滤试试 🍃</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 数据对比：表映射 + 逐表状态 + 独立 INSERT/DELETE/UPDATE 三 Tab
// ---------------------------------------------------------------------------

function dataStatusText(s: DataTableStatus): string {
  if (s.status === 'done')
    return `完成（A${s.countA ?? '?'}行/B${s.countB ?? '?'}行，I${s.insertCount ?? 0}/D${s.deleteCount ?? 0}/U${s.updateCount ?? 0}）`;
  if (s.status === 'running') return '进行中…';
  if (s.status === 'skipped')
    return `跳过（无可用行身份）${s.countA != null || s.countB != null ? `（A${s.countA ?? '?'}行/B${s.countB ?? '?'}行）` : ''} — ${s.message ?? ''}`;
  if (s.status === 'confirm-needed') return `超阈待确认 — ${s.message ?? ''}`;
  if (s.status === 'error') return `失败 — ${s.message ?? '未知错误'}`;
  return '待比';
}

/** 数据对比可调参数三输入（分页批量 / 行阈值 / INSERT 分批；失焦/回车提交，非法回落默认）。 */
function DataOptionsInputs({
  batchRows,
  threshold,
  insertBatch,
  onBatchRows,
  onThreshold,
  onInsertBatch,
}: {
  batchRows: number;
  threshold: number;
  insertBatch: number;
  onBatchRows: (v: string) => void;
  onThreshold: (v: string) => void;
  onInsertBatch: (v: string) => void;
}) {
  const [b, setB] = useState(String(batchRows));
  const [t, setT] = useState(String(threshold));
  const [i, setI] = useState(String(insertBatch));
  useEffect(() => setB(String(batchRows)), [batchRows]);
  useEffect(() => setT(String(threshold)), [threshold]);
  useEffect(() => setI(String(insertBatch)), [insertBatch]);
  return (
    <div className="data-pair-row" title="数据对比可调参数：非法/越界输入回落默认">
      <label title="主键范围分页批量（100-5000，默认 1000）">
        分页批量
        <input
          className="data-opt-input mono"
          inputMode="numeric"
          value={b}
          onChange={(e) => setB(e.target.value)}
          onBlur={() => onBatchRows(b)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <label title="单表行数阈值（10000-1000000，默认 100000；超阈仍需二次确认）">
        行阈值
        <input
          className="data-opt-input mono"
          inputMode="numeric"
          value={t}
          onChange={(e) => setT(e.target.value)}
          onBlur={() => onThreshold(t)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <label title="INSERT 多 VALUES 分批行数（100-2000，默认 500）">
        INSERT分批
        <input
          className="data-opt-input mono"
          inputMode="numeric"
          value={i}
          onChange={(e) => setI(e.target.value)}
          onBlur={() => onInsertBatch(i)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
    </div>
  );
}

function DataSection({
  lists,
  listsLoading,
  pairs,
  statusRows,
  needConfirm,
  batchRows,
  threshold,
  insertBatch,
  onLoadLists,
  onSetPairB,
  onRemovePair,
  onAddPair,
  onConfirmRerun,
  onBatchRows,
  onThreshold,
  onInsertBatch,
  onToast,
}: {
  lists: DataTableLists;
  listsLoading: boolean;
  pairs: Array<{ a: string; b: string }>;
  statusRows: DataTableStatus[];
  needConfirm: boolean;
  batchRows: number;
  threshold: number;
  insertBatch: number;
  onLoadLists: () => void;
  onSetPairB: (index: number, b: string) => void;
  onRemovePair: (index: number) => void;
  onAddPair: (a: string, b: string) => void;
  onConfirmRerun: () => void;
  onBatchRows: (v: string) => void;
  onThreshold: (v: string) => void;
  onInsertBatch: (v: string) => void;
  onToast: (msg: string) => void;
}) {
  const [addA, setAddA] = useState('');
  const [addB, setAddB] = useState('');
  return (
    <div className="card">
      <div className="pane-head">
        <h2>数据表映射</h2>
        <button className="btn btn-sm" disabled={listsLoading} onClick={onLoadLists}>
          {listsLoading ? '载入中…' : '载入表清单（同名自动配对）'}
        </button>
      </div>
      {pairs.length === 0 && (
        <div className="empty">未配置映射时按 A/B 同名交集跑；也可先载入清单再手动改 B 表下拉 / 增删行。</div>
      )}
      <DataOptionsInputs
        batchRows={batchRows}
        threshold={threshold}
        insertBatch={insertBatch}
        onBatchRows={onBatchRows}
        onThreshold={onThreshold}
        onInsertBatch={onInsertBatch}
      />
      {pairs.map((p, i) => (
        <div className="data-pair-row" key={`${p.a}→${p.b}@${i}`}>
          <span className="mono">{p.a}</span>
          <span> → </span>
          <select
            className="slot-select"
            value={p.b}
            onChange={(e) => onSetPairB(i, e.target.value)}
            title="手动改 B 表映射"
          >
            {lists.b.includes(p.b) ? null : <option value={p.b}>{p.b}</option>}
            {lists.b.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="mini-btn danger" title="删除本行映射" onClick={() => onRemovePair(i)}>
            删
          </button>
        </div>
      ))}
      <div className="data-pair-row">
        <select className="slot-select" value={addA} onChange={(e) => setAddA(e.target.value)} title="A 表">
          <option value="">A 表…</option>
          {lists.a.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span> → </span>
        <select className="slot-select" value={addB} onChange={(e) => setAddB(e.target.value)} title="B 表">
          <option value="">B 表…</option>
          {lists.b.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          className="mini-btn"
          onClick={() => {
            if (!addA || !addB) {
              onToast('请先选 A / B 表');
              return;
            }
            onAddPair(addA, addB);
            setAddA('');
            setAddB('');
          }}
        >
          加一行
        </button>
      </div>
      {statusRows.length > 0 && (
        <div className="data-status">
          {statusRows.map((s) => (
            <div
              className={`data-status-row st-${s.status}`}
              key={`${s.a}→${s.b}`}
              title={s.message ?? dataStatusText(s)}
            >
              <span className="mono">
                {s.a} → {s.b}
              </span>
              <span>{dataStatusText(s)}</span>
            </div>
          ))}
        </div>
      )}
      {needConfirm && (
        <div className="drop-alert">
          ⚠️ 部分大表行数超阈（当前阈值 {threshold}），已跳过。请确认后重跑。
          <button className="btn btn-sm btn-primary" onClick={onConfirmRerun} title="二次确认超阈大表并重跑">
            确认并重跑
          </button>
        </div>
      )}
      <p className="hint">💡 只读生成 INSERT/DELETE/UPDATE，不执行；无主键且无可用 UNIQUE 的表跳过行级 diff，只给行数差异；全列 NOT NULL 的 UNIQUE 键可等价做行身份。</p>
    </div>
  );
}

function DataDiffTable({
  counts,
  rows,
  dmlFilter,
  onDmlFilter,
  onSelect,
  selectedId,
  aName,
  bName,
  onToast,
}: {
  counts: Record<DmlFilter, number>;
  rows: DiffItem[];
  dmlFilter: DmlFilter;
  onDmlFilter: (f: DmlFilter) => void;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
  aName: string;
  bName: string;
  onToast: (msg: string) => void;
}) {
  const handleCopy = async (): Promise<void> => {
    if (rows.length === 0) {
      onToast('暂无数据 SQL 可复制');
      return;
    }
    const text = buildExportText(rows, { aName, bName, at: new Date().toISOString() });
    const ok = await copyText(text);
    onToast(ok ? `已复制数据 ${dmlFilter}（${rows.length}条）到剪贴板` : '复制失败：无剪贴板权限');
  };
  const handleExport = (): void => {
    if (rows.length === 0) {
      onToast('暂无数据 SQL 可导出');
      return;
    }
    const text = buildExportText(rows, { aName, bName, at: new Date().toISOString() });
    downloadSqlFile(`sqldiff_data_${dmlFilter.toLowerCase()}_${Date.now()}.sql`, text);
    onToast(`已导出数据 ${dmlFilter} .sql（含头注释，共 ${rows.length} 条）`);
  };
  return (
    <div className="card diff-card">
      <div className="diff-tabs">
        {DML_TABS.map((t) => (
          <button
            key={t.value}
            className={dmlFilter === t.value ? 'tab-btn active' : 'tab-btn'}
            onClick={() => onDmlFilter(t.value)}
          >
            {t.label} ({counts[t.value]})
          </button>
        ))}
        <span className="diff-stat">数据 {rows.length} 条（只读生成，未执行）</span>
        <span className="diff-stat">
          <button className="mini-btn" onClick={() => void handleCopy()}>
            ⧉ 复制本类
          </button>{' '}
          <button className="mini-btn" onClick={handleExport}>
            导出本类 .sql
          </button>
        </span>
      </div>
      <div className="diff-scroll">
        <table className="diff-table">
          <thead>
            <tr>
              <th>表</th>
              <th>DML</th>
              <th>风险</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: DiffItem) => (
              <tr
                key={r.id}
                className={selectedId === r.id ? 'diff-row selected' : 'diff-row'}
                onClick={() => onSelect(selectedId === r.id ? null : r.id)}
              >
                <td className="mono">{r.objectName}</td>
                <td>
                  <span className={`badge b-${r.changeType.toLowerCase()}`}>{r.dml ?? r.changeType}</span>
                </td>
                <td className={riskClass(r.risk)}>{riskLabel(r.risk)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">该类暂无数据差异 🍃</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 右栏：SQL 预览
// ---------------------------------------------------------------------------

function SqlPreview({
  tabItems,
  extraItems = [],
  selectedId,
  aName,
  bName,
  onToast,
}: {
  tabItems: DiffItem[];
  /** 数据 Tab 行（仅供选中单条预览，不参与“当前Tab全部”复制/导出）。 */
  extraItems?: DiffItem[];
  selectedId: string | null;
  aName: string;
  bName: string;
  onToast: (msg: string) => void;
}) {
  const selected = selectedId
    ? (tabItems.find((it) => it.id === selectedId) ?? extraItems.find((it) => it.id === selectedId) ?? null)
    : null;
  const current = selected ? [selected] : tabItems;
  const hasDrop = current.some((it) => it.changeType === 'DROP');

  const exportText = useMemo(
    () => buildExportText(current, { aName, bName, at: new Date().toISOString() }),
    // current 由 tabItems + selectedId 派生；直接依赖两者即可（引用每 render 都变，故不用 current 本身）。
    [tabItems, selectedId, aName, bName],
  );
  const highlighted = useMemo(() => highlightSql(exportText), [exportText]);

  const confirmDropIfNeeded = (): boolean => {
    if (!hasDrop) return true;
    return window.confirm('含 DROP 高危语句，执行前请备份。确认复制吗？');
  };

  const handleCopy = async (): Promise<void> => {
    if (current.length === 0) {
      onToast('暂无 SQL 可复制');
      return;
    }
    if (!confirmDropIfNeeded()) return;
    const ok = await copyText(exportText);
    onToast(ok ? `已复制 ${current.length} 条 SQL 到剪贴板` : '复制失败：无剪贴板权限');
  };

  const handleExport = (): void => {
    if (current.length === 0) {
      onToast('暂无 SQL 可导出');
      return;
    }
    downloadSqlFile(`sqldiff_${Date.now()}.sql`, exportText);
    onToast(`已导出 .sql（含头注释，顺序 DROP→CREATE→CHANGE，共 ${current.length} 条）`);
  };

  return (
    <aside className="card pane-right">
      <div className="pane-head">
        <h2>SQL 预览</h2>
        <div className="pane-head-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void handleCopy()}>
            {selected ? '⧉ 复制单条' : `⧉ 复制当前Tab（${current.length}条）`}
          </button>
          <button className="btn btn-sm" onClick={handleExport}>
            导出 .sql
          </button>
        </div>
      </div>
      <div className="sql-mode">{selected ? `· 单条：${selected.objectName}` : `· 当前Tab全部（${current.length}条）`}</div>
      {hasDrop && (
        <div className="drop-alert">⚠️ 含 <b>DROP</b> 高危语句：执行前请备份，复制需二次确认。</div>
      )}
      {/* <pre> fallback：Monaco 体积大且需 worker，首版用高亮 <pre>（设计允许二选一）。 */}
      {current.length > 0 ? (
        <pre className="sql-view" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <pre className="sql-view">暂无 SQL — 先对比，再点差异行查看单条</pre>
      )}
      <div className="risk-box">
        <div className="risk-title">🛡 风险说明</div>
        <div className="risk-text">
          {current.length > 0
            ? current.map((it) => `【${it.objectName}】${it.explain ?? '—'}`).join('\n')
            : '—'}
        </div>
        <div className="risk-title">↩ 回滚建议</div>
        <div className="risk-text">
          {current.length > 0
            ? current.map((it) => `【${it.objectName}】${it.rollback ?? '—'}`).join('\n')
            : '—'}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 节点表单：新增 / 编辑（R1 全字段）+ 免保存测试连接
// ---------------------------------------------------------------------------

function NodeModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: NodeMeta | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const saveNode = useDesktopStore((s) => s.saveNode);
  const testDraft = useDesktopStore((s) => s.testDraft);
  const [alias, setAlias] = useState(editing?.alias ?? '');
  const [host, setHost] = useState(editing?.host ?? '127.0.0.1');
  const [port, setPort] = useState(String(editing?.port ?? 3306));
  const [user, setUser] = useState(editing?.user ?? 'root');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState(editing?.database ?? '');
  const [group, setGroup] = useState(editing?.group ?? '');
  const [tags, setTags] = useState((editing?.tags ?? []).join(', '));
  const [star, setStar] = useState(editing?.star ?? false);
  const [sshEnabled, setSshEnabled] = useState(editing?.ssh.enabled ?? false);
  const [sshHost, setSshHost] = useState(editing?.ssh.host ?? '');
  const [sshPort, setSshPort] = useState(String(editing?.ssh.port ?? 22));
  const [sshUser, setSshUser] = useState(editing?.ssh.user ?? '');
  const [authType, setAuthType] = useState<'password' | 'privateKey'>(editing?.ssh.authType ?? 'password');
  const [sshPassword, setSshPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const collect = (): NodeCreateInput => {
    const numPort = port.trim() === '' ? undefined : Number.parseInt(port.trim(), 10);
    const numSshPort = sshPort.trim() === '' ? undefined : Number.parseInt(sshPort.trim(), 10);
    const secret: SecretBundle = {};
    let hasSecret = false;
    if (password) {
      secret.password = password;
      hasSecret = true;
    }
    if (sshEnabled && authType === 'password' && sshPassword) {
      secret.sshPassword = sshPassword;
      hasSecret = true;
    }
    if (sshEnabled && authType === 'privateKey') {
      if (privateKey) {
        secret.privateKey = privateKey;
        hasSecret = true;
      }
      if (passphrase) {
        secret.passphrase = passphrase;
        hasSecret = true;
      }
    }
    return {
      alias: alias.trim(),
      host: host.trim(),
      ...(numPort !== undefined ? { port: numPort } : {}),
      user: user.trim(),
      database: database.trim(),
      group: group.trim(),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      star,
      ssh: {
        enabled: sshEnabled,
        ...(sshHost.trim() ? { host: sshHost.trim() } : {}),
        ...(numSshPort !== undefined ? { port: numSshPort } : {}),
        ...(sshUser.trim() ? { user: sshUser.trim() } : {}),
        authType,
      },
      // 编辑时留空密码 = 不动密钥；新建时透传（可空，由主进程 vault 落盘）。
      ...(editing ? (hasSecret ? { secret } : {}) : { secret }),
    };
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestMsg(null);
    try {
      const input = collect();
      const node: NodeMeta = {
        id: editing?.id ?? 'draft',
        alias: input.alias || '未命名',
        host: input.host || '127.0.0.1',
        port: input.port ?? 3306,
        user: input.user || 'root',
        database: input.database,
        ...(input.group ? { group: input.group } : {}),
        ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
        ssh: {
          enabled: input.ssh?.enabled ?? false,
          host: input.ssh?.host ?? '',
          port: input.ssh?.port ?? 22,
          user: input.ssh?.user ?? '',
          authType: input.ssh?.authType ?? 'password',
        },
        createdAt: editing?.createdAt ?? new Date().toISOString(),
      };
      const r = await testDraft(node, input.secret ?? {});
      setTestOk(r.ok);
      setTestMsg(r.ok ? `连接成功，延迟 ${r.ms}ms` : `连接失败 [${r.code ?? 'UNKNOWN'}] ${r.message ?? ''}`);
    } catch (e) {
      setTestOk(false);
      setTestMsg(e instanceof Error ? e.message : '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    setErr(null);
    if (!alias.trim() || !host.trim() || !user.trim() || !database.trim()) {
      setErr('别名 / host / user / database 为必填');
      return;
    }
    setSaving(true);
    try {
      const input = collect();
      if (editing) {
        await saveNode(input, editing.id);
        onSaved(`已更新节点：${input.alias}`);
      } else {
        await saveNode(input);
        onSaved(`已新增节点：${input.alias}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label={editing ? '编辑节点' : '新增节点'}>
        <div className="modal-title">{editing ? '编辑节点' : '新增节点'}</div>
        <div className="form-grid">
          <label className="form-row">
            <span>别名 *</span>
            <input className="form-input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="prod-主库" />
          </label>
          <label className="form-row">
            <span>host *</span>
            <input className="form-input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
          </label>
          <label className="form-row">
            <span>port</span>
            <input className="form-input mono" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3306" />
          </label>
          <label className="form-row">
            <span>user *</span>
            <input className="form-input mono" value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
          </label>
          <label className="form-row">
            <span>password{editing ? '（留空不动）' : ''}</span>
            <input
              className="form-input mono"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={editing ? '留空则保留原密码' : '数据库密码（进钥匙串，不落盘明文）'}
            />
          </label>
          <label className="form-row">
            <span>database *</span>
            <input className="form-input mono" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="shop" />
          </label>
          <label className="form-row">
            <span>分组</span>
            <input className="form-input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="生产" />
          </label>
          <label className="form-row">
            <span>标签（逗号分隔）</span>
            <input className="form-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, 核心" />
          </label>
          <label className="form-check">
            <input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> 收藏到我的（★）
          </label>
          <label className="form-check">
            <input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} /> 启用 SSH 隧道（单跳，Windows 可用）
          </label>
          {sshEnabled && (
            <>
              <label className="form-row">
                <span>ssh host *</span>
                <input className="form-input mono" value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="10.0.0.1" />
              </label>
              <label className="form-row">
                <span>ssh port</span>
                <input className="form-input mono" value={sshPort} onChange={(e) => setSshPort(e.target.value)} placeholder="22" />
              </label>
              <label className="form-row">
                <span>ssh user *</span>
                <input className="form-input mono" value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="deploy" />
              </label>
              <label className="form-row">
                <span>SSH 认证</span>
                <select className="form-input" value={authType} onChange={(e) => setAuthType(e.target.value as 'password' | 'privateKey')}>
                  <option value="password">密码</option>
                  <option value="privateKey">密钥（privateKey + passphrase）</option>
                </select>
              </label>
              {authType === 'password' ? (
                <label className="form-row">
                  <span>ssh 密码{editing ? '（留空不动）' : ''}</span>
                  <input
                    className="form-input mono"
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={editing ? '留空则保留原密码' : 'SSH 密码'}
                  />
                </label>
              ) : (
                <>
                  <label className="form-row">
                    <span>私钥{editing ? '（留空不动）' : ''}</span>
                    <textarea
                      className="form-input mono form-textarea"
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    />
                  </label>
                  <label className="form-row">
                    <span>passphrase（可选）</span>
                    <input
                      className="form-input mono"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="密钥口令（可空）"
                    />
                  </label>
                </>
              )}
            </>
          )}
        </div>
        {err && <div className="form-err">{err}</div>}
        {testMsg && <div className={testOk ? 'form-ok' : 'form-err'}>{testMsg}</div>}
        <div className="modal-actions">
          <button className="btn" disabled={testing} onClick={() => void handleTest()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <span className="modal-actions-right">
            <button className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </span>
        </div>
        <p className="form-hint">密码 / 密钥只进系统钥匙串（safeStorage 加密），nodes.json 仅存元数据；特殊字符密码请走本表单，不要拼连接串。</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App 组装
// ---------------------------------------------------------------------------

export default function App() {
  const nodes = useDesktopStore((s) => s.nodes);
  const history = useDesktopStore((s) => s.history);
  const leftTab = useDesktopStore((s) => s.leftTab);
  const nodeKeyword = useDesktopStore((s) => s.nodeKeyword);
  const nodesLoading = useDesktopStore((s) => s.nodesLoading);
  const slotA = useDesktopStore((s) => s.slotA);
  const slotB = useDesktopStore((s) => s.slotB);
  const scopes = useDesktopStore((s) => s.scopes);
  const includeData = useDesktopStore((s) => s.includeData);
  const dataPairs = useDesktopStore((s) => s.dataPairs);
  const dataLists = useDesktopStore((s) => s.dataLists);
  const dataListsLoading = useDesktopStore((s) => s.dataListsLoading);
  const dataStatus = useDesktopStore((s) => s.dataStatus);
  const dataBatchRows = useDesktopStore((s) => s.dataBatchRows);
  const dataThreshold = useDesktopStore((s) => s.dataThreshold);
  const dataInsertBatch = useDesktopStore((s) => s.dataInsertBatch);
  const tableFilter = useDesktopStore((s) => s.tableFilter);
  const diffFilter = useDesktopStore((s) => s.diffFilter);
  const dmlFilter = useDesktopStore((s) => s.dmlFilter);
  const objectTypeFilter = useDesktopStore((s) => s.objectTypeFilter);
  const stmtKindFilter = useDesktopStore((s) => s.stmtKindFilter);
  const aspectFilter = useDesktopStore((s) => s.aspectFilter);
  const verbFilter = useDesktopStore((s) => s.verbFilter);
  const items = useDesktopStore((s) => s.items);
  const selectedId = useDesktopStore((s) => s.selectedId);
  const comparing = useDesktopStore((s) => s.comparing);
  const progress = useDesktopStore((s) => s.progress);
  const progressPct = useDesktopStore((s) => s.progressPct);
  const lastComboText = useDesktopStore((s) => s.lastComboText);
  const toast = useDesktopStore((s) => s.toast);

  const setLeftTab = useDesktopStore((s) => s.setLeftTab);
  const setNodeKeyword = useDesktopStore((s) => s.setNodeKeyword);
  const assignNode = useDesktopStore((s) => s.assignNode);
  const setSlot = useDesktopStore((s) => s.setSlot);
  const swapSlots = useDesktopStore((s) => s.swapSlots);
  const clearSlots = useDesktopStore((s) => s.clearSlots);
  const toggleScope = useDesktopStore((s) => s.toggleScope);
  const toggleIncludeData = useDesktopStore((s) => s.toggleIncludeData);
  const setDataPairB = useDesktopStore((s) => s.setDataPairB);
  const setDataBatchRows = useDesktopStore((s) => s.setDataBatchRows);
  const setDataThreshold = useDesktopStore((s) => s.setDataThreshold);
  const setDataInsertBatch = useDesktopStore((s) => s.setDataInsertBatch);
  const removeDataPair = useDesktopStore((s) => s.removeDataPair);
  const addDataPair = useDesktopStore((s) => s.addDataPair);
  const setConfirmDataThreshold = useDesktopStore((s) => s.setConfirmDataThreshold);
  const refreshDataTables = useDesktopStore((s) => s.refreshDataTables);
  const setTableFilter = useDesktopStore((s) => s.setTableFilter);
  const setDiffFilter = useDesktopStore((s) => s.setDiffFilter);
  const setDmlFilter = useDesktopStore((s) => s.setDmlFilter);
  const setObjectTypeFilter = useDesktopStore((s) => s.setObjectTypeFilter);
  const setStmtKindFilter = useDesktopStore((s) => s.setStmtKindFilter);
  const setAspectFilter = useDesktopStore((s) => s.setAspectFilter);
  const toggleVerb = useDesktopStore((s) => s.toggleVerb);
  const selectDiff = useDesktopStore((s) => s.selectDiff);
  const setToast = useDesktopStore((s) => s.setToast);
  const toggleStar = useDesktopStore((s) => s.toggleStar);
  const refreshNodes = useDesktopStore((s) => s.refreshNodes);
  const refreshHistory = useDesktopStore((s) => s.refreshHistory);
  const runCompare = useDesktopStore((s) => s.runCompare);
  const cancelCompare = useDesktopStore((s) => s.cancelCompare);
  const removeNode = useDesktopStore((s) => s.removeNode);
  const testNode = useDesktopStore((s) => s.testNode);
  const exportDoc = useDesktopStore((s) => s.exportDoc);
  const importDoc = useDesktopStore((s) => s.importDoc);
  const importLegacy = useDesktopStore((s) => s.importLegacy);

  // 节点管理本地状态：表单 Modal + 单卡测试延迟。
  const [nodeModal, setNodeModal] = useState<{ editingId: string | null } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [latencies, setLatencies] = useState<Record<string, number>>({});

  // 首屏：经 IPC 拉节点 + 历史（失败则保留种子/空历史，离线可用）。
  useEffect(() => {
    void refreshNodes().catch(() => undefined);
    void refreshHistory().catch(() => undefined);
  }, []);

  // toast 轻提示 2.2s 自动消失（与 mock 一致）。
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  // 快捷键 ⌘/Ctrl + Enter 对比。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void runCompare();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [runCompare]);

  const kw = tableFilter.trim().toLowerCase();
  // 结构组（不含数据行，数据走独立三 Tab）。
  const structItems = useMemo(() => items.filter((it) => it.objectType !== 'data'), [items]);
  const dataItems = useMemo(() => items.filter((it) => it.objectType === 'data'), [items]);
  // R1/R3 过滤链（复制/导出与 DiffTable 行同源，复制=所见）：
  // 维度 -> 对象类型+关键字 -> 切面 -> CREATE/DROP/CHANGE Tab。
  const byDim = useMemo(
    () =>
      structItems.filter(
        (it) => stmtKindFilter === 'ALL' || (it.stmtKind ?? 'DDL') === stmtKindFilter,
      ),
    [structItems, stmtKindFilter],
  );
  const byObj = useMemo(
    () =>
      byDim.filter(
        (it) =>
          (objectTypeFilter === 'ALL' || it.objectType === objectTypeFilter) &&
          (!kw ||
            it.objectName.toLowerCase().includes(kw) ||
            it.sql.toLowerCase().includes(kw)),
      ),
    [byDim, objectTypeFilter, kw],
  );
  // INDEX chip 标签计数（切面自身不过滤，保证开关可逆可见）。
  const indexCount = useMemo(
    () => byObj.filter((it) => (it.aspects ?? []).includes('index')).length,
    [byObj],
  );
  const byAspect = useMemo(
    () => (aspectFilter === 'ALL' ? byObj : byObj.filter((it) => (it.aspects ?? []).includes(aspectFilter))),
    [byObj, aspectFilter],
  );
  const counts = useMemo(() => {
    const c: Record<DiffFilter, number> = { ALL: byAspect.length, CREATE: 0, DROP: 0, CHANGE: 0 };
    for (const it of byAspect) c[it.changeType] += 1;
    return c;
  }, [byAspect]);
  // R7 动词桶（多选 OR；空/'ALL' = 不限）：结构 + 数据两表同受约束，与维度/切面/Tab 正交 AND。
  // 计数基座取 Tab/动词过滤前的列表（同 INDEX chip 模式，保证开关可逆可见）；
  // Tab 计数（counts/dmlCounts）亦不扣减动词，对称可逆。
  const verbSet = useMemo(
    () => (verbFilter === 'ALL' ? null : new Set<Verb>(verbFilter)),
    [verbFilter],
  );
  const structVerbCounts = useMemo(() => {
    const c: Record<Verb, number> = { CREATE: 0, DROP: 0, ALTER: 0, INSERT: 0, UPDATE: 0, DELETE: 0, OTHER: 0 };
    for (const it of byAspect) c[verbOf(it.sql)] += 1;
    return c;
  }, [byAspect]);
  const dataVerbCounts = useMemo(() => {
    const c: Record<Verb, number> = { CREATE: 0, DROP: 0, ALTER: 0, INSERT: 0, UPDATE: 0, DELETE: 0, OTHER: 0 };
    for (const it of dataItems) c[verbOf(it.sql)] += 1;
    return c;
  }, [dataItems]);
  const tabItems = useMemo(
    () =>
      byAspect.filter(
        (it) =>
          (diffFilter === 'ALL' || it.changeType === diffFilter) &&
          (verbSet === null || verbSet.size === 0 || verbSet.has(verbOf(it.sql))),
      ),
    [byAspect, diffFilter, verbSet],
  );
  const dmlCounts = useMemo(() => {
    const c: Record<DmlFilter, number> = { ALL: dataItems.length, INSERT: 0, DELETE: 0, UPDATE: 0 };
    for (const it of dataItems) {
      if (it.dml) c[it.dml] += 1;
    }
    return c;
  }, [dataItems]);
  const dmlTabItems = useMemo(
    () =>
      dataItems.filter(
        (it) =>
          (dmlFilter === 'ALL' || it.dml === dmlFilter) &&
          (verbSet === null || verbSet.size === 0 || verbSet.has(verbOf(it.sql))),
      ),
    [dataItems, dmlFilter, verbSet],
  );
  const needConfirm = useMemo(
    () => dataStatus.some((t) => t.status === 'confirm-needed'),
    [dataStatus],
  );

  const aliasOf = (id: string | null): string =>
    nodes.find((n) => n.id === id)?.alias ?? 'db';

  const restoreHistory = (entry: HistoryEntry): void => {
    if (entry.aId && entry.bId) {
      const ids = new Set(nodes.map((n) => n.id));
      if (ids.has(entry.aId) && ids.has(entry.bId)) {
        setSlot('A', entry.aId);
        setSlot('B', entry.bId);
        setToast(`已恢复组合：${entry.aAlias} → ${entry.bAlias}`);
        return;
      }
    }
    setToast('该历史条目的节点已不存在，仅展示');
  };

  const status = comparing
    ? (progress || '对比中…')
    : lastComboText || `就绪 · ${items.length} 条差异`;

  const handleTestNode = (id: string): void => {
    setTestingId(id);
    void testNode(id)
      .then((r) => {
        if (r.ok) {
          setLatencies((m) => ({ ...m, [id]: r.ms }));
          const n = nodes.find((x) => x.id === id);
          setToast(`连接成功：${n?.alias ?? id}（${r.ms}ms）`);
        } else {
          setToast(`连接失败 [${r.code ?? 'UNKNOWN'}]：${r.message ?? '未知错误'}`);
        }
      })
      .catch((e: unknown) => setToast(e instanceof Error ? e.message : '测试失败'))
      .finally(() => setTestingId(null));
  };

  const handleRemoveNode = (id: string): void => {
    const n = nodes.find((x) => x.id === id);
    if (!window.confirm(`删除节点 ${n?.alias ?? id}？密钥一并删除，该操作不可撤销。`)) return;
    void removeNode(id)
      .then(() => setToast(`已删除节点：${n?.alias ?? id}`))
      .catch((e: unknown) => setToast(e instanceof Error ? e.message : '删除失败'));
  };

  const handleExport = (): void => {
    void exportDoc()
      .then((doc) => {
        downloadSqlFile(`sqldiff_nodes_${Date.now()}.json`, JSON.stringify(doc, null, 2));
        setToast(`已导出 ${doc.nodes.length} 个节点（密码已加密，无明文）`);
      })
      .catch((e: unknown) => setToast(e instanceof Error ? e.message : '导出失败'));
  };

  const handleImportFile = (file: File): void => {
    void file
      .text()
      .then((text) => importDoc(JSON.parse(text) as Parameters<typeof importDoc>[0]))
      .then((count) => setToast(`已导入 ${count} 个节点，密码免重输`))
      .catch((e: unknown) => setToast(`导入失败：${e instanceof Error ? e.message : '文件非法'}`));
  };

  const handleImportLegacy = (): void => {
    const s = window.prompt('粘贴老 CLI 连接串（user:pass@host~db#port[+sshuser:sshpass@sshhost#sshport]）');
    if (!s || !s.trim()) return;
    void importLegacy(s.trim())
      .then((m) => setToast(`已导入老连接串：${m.alias}`))
      .catch((e: unknown) => setToast(e instanceof Error ? e.message : '解析失败'));
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">S</div>
        <div className="title">
          SqlDiff 桌面版 <span className="subtitle">离线可用 · 只读对比不执行</span>
        </div>
        <div className="topbar-right">
          <span>深色智能化</span>
          <span className="dot" />
          <span>
            <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> 对比
          </span>
        </div>
      </header>

      <main className="layout">
        <NodeLibrary
          nodes={nodes}
          history={history}
          leftTab={leftTab}
          keyword={nodeKeyword}
          nodesLoading={nodesLoading}
          latencies={latencies}
          testingId={testingId}
          onTab={setLeftTab}
          onKeyword={setNodeKeyword}
          onPick={assignNode}
          onToggleStar={toggleStar}
          onRestoreHistory={restoreHistory}
          onNewNode={() => setNodeModal({ editingId: null })}
          onEditNode={(id) => setNodeModal({ editingId: id })}
          onRemoveNode={handleRemoveNode}
          onTestNode={handleTestNode}
          onExport={handleExport}
          onImportFile={handleImportFile}
          onImportLegacy={handleImportLegacy}
        />

        <section className="pane-center">
          <CompareSlots
            nodes={nodes}
            slotA={slotA}
            slotB={slotB}
            scopes={scopes}
            includeData={includeData}
            tableFilter={tableFilter}
            comparing={comparing}
            progress={progress}
            progressPct={progressPct}
            lastComboText={lastComboText}
            onDropNode={setSlot}
            onSelect={setSlot}
            onSwap={() => {
              swapSlots();
              setToast('已交换 A ⇄ B（等价老 --reverse）');
            }}
            onClear={clearSlots}
            onToggleScope={toggleScope}
            onToggleIncludeData={toggleIncludeData}
            onTableFilter={setTableFilter}
            onRun={() => void runCompare()}
            onCancel={() => void cancelCompare()}
          />
          {includeData && (
            <DataSection
              lists={dataLists}
              listsLoading={dataListsLoading}
              pairs={dataPairs}
              statusRows={dataStatus}
              needConfirm={needConfirm}
              batchRows={dataBatchRows}
              threshold={dataThreshold}
              insertBatch={dataInsertBatch}
              onLoadLists={() => void refreshDataTables()}
              onSetPairB={setDataPairB}
              onRemovePair={removeDataPair}
              onAddPair={addDataPair}
              onConfirmRerun={() => {
                setConfirmDataThreshold(true);
                void runCompare();
              }}
              onBatchRows={setDataBatchRows}
              onThreshold={setDataThreshold}
              onInsertBatch={setDataInsertBatch}
              onToast={setToast}
            />
          )}
          <DiffTable
            counts={counts}
            total={structItems.length}
            visibleCount={tabItems.length}
            rows={tabItems}
            diffFilter={diffFilter}
            objectTypeFilter={objectTypeFilter}
            stmtKindFilter={stmtKindFilter}
            aspectFilter={aspectFilter}
            indexCount={indexCount}
            verbFilter={verbFilter}
            structVerbCounts={structVerbCounts}
            dataVerbCounts={dataVerbCounts}
            onDiffFilter={setDiffFilter}
            onObjFilter={setObjectTypeFilter}
            onStmtKindFilter={setStmtKindFilter}
            onAspectFilter={setAspectFilter}
            onToggleVerb={toggleVerb}
            onSelect={selectDiff}
            selectedId={selectedId}
          />
          {stmtKindFilter !== 'DDL' && (includeData || dataItems.length > 0 || dataStatus.length > 0) && (
            <DataDiffTable
              counts={dmlCounts}
              rows={dmlTabItems}
              dmlFilter={dmlFilter}
              onDmlFilter={setDmlFilter}
              onSelect={selectDiff}
              selectedId={selectedId}
              aName={aliasOf(slotA)}
              bName={aliasOf(slotB)}
              onToast={setToast}
            />
          )}
          {stmtKindFilter === 'DML' && !includeData && dataItems.length === 0 && dataStatus.length === 0 && (
            <div className="card">
              <div className="empty">DML 为数据行差异 — 勾选「数据」并对比后在此查看 INSERT / DELETE / UPDATE 🍃</div>
            </div>
          )}
        </section>

        <SqlPreview
          tabItems={stmtKindFilter === 'DML' ? dmlTabItems : tabItems}
          extraItems={stmtKindFilter === 'DML' ? [] : dataItems}
          selectedId={selectedId}
          aName={aliasOf(slotA)}
          bName={aliasOf(slotB)}
          onToast={setToast}
        />
      </main>

      <footer className="statusbar">{status}</footer>
      {nodeModal && (
        <NodeModal
          editing={nodeModal.editingId ? (nodes.find((n) => n.id === nodeModal.editingId) ?? null) : null}
          onClose={() => setNodeModal(null)}
          onSaved={(msg) => {
            setNodeModal(null);
            setToast(msg);
          }}
        />
      )}
      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
