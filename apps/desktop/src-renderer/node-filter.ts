// 左侧节点库 Tab 过滤（纯函数，无 React 依赖，单测直测）：
// 'all' 直通（仅关键字过滤，新节点立即可见）；'mine' 星标；'fav' 置顶 + 频次 Top；
// 'hist' 由历史列表展示，节点列表不消费（直通即可）。

import type { NodeMeta } from '../src-core/types';
import type { LeftTab } from './store';

export function visibleNodes(nodes: NodeMeta[], tab: LeftTab, keyword: string): NodeMeta[] {
  const kw = keyword.trim().toLowerCase();
  const list = nodes.filter((n) => {
    if (kw && !(n.alias + n.host + n.database + (n.group ?? '')).toLowerCase().includes(kw))
      return false;
    if (tab === 'mine' && !n.star) return false;
    // 常用 = 手动置顶（pinned）+ 按频次自动 Top（用过即入围，按 useCount 倒序）。
    if (tab === 'fav' && !n.pinned && (n.useCount ?? 0) <= 0) return false;
    return true;
  });
  if (tab === 'fav') return [...list].sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
  return list;
}
