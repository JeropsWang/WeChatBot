import { expect, it } from 'vitest';
import { commandContent, speakerContent } from '../apps/server/speaker-context.js';
it('only removes the exact leading bot mention', () => {
  expect(commandContent('@测试机器人\u2005/记住 喜欢茶', '测试机器人')).toBe('/记住 喜欢茶');
  expect(commandContent('@别人 /停止 @测试机器人', '测试机器人')).toBe('@别人 /停止 @测试机器人');
});
it('keeps author identities distinct and user text inside data', () => {
  const m = {
    direction: 'in',
    content: '我喜欢茶',
    sender_name: '甲',
    raw: { uiIdentityStatus: 'matched', uiMemberId: 'a' },
  };
  expect(speakerContent(m)).not.toBe(
    speakerContent({ ...m, raw: { uiIdentityStatus: 'matched', uiMemberId: 'b' } }),
  );
  expect(JSON.parse(speakerContent({ ...m, raw: {} })).speaker).toEqual({ status: 'unknown' });
});
