// 小增强 R1 单测：data-run 行身份决策（纯函数 decideIdentity，无需真库）。
import { describe, expect, it } from 'vitest';
import { decideIdentity } from './data-run';

const DDL_PK_ID = [
  'CREATE TABLE `users` (',
  '  `id` int NOT NULL,',
  '  `email` varchar(255) DEFAULT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_PK_OTHER = [
  'CREATE TABLE `users` (',
  '  `uid` int NOT NULL,',
  '  `email` varchar(255) DEFAULT NULL,',
  '  PRIMARY KEY (`uid`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_UNIQUE_EMAIL = [
  'CREATE TABLE `users` (',
  '  `id` int DEFAULT NULL,',
  '  `email` varchar(255) NOT NULL,',
  '  UNIQUE KEY `uk_email` (`email`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_UNIQUE_OTHER = [
  'CREATE TABLE `users` (',
  '  `id` int DEFAULT NULL,',
  '  `phone` varchar(32) NOT NULL,',
  '  UNIQUE KEY `uk_phone` (`phone`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_NULLABLE_UNIQUE = [
  'CREATE TABLE `users` (',
  '  `id` int DEFAULT NULL,',
  '  `email` varchar(255) DEFAULT NULL,',
  '  UNIQUE KEY `uk_email` (`email`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_NO_KEYS = [
  'CREATE TABLE `logs` (',
  '  `id` int DEFAULT NULL,',
  '  `msg` varchar(64) DEFAULT NULL',
  ') ENGINE=InnoDB',
].join('\n');

describe('decideIdentity 行身份决策', () => {
  it('两侧同 PK -> 可比，非 UNIQUE 路径', () => {
    const d = decideIdentity(DDL_PK_ID, DDL_PK_ID, 'users', 'users');
    expect(d).toEqual({ ok: true, cols: ['id'], viaUnique: false, uniqueNote: '' });
  });

  it('两侧同一非空 UNIQUE -> 可比，备注按UNIQUE(email)比对', () => {
    const d = decideIdentity(DDL_UNIQUE_EMAIL, DDL_UNIQUE_EMAIL, 'users', 'users');
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.cols).toEqual(['email']);
      expect(d.viaUnique).toBe(true);
      expect(d.uniqueNote).toBe('按UNIQUE(email)比对');
    }
  });

  it('PK(id) vs UNIQUE(id) 同列集 -> 可比（UNIQUE 备注）', () => {
    const ddlUniqueId = [
      'CREATE TABLE `users` (',
      '  `id` int NOT NULL,',
      '  UNIQUE KEY `uk_id` (`id`)',
      ') ENGINE=InnoDB',
    ].join('\n');
    const d = decideIdentity(DDL_PK_ID, ddlUniqueId, 'users', 'users');
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.cols).toEqual(['id']);
      expect(d.viaUnique).toBe(true);
    }
  });

  it('可空 UNIQUE -> skipped，理由点名可空列', () => {
    const d = decideIdentity(DDL_NULLABLE_UNIQUE, DDL_NULLABLE_UNIQUE, 'users', 'users');
    expect(d.ok).toBe(false);
    if (!d.ok && d.skipped) {
      expect(d.message).toContain('email');
      expect(d.message).toContain('已跳过行级 diff');
    } else {
      throw new Error('期望 skipped 决策');
    }
  });

  it('无任何唯一键 -> skipped（无唯一键理由）', () => {
    const d = decideIdentity(DDL_NO_KEYS, DDL_NO_KEYS, 'logs', 'logs');
    expect(d.ok).toBe(false);
    if (!d.ok && d.skipped) {
      expect(d.message).toContain('无 PRIMARY KEY 且无 UNIQUE 键');
    } else {
      throw new Error('期望 skipped 决策');
    }
  });

  it('两侧 PK 不一致 -> error pk-mismatch（A/B 点名）', () => {
    const d = decideIdentity(DDL_PK_ID, DDL_PK_OTHER, 'users', 'users');
    expect(d.ok).toBe(false);
    if (!d.ok && !d.skipped) {
      expect(d.message).toContain('PK(id)');
      expect(d.message).toContain('PK(uid)');
    } else {
      throw new Error('期望 mismatch 决策');
    }
  });

  it('两侧 UNIQUE 列集不一致 -> error（含 UNIQUE 标签）', () => {
    const d = decideIdentity(DDL_UNIQUE_EMAIL, DDL_UNIQUE_OTHER, 'users', 'users');
    expect(d.ok).toBe(false);
    if (!d.ok && !d.skipped) {
      expect(d.message).toContain('UNIQUE uk_email(email)');
      expect(d.message).toContain('UNIQUE uk_phone(phone)');
    } else {
      throw new Error('期望 mismatch 决策');
    }
  });
});
