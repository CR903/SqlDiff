// 多次 preflight 历史对比 · 独立历史视图（10-04-history-diff）。
//
// - 只做展示：经 IPC（preflight.history list/get）读 preflight-history.json，不直接碰文件；
// - diff 由 src-core/diffPreflight 纯函数计算，不走 IPC；
// - 同库约束：只有同 (bId, database) 的两次可比，跨组选择直接禁用；
// - renderer-only 本地状态，不进 Zustand（不动现有 preflight 面板逻辑）。

import { useEffect, useMemo, useState } from 'react';
import { diffPreflight, historyGroupKey } from '../src-core/preflight-history';
import type { PreflightHistoryEntry } from '../src-core/preflight-history';
import { sanitizeIpcError } from '../src-core/ipc-error';
import type { SqlDiffApi } from '../src-main/preload';

function getIpc(): SqlDiffApi | null {
  try {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { sqldiff?: SqlDiffApi };
    return w.sqldiff ?? null;
  } catch {
    return null;
  }
}

function fmtTime(at: string): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return at;
  }
}

interface Group {
  key: string;
  bAlias: string;
  database: string;
  entries: PreflightHistoryEntry[];
}

function groupEntries(list: PreflightHistoryEntry[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const e of list) {
    const key = historyGroupKey(e);
    const g = byKey.get(key);
    if (g) {
      g.entries.push(e);
    } else {
      byKey.set(key, { key, bAlias: e.bAlias, database: e.database, entries: [e] });
    }
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
  return groups;
}

export function PreflightHistoryModal({
  onClose,
  onToast,
}: {
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [entries, setEntries] = useState<PreflightHistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    const api = getIpc();
    if (!api) {
      setLoadError('当前为预览模式（无主进程），请在 Electron 中运行以查看历史');
      return;
    }
    void api.preflight.history
      .list()
      .then((list) => setEntries(Array.isArray(list) ? list : []))
      .catch((e: unknown) => setLoadError(sanitizeIpcError(e)));
  }, []);

  const groups = useMemo(() => (entries ? groupEntries(entries) : []), [entries]);
  const byId = useMemo(() => new Map((entries ?? []).map((e) => [e.id, e])), [entries]);
  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => byId.get(id))
        .filter((e): e is PreflightHistoryEntry => e != null)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    [selectedIds, byId],
  );

  const toggleSelect = (entry: PreflightHistoryEntry): void => {
    setSelectedIds((cur) => {
      if (cur.includes(entry.id)) return cur.filter((id) => id !== entry.id);
      if (cur.length === 0) return [entry.id];
      const first = byId.get(cur[0]);
      // 同库约束：跨组直接换组（保留点击项），避免无意义的跨库对比。
      if (first && (first.bId !== entry.bId || first.database !== entry.database)) {
        onToast('已切换目标库：跨库对比无意义，只保留本次选择');
        return [entry.id];
      }
      if (cur.length >= 2) return [cur[1], entry.id];
      return [...cur, entry.id];
    });
  };

  const diff = useMemo(() => {
    if (selected.length !== 2) return null;
    return diffPreflight(selected[0].report, selected[1].report);
  }, [selected]);

  const handleClear = (): void => {
    if (!window.confirm('清空全部 Preflight 历史？该操作不可撤销。')) return;
    const api = getIpc();
    if (!api) {
      onToast('当前为预览模式，无法清空');
      return;
    }
    setClearing(true);
    void api.preflight.history
      .clear()
      .then(() => {
        setEntries([]);
        setSelectedIds([]);
        onToast('已清空 Preflight 历史');
      })
      .catch((e: unknown) => onToast(sanitizeIpcError(e)))
      .finally(() => setClearing(false));
  };

  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label="Preflight 历史对比">
        <div className="modal-title">Preflight 历史对比</div>
        {loadError ? (
          <div className="empty">{loadError}</div>
        ) : entries === null ? (
          <div className="empty">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="empty">暂无 Preflight 历史 — 成功运行一次 Preflight 后此处自动存档（每库最近 10 份）</div>
        ) : (
          <>
            <div className="hint">同一目标库选任意两次，对比 verdict 变化 + issues 新增 / 消失 / 等级变化。</div>
            {groups.map((g) => (
              <div key={g.key}>
                <div className="coverage-head">
                  {g.bAlias} / {g.database}（{g.entries.length} 份）
                </div>
                <div className="data-status" role="table" aria-label={`历史 ${g.bAlias}`}>
                  {g.entries.map((e) => {
                    const on = selectedIds.includes(e.id);
                    const otherGroupSelected =
                      selectedIds.length > 0 &&
                      selectedIds.some((id) => {
                        const s = byId.get(id);
                        return s && (s.bId !== e.bId || s.database !== e.database);
                      });
                    return (
                      <button
                        key={e.id}
                        className={`data-status-row st-${on ? 'done' : 'pending'}`}
                        disabled={otherGroupSelected && !on}
                        title={
                          otherGroupSelected && !on
                            ? '跨库对比无意义：请先取消已选，再选本库报告'
                            : on
                              ? '点击取消选择'
                              : '点击选择（最多两次，同库）'
                        }
                        onClick={() => toggleSelect(e)}
                      >
                        <span className="mono">{fmtTime(e.at)}</span>
                        <span>
                          {on ? '✓ ' : ''}
                          {e.report.verdict.level} · b{e.report.verdict.blocking}/w
                          {e.report.verdict.warnings}/u{e.report.verdict.unknowns}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {selected.length === 2 && diff && (
              <div>
                <div className="coverage-head">
                  对比：{fmtTime(selected[0].at)} → {fmtTime(selected[1].at)}
                </div>
                <div className="risk-text">
                  Verdict：{diff.verdictChanged ? '有变化' : '无变化'}（{diff.from.decision} b
                  {diff.from.blocking}/w{diff.from.warnings}/u{diff.from.unknowns} →{' '}
                  {diff.to.decision} b{diff.to.blocking}/w{diff.to.warnings}/u{diff.to.unknowns}）
                </div>
                {diff.addedIssues.length === 0 &&
                  diff.removedIssues.length === 0 &&
                  diff.severityChanged.length === 0 && (
                    <div className="empty">两次 issues 完全一致 — 风险既没收敛也没恶化 🍃</div>
                  )}
                {diff.addedIssues.length > 0 && (
                  <>
                    <div className="coverage-head">新增 issues（{diff.addedIssues.length}）</div>
                    <div className="data-status">
                      {diff.addedIssues.map((i) => (
                        <div className="data-status-row st-error" key={i.id} title={i.detail}>
                          <span className="mono">{i.id}</span>
                          <span>
                            {i.severity} · {i.title}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {diff.removedIssues.length > 0 && (
                  <>
                    <div className="coverage-head">消失 issues（{diff.removedIssues.length}）</div>
                    <div className="data-status">
                      {diff.removedIssues.map((i) => (
                        <div className="data-status-row st-skipped" key={i.id} title={i.detail}>
                          <span className="mono">{i.id}</span>
                          <span>
                            {i.severity} · {i.title}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {diff.severityChanged.length > 0 && (
                  <>
                    <div className="coverage-head">等级变化（{diff.severityChanged.length}）</div>
                    <div className="data-status">
                      {diff.severityChanged.map((c) => (
                        <div className="data-status-row st-running" key={c.id}>
                          <span className="mono">{c.id}</span>
                          <span>
                            {c.from} → {c.to}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {selected.length < 2 && (
              <div className="hint">
                {selected.length === 0 ? '点选同一目标库的两次报告开始对比' : '已选 1 次，再选 1 次即可对比'}
              </div>
            )}
          </>
        )}
        <div className="modal-actions">
          <span className="form-hint">每库最近 10 份滚动保留 · 无秘密入库</span>
          <span className="modal-actions-right">
            <button
              className="btn btn-ghost"
              disabled={clearing || !entries || entries.length === 0}
              onClick={handleClear}
            >
              {clearing ? '清空中…' : '清空历史'}
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              关闭
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
