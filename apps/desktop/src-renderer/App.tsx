import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VERB_CHIPS, useDesktopStore, type AspectFilter, type DiffFilter, type LeftTab, type ObjectTypeFilter, type SlotId, type VerbFilter } from './store';
import type { CompareResult, CoverageReason, DataTableStatus, DiffItem, ExcludedObject, HistoryEntry, NodeMeta, ObjectType, ObjectTypeWithData, SecretBundle, StmtAspect, Verb } from '../src-core/types';
import { sanitizeIpcError } from '../src-core/ipc-error';
import { verbOf } from '../src-core/classify';
import { visibleNodes } from './node-filter';
import { buildManifest, manifestFileNames, manifestToMarkdown, serializeManifest } from '../src-core/manifest';
import { preflightFileNames, preflightToDetailMarkdown, preflightToExecutiveMarkdown, serializePreflight, getSummary } from '../src-core/preflight';
import type { PreflightReport } from '../src-core/preflight-types';
import type { DataTableLists, DBeaverExportResult, DatagripExportResult, NodeCreateInput, SqlDiffApi } from '../src-main/preload';
import {
  buildExportText,
  copyText,
  exportSavedMessage,
  highlightSql,
  saveTextFile,
  saveTextFiles,
} from './sql';
import {
  draftToNodeInput,
  LEGACY_EXAMPLE,
  parseLegacyToDraft,
  validateDraft,
  type LegacyDraft,
} from './legacy-import';
import { aspectScopeFor, countAspects, pruneAspectFilter } from '../src-core/compare-filter';

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
  { value: 'all', label: '全部' },
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

/** R4 对象 chips（多选含数据行；组内 OR、组间 AND；复制/导出与单表行同源）。 */
const OBJ_CHIPS: Array<{ value: ObjectTypeWithData; label: string }> = [
  { value: 'table', label: '表' },
  { value: 'view', label: '视图' },
  { value: 'procedure', label: '过程' },
  { value: 'function', label: '函数' },
  { value: 'data', label: '数据' },
];

import { hasMoreRows, nextWindowLimit, ROW_WINDOW, windowRows } from './row-window';

/** 关键字重计算的 debounce 间隔（ms）。输入框本身不延迟，只延迟过滤链。 */
const KEYWORD_DEBOUNCE_MS = 200;

/**
 * SQL 预览面板渲染的最多条数。实测：ALL Tab 未选行时 current=3135 条，
 * highlightSql 全量 tokenize 后注入 <pre> 产生 35,578 个 DOM 节点
 * （18,772 tok-kw + 11,446 tok- + 3,140 tok-cmt + 2,220 tok-num），
 * 是 DROP→全部 3.0s、关键字输入 1.6s 的真正瓶颈（远超差异表本身）。
 * 限量 30 条兼顾「预览够看」与「DOM 控制在约 1k 节点」；复制/导出仍基于全量。
 */
