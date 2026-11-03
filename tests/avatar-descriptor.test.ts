import { it, expect } from 'vitest';
import { sameAvatarDescriptor } from '../apps/server/avatar-descriptor.js';
it('allows small render differences and rejects different or missing avatar descriptors', () => {
  const a = { version: 1, hash: 'a5'.repeat(16), colors: Array(12).fill(100) };
  expect(
    sameAvatarDescriptor(a, { ...a, hash: 'a5'.repeat(15) + 'a7', colors: Array(12).fill(102) }),
  ).toBe(true);
  expect(sameAvatarDescriptor(a, { ...a, hash: '00'.repeat(16) })).toBe(false);
  expect(sameAvatarDescriptor(a, { ...a, colors: Array(12).fill(140) })).toBe(false);
  expect(sameAvatarDescriptor(a, null)).toBe(false);
  expect(sameAvatarDescriptor(null, null)).toBe(false);
});
