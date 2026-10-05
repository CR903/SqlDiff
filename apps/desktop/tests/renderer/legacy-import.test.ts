// 老连接串「解析为可编辑草稿」的回归。
//
// 核心事实（实测得出，勿凭印象改）：解析用 lastIndexOf 取「最后一个」分隔符，
// 所以密码里的 @ ~ # 能完整还原；真正会炸的是 +（SSH 分段符，用 indexOf 取第一个）。
// 因此本模块的契约是：解析只负责「尽力拆成草稿」，最终由用户裁决，绝不静默改写。
import { describe, expect, it } from 'vitest';
import {
  draftToNodeInput,
  LEGACY_EXAMPLE,
  parseLegacyToDraft,
  validateDraft,
  type LegacyDraft,
} from '../../src-renderer/legacy-import';

function draftOf(src: string): LegacyDraft {
  const p = parseLegacyToDraft(src);
  if (p.level === 'error') throw new Error(`期望解析成功，实际报错：${p.message}`);
  return p.draft;
}

describe('parseLegacyToDraft：基本段', () => {
  it('user:pass@host~db#port 拆成草稿字段', () => {
    expect(draftOf('appuser:secret@10.0.0.8~shop#3307')).toMatchObject({
      user: 'appuser',
      password: 'secret',
      host: '10.0.0.8',
      database: 'shop',
      port: '3307',
      sshEnabled: false,
    });
  });

  it('省略端口填默认 3306，别名自动生成', () => {
    const d = draftOf('u:p@h~db');
    expect(d.port).toBe('3306');
    expect(d.alias).toBe('u@h/db');
  });

  it('缺分隔符 → error（UI 会给手填表单，不卡死）', () => {
    const p = parseLegacyToDraft('这不是连接串');
    expect(p.level).toBe('error');
  });

  it('空串 → error', () => {
    expect(parseLegacyToDraft('   ').level).toBe('error');
  });
});

describe('parseLegacyToDraft：密码含特殊字符（本次重构的核心诉求）', () => {
  // 回归锁定：这些字符曾被 UI 警告为「会切错位」，实测证明能完整还原。
  it.each([
    ['p@ss', 'u:p@ss@10.0.0.8~shop#3306'],
    ['p@s@s', 'u:p@s@s@10.0.0.8~shop#3306'],
    ['p~ss', 'u:p~ss@10.0.0.8~shop#3306'],
    ['p#ss', 'u:p#ss@10.0.0.8~shop#3306'],
    ['p:ss', 'u:p:ss@10.0.0.8~shop#3306'],
  ])('密码 %s 完整还原（不会被分隔符切走）', (pw, src) => {
    expect(draftOf(src).password).toBe(pw);
  });

  it('密码含 @ 时不产生任何风险提示（曾误报，用户会白担心）', () => {
    const p = parseLegacyToDraft('u:p@ss@10.0.0.8~shop#3306');
    expect(p.level).toBe('ok');
  });

  it('密码含 + 时给出明确风险提示，但仍产出草稿让用户手改', () => {
    const p = parseLegacyToDraft('u:p+ss@10.0.0.8~shop#3306');
    expect(p.level).toBe('warn');
    if (p.level !== 'warn') return;
    expect(p.risks.join(' ')).toContain('+');
    expect(p.draft.host).toBe('10.0.0.8'); // 数据库段仍正确切出
  });

  it('端口非法 → warn，且保留用户原文供其修改（不静默改写）', () => {
    const p = parseLegacyToDraft('u:p@h~db#abc');
    expect(p.level).toBe('warn');
    if (p.level !== 'warn') return;
    expect(p.draft.port).toBe('abc');
    expect(p.risks.join(' ')).toContain('端口');
  });
});