const SQL_PREVIEW_CAP = 30;

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
  onExportDbeaver,
  onExportDatagrip,
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
  onExportDbeaver: () => void;
  onExportDatagrip: () => void;
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
          title="选择节点并导出为 DBeaver data-sources JSON（不迁移秘密）"
          disabled={nodesLoading || nodes.length === 0}
          onClick={onExportDbeaver}
        >
          DBeaver
        </button>
        <button
          className="link-btn"
          title="选择节点并导出为 DataGrip 三件套 XML（不迁移秘密）"
          disabled={nodesLoading || nodes.length === 0}
          onClick={onExportDatagrip}
        >
          DataGrip
        </button>
        <button
          className="link-btn"
          title="从导出的 JSON 导入恢复（免重输密码）"
          onClick={() => fileRef.current?.click()}
        >
          导入
        </button>
        <button
          className="link-btn"
          title="从老 CLI 连接串导入节点（格式：用户名:密码@主机~库名#端口，可选 +SSH段）"
          onClick={onImportLegacy}
        >
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
              {leftTab === 'mine'
                ? '暂无收藏 — 点击卡片上的 ☆ 收藏到我的'
                : leftTab === 'fav'
                  ? '暂无常用节点 — 多对比几次或点右上角 ＋ 新增'
                  : '暂无节点 — 点右上角 ＋ 新增'}
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
  aspectFilter,
  aspectScope,
  aspectCounts,
  objCounts,
  verbFilter,
  verbCounts,
  onDiffFilter,
  onObjFilter,
  onToggleObj,
  onToggleAspect,
  onAspectFilter,
  onVerbFilter,
  onToggleVerb,
  onSelect,
  selectedId,
  onExportManifest,
  canExportManifest,
  onRunPreflight,
  canRunPreflight,
  preflightRunning,
  lastPreflightResult,
  onExportPreflight,
}: {
  counts: Record<DiffFilter, number>;
  total: number;
  visibleCount: number;
  rows: DiffItem[];
  diffFilter: DiffFilter;
  /** R4 对象多选（含数据；'ALL' = 不限，组内 OR）。 */
  objectTypeFilter: ObjectTypeFilter;
  /** R4 切面多选；'ALL' = 不限，组内 OR。 */
  aspectFilter: AspectFilter;
  /** 当前 Tab 的切面子标签集（null = 该 Tab 不分子标签，即 ALL / CREATE）。 */
  aspectScope: { value: StmtAspect; label: string }[] | null;
  /** 当前 Tab 内各切面的语句数（子标签标签用，不过滤自身）。 */
  aspectCounts: Record<StmtAspect, number>;
  /** 对象 chip 计数基座（对象自身不过滤，保证开关可逆可见）。 */
  objCounts: Record<ObjectTypeWithData, number>;
  /** R7 动词桶选择（'ALL' = 不限；多选 OR，组间与对象/切面/Tab 正交 AND）。 */
  verbFilter: VerbFilter;
  /** 动词计数基座（Tab/动词自身不过滤，保证开关可逆可见）。 */
  verbCounts: Record<Verb, number>;
  onDiffFilter: (f: DiffFilter) => void;
  onObjFilter: (f: ObjectTypeFilter) => void;
  onToggleObj: (o: ObjectTypeWithData) => void;
  onToggleAspect: (a: StmtAspect) => void;
  /** 切面「全部」按钮：清空切面选择（aspectFilter = 'ALL'），与对象/动词行「全部」一致。 */
  onAspectFilter: (f: AspectFilter) => void;
  /** 动词「全部」按钮：清空动词桶选择（verbFilter = 'ALL'），与对象行「全部」一致。 */
  onVerbFilter: (f: VerbFilter) => void;
  onToggleVerb: (v: Verb) => void;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
  /** 审查报告导出入口（仅真实比较可用）。 */
  onExportManifest?: () => void;
  canExportManifest?: boolean;
  /** Preflight 运行入口（仅真实比较可用）。 */
  onRunPreflight?: () => void;
  canRunPreflight?: boolean;
  preflightRunning?: boolean;
  lastPreflightResult?: PreflightReport | null;
  onExportPreflight?: () => void;
}) {
  const isObjOn = (o: ObjectTypeWithData): boolean =>
    objectTypeFilter !== 'ALL' && objectTypeFilter.includes(o);
  const isAspectOn = (a: StmtAspect): boolean =>
    aspectFilter !== 'ALL' && aspectFilter.includes(a);
  const isVerbOn = (v: Verb): boolean => verbFilter !== 'ALL' && verbFilter.includes(v);

  // 渲染窗口：全量渲染 3000+ 行会产生 5 万+ DOM 节点（实测 3135 行 → 57,673 元素），
  // 单次筛选实测阻塞主线程约 3s。这里只渲染前 N 行，滚到底自动加页。
  // 窗口计算已抽为 row-window.ts 纯函数并单测，避免逻辑埋在组件里无从验证。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [limit, setLimit] = useState(ROW_WINDOW);
  const shownRows = useMemo(() => windowRows(rows, limit), [rows, limit]);
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const next = nextWindowLimit({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }, limit, rows.length);
    if (next !== limit) setLimit(next);
  }, [limit, rows.length]);
  // 过滤结果变化 -> 回到第一页并复位滚动位置（否则用户停在原滚动偏移，看到的是不相干的中段内容）。
  // 只依赖 rows 的引用：任一筛选维度变化都会产生新数组，但滚动加页只改 limit，不会触发。
  useEffect(() => {
    setLimit(ROW_WINDOW);
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [rows]);

  return (
    <div className="card diff-card">
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
        {onExportManifest && (
          <button
            className="btn btn-sm"
            disabled={!canExportManifest}
            onClick={onExportManifest}
            title={
              canExportManifest
                ? '导出当前真实比较的审查报告（JSON + Markdown，无秘密、数据行值已脱敏）'
                : '仅真实比较可导出审查报告'
            }
          >
            导出审查报告
          </button>
        )}
        {onRunPreflight && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canRunPreflight}
            onClick={onRunPreflight}
            title={
              canRunPreflight
                ? '对已 diff 出的表级 DDL 跑只读 Preflight 检查（版本 / 表规模 / 复制延迟 / 权限盲区 / Online DDL 算法）'
                : '仅真实比较（非 demo、非比对中）且至少含 1 条表级 DDL 项可运行 Preflight'
            }
          >
            {preflightRunning ? 'Preflight 运行中…' : '运行 Preflight'}
          </button>
        )}
      </div>
      {lastPreflightResult && (
        <div
          className={`preflight-verdict preflight-verdict-${getSummary(lastPreflightResult).decision.toLowerCase()}`}
          role="status"
          aria-live="polite"
        >
          <strong>{getSummary(lastPreflightResult).decision}</strong>
          <span>
            · {lastPreflightResult.verdict.blocking} blocking / {lastPreflightResult.verdict.warnings} warnings / {lastPreflightResult.verdict.unknowns} unknowns
          </span>
          {onExportPreflight && (
            <button
              type="button"
              className="btn btn-sm preflight-export-btn"
              onClick={onExportPreflight}
              title="导出 Preflight 报告（JSON + Markdown，无秘密、无行值）"
            >
              导出 Preflight 报告
            </button>
          )}
        </div>
      )}
      {/* 切面子标签：仅 DROP / CHANGE Tab 出现，按 Tab 作用域限定。
        紧贴 Tab 行、用左色条表达从属关系。计数基座是 byTab（不含切面自身过滤），
        因此数字回答「点了会得到几条」。计数为 0 时显示但禁用——隐藏会让用户以为漏了功能。 */}
      {aspectScope && (
        <div
          className="obj-filters obj-filters-subtab"
          title={`「${diffFilter}」内的语句按改动对象分类。切换上方 Tab 会自动清理该 Tab 不适用的选择。`}
        >
          <button
            className={aspectFilter === 'ALL' ? 'chip active' : 'chip'}
            title={`「${diffFilter}」内的全部切面（不限）`}
            onClick={() => onAspectFilter('ALL')}
          >
            全部
          </button>
          {aspectScope.map((f) => (
            <button
              key={f.value}
              className={isAspectOn(f.value) ? 'chip active' : 'chip'}
              title={`仅看 ${diffFilter} 中的${f.label}类语句`}
              // 计数为 0 的子标签禁用，但**已选中的必须保持可点**：
              // 否则会出现「active + disabled」的困局——结果为空、chip 点不动、
              // 用户既看不到原因也退不出（切换 Tab 前）。实测 CHANGE 的「主键 (0)」
              // 正是这种情形：CHANGE 侧确实没有主键变更，但选择仍需可撤销。
              disabled={aspectCounts[f.value] === 0 && !isAspectOn(f.value)}
              onClick={() => onToggleAspect(f.value)}
            >
              {f.label} ({aspectCounts[f.value]})
            </button>
          ))}
        </div>
      )}
      <div className="obj-filters" title="按对象类型过滤（多选含数据行；与动词/切面/Tab/关键字正交 AND；复制=所见）">
        <button
          className={objectTypeFilter === 'ALL' ? 'chip active' : 'chip'}
          onClick={() => onObjFilter('ALL')}
        >
          全部
        </button>
        {OBJ_CHIPS.map((f) => (
          <button
            key={f.value}
            className={isObjOn(f.value) ? 'chip active' : 'chip'}
            title={`只看${f.label}（当前 ${objCounts[f.value]} 条）`}
            onClick={() => onToggleObj(f.value)}
          >
            {f.label} ({objCounts[f.value]})
          </button>
        ))}
      </div>
      <div className="obj-filters" title="按语句首动词过滤（CREATE/DROP/ALTER/INSERT/UPDATE/DELETE 多选；与对象/切面/Tab/关键字正交 AND；复制=所见）。与上方 Tab 的区别：Tab 看整条 SQL 的变更结果（CREATE/DROP/CHANGE），此处只看首关键字 —— 如 CREATE OR REPLACE 视图变更归 Tab CHANGE + 动词 CREATE。">
        <button
          className={verbFilter === 'ALL' ? 'chip active' : 'chip'}
          onClick={() => onVerbFilter('ALL')}
        >
          全部
        </button>
        {VERB_CHIPS.map((v) => (
          <button
            key={v}
            className={isVerbOn(v) ? 'chip active' : 'chip'}
            title={`只看 ${v} 开头语句（当前 ${verbCounts[v]} 条）`}
            onClick={() => onToggleVerb(v)}
          >
            {v} ({verbCounts[v]})
          </button>
        ))}
      </div>
      <div className="diff-scroll" ref={scrollRef} onScroll={handleScroll}>
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
            {shownRows.map((r) => (
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
        {/* 渲染窗口：全量渲染 3000+ 行会产生 5 万+ DOM 节点，实测单次筛选阻塞主线程约 3s。
            这里只渲染窗口，滚到底自动加页；过滤结果变化时回到第一页并复位滚动。 */}
        {hasMoreRows(shownRows.length, rows.length) && (
          <div className="diff-more">
            已显示 {shownRows.length} / 共 {rows.length} 条 —— 继续下拉自动加载
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 数据对比：表映射 + 逐表状态 + 独立 INSERT/DELETE/UPDATE 三 Tab
// ---------------------------------------------------------------------------

const OBJECT_TYPE_LABEL: Record<ObjectType, string> = {
  table: '表',
  view: '视图',
  procedure: '过程',
  function: '函数',
};

/** 覆盖原因码的中文短文案（原因码来自 src-core/types，原因文本只在界面这一处维护）。 */
function coverageReasonText(r: CoverageReason): string {
  if (r === 'permission-denied') return '权限不足';
  if (r === 'object-missing') return '对象已不存在';
  if (r === 'aborted') return '已取消';
  return '未知原因';
}

/**
 * 被排除对象的哪一侧可见（ExcludedObject.side 的中文）。
 * 反直觉但必须直说：可见的那一侧正是「本该进入比较、却因另一侧授权不足拿不到」的一侧。
 */
function excludedSideText(s: ExcludedObject): string {
  return s.side === 'b-only' ? '仅 B 侧可见' : '仅 A 侧可见';
}

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
  /** 选中回退（单表已含数据行，默认空；保留参数兼容旧调用）。 */
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

  // 预览只渲染前 N 条：未选行时 current=tabItems（ALL Tab 下 3135 条），
  // 全量 highlightSql 会产生 35k+ DOM 节点（实测瓶颈）。选中单行时 current=[selected]，无需限量。
  // 复制/导出按需在 handler 里算全量，不再每按键重建 3135 条 SQL 文本。
  const previewCapped = !selected && tabItems.length > SQL_PREVIEW_CAP;
  const previewText = useMemo(
    () => buildExportText(selected ? [selected] : tabItems.slice(0, SQL_PREVIEW_CAP), { aName, bName, at: new Date().toISOString() }),
    // selected 由 tabItems + selectedId 派生，依赖这两者即可。
    [tabItems, selectedId, selected, aName, bName],
  );
  const highlighted = useMemo(() => highlightSql(previewText), [previewText]);

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
    // 按需算全量：预览已限量，复制必须含全部 current。
    const fullText = buildExportText(current, { aName, bName, at: new Date().toISOString() });
    const ok = await copyText(fullText);
    onToast(ok ? `已复制 ${current.length} 条 SQL 到剪贴板` : '复制失败：无剪贴板权限');
  };

  const handleExport = async (): Promise<void> => {
    if (current.length === 0) {
      onToast('暂无可导出 SQL');
      return;
    }
    try {
      // 按需算全量：导出含全部 current，与预览限量无关。
      const fullText = buildExportText(current, { aName, bName, at: new Date().toISOString() });
      const outcome = await saveTextFile(
        `sqldiff_${Date.now()}.sql`,
        fullText,
        '导出 SqlDiff SQL',
      );
      if (outcome.status === 'canceled') return;
      const prefix = `已导出 .sql（顺序 DROP→CREATE→CHANGE，共 ${current.length} 条）`;
      onToast(
        outcome.status === 'saved'
          ? exportSavedMessage(prefix, outcome.filePath)
          : `${prefix}（当前为预览模式，文件由浏览器下载）`,
      );
    } catch (e) {
      onToast(`导出失败：${sanitizeIpcError(e)}`);
    }
  };

  return (
    <aside className="card pane-right">
      <div className="pane-head">
        <h2>SQL 预览</h2>
        <div className="pane-head-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void handleCopy()}>
            {selected ? '⧉ 复制单条' : `⧉ 复制当前Tab（${current.length}条）`}
          </button>
          <button className="btn btn-sm" onClick={() => void handleExport()}>
            导出 .sql
          </button>
        </div>
      </div>
      <div className="sql-mode">
        {selected
          ? `· 单条：${selected.objectName}`
          : previewCapped
            ? `· 前 ${SQL_PREVIEW_CAP} 条预览（共 ${current.length} 条，复制 / 导出仍含全部）`
            : `· 当前Tab全部（${current.length}条）`}
      </div>
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
// 节点导出弹窗：DBeaver JSON / DataGrip XML，共享选择流程与无秘密迁移提示
// ---------------------------------------------------------------------------

type NodeExportTarget = 'dbeaver' | 'datagrip';
type NodeExportOutcome =
  | { kind: 'dbeaver'; result: DBeaverExportResult; paths: string[] | null }
  | { kind: 'datagrip'; result: DatagripExportResult; paths: string[] | null };

function ExportModal({
  target,
  nodes,
  onClose,
  onExported,
}: {
  target: NodeExportTarget;
  nodes: NodeMeta[];
  onClose: () => void;
  onExported: (outcome: NodeExportOutcome) => void;
}) {
  const exportDbeaver = useDesktopStore((s) => s.exportDbeaver);
  const exportDatagrip = useDesktopStore((s) => s.exportDatagrip);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(nodes.map((node) => node.id)));
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCount = selectedIds.size;

  const toggleNode = (id: string): void => {
    setError(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = (): void => {
    setError(null);
    setSelectedIds(new Set(nodes.map((node) => node.id)));
  };

  const selectNone = (): void => {
    setError(null);
    setSelectedIds(new Set());
  };

  // 按目标切换的文案与文件提示；结构与按钮保持同一套。
  const title = target === 'dbeaver' ? 'DBeaver' : 'DataGrip';
  const bannerText =
    target === 'dbeaver'
      ? '不会迁移密码/私钥，导入后需重新输入。私钥认证节点还需在 DBeaver 中重新选择密钥。'
      : '导出不会迁移密码、私钥或 passphrase；导入后需在 DataGrip 中重新输入。私钥认证节点还需在 DataGrip 中重新选择密钥。';
  const sshKeyWarning =
    target === 'dbeaver' ? '待补 SSH 私钥' : '待补 SSH 私钥（DataGrip 中重新选择）';
  const fileHint =
    target === 'dbeaver'
      ? '文件：data-sources-sqldiff.json'
      : '文件：dataSources.xml · dataSources.local.xml · sshConfigs.xml（按需）';

  const handleExport = async (): Promise<void> => {
    if (selectedCount === 0) {
      setError('请至少选择一个节点');
      return;
    }
    setExporting(true);
    setError(null);
    try {
      // 两个目标都统一走 saveTextFiles（bundle 通道）；
      // DBeaver 单文件也套 bundle，保持与多文件同一路径（Stage 2 遗留项）。
      let outcome: NodeExportOutcome;
      let saveStatus: 'saved' | 'canceled' | 'fallback' = 'fallback';
      if (target === 'dbeaver') {
        const result = await exportDbeaver([...selectedIds]);
        const save = await saveTextFiles(
          [{ name: result.fileName, content: result.content }],
          '导出 DBeaver 连接配置',
        );
        saveStatus = save.status;
        outcome = {
          kind: 'dbeaver',
          result,
          paths: save.status === 'saved' ? save.filePaths : null,
        };
      } else {
        const result = await exportDatagrip([...selectedIds]);
        const save = await saveTextFiles(
          result.files.map((f) => ({ name: f.fileName, content: f.content })),
          '导出 DataGrip 三件套 XML',
        );
        saveStatus = save.status;
        outcome = {
          kind: 'datagrip',
          result,
          paths: save.status === 'saved' ? save.filePaths : null,
        };
      }
      setExporting(false);
      // 取消保存 = 用户主动放弃，弹窗保留已选节点以便重试（与系统另存为的行为一致）。
      if (saveStatus === 'canceled') {
        setError('已取消导出，未写入文件');
        return;
      }
      onExported(outcome);
      onClose();
    } catch (e) {
      setExporting(false);
      setError(sanitizeIpcError(e));
    }
  };

  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget && !exporting) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label={`导出到 ${title}`}>
        <div className="modal-title">导出到 {title}</div>
        <div className="dbeaver-export-warning">{bannerText}</div>
        <div className="dbeaver-select-actions">
          <span>已选 {selectedCount} / {nodes.length}</span>
          <span className="dbeaver-select-buttons">
            <button className="mini-btn" disabled={exporting || nodes.length === 0} onClick={selectAll}>
              全选
            </button>
            <button className="mini-btn" disabled={exporting || selectedCount === 0} onClick={selectNone}>
              全不选
            </button>
          </span>
        </div>
        <div className="dbeaver-node-list">
          {nodes.map((node) => (
            <label className="dbeaver-node-option" key={node.id}>
              <input
                type="checkbox"
                checked={selectedIds.has(node.id)}
                disabled={exporting}
                onChange={() => toggleNode(node.id)}
              />
              <span className="dbeaver-node-main">
                <span>{node.alias}</span>
                <span className="mono">{node.host}:{node.port} / {node.database}</span>
              </span>
              {node.ssh.enabled && node.ssh.authType === 'privateKey' && (
                <span className="dbeaver-node-warning">{sshKeyWarning}</span>
              )}
            </label>
          ))}
          {nodes.length === 0 && <div className="empty">暂无可导出的节点</div>}
        </div>
        {error && <div className="form-err">{error}</div>}
        <div className="modal-actions">
          <span className="form-hint">{fileHint}</span>
          <span className="modal-actions-right">
            <button className="btn btn-ghost" disabled={exporting} onClick={onClose}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={exporting || selectedCount === 0}
              onClick={() => void handleExport()}
            >
              {exporting ? '导出中…' : `导出 ${selectedCount} 个节点`}
            </button>
          </span>
        </div>
      </div>
    </div>
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
      setTestMsg(sanitizeIpcError(e));
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
      setErr(sanitizeIpcError(e));
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

/**
 * 老 CLI 连接串导入弹窗（粘贴 → 可纠正字段 → 结构化入库）。
 *
 * 为什么不直接用 window.prompt：Electron 下 prompt 抛异常且无人捕获（实测确认），
 * 表现为「点了没反应」。
 *
 * 为什么解析结果要可编辑：老串用分隔符编码，而密码是任意字符，两者本质冲突
 * （实测：密码含 @ ~ # 能还原，含 + 必失败）。既然解析不可靠，就让用户来裁决——
 * 最终按结构化字段入库，不再让分隔符规则做第二次切割。
 */
function LegacyImportModal({ onClose, onImported }: { onClose: () => void; onImported: (msg: string) => void }) {
  const saveNode = useDesktopStore((s) => s.saveNode);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<LegacyDraft | null>(null);
  const [risks, setRisks] = useState<string[]>([]);
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const draftErrs = useMemo(() => (draft ? validateDraft(draft) : []), [draft]);
  const set = <K extends keyof LegacyDraft>(k: K, v: LegacyDraft[K]): void =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const handleParse = (raw: string): void => {
    setText(raw);
    setErr(null);
    if (!raw.trim()) {
      setDraft(null);
      setRisks([]);
      setParseMsg(null);
      return;
    }
    const p = parseLegacyToDraft(raw);
    if (p.level === 'error') {
      // 切不出草稿也给一个空表单，用户总能手填，不被卡死。
      setDraft(null);
      setRisks([]);
      setParseMsg(p.message);
      return;
    }
    setDraft(p.draft);
    setRisks(p.level === 'warn' ? p.risks : []);
    setParseMsg(null);
  };

  const handleImport = async (): Promise<void> => {
    if (!draft) {
      setErr('请先粘贴连接串，或点「填入示例」看看格式');
      return;
    }
    const invalid = validateDraft(draft);
    if (invalid.length > 0) {
      setErr(invalid.join('；'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const m = await saveNode(draftToNodeInput(draft) as NodeCreateInput);
      onImported(`已导入老连接串：${m.alias}`);
    } catch (e) {
      setErr(sanitizeIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal modal-wide" role="dialog" aria-label="从老 CLI 连接串导入">
        <div className="modal-title">从老 CLI 连接串导入</div>
        <div className="form-grid">
          <div className="legacy-intro">
            <p>
              从命令行工具（老 mysqldiff）里复制一条连接串，粘到下面即可生成一个节点，<b>免去手填表单</b>。
            </p>
            <p>
              粘贴后会<b>自动拆成下面的字段，可以随意修改</b>——密码里有 <code>@</code> 等特殊符号时，
              请以你实际填写的内容为准。
            </p>
          </div>

          <div className="legacy-format">
            <div className="legacy-format-title">格式</div>
            <code className="legacy-format-code">用户名:密码@主机~库名#端口</code>
            <code className="legacy-format-code">+ssh用户名:ssh密码@ssh主机#ssh端口</code>
            <ul className="legacy-format-rules">
              <li><code>:</code> 分隔用户名与密码</li>
              <li><code>@</code> 之后是主机</li>
              <li><code>~</code> 之后是数据库名</li>
              <li><code>#</code> 之后是端口，可省略（默认 3306）</li>
              <li><code>+</code> 之后是 SSH 跳板段，<b>不需要跳板就整段省略</b>（SSH 端口默认 22）</li>
            </ul>
          </div>

          <label className="form-row">
            <span>连接串</span>
            <input
              className="form-input mono"
              value={text}
              onChange={(e) => handleParse(e.target.value)}
              placeholder="appuser:secret@10.0.0.8~shop#3306"
              autoFocus
            />
          </label>

          <div className="legacy-preview-row">
            <button className="btn btn-ghost btn-sm" onClick={() => handleParse(LEGACY_EXAMPLE)}>
              填入示例
            </button>
          </div>

          {parseMsg && (
            <div className="legacy-preview warn">
              <div>⚠ {parseMsg}</div>
            </div>
          )}

          {risks.length > 0 && (
            <div className="legacy-preview warn">
              <div><b>请核对下面的字段是否正确</b></div>
              {risks.map((r) => <div key={r}>· {r}</div>)}
            </div>
          )}

          {draft && (
            <div className="legacy-fields">
              <div className="legacy-fields-title">确认字段（可直接修改）</div>
              <label className="form-row">
                <span>别名</span>
                <input className="form-input" value={draft.alias} onChange={(e) => set('alias', e.target.value)} />
              </label>
              <label className="form-row">
                <span>主机</span>
                <input className="form-input mono" value={draft.host} onChange={(e) => set('host', e.target.value)} />
              </label>
              <label className="form-row">
                <span>端口</span>
                <input className="form-input mono" value={draft.port} onChange={(e) => set('port', e.target.value)} />
              </label>
              <label className="form-row">
                <span>用户名</span>
                <input className="form-input" value={draft.user} onChange={(e) => set('user', e.target.value)} />
              </label>
              <label className="form-row">
                <span>密码</span>
                <input
                  className="form-input mono"
                  type="password"
                  value={draft.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder="可留空，之后再补"
                />
              </label>
              <label className="form-row">
                <span>库名</span>
                <input className="form-input mono" value={draft.database} onChange={(e) => set('database', e.target.value)} />
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={draft.sshEnabled}
                  onChange={(e) => set('sshEnabled', e.target.checked)}
                />
                走 SSH 跳板
              </label>
              {draft.sshEnabled && (
                <>
                  <label className="form-row">
                    <span>跳板主机</span>
                    <input className="form-input mono" value={draft.sshHost} onChange={(e) => set('sshHost', e.target.value)} />
                  </label>
                  <label className="form-row">
                    <span>跳板端口</span>
                    <input className="form-input mono" value={draft.sshPort} onChange={(e) => set('sshPort', e.target.value)} />
                  </label>
                  <label className="form-row">
                    <span>SSH 用户名</span>
                    <input className="form-input" value={draft.sshUser} onChange={(e) => set('sshUser', e.target.value)} />
                  </label>
                  <label className="form-row">
                    <span>SSH 密码</span>
                    <input
                      className="form-input mono"
                      type="password"
                      value={draft.sshPassword}
                      onChange={(e) => set('sshPassword', e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          )}

          {err && <div className="form-err">{err}</div>}

          <div className="modal-actions">
            <span className="modal-actions-right">
              <button className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>
              <button
                className="btn btn-primary"
                disabled={busy || !draft || draftErrs.length > 0}
                onClick={() => void handleImport()}
              >
                {busy ? '导入中…' : '导入'}
              </button>
            </span>
          </div>
          <p className="form-hint">
            密码会加密进系统钥匙串，nodes.json 只存元数据。密码含 <code>@</code> <code>~</code> <code>#</code> 时可能被切错位，
            建议改用「＋ 新增」手填表单。
          </p>
        </div>
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
  const objectTypeFilter = useDesktopStore((s) => s.objectTypeFilter);
  const aspectFilter = useDesktopStore((s) => s.aspectFilter);
  const verbFilter = useDesktopStore((s) => s.verbFilter);
  const items = useDesktopStore((s) => s.items);
  const selectedId = useDesktopStore((s) => s.selectedId);
  const stats = useDesktopStore((s) => s.stats);
  const lastCompareRequest = useDesktopStore((s) => s.lastCompareRequest);
  const comparing = useDesktopStore((s) => s.comparing);
  const progress = useDesktopStore((s) => s.progress);
  const progressPct = useDesktopStore((s) => s.progressPct);
  const lastComboText = useDesktopStore((s) => s.lastComboText);
  const resultSource = useDesktopStore((s) => s.resultSource);
  const coverage = useDesktopStore((s) => s.coverage);
  const visibility = useDesktopStore((s) => s.visibility);
  const resultError = useDesktopStore((s) => s.resultError);
  const toast = useDesktopStore((s) => s.toast);
  const lastPreflightResult = useDesktopStore((s) => s.lastPreflightResult);
  const preflightRunning = useDesktopStore((s) => s.preflightRunning);

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
  const setObjectTypeFilter = useDesktopStore((s) => s.setObjectTypeFilter);
  const toggleObjectType = useDesktopStore((s) => s.toggleObjectType);
  const toggleAspect = useDesktopStore((s) => s.toggleAspect);
  const setAspectFilter = useDesktopStore((s) => s.setAspectFilter);
  const setVerbFilter = useDesktopStore((s) => s.setVerbFilter);
  const toggleVerb = useDesktopStore((s) => s.toggleVerb);
  const selectDiff = useDesktopStore((s) => s.selectDiff);
  const setToast = useDesktopStore((s) => s.setToast);
  const toggleStar = useDesktopStore((s) => s.toggleStar);
  const refreshNodes = useDesktopStore((s) => s.refreshNodes);
  const refreshHistory = useDesktopStore((s) => s.refreshHistory);
  const runCompare = useDesktopStore((s) => s.runCompare);
  const cancelCompare = useDesktopStore((s) => s.cancelCompare);
  const runPreflight = useDesktopStore((s) => s.runPreflight);
  const removeNode = useDesktopStore((s) => s.removeNode);
  const testNode = useDesktopStore((s) => s.testNode);
  const exportDoc = useDesktopStore((s) => s.exportDoc);
  const importDoc = useDesktopStore((s) => s.importDoc);

  // 节点管理本地状态：表单 Modal + 导出 Modal（DBeaver/DataGrip）+ 老串导入 Modal + 单卡测试延迟。
  const [nodeModal, setNodeModal] = useState<{ editingId: string | null } | null>(null);
  const [exportTarget, setExportTarget] = useState<NodeExportTarget | null>(null);
  const [legacyImportOpen, setLegacyImportOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [latencies, setLatencies] = useState<Record<string, number>>({});
  // 覆盖明细展开态：renderer-only UI 状态（state-management.md：不进 Zustand）。
  const [coverageOpen, setCoverageOpen] = useState(false);
  // 授权盲区明细展开态：同为 renderer-only UI 状态（与覆盖明细分开，两张卡各自开合）。
  const [visibilityOpen, setVisibilityOpen] = useState(false);

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

  // 关键字过滤做 debounce：输入框保持即时响应，只延迟这条重计算链。
  // 刻意不在输入端 debounce——tableFilter 同时会传给 compare.run，
  // 那里若被延迟，按 ⌘/Ctrl+Enter 可能用到旧值去查表。
  const [kwNow, setKwNow] = useState(tableFilter);
  useEffect(() => {
    const t = setTimeout(() => setKwNow(tableFilter), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [tableFilter]);
  const kw = kwNow.trim().toLowerCase();
  // 检索键预计算：原先每次按键都对全量 items 的 objectName/sql 做 toLowerCase()，
  // 3135 条 × KB 级 SQL ≈ 每按键数 MB 字符串分配。改为 items 变化时算一次。
  // 内存代价：多存一份小写副本（约数 MB），换取按键 O(n) 的 includes。
  // 只有表与数据行参与关键字（与 fetchMetadata/postFilterResult 语义一致），故只索引这两类。
  const searchIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) {
      if (it.objectType !== 'table' && it.objectType !== 'data') continue;
      m.set(it.id, `${it.objectName}\n${it.sql}`.toLowerCase());
    }
    return m;
  }, [items]);
  // R4 单表统一过滤链（结构 + 数据同表，复制/导出与 DiffTable 行同源，复制=所见）：
  // 关键字（仅作用于表 + 数据行）→ 对象（多选 OR）→ 切面（多选 OR）→ CREATE/DROP/CHANGE Tab + 动词（多选 OR）；组间 AND。
  const byKw = useMemo(
    () =>
      kw
        ? items.filter((it) => {
            if (it.objectType !== 'table' && it.objectType !== 'data') return true;
            return searchIndex.get(it.id)?.includes(kw) ?? true;
          })
        : items,
    [items, kw, searchIndex],
  );
  const objSet = useMemo(
    () => (objectTypeFilter === 'ALL' ? null : new Set<ObjectTypeWithData>(objectTypeFilter)),
    [objectTypeFilter],
  );
  const byObj = useMemo(
    () =>
      objSet === null || objSet.size === 0 ? byKw : byKw.filter((it) => objSet.has(it.objectType)),
    [byKw, objSet],
  );
  // 对象 chip 计数基座（对象自身不过滤，保证开关可逆可见）。
  const objCounts = useMemo(() => {
    const c: Record<ObjectTypeWithData, number> = {
      table: 0,
      view: 0,
      procedure: 0,
      function: 0,
      data: 0,
    };
    for (const it of byKw) c[it.objectType] += 1;
    return c;
  }, [byKw]);
  const aspSet = useMemo(
    () => (aspectFilter === 'ALL' ? null : new Set<StmtAspect>(aspectFilter)),
    [aspectFilter],
  );
  const byAspect = useMemo(
    () =>
      aspSet === null || aspSet.size === 0
        ? byObj
        : byObj.filter((it) => (it.aspects ?? []).some((a) => aspSet.has(a))),
    [byObj, aspSet],
  );
  // 切面子标签：仅 DROP / CHANGE Tab 出现（ALL / CREATE 不细分）。
  const aspectScope = useMemo(() => aspectScopeFor(diffFilter), [diffFilter]);
  // 子标签计数基座 = 已按 Tab 收窄、但**尚未按切面收窄**的列表（故取自 byObj 而非 byAspect）。
  // 若误用 byAspect，计数会包含切面过滤自身：选中「表」后其余切面全变 0 → 全部 disabled →
  // 多选 OR 直接失效（用户无法再叠加第二个切面）。这正是 AC4 要求「不以自身为基数」。
  const byTab = useMemo(
    () =>
      diffFilter === 'ALL' ? byObj : byObj.filter((it) => it.changeType === diffFilter),
    [byObj, diffFilter],
  );
  const aspectCounts = useMemo(() => countAspects(byTab), [byTab]);
  const counts = useMemo(() => {
    const c: Record<DiffFilter, number> = { ALL: byAspect.length, CREATE: 0, DROP: 0, CHANGE: 0 };
    for (const it of byAspect) c[it.changeType] += 1;
    return c;
  }, [byAspect]);
  // R7 动词桶（多选 OR；空/'ALL' = 不限）：单表统一约束，与对象/切面/Tab 正交 AND。
  // 计数基座取 Tab/动词过滤前的列表（同 INDEX chip 模式，保证开关可逆可见）；
  // Tab 计数（counts）亦不扣减动词，对称可逆。
  const verbSet = useMemo(
    () => (verbFilter === 'ALL' ? null : new Set<Verb>(verbFilter)),
    [verbFilter],
  );
  const verbCounts = useMemo(() => {
    const c: Record<Verb, number> = { CREATE: 0, DROP: 0, ALTER: 0, INSERT: 0, UPDATE: 0, DELETE: 0, OTHER: 0 };
    for (const it of byAspect) c[verbOf(it.sql)] += 1;
    return c;
  }, [byAspect]);
  const tabItems = useMemo(
    () =>
      byAspect.filter(
        (it) =>
          (diffFilter === 'ALL' || it.changeType === diffFilter) &&
          (verbSet === null || verbSet.size === 0 || verbSet.has(verbOf(it.sql))),
      ),
    [byAspect, diffFilter, verbSet],
  );
  // DML 空提示条用（数据行已并入主表，此处仅判空指引勾选「数据」）。
  const dataItems = useMemo(() => items.filter((it) => it.objectType === 'data'), [items]);
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

  // 覆盖跳过计数：仅在存在未检查对象时出现；全部成功时界面保持安静。
  const skippedCount = (coverage?.skipped.length ?? 0);
  // 授权盲区（比较范围）提示：excluded 非空 → 有对象因授权未参与比较；
  // reliable=false → 连"是否完整"都无法证明，措辞必须更强（绝不暗示范围已完整）。
  // 两者都不成立（excluded 为空且判据可靠）→ 不渲染任何提示位，界面保持安静。
  const visExcludedCount = visibility?.excluded.length ?? 0;
  const visUnreliable = visibility != null && !visibility.reliable;
  const visShow = visibility != null && (visExcludedCount > 0 || visUnreliable);
  const visCompared = visibility?.compared ?? 0;
  // 来源标识常驻状态行（不依赖 2.2s toast）；真实成功无前缀，避免噪音。
  const sourcePrefix = resultSource === 'demo' ? '本地示例 · ' : '';
  // 每次新结果都收起明细（结果替换即重置，与 resultError 同批）。
  useEffect(() => {
    setCoverageOpen(false);
  }, [coverage]);
  useEffect(() => {
    setVisibilityOpen(false);
  }, [visibility]);
  // Tab 切换时清理该 Tab 不适用的切面选择。
  // 不做这一步会出现「静默空列表」：在 DROP 下选了「表」再切到 CHANGE（无 table 切面），
  // 结果为空且界面上没有任何可见原因。裁剪后为空则回落 ALL。
  useEffect(() => {
    const cur = aspectFilter;
    const next = pruneAspectFilter(cur, diffFilter);
    const unchanged =
      cur === next ||
      (Array.isArray(cur) && Array.isArray(next) && cur.length === next.length && cur.every((a, i) => a === next[i]));
    if (!unchanged) setAspectFilter(next);
  }, [diffFilter, aspectFilter, setAspectFilter]);

  const status = comparing
    ? (progress || '对比中…')
    : sourcePrefix + (lastComboText || `就绪 · ${items.length} 条差异`);

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
      .catch((e: unknown) => setToast(sanitizeIpcError(e)))
      .finally(() => setTestingId(null));
  };

  const handleRemoveNode = (id: string): void => {
    const n = nodes.find((x) => x.id === id);
    if (!window.confirm(`删除节点 ${n?.alias ?? id}？密钥一并删除，该操作不可撤销。`)) return;
    void removeNode(id)
      .then(() => setToast(`已删除节点：${n?.alias ?? id}`))
      .catch((e: unknown) => setToast(sanitizeIpcError(e)));
  };

  const handleExport = async (): Promise<void> => {
    try {
      const doc = await exportDoc();
      const outcome = await saveTextFile(
        `sqldiff_nodes_${Date.now()}.json`,
        JSON.stringify(doc, null, 2),
        '导出 SqlDiff 节点配置',
      );
      if (outcome.status === 'canceled') return;
      const prefix = `已导出 ${doc.nodes.length} 个节点（密码已加密，无明文）`;
      setToast(
        outcome.status === 'saved'
          ? exportSavedMessage(prefix, outcome.filePath)
          : `${prefix}（当前为预览模式，文件由浏览器下载）`,
      );
    } catch (e) {
      setToast(sanitizeIpcError(e));
    }
  };

  const handleDbeaverExported = (result: DBeaverExportResult, filePath: string): void => {
    const warning = result.warnings[0]
      ? `；${result.warnings.length} 条 SSH 密钥待补：${result.warnings[0]}`
      : '';
    const prefix = `已生成 DBeaver 配置（${result.exportedCount} 个节点，未迁移密码/私钥）${warning}`;
    setToast(filePath ? exportSavedMessage(prefix, filePath) : `${prefix}（当前为预览模式，文件由浏览器下载）`);
  };

  const handleDatagripExported = (result: DatagripExportResult, filePaths: string[]): void => {
    const warning = result.warnings.length > 0
      ? `；${result.warnings.length} 条提示（含 SSH 私钥待补 / 拓扑折叠）：${result.warnings[0]}`
      : '';
    const prefix = `已导出 ${result.files.length} 个 XML（${result.exportedCount} 个节点，未迁移密码/私钥）${warning}`;
    const dir = filePaths[0]?.replace(/[/\\][^/\\]*$/, '') ?? '';
    setToast(dir ? exportSavedMessage(`${prefix}，目录`, dir) : `${prefix}（当前为预览模式，文件由浏览器下载）`);
  };

  // 统一出口：ExportModal 内部按 target 调 store 并保存，此处只做 toast 汇总。
  const handleExported = (outcome: NodeExportOutcome): void => {
    if (outcome.kind === 'dbeaver') {
      handleDbeaverExported(outcome.result, outcome.paths?.[0] ?? '');
    } else {
      handleDatagripExported(outcome.result, outcome.paths ?? []);
    }
  };

  const handleImportFile = (file: File): void => {
    void file
      .text()
      .then((text) => importDoc(JSON.parse(text) as Parameters<typeof importDoc>[0]))
      .then((count) => setToast(`已导入 ${count} 个节点，密码免重输`))
      .catch((e: unknown) => setToast(`导入失败：${sanitizeIpcError(e)}`));
  };

  const handleImportLegacy = (): void => {
    // 原实现用 window.prompt，Electron 下会抛异常且此处无人捕获 → 点击毫无反应（已实测确认）。
    // 改为打开带格式说明与解析预览的弹窗。
    setLegacyImportOpen(true);
  };

  // 审查报告导出：仅真实比较可用（demo 结果不提供导出入口）。
  // manifest 构建在 renderer 侧纯函数完成（不重跑比较、不落盘），
  // 下载内容层面对 data 项脱敏；导出物不含秘密与未经裁定的行值。
  const canExportManifest = resultSource === 'real' && lastCompareRequest != null && !comparing;

  // Preflight 门控：需真实比较可用 + 非运行中 + 至少 1 个表级 DDL 项。
  const canRunPreflight =
    resultSource === 'real' &&
    lastCompareRequest != null &&
    !comparing &&
    !preflightRunning &&
    items.some((i) => i.objectType === 'table');

  const handleRunPreflight = async (): Promise<void> => {
    if (!canRunPreflight) {
      setToast('请先完成一次真实比较（不含数据 DML）');
      return;
    }
    await runPreflight();
  };

  const handleExportPreflight = async (): Promise<void> => {
    const result = lastPreflightResult;
    if (!result) {
      setToast('暂无可导出的 Preflight 报告（先运行 Preflight）');
      return;
    }
    try {
      const names = preflightFileNames(result.checkedAt);
      const jsonContent = serializePreflight(result);
      const markdownContent = preflightToExecutiveMarkdown(result);
      const detailMarkdownContent = preflightToDetailMarkdown(result);
      const outcome = await saveTextFiles(
        [
          { name: names.jsonFileName, content: jsonContent },
          { name: names.markdownFileName, content: markdownContent },
          { name: names.detailMarkdownFileName, content: detailMarkdownContent },
        ],
        '导出 Preflight 报告（JSON + 结论 Markdown + 详细 Markdown）',
      );
      if (outcome.status === 'canceled') return;
      if (outcome.status === 'saved') {
        const dir = outcome.filePaths[0]?.replace(/[/\\][^/\\]*$/, '') ?? '';
        setToast(exportSavedMessage('已导出 Preflight 报告：JSON + 结论 + 详细 Markdown，目录', dir));
      } else {
        setToast('已导出 Preflight 报告（当前为预览模式，文件由浏览器下载）');
      }
    } catch (e) {
      setToast(`导出失败：${sanitizeIpcError(e)}`);
    }
  };

  const handleExportManifest = async (): Promise<void> => {
    if (!lastCompareRequest) {
      setToast('暂无可导出的审查报告（先完成一次真实比较）');
      return;
    }
    try {
      const api = (window as unknown as { sqldiff?: SqlDiffApi }).sqldiff ?? null;
      const appVersion = api ? await api.app.version() : '0.0.0';
      const result: CompareResult = {
        items,
        stats: stats ?? {
          ALL: 0,
          CREATE: 0,
          DROP: 0,
          CHANGE: 0,
          INDEX: 0,
          DML: { INSERT: 0, DELETE: 0, UPDATE: 0 },
        },
        ...(dataStatus.length > 0 ? { dataTables: dataStatus } : {}),
        source: resultSource ?? 'real',
        ...(coverage ? { coverage } : {}),
        ...(visibility ? { visibility } : {}),
      };
      const m = buildManifest({
        result,
        request: lastCompareRequest,
        aAlias: aliasOf(slotA),
        bAlias: aliasOf(slotB),
        appVersion,
      });
      const names = manifestFileNames(m.exportedAt);
      // JSON + Markdown 走同一次「选目录」，避免连弹两次对话框。
      const outcome = await saveTextFiles(
        [
          { name: names.jsonFileName, content: serializeManifest(m) },
          { name: names.markdownFileName, content: manifestToMarkdown(m) },
        ],
        '导出审查报告（JSON + Markdown）',
      );
      if (outcome.status === 'canceled') return;
      const statusNote = m.coverageStatus.kind === 'ok' ? '' : `（覆盖状态：${m.coverageStatus.kind}）`;
      const prefix = `已导出审查报告：JSON + Markdown${statusNote}`;
      if (outcome.status === 'saved') {
        const dir = outcome.filePaths[0]?.replace(/[/\\][^/\\]*$/, '') ?? '';
        setToast(exportSavedMessage(`${prefix}，目录`, dir));
      } else {
        setToast(`${prefix}（当前为预览模式，文件由浏览器下载）`);
      }
    } catch (e) {
      setToast(`导出失败：${sanitizeIpcError(e)}`);
    }
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
          onExport={() => void handleExport()}
          onExportDbeaver={() => setExportTarget('dbeaver')}
          onExportDatagrip={() => setExportTarget('datagrip')}
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
          {/*
            结构覆盖明细：常驻计数在 footer，此处仅在用户点开时渲染（复用数据侧 statusRows 行式，
            不新增独立面板）。skipped 为空时整块不出现，界面保持安静。
          */}
          {skippedCount > 0 && coverageOpen && coverage && (
            <div className="card coverage-card">
              <div className="coverage-head">
                以下 {skippedCount} 个对象未取到 SHOW CREATE，已跳过且不参与差异 —— 「无差异」不等于「已全部检查」
              </div>
              <div className="data-status" role="table" aria-label="结构覆盖未检查对象明细">
                {coverage.skipped.map((s, i) => (
                  <div
                    className="data-status-row st-skipped"
                    key={`${s.objectType}:${s.name}:${i}`}
                    title={coverageReasonText(s.reason)}
                  >
                    <span className="mono">
                      {s.name} <span className="hint">{OBJECT_TYPE_LABEL[s.objectType]}</span>
                    </span>
                    <span>{coverageReasonText(s.reason)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/*
            授权盲区明细（常驻计数在 footer，此处仅在用户点开时渲染）：
            复用覆盖卡片的 coverage-card / data-status-row / st-skipped 行式，不新增独立面板。
            excluded 为空且判据可靠时整块不出现，界面保持安静。
          */}
          {visShow && visibilityOpen && visibility && (
            <div className="card coverage-card">
              <div className="coverage-head">
                {visUnreliable
                  ? `授权范围无法确认，已按最保守范围比较：仅比较 A / B 双方均可见的 ${visCompared} 个对象`
                  : `本次比较范围为 A / B 双方均可见的 ${visCompared} 个对象`}
                {visExcludedCount > 0 &&
                  `；以下 ${visExcludedCount} 个对象因连接账号的授权看不到另一侧，未参与比较（不会据此生成 CREATE / DROP）`}
              </div>
              {visExcludedCount === 0 && (
                <div className="hint">
                  本次没有对象因授权被排除。此提示只说明「比较范围未能被证明完整」，
                  已按双方均可见的对象集合比较；它不代表两个 schema 一致。
                </div>
              )}
              <div className="data-status" role="table" aria-label="因授权未参与比较的对象明细">
                {visibility.excluded.map((x, i) => (
                  <div
                    className="data-status-row st-skipped"
                    key={`${x.objectType}:${x.name}:${x.side}:${i}`}
                    title="该对象只有一侧可见，无法判断它是否真的存在于另一侧"
                  >
                    <span className="mono">
                      {x.name} <span className="hint">{OBJECT_TYPE_LABEL[x.objectType]}</span>
                    </span>
                    <span>{excludedSideText(x)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/*
            真实比较失败（Q1 决策）：结果区渲染显式错误卡，替代差异列表 ——
            同时避免 DiffTable 的「空空如也」空态被误读成「两库一致」。
          */}
          {resultError ? (
            <div className="card result-error" role="alert">
              <div className="empty">
                ⚠️ 对比失败：{resultError}
                <div className="hint">
                  请检查 A / B 节点的连接地址、账号与密码后重试；此处不展示任何示例差异，避免与真实结果混淆。
                </div>
              </div>
            </div>
          ) : (
            <>
              <DiffTable
                counts={counts}
                total={items.length}
                visibleCount={tabItems.length}
                rows={tabItems}
                diffFilter={diffFilter}
                objectTypeFilter={objectTypeFilter}
                aspectFilter={aspectFilter}
                aspectScope={aspectScope}
                aspectCounts={aspectCounts}
                objCounts={objCounts}
                verbFilter={verbFilter}
                verbCounts={verbCounts}
                onDiffFilter={setDiffFilter}
                onObjFilter={setObjectTypeFilter}
                onToggleObj={toggleObjectType}
                onToggleAspect={toggleAspect}
                onAspectFilter={setAspectFilter}
                onVerbFilter={setVerbFilter}
                onToggleVerb={toggleVerb}
                onSelect={selectDiff}
                selectedId={selectedId}
                onExportManifest={() => void handleExportManifest()}
                canExportManifest={canExportManifest}
                onRunPreflight={() => void handleRunPreflight()}
                canRunPreflight={canRunPreflight}
                preflightRunning={preflightRunning}
                lastPreflightResult={lastPreflightResult}
                onExportPreflight={() => void handleExportPreflight()}
              />
              {dataItems.length === 0 && dataStatus.length === 0 && (
                <div className="card">
                  <div className="empty">暂无数据行 — 勾选「数据」范围并对比后，INSERT / DELETE / UPDATE 行与结构同表展示（可用“数据”对象 chip + 动词 DML 组定位）🍃</div>
                </div>
              )}
            </>
          )}
        </section>

        <SqlPreview
          tabItems={tabItems}
          selectedId={selectedId}
          aName={aliasOf(slotA)}
          bName={aliasOf(slotB)}
          onToast={setToast}
        />
      </main>

      {/*
        状态行（常驻，不依赖 2.2s toast）：
        - 来源前缀：demo → 「本地示例 · 」；真实成功不加前缀（失败时 lastComboText 本身写「对比失败」）。
        - 覆盖计数：仅在存在未检查对象时出现，点击展开/收起中栏明细；全部成功时不渲染任何提示位。
        - 比较范围：excluded 非空 → 「N 个对象因授权未参与比较」；判据不可靠 → 更强措辞
          「授权范围无法确认，已按最保守范围比较」。excluded 为空且判据可靠时不渲染。
      */}
      <footer className="statusbar">
        <span>{status}</span>
        {skippedCount > 0 && (
          <button
            className="linkish"
            onClick={() => setCoverageOpen((v) => !v)}
            aria-expanded={coverageOpen}
            title={coverageOpen ? '收起未检查对象明细' : '查看未检查对象明细'}
          >
            · {skippedCount} 个对象未检查{coverageOpen ? '（收起明细）' : '（查看明细）'}
          </button>
        )}
        {visShow && (
          <button
            className="linkish"
            onClick={() => setVisibilityOpen((v) => !v)}
            aria-expanded={visibilityOpen}
            title={visibilityOpen ? '收起比较范围明细' : '查看比较范围明细'}
          >
            {visUnreliable
              ? '· 授权范围无法确认，已按最保守范围比较'
              : `· ${visExcludedCount} 个对象因授权未参与比较`}
            {visibilityOpen ? '（收起明细）' : '（查看明细）'}
          </button>
        )}
      </footer>
      {exportTarget && (
        <ExportModal
          target={exportTarget}
          nodes={nodes}
          onClose={() => setExportTarget(null)}
          onExported={handleExported}
        />
      )}
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
      {legacyImportOpen && (
        <LegacyImportModal
          onClose={() => setLegacyImportOpen(false)}
          onImported={(msg) => {
            setLegacyImportOpen(false);
            setToast(msg);
          }}
        />
      )}
      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
