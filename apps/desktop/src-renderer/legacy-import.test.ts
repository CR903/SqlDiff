// 老连接串导入预览的回归：分隔符语义必须与主进程 parseLegacyConnectionString 一致，
// 且「格式看不懂」这件事本身就是这个模块存在的理由——预览错误会直接把人带偏。
import { describe, expect, it } from 'vitest';
import { LEGACY_EXAMPLE, previewLegacyString, splitLegacyString } from './legacy-import';

describe('splitLegacyString：基本段', () => {
  it('user:pass@host~db#port 逐段切分', () => {
    expect(splitLegacyString('appuser:secret@10.0.0.8~shop#3307')).toEqual({
      user: 'appuser',
      password: 'secret',
      host: '10.0.0.8',
      port: 3307,
      database: 'shop',
      ssh: null,
      portInvalid: false,
      sshPortInvalid: false,
    });
  });

  it('省略 #端口 时默认 3306', () => {
    const p = splitLegacyString('u:p@h~db');
    expect('port' in p && p.port).toBe(3306);
  });

  it('缺 ~ 视为格式错误', () => {
    expect(splitLegacyString('u:p@host')).toHaveProperty('error');
  });

  it('库名为空视为格式错误', () => {
    expect(splitLegacyString('u:p@host~')).toHaveProperty('error');
  });

  it('端口非法回落默认 3306（与主进程 parsePort 同语义）', () => {
    const p = splitLegacyString('u:p@h~db#abc');
    expect('port' in p && p.port).toBe(3306);
  });
});

describe('splitLegacyString：SSH 段', () => {
  it('+ 之后解析 sshuser:sshpass@sshhost#sshport', () => {
    const p = splitLegacyString('u:p@h~db#3306+su:sp@jump1#2222');
    expect('ssh' in p && p.ssh).toEqual({ user: 'su', password: 'sp', host: 'jump1', port: 2222 });
  });

  it('SSH 端口省略时默认 22', () => {
    const p = splitLegacyString('u:p@h~db+su:sp@jump1');
    expect('ssh' in p && p.ssh?.port).toBe(22);
  });

  it('SSH 段缺 @ 视为格式错误', () => {
    expect(splitLegacyString('u:p@h~db+su:sp')).toHaveProperty('error');
  });
});

describe('previewLegacyString：等级与文案', () => {
  it('空输入返回 null（不打扰用户）', () => {
    expect(previewLegacyString('')).toBeNull();
    expect(previewLegacyString('   ')).toBeNull();
  });

  it('正常串 → ok，并逐行说明解析结果', () => {
    const p = previewLegacyString('appuser:secret@10.0.0.8~shop');
    expect(p?.level).toBe('ok');
    expect(p?.summary).toBe('将导入为 appuser@10.0.0.8/shop');
    expect(p?.lines.join(' ')).toContain('不走 SSH 跳板');
  });

  it('带 SSH 段 → ok，且明确说明走跳板', () => {
    const p = previewLegacyString(LEGACY_EXAMPLE);
    expect(p?.level).toBe('ok');
    expect(p?.lines.join(' ')).toContain('走 SSH 跳板：10.0.0.2:22');
  });

  it('格式错 → error（导入按钮应禁用）', () => {
    const p = previewLegacyString('这不是连接串');
    expect(p?.level).toBe('error');
  });

  it('密码含 @ → warn，明确提示可能切错位', () => {
    const p = previewLegacyString('u:p@ss@10.0.0.8~shop');
    expect(p?.level).toBe('warn');
    expect(p && 'risk' in p ? p.risk : '').toContain('切');
  });

  it('端口非法 → warn', () => {
    const p = previewLegacyString('u:p@h~db#abc');
    expect(p?.level).toBe('warn');
  });

  // 回归：曾用 `src.includes('#') && port===3306` 判端口非法，导致任何显式写 #3306
  // 的正常串（含官方示例）都被误报警告。省略端口/显式写合法端口都必须是 ok。
  it('显式写合法端口（含默认 3306）不应误报警告', () => {
    expect(previewLegacyString('u:p@h~db#3306')?.level).toBe('ok');
    expect(previewLegacyString('u:p@h~db#3307')?.level).toBe('ok');
    expect(previewLegacyString('u:p@h~db')?.level).toBe('ok');
    expect(previewLegacyString('u:p@h~db#3306+su:sp@jump#22')?.level).toBe('ok');
  });

  it('密码为空如实提示，不假装有密码', () => {
    const p = previewLegacyString('u:@h~db');
    expect(p?.level).toBe('ok');
    expect(p?.lines.join(' ')).toContain('密码为空');
  });
});

describe('LEGACY_EXAMPLE', () => {
  it('示例自身必须是可解析的 ok 串（避免教用户一个错例子）', () => {
    expect(previewLegacyString(LEGACY_EXAMPLE)?.level).toBe('ok');
  });
});