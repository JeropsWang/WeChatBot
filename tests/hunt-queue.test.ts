import { it, expect } from 'vitest';
import { huntQueueQuery } from '../apps/server/hunt-queue.js';
it('validates queue filters and page bounds', () => {
  expect(huntQueueQuery.parse({ stage: 'active', page: '2', pageSize: '50' })).toMatchObject({
    stage: 'active',
    page: 2,
    pageSize: 50,
  });
  for (const input of [
    { stage: 'invented' },
    { pageSize: '30' },
    { page: '0' },
    { chatId: 'wrong' },
  ])
    expect(huntQueueQuery.safeParse(input).success).toBe(false);
});
