import { describe, expect, it } from 'vitest';
import {
  parseCommand,
  proactiveEligible,
  composePrompt,
  classifyMemory,
  segmentChinese,
  BANTER_BOUNDARY,
} from '../apps/server/domain.js';
import { defaultSettings } from '../packages/contracts.js';

describe('deterministic commands', () => {
  it('recognizes Chinese/English aliases and quoted arguments', () => {
    expect(parseCommand('/搜索 终末地 新消息')).toEqual({
      name: 'search',
      argument: '终末地 新消息',
    });
    expect(parseCommand(' /remember 我喜欢短回复 ')).toEqual({
      name: 'remember',
      argument: '我喜欢短回复',
    });
    expect(parseCommand('/停止')).toEqual({ name: 'stop', argument: '' });
    expect(parseCommand('/model reset')).toEqual({ name: 'unknown', argument: '/model reset' });
    expect(parseCommand('聊天里提到 /停止')).toBeNull();
  });
});
describe('proactive constraints with a controlled clock', () => {
  const now = Date.UTC(2026, 9, 26, 5);
  const common = {
    now,
    cooldownSeconds: 120,
    hourlyLimit: 10,
    paused: false,
    enabled: true,
    verified: true,
    createdAt: now,
    sentTimes: [] as number[],
  };
  it('rejects at119 seconds and permits at120 seconds', () => {
    expect(proactiveEligible({ ...common, sentTimes: [now - 119000] })).toBe(false);
    expect(proactiveEligible({ ...common, sentTimes: [now - 120000] })).toBe(true);
  });
  it('enforces rolling-hour limit and expires stale jobs', () => {
    expect(proactiveEligible({ ...common, sentTimes: Array(10).fill(now - 150000) })).toBe(false);
    expect(proactiveEligible({ ...common, sentTimes: Array(10).fill(now - 3600001) })).toBe(true);
    expect(proactiveEligible({ ...common, createdAt: now - 120001 })).toBe(false);
    expect(proactiveEligible({ ...common, verified: false })).toBe(false);
    expect(proactiveEligible({ ...common, paused: true })).toBe(false);
  });
});
describe('personality and source-grounded memory', () => {
  it('uses per-group overrides without changing global configuration', () => {
    const original = structuredClone(defaultSettings.persona);
    const prompt = composePrompt(original, { length: '详细' }, [
      { content: '聚会在周六', source: '茶话会', id: 'm1' },
    ]);
    expect(prompt).toContain('详细');
    expect(prompt).toContain('茶话会');
    expect(prompt).toContain('m1');
    expect(original).toEqual(defaultSettings.persona);
  });
  it('does not activate unsupported or conflicting claims or overwrite pinned memories', () => {
    expect(
      classifyMemory({ confidence: 0.95, evidence: ['a'], conflict: false, pinned: false }),
    ).toBe('active');
    expect(classifyMemory({ confidence: 0.99, evidence: [], conflict: false, pinned: false })).toBe(
      'candidate',
    );
    expect(
      classifyMemory({ confidence: 0.99, evidence: ['a'], conflict: true, pinned: false }),
    ).toBe('conflicted');
    expect(
      classifyMemory({ confidence: 0.99, evidence: ['a'], conflict: false, pinned: true }),
    ).toBe('candidate');
  });
  it('segments Chinese words for PostgreSQL simple full-text search', () => {
    const text = segmentChinese('喜欢简短自然的回复');
    expect(text).toContain(' ');
    expect(text).toContain('回复');
  });
});
describe('banter stop-line', () => {
  it('survives group-level persona edits and empty personas', () => {
    const rare = {
      prompt: '',
      length: '简短' as const,
      formality: '自然' as const,
      humor: '活泼' as const,
      emoji: '偶尔' as const,
      examples: '',
    };
    for (const prompt of [
      composePrompt(defaultSettings.persona, {}, []),
      composePrompt(rare, {}, []),
      composePrompt(rare, { prompt: '你是一个只会夸人的助手', humor: '克制' }, []),
    ]) {
      expect(prompt).toContain(BANTER_BOUNDARY);
      expect(prompt.split(BANTER_BOUNDARY)).toHaveLength(2);
    }
  });
  it('bounds insults to banter: no family, appearance or group targeting', () => {
    expect(BANTER_BOUNDARY).toContain('玩笑');
    for (const banned of ['家人', '长相', '地域', '群体扫射', '求助'])
      expect(BANTER_BOUNDARY).toContain(banned);
    expect(BANTER_BOUNDARY).toContain('具体言行');
    expect(BANTER_BOUNDARY).toContain('对话证据');
    expect(BANTER_BOUNDARY).toContain('少量粗口');
    expect(BANTER_BOUNDARY).not.toContain('不用真实脏字');
  });
  it('preserves natural conversation and evidence-bound disagreement under group persona overrides', () => {
    const prompt = composePrompt(defaultSettings.persona, { prompt: '随便说点什么' }, []);
    for (const rule of ['不要机械复读', '不编造亲身经历', '不是挑衅', '不为凑字数'])
      expect(prompt).toContain(rule);
  });
  it('keeps a cold direct tone without confusing insults with a factual correction', () => {
    const prompt = composePrompt(defaultSettings.persona, {}, []);
    for (const rule of ['不讨好', '不自贬', '辱骂不是纠错', '10至25字', '50字'])
      expect(prompt).toContain(rule);
  });
});