describe('parseLegacyToDraft：SSH 段', () => {
  it('+ 之后拆出跳板字段并自动勾选', () => {
    const d = draftOf('u:p@h~db#3306+su:sp@jump1#2222');
    expect(d.sshEnabled).toBe(true);
    expect(d.sshUser).toBe('su');
    expect(d.sshPassword).toBe('sp');
    expect(d.sshHost).toBe('jump1');
    expect(d.sshPort).toBe('2222');
  });

  it('SSH 端口省略填默认 22', () => {
    expect(draftOf('u:p@h~db+su:sp@jump1').sshPort).toBe('22');
  });

  it('SSH 段切不开 → warn 而非 error（用户可手动填或取消勾选）', () => {
    const p = parseLegacyToDraft('u:p@h~db+badssh');
    expect(p.level).toBe('warn');
    if (p.level !== 'warn') return;
    expect(p.risks.join(' ')).toContain('SSH');
    expect(p.draft.sshEnabled).toBe(false);
  });
});

describe('draftToNodeInput：结构化入库', () => {
  it('草稿转 NodeCreateInput 形状，密码进 secret', () => {
    const input = draftToNodeInput(draftOf('appuser:secret@10.0.0.8~shop#3307'));
    expect(input).toMatchObject({
      host: '10.0.0.8',
      port: 3307,
      user: 'appuser',
      database: 'shop',
      secret: { password: 'secret' },
    });
    expect(input.ssh.enabled).toBe(false);
  });

  it('别名留空时回落 user@host/db', () => {
    const d = { ...draftOf('u:p@h~db'), alias: '  ' };
    expect(draftToNodeInput(d).alias).toBe('u@h/db');
  });

  it('空密码不写入 secret（后续可在节点表单补）', () => {
    expect(draftToNodeInput(draftOf('u:@h~db')).secret).toEqual({});
  });

  it('勾选 SSH 时才带 sshPassword', () => {
    const withSsh = draftToNodeInput(draftOf('u:p@h~db+su:sp@jump#22'));
    expect(withSsh.secret).toEqual({ password: 'p', sshPassword: 'sp' });
    expect(withSsh.ssh).toMatchObject({ enabled: true, host: 'jump', port: 22, user: 'su' });
  });

  it('取消 SSH 勾选后不携带跳板信息', () => {
    const d = { ...draftOf('u:p@h~db+su:sp@jump#22'), sshEnabled: false };
    const input = draftToNodeInput(d);
    expect(input.ssh.enabled).toBe(false);
    expect(input.ssh.host).toBe('');
    expect(input.secret.sshPassword).toBeUndefined();
  });
});

describe('validateDraft', () => {
  it('完整草稿无错误', () => {
    expect(validateDraft(draftOf(LEGACY_EXAMPLE))).toEqual([]);
  });

  it('必填项缺失逐条报出', () => {
    const d = { ...draftOf('u:p@h~db'), host: '', user: '', database: '' };
    const errs = validateDraft(d);
    expect(errs).toContain('主机不能为空');
    expect(errs).toContain('用户名不能为空');
    expect(errs).toContain('库名不能为空');
  });

  it('端口越界报错', () => {
    expect(validateDraft({ ...draftOf('u:p@h~db'), port: '99999' })).toContain('端口需为 1-65535 的整数');
  });

  it('勾了 SSH 但跳板信息不全要报错', () => {
    const d = { ...draftOf('u:p@h~db'), sshEnabled: true, sshHost: '', sshUser: '' };
    const errs = validateDraft(d);
    expect(errs.some((e) => e.includes('跳板主机'))).toBe(true);
    expect(errs.some((e) => e.includes('SSH 用户名'))).toBe(true);
  });

  it('端口留空按默认 3306 视为合法', () => {
    expect(validateDraft({ ...draftOf('u:p@h~db'), port: '' })).toEqual([]);
  });
});

describe('LEGACY_EXAMPLE', () => {
  it('示例自身必须是 ok 且字段完整（避免教用户一个错例子）', () => {
    const p = parseLegacyToDraft(LEGACY_EXAMPLE);
    expect(p.level).toBe('ok');
    expect(validateDraft(p.level === 'error' ? ({} as LegacyDraft) : p.draft)).toEqual([]);
  });
});