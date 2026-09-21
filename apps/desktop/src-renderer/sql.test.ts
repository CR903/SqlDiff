// M5 回归：SQL 高亮不嵌套 + 导出文本顺序/头注释（AC5 批量复制与所见一致，AC6 头注释+顺序）。
import { describe, expect, it } from 'vitest';
import type { DiffItem } from '../src-core/types';
import { buildExportText, highlightSql } from './sql';

function spanBalance(html: string): boolean {
  const open = html.match(/<span/g)?.length ?? 0;
  const close = html.match(/<\/span>/g)?.length ?? 0;
  return open === close;
}

describe('highlightSql', () => {
  it('关键字高亮且标签配平', () => {
    const html = highlightSql('CREATE TABLE `users`;');
    expect(html).toContain('<span class="tok-kw">CREATE</span>');
    expect(html).toContain('<span class="tok-str">`users`</span>');
    expect(spanBalance(html)).toBe(true);
  });

  it('单引号串内的关键字不按关键字高亮（无嵌套 span）', () => {
    const html = highlightSql("SELECT * FROM `t` WHERE `s` = 'CREATE';");
    expect(html).toContain(`<span class="tok-str">'CREATE'</span>`);
    expect(html).not.toContain('<span class="tok-kw">CREATE</span>');
    expect(spanBalance(html)).toBe(true);
  });

  it('行注释整体为 tok-cmt，注释内的 DROP 不按关键字高亮', () => {
    const html = highlightSql('-- DROP TABLE x\nSELECT 1;');
    expect(html).toContain('<span class="tok-cmt">-- DROP TABLE x</span>');
    expect(html).not.toContain('<span class="tok-kw">DROP</span>');
    expect(html).toContain('<span class="tok-kw">SELECT</span>');
    expect(spanBalance(html)).toBe(true);
  });
});

describe('buildExportText', () => {
  const items: DiffItem[] = [
    {
      id: 'table:users',
      objectType: 'table',
      objectName: 'users',
      changeType: 'CREATE',
      risk: 'low',
      sql: 'CREATE TABLE `users` (`id` int);',
    },
    {
      id: 'table:old',
      objectType: 'table',
      objectName: 'old',
      changeType: 'DROP',
      risk: 'high',
      sql: 'DROP TABLE `old`;',
    },
    {
      id: 'table:t',
      objectType: 'table',
      objectName: 't',
      changeType: 'CHANGE',
      risk: 'medium',
      sql: 'ALTER TABLE `t` ADD COLUMN `age` int;',
    },
  ];

  it('顺序 DROP→CREATE→CHANGE，且头注释含 A/B/时间', () => {
    const text = buildExportText(items, { aName: 'A库', bName: 'B库', at: '2026-09-21T00:00:00.000Z' });
    expect(text).toContain('A(来源): A库');
    expect(text).toContain('B(目标): B库');
    expect(text).toContain('2026-09-21T00:00:00.000Z');
    const iDrop = text.indexOf('DROP TABLE');
    const iCreate = text.indexOf('CREATE TABLE');
    const iAlter = text.indexOf('ADD COLUMN');
    expect(iDrop).toBeGreaterThanOrEqual(0);
    expect(iCreate).toBeGreaterThanOrEqual(0);
    expect(iAlter).toBeGreaterThanOrEqual(0);
    expect(iDrop).toBeLessThan(iCreate);
    expect(iCreate).toBeLessThan(iAlter);
  });

  it('空差异导出提示无差异', () => {
    expect(buildExportText([], { aName: 'A', bName: 'B' })).toContain('无差异');
  });
});
