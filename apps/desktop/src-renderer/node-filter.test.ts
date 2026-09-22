// I3 回归：左侧 Tab 过滤（新节点三处不可见 -> 'all' 直通立即可见）。
import { describe, expect, it } from 'vitest';
import type { NodeMeta } from '../src-core/types';
import { visibleNodes } from './node-filter';

function meta(id: string, extra: Partial<NodeMeta> = {}): NodeMeta {
  return {
    id,
    alias: id,
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: 'shop',
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

const nodes = [
  meta('fresh-new', { alias: 'fresh-new' }),
  meta('n-star', { alias: 'star库', star: true, useCount: 5 }),
  meta('n-used', { alias: 'used库', useCount: 27 }),
  meta('n-pinned', { alias: 'pinned库', pinned: true }),
];

describe('visibleNodes', () => {
  it('all 直通：新节点（无星/无频次/无置顶）立即可见', () => {
    const ids = visibleNodes(nodes, 'all', '').map((n) => n.id);
    expect(ids).toContain('fresh-new');
    expect(ids).toHaveLength(4);
  });

  it('mine 只见星标；fav 见置顶+用过（按频次倒序）', () => {
    expect(visibleNodes(nodes, 'mine', '').map((n) => n.id)).toEqual(['n-star']);
    expect(visibleNodes(nodes, 'fav', '').map((n) => n.id)).toEqual(['n-used', 'n-star', 'n-pinned']);
  });

  it('关键字过滤与 Tab 正交', () => {
    expect(visibleNodes(nodes, 'all', 'star库').map((n) => n.id)).toEqual(['n-star']);
    expect(visibleNodes(nodes, 'mine', '不存在').map((n) => n.id)).toEqual([]);
  });
});
