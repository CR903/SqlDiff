// 渲染窗口纯逻辑的回归（对应 App.tsx 的渲染上限行为）。
// 这些分支此前只存在于组件内部、无测试覆盖，抽成纯函数后逐条锁定。
import { describe, expect, it } from 'vitest';
import { hasMoreRows, nextWindowLimit, ROW_WINDOW, windowRows } from './row-window';

const M = (scrollTop: number, clientHeight = 300, scrollHeight = 3000) => ({ scrollTop, clientHeight, scrollHeight });

describe('windowRows', () => {
  it('limit 小于总数时截断', () => {
    expect(windowRows([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });

  it('limit 等于或超过总数时返回全部', () => {
    expect(windowRows([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(windowRows([1, 2, 3], 99)).toEqual([1, 2, 3]);
  });

  it('空数组安全', () => {
    expect(windowRows([], 200)).toEqual([]);
  });

  it('limit 为 0 或负数不产生越界空洞', () => {
    expect(windowRows([1, 2, 3], 0)).toEqual([]);
    expect(windowRows([1, 2, 3], -5)).toEqual([]);
  });

  it('返回新数组，不泄漏内部引用', () => {
    const src = [1, 2, 3];
    expect(windowRows(src, 99)).not.toBe(src);
  });
});

describe('nextWindowLimit', () => {
  it('滚到底部：加一页', () => {
    expect(nextWindowLimit(M(2800), 200, 3135)).toBe(400);
  });

  it('未到底部：不变（同一引用语义用 === 判断）', () => {
    expect(nextWindowLimit(M(100), 200, 3135)).toBe(200);
  });

  it('已到最后窗口：不再增长（避免无限 setState）', () => {
    // limit 已等于总数，且在底部
    expect(nextWindowLimit(M(2900), 3135, 3135)).toBe(3135);
  });

  it('加页时不超过总数（末页可能不足一页）', () => {
    // limit=300, total=350 -> 应收敛到 350 而非 500
    expect(nextWindowLimit(M(2900), 300, 350)).toBe(350);
  });

  it('总数小于初始 limit：不增长', () => {
    expect(nextWindowLimit(M(0, 300, 100), 200, 50)).toBe(200);
  });

  it('阈值为一页像素：差几像素到底也算到达，避免快滚漏触发', () => {
    // scrollTop+clientHeight = 2820, scrollHeight = 3000, 阈值 200 -> 2800，已越过
    expect(nextWindowLimit(M(2520, 300, 3000), 200, 1000)).toBe(400);
    // 未越过阈值
    expect(nextWindowLimit(M(2400, 300, 3000), 200, 1000)).toBe(200);
  });

  it('可用自定义页大小', () => {
    expect(nextWindowLimit(M(2900, 300, 3000), 200, 1000, 50)).toBe(250);
  });

  it('scrollHeight 为 0（内容未撑开）时不误增长', () => {
    // 0 + 300 >= 0 - 200 为真，但 limit>=total 时不应增长
    expect(nextWindowLimit({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }, 200, 0)).toBe(200);
  });
});

describe('hasMoreRows', () => {
  it('还有未渲染行时为 true', () => {
    expect(hasMoreRows(200, 3135)).toBe(true);
  });

  it('全部渲染后为 false', () => {
    expect(hasMoreRows(3135, 3135)).toBe(false);
  });
});

describe('ROW_WINDOW', () => {
  it('取值足以覆盖首屏又不至于压垮 DOM', () => {
    // 3135 行全量渲染实测 57,673 元素（18.4/行）；
    // 200 行约 3.7k 元素，且低于常见视口一屏能显示的行数上限场景之外。
    expect(ROW_WINDOW).toBeGreaterThanOrEqual(50);
    expect(ROW_WINDOW).toBeLessThanOrEqual(500);
  });
});